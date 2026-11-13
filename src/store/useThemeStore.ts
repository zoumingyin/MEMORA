import { create } from 'zustand'
import {
  applyThemeToDocument,
  broadcastTheme,
  isThemeOwner,
  listenThemeChanged,
  matchMediaTheme,
  readSystemTheme,
  replyThemeTo,
  requestTheme,
  THEME_REQUEST_EVENT,
  TRAY_SET_THEME_EVENT,
  type ResolvedTheme,
  type ThemeMode,
} from '../theme/themeBridge'
import { isTauriRuntime } from '../repository'
import { listen } from '@tauri-apps/api/event'

/** 主题持久化键（沿用仓库 localStorage `bianqian.<域>.v<N>` 约定） */
const STORAGE_KEY = 'bianqian.theme.v1'
/** 旧键：主题曾与置顶/透明度同存于 window.v1，迁移时读取一次 */
const LEGACY_STORAGE_KEY = 'bianqian.window.v1'

/** 系统主题轮询间隔：注册表无变更通知，matchMedia 之外的兜底 */
const SYSTEM_POLL_MS = 5000

const MODES: ThemeMode[] = ['light', 'dark', 'system']

function normalizeMode(value: unknown): ThemeMode | null {
  return MODES.includes(value as ThemeMode) ? (value as ThemeMode) : null
}

/** 读取持久化模式；首次升级时把旧的 light/dark 选择迁过来，无记录则默认跟随系统 */
function loadMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as { mode?: unknown }
      const mode = normalizeMode(parsed?.mode)
      if (mode) return mode
    }
    const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY)
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw) as { theme?: unknown }
      const mode = normalizeMode(legacy?.theme)
      if (mode) return mode
    }
  } catch {
    // 存储损坏 / 不可用时回落默认
  }
  return 'system'
}

function persistMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode }))
  } catch {
    // 存储不可用时本次会话仍生效
  }
}

function resolve(mode: ThemeMode, systemTheme: ResolvedTheme): ResolvedTheme {
  return mode === 'system' ? systemTheme : mode
}

interface ThemeState {
  /** 用户选择的模式（持久化，全部窗口共享同一份） */
  mode: ThemeMode
  /** 实际生效主题，组件与 antd 一律读这个 */
  resolvedTheme: ResolvedTheme
  /** 系统当前主题（system 模式的解析输入） */
  systemTheme: ResolvedTheme
  /** 已完成初始化（订阅建立、系统主题读到真实值） */
  ready: boolean
  setMode: (mode: ThemeMode) => void
  initializeTheme: () => Promise<() => void>
}

const initialMode = loadMode()
// 首屏兜底：注册表是异步的，先用 matchMedia 的结果解析，避免初始化期间闪一帧错误主题
const initialSystem = matchMediaTheme()
const initialResolved = resolve(initialMode, initialSystem)
// 模块加载即落 DOM：早于 React 首次渲染，配合 HTML 引导脚本消除主题闪烁
applyThemeToDocument(initialResolved)

/** 应用生效主题并按需广播（只有主窗口写盘与广播） */
function commit(mode: ThemeMode, systemTheme: ResolvedTheme, notify: boolean): void {
  const resolved = resolve(mode, systemTheme)
  const changed = useThemeStore.getState().resolvedTheme !== resolved
  useThemeStore.setState({ mode, systemTheme, resolvedTheme: resolved })
  applyThemeToDocument(resolved)
  if (!isThemeOwner()) return
  if (notify) persistMode(mode)
  if (notify || changed) void broadcastTheme({ mode, resolved })
}

export const useThemeStore = create<ThemeState>(() => ({
  mode: initialMode,
  resolvedTheme: initialResolved,
  systemTheme: initialSystem,
  ready: false,
  setMode: (mode) => {
    commit(mode, useThemeStore.getState().systemTheme, true)
  },
  initializeTheme: () => initializeTheme(),
}))

/** 引用计数 + 单例订阅：同一窗口内重复调用只建立一套监听，全部释放后才拆卸 */
let refs = 0
let starting: Promise<void> | null = null
let dispose: (() => void) | null = null

