import { emit, emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { isTauriRuntime } from '../repository'

/** 主题模式：用户可选的三档 */
export type ThemeMode = 'light' | 'dark' | 'system'
/** 实际生效的主题：system 解析后的结果 */
export type ResolvedTheme = 'light' | 'dark'

/** 主窗口 → 全部窗口：主题已变更（也用于响应 theme:request 的定向回复） */
export const THEME_CHANGED_EVENT = 'theme:changed'
/** 子窗口 → 主窗口：新窗口就绪，索取当前主题 */
export const THEME_REQUEST_EVENT = 'theme:request'
/** 托盘菜单 → 主窗口：切换主题模式 */
export const TRAY_SET_THEME_EVENT = 'tray:set-theme'

export interface ThemePayload {
  mode: ThemeMode
  resolved: ResolvedTheme
}

/** 当前窗口标签；浏览器预览环境统一按 main 处理 */
export function currentWindowLabel(): string {
  if (!isTauriRuntime()) return 'main'
  try {
    return getCurrentWindow().label
  } catch {
    return 'main'
  }
}

/**
 * 主题唯一写入口是主窗口：它常驻托盘（只 hide 不销毁），负责持久化与广播。
 * 子窗口只读取 + 订阅，避免各窗口存出互相矛盾的主题。
 */
export function isThemeOwner(): boolean {
  return currentWindowLabel() === 'main'
}

/** 浏览器 / 非 Windows 兜底：WebView2 的 prefers-color-scheme 跟随 Windows 应用模式 */
export function matchMediaTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/**
 * 读取 Windows 系统应用主题。注册表 AppsUseLightTheme 是权威来源，
 * 读失败（非 Windows / 权限 / 预览环境）回落到 matchMedia。
 */
export async function readSystemTheme(): Promise<ResolvedTheme> {
  if (isTauriRuntime()) {
    try {
      const value = await invoke<string>('get_system_theme')
      if (value === 'dark' || value === 'light') return value
    } catch {
      // 命令不可用（旧二进制 / 非 Windows）时走 matchMedia
    }
  }
  return matchMediaTheme()
}

/**
 * 把生效主题落到根节点：data-theme 驱动全部 CSS 令牌，
 * .dark-glass 保留为既有 112 处暗色选择器的标记，color-scheme 让原生滚动条/表单控件跟随。
 */
export function applyThemeToDocument(resolved: ResolvedTheme): void {
  const root = document.documentElement
  root.dataset.theme = resolved
  root.classList.toggle('dark-glass', resolved === 'dark')
  root.style.colorScheme = resolved
}

/** 主窗口广播主题；失败不影响本窗口已生效的主题 */
export async function broadcastTheme(payload: ThemePayload): Promise<void> {
  try {
    await emit(THEME_CHANGED_EVENT, payload)
  } catch {
    // 事件通道不可用时各子窗口仍会在下次创建时从 localStorage 读到正确主题
  }
}

/** 主窗口定向回复某个新窗口 */
export async function replyThemeTo(label: string, payload: ThemePayload): Promise<void> {
  try {
    await emitTo(label, THEME_CHANGED_EVENT, payload)
  } catch {
    // 窗口可能已销毁
  }
}

/** 订阅主题广播（所有窗口共用），返回取消订阅函数 */
export function listenThemeChanged(
  handler: (payload: ThemePayload) => void
): Promise<UnlistenFn> {
  return listen<ThemePayload>(THEME_CHANGED_EVENT, (event) => handler(event.payload))
}

/** 子窗口向主窗口索取当前主题 */
export async function requestTheme(): Promise<void> {
  try {
    await emitTo('main', THEME_REQUEST_EVENT, { label: currentWindowLabel() })
  } catch {
    // 主窗口不可达时沿用本地读到的主题
  }
}