async function start(): Promise<void> {
  const owner = isThemeOwner()
  const cleanups: Array<() => void> = []
  let stopped = false

  const systemTheme = await readSystemTheme()
  if (stopped) return
  const state = useThemeStore.getState()
  // 子窗口不写盘：主窗口是持久化的唯一来源
  commit(state.mode, systemTheme, owner && localStorage.getItem(STORAGE_KEY) === null)
  useThemeStore.setState({ ready: true })
  // 启动无条件广播一次：托盘菜单勾选据此校正为真实持久化选择（Rust 侧只猜了个初值）
  if (owner) {
    const current = useThemeStore.getState()
    void broadcastTheme({ mode: current.mode, resolved: current.resolvedTheme })
  }

  const onSystemMaybeChanged = async (): Promise<void> => {
    const next = await readSystemTheme()
    if (stopped) return
    const current = useThemeStore.getState()
    if (next === current.systemTheme) return
    commit(current.mode, next, false)
  }

  // matchMedia 在多数 WebView2 版本上会随 Windows 应用模式即时变化，作为快路径
  const media = window.matchMedia?.('(prefers-color-scheme: dark)')
  const onMediaChange = (): void => void onSystemMaybeChanged()
  media?.addEventListener?.('change', onMediaChange)
  cleanups.push(() => media?.removeEventListener?.('change', onMediaChange))

  // 注册表轮询兜底 + 回到窗口时立刻校准（手动模式下 commit 不会改变 resolvedTheme）
  const timer = window.setInterval(() => void onSystemMaybeChanged(), SYSTEM_POLL_MS)
  cleanups.push(() => window.clearInterval(timer))
  const onFocus = (): void => void onSystemMaybeChanged()
  window.addEventListener('focus', onFocus)
  cleanups.push(() => window.removeEventListener('focus', onFocus))

  if (isTauriRuntime()) {
    // 全部窗口订阅广播；主窗口自己也会收到，commit 幂等不会成环
    void listenThemeChanged((payload) => {
      if (stopped) return
      const mode = normalizeMode(payload.mode)
      if (!mode) return
      const resolved = payload.resolved === 'dark' ? 'dark' : 'light'
      useThemeStore.setState({ mode, resolvedTheme: resolved })
      applyThemeToDocument(resolved)
    }).then((unlisten) => {
      if (stopped) unlisten()
      else cleanups.push(unlisten)
    })

    if (owner) {
      // 新窗口就绪后索取主题：覆盖「创建瞬间主窗口刚切主题」的竞态
      void listen<{ label?: string }>(THEME_REQUEST_EVENT, (event) => {
        const label = event.payload?.label
        if (!label) return
        const current = useThemeStore.getState()
        void replyThemeTo(label, { mode: current.mode, resolved: current.resolvedTheme })
      }).then((unlisten) => {
        if (stopped) unlisten()
        else cleanups.push(unlisten)
      })
      // 托盘菜单主题入口：交由主窗口统一落盘与广播
      void listen<string>(TRAY_SET_THEME_EVENT, (event) => {
        const mode = normalizeMode(event.payload)
        if (mode) useThemeStore.getState().setMode(mode)
      }).then((unlisten) => {
        if (stopped) unlisten()
        else cleanups.push(unlisten)
      })
      // 首次升级把迁移来的旧选择写进新键
      if (localStorage.getItem(STORAGE_KEY) === null) persistMode(useThemeStore.getState().mode)
    } else {
      void requestTheme()
    }
  }

  dispose = () => {
    stopped = true
    for (const cleanup of cleanups.splice(0)) {
      try {
        cleanup()
      } catch {
        // 监听器已随窗口销毁
      }
    }
  }
}

/**
 * 建立主题订阅。主窗口负责系统主题监听、持久化与广播；子窗口只订阅。
 * 返回释放函数，窗口卸载时调用；重复调用共享同一套监听。
 */
async function initializeTheme(): Promise<() => void> {
  refs += 1
  starting ??= start()
  await starting
  let released = false
  return () => {
    if (released) return
    released = true
    refs -= 1
    if (refs > 0) return
    dispose?.()
    dispose = null
    starting = null
  }
}