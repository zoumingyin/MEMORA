import {
  currentMonitor,
  getCurrentWindow,
  type Window as TauriWindow,
} from '@tauri-apps/api/window'
import { PhysicalPosition, PhysicalSize, LogicalSize } from '@tauri-apps/api/dpi'
import { invoke } from '@tauri-apps/api/core'
import { isTauriRuntime } from '../repository'

/** 窗口可见矩形（客户区，物理像素）：桌面坐标 + 客户区尺寸。
 *  不含透明窗口那圈不可见阴影边框，贴边判定与落盘都用它，
 *  否则判定会把「还差一个边框宽度」当成已经贴边。 */
export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/** 主窗口设计最小/默认尺寸（对齐 tauri.conf.json）：小于最小值的边界视为异常
 *  （如历史收纳窄条 / 弹窗尺寸被误传），恢复时回退默认尺寸，避免恢复成窄条小窗 */
const APP_MIN_WIDTH = 422
const APP_MIN_HEIGHT = 540
const APP_DEFAULT_WIDTH = 422
const APP_DEFAULT_HEIGHT = 540

/** 窗口位置/尺寸持久化键：v2 —— 旧 v1 键曾被收纳窄条/弹窗尺寸污染，换键丢弃历史脏数据；
 *  无记录（首次启动）时按 tauri.conf.json 默认尺寸打开 */
const BOUNDS_STORAGE_KEY = 'bianqian.window.bounds.v2'

/**
 * 按窗口标签隔离的存储键：弹窗（闹钟/图片预览）与主窗口共用同一 origin 的
 * localStorage，固定键会被任何运行窗口逻辑的窗口互相覆盖；按 label 隔离，
 * 主窗口的恢复数据只由主窗口读写。
 */
function boundsKey(): string {
  try {
    return `${BOUNDS_STORAGE_KEY}.${getCurrentWindow().label}`
  } catch {
    return BOUNDS_STORAGE_KEY
  }
}

/** 保存窗口边界到本地存储（下次启动恢复用） */
export function saveBoundsToStorage(bounds: Bounds): void {
  try {
    localStorage.setItem(boundsKey(), JSON.stringify(bounds))
  } catch {
    // 存储不可用时静默跳过，不影响正常功能
  }
}

/** 读取上次保存的窗口边界；无记录或数据损坏返回 null */
export function loadBoundsFromStorage(): Bounds | null {
  try {
    const raw = localStorage.getItem(boundsKey())
    if (!raw) return null
    const parsed = JSON.parse(raw) as Bounds
    if (
      typeof parsed.x !== 'number' ||
      typeof parsed.y !== 'number' ||
      typeof parsed.width !== 'number' ||
      typeof parsed.height !== 'number'
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

/** 显示器可用工作区（已扣除任务栏等系统遮挡） */
export interface WorkArea {
  x: number
  y: number
  width: number
  height: number
}

let currentWindow: TauriWindow | null = null

function win(): TauriWindow {
  if (!currentWindow) currentWindow = getCurrentWindow()
  return currentWindow
}

/** 窗口置顶开关 */
export async function applyAlwaysOnTop(enabled: boolean): Promise<void> {
  if (!isTauriRuntime()) return
  await win().setAlwaysOnTop(enabled)
}

/** 读取当前窗口的可见矩形（客户区） */
export async function getBounds(): Promise<Bounds | null> {
  if (!isTauriRuntime()) return null
  const [position, size] = await Promise.all([
    win().innerPosition(),
    win().innerSize(),
  ])
  return { x: position.x, y: position.y, width: size.width, height: size.height }
}

/** 最近一次由本程序下发窗口位置/尺寸的时刻（毫秒） */
let lastProgrammaticBoundsAt = 0

/**
 * 窗口是否刚被本程序移动过。贴边收纳只看用户拖拽：悬停展开会把窗口放回贴边位置，
 * 这次移动同样触发 moved 事件，不区分的话刚展开就又被判定为「拖到边缘」而收回去。
 */
export function isProgrammaticMoveRecent(withinMs: number): boolean {
  return Date.now() - lastProgrammaticBoundsAt < withinMs
}

/** 移动窗口到物理坐标 (x, y)：外框（含不可见边框）口径，可见矩形请用 setBounds */
export async function setPosition(x: number, y: number): Promise<void> {
  if (!isTauriRuntime()) return
  lastProgrammaticBoundsAt = Date.now()
  await win().setPosition(new PhysicalPosition(Math.round(x), Math.round(y)))
}

/** 设置窗口物理尺寸（客户区尺寸） */
export async function setSize(width: number, height: number): Promise<void> {
  if (!isTauriRuntime()) return
  lastProgrammaticBoundsAt = Date.now()
  await win().setSize(
    new PhysicalSize(Math.round(width), Math.round(height)),
  )
}

/** 不可见边框的宽度（物理像素）：客户区左上角相对窗口左上角的偏移。
 *  透明窗口 + shadow 会在四周留一圈看不见的边框，占几到十几像素。
 *  读不到就按 0 处理：applyBounds 下发后会实测补偿，换算起点错不影响最终贴边。 */
async function getFrameInsets(): Promise<{ x: number; y: number }> {
  if (!isTauriRuntime()) return { x: 0, y: 0 }
  try {
    const [inner, outer] = await Promise.all([
      win().innerPosition(),
      win().outerPosition(),
    ])
    return { x: inner.x - outer.x, y: inner.y - outer.y }
  } catch {
    return { x: 0, y: 0 }
  }
}

/** 把可见矩形落到桌面上：尺寸本来就是客户区口径，位置要换算掉不可见边框。
 *  位置与尺寸必须单条 IPC 原子下发（Rust 侧一次 SetWindowPos）：分开 setSize/setPosition
 *  时两条消息先后落地，中间态窗口按左上角锚点放大——右侧/顶部收纳的贴边窗口会被
 *  甩出屏幕，钉在边缘的窄条闪没一帧再弹回（收纳展开时「小条闪烁」即由此而来）。 */
async function setBounds(
  bounds: Bounds,
  insets: { x: number; y: number },
): Promise<void> {
  lastProgrammaticBoundsAt = Date.now()
  await invoke('set_window_bounds', {
    x: Math.round(bounds.x - insets.x),
    y: Math.round(bounds.y - insets.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  })
}

const BOUNDS_SETTLE_MS = 120
const BOUNDS_TOLERANCE = 2
/** 下发后的复查轮数：首帧可能被系统拖拽循环忽略，边框换算误差也要一轮补偿 */
const BOUNDS_FIXUP_LIMIT = 3

/**
 * 把可见矩形真正落到目标位置并回读确认，返回是否落到位。
 * 边框宽度只用于给出换算起点：DPI、阴影实现都会让它偏离，所以每轮下发后实测——
 * 尺寸已到位而位置还偏，就把这个差值补进换算里再发一轮（窄条贴边靠它才不留缝）；
 * 尺寸都没变说明整段 SetWindowPos 被拖拽循环吞了，原样重发，不能拿假差值去污染补偿。
 */
export async function applyBounds(
  target: Bounds,
  settleMs: number = BOUNDS_SETTLE_MS,
): Promise<boolean> {
  const insets = await getFrameInsets()
  let dx = 0
  let dy = 0
  for (let i = 0; i < BOUNDS_FIXUP_LIMIT; i += 1) {
    try {
      await setBounds(
        {
          ...target,
          x: target.x - dx,
          y: target.y - dy,
        },
        insets,
      )
    } catch (error) {
      // IPC 失败按「未落位」处理：调用方（DockBar/expandIfDocked）会维持原状并回退钉住态，
      // 不能让异常逃出去变成未处理 rejection
      console.error('[window] 下发窗口矩形失败', error)
      return false
    }
    await new Promise((resolve) => window.setTimeout(resolve, settleMs))
    const after = await getBounds()
    if (!after) return false
    const sized =
      Math.abs(after.width - target.width) <= BOUNDS_TOLERANCE &&
      Math.abs(after.height - target.height) <= BOUNDS_TOLERANCE
    if (!sized) continue
    if (
      Math.abs(after.x - target.x) <= BOUNDS_TOLERANCE &&
      Math.abs(after.y - target.y) <= BOUNDS_TOLERANCE
    )
      return true
    dx = after.x - target.x
    dy = after.y - target.y
  }
  return false
}

/** 贴边收纳的几何诊断：一次性打印原生读到的内外框、工作区与缩放，用于定位贴边偏差 */
export async function logDockGeometry(
  tag: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  if (!isTauriRuntime()) return
  try {
    const w = win()
    const [innerPos, outerPos, innerSize, outerSize, monitor, scale] =
      await Promise.all([
        w.innerPosition(),
        w.outerPosition(),
        w.innerSize(),
        w.outerSize(),
        currentMonitor(),
        w.scaleFactor(),
      ])
    console.info(`[dock:${tag}]`, {
      inner: [innerPos.x, innerPos.y, innerSize.width, innerSize.height],
      outer: [outerPos.x, outerPos.y, outerSize.width, outerSize.height],
      workArea: monitor
        ? [
            monitor.workArea.position.x,
            monitor.workArea.position.y,
            monitor.workArea.size.width,
            monitor.workArea.size.height,
          ]
        : null,
      scale,
      ...extra,
    })
  } catch (error) {
    console.warn(`[dock:${tag}] 读取几何失败`, error)
  }
}

/** 设置/清空窗口最小尺寸约束（逻辑像素，对齐 tauri.conf.json）。
 *  收纳窄条要把窗口缩到 10px，必须先清空约束，否则 Windows 会按最小尺寸顶回；
 *  展开恢复时再设回来。 */
export async function setMinSizeConstraint(enabled: boolean): Promise<void> {
  if (!isTauriRuntime()) return
  try {
    await win().setMinSize(
      enabled ? new LogicalSize(APP_MIN_WIDTH, APP_MIN_HEIGHT) : null,
    )
  } catch (error) {
    console.error('调整窗口最小尺寸约束失败', error)
  }
}

/** 开关窗口投影：收纳窄条是贴边浮层，DWM 投影会让胶囊列看起来悬空发虚；
 *  收纳时关掉，展开恢复正常窗口时再开回来 */
export async function setShadowEnabled(enabled: boolean): Promise<void> {
  if (!isTauriRuntime()) return
  try {
    await win().setShadow(enabled)
  } catch (error) {
    console.error('切换窗口投影失败', error)
  }
}

/** 工作区缓存：显示器工作区极少变化，5 秒内复用，避免收纳/弹出时反复 IPC 查询 */
let workAreaCache: { area: WorkArea; at: number } | null = null

/** 当前显示器的可用工作区（扣除任务栏）；5 秒内走缓存 */
export async function currentWorkArea(): Promise<WorkArea | null> {
  if (!isTauriRuntime()) return null
  const now = Date.now()
  if (workAreaCache && now - workAreaCache.at < 5_000) return workAreaCache.area
  const monitor = await currentMonitor()
  if (!monitor) return null
  const area = {
    x: monitor.workArea.position.x,
    y: monitor.workArea.position.y,
    width: monitor.workArea.size.width,
    height: monitor.workArea.size.height,
  }
  workAreaCache = { area, at: now }
  return area
}

/** 订阅窗口移动，返回解绑函数 */
export async function onWindowMoved(
  handler: (bounds: Bounds) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) return () => undefined
  const unlisten = await win().onMoved(async () => {
    const bounds = await getBounds()
    if (bounds) handler(bounds)
  })
  return unlisten
}

/** 订阅窗口尺寸变化，返回解绑函数 */
export async function onWindowResized(
  handler: (bounds: Bounds) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) return () => undefined
  const unlisten = await win().onResized(async () => {
    const bounds = await getBounds()
    if (bounds) handler(bounds)
  })
  return unlisten
}

/** 最小化到任务栏 */
export async function minimizeWindow(): Promise<void> {
  if (!isTauriRuntime()) return
  await win().minimize()
}

/** 关闭主窗口 */
export async function closeWindow(): Promise<void> {
  if (!isTauriRuntime()) return
  await win().close()
}

/** 窗口是否处于最大化状态（最大化时跳过吸附，避免移动被 Windows 还原） */
export async function isMaximized(): Promise<boolean> {
  if (!isTauriRuntime()) return false
  try {
    return await win().isMaximized()
  } catch {
    return false
  }
}

/** 窗口是否处于最小化状态（最小化时 Windows 把窗口矩形挪到屏幕外并缩成窄条） */
export async function isMinimized(): Promise<boolean> {
  if (!isTauriRuntime()) return false
  try {
    return await win().isMinimized()
  } catch {
    return false
  }
}

/** 边界是否值得落盘：最小化矩形的典型值是屏幕外坐标 + 几十像素高，保存后下次启动会恢复成异常窗口 */
export function isStorableBounds(bounds: Bounds): boolean {
  return (
    bounds.width >= 100 &&
    bounds.height >= 100 &&
    bounds.x > -10_000 &&
    bounds.y > -10_000
  )
}

/**
 * 主窗口可用性兜底：最小化后 show() 仍停在屏幕外的窄条矩形，必须 unminimize；
 * 若还原出的边界异常（最小化期间被吸附/落盘的脏数据）则钳回当前工作区。
 * 托盘 / 全局快捷键 / 导出图片等唤起路径调用。
 */
export async function ensureWindowVisible(): Promise<void> {
  if (!isTauriRuntime()) return
  const window = win()
  const minimized = await window.isMinimized().catch(() => false)
  if (minimized) await window.unminimize()
  const bounds = await getBounds()
  if (bounds && !isStorableBounds(bounds)) {
    await restoreBounds(bounds)
  }
  if (minimized) {
    await window.show()
    await window.setFocus()
  }
}

/** 恢复窗口到指定边界（物理坐标与尺寸）；尺寸与位置并行下发，减少展开/收回的串行等待。
 *  对越界/超大边界做工作区钳制：若保存的边界来自最大化状态（全屏尺寸）或显示器变化
 *  （屏幕外坐标），恢复时收缩/移回可见区域，避免透明窗口恢复成异常尺寸后不显示。
 *  边界一步到位、不做逐帧补间：尺寸与位置是两次独立 IPC，且中间宽度会触发界面重排，
 *  按帧下发表现为抖动；过渡动效改由内容层的 CSS 动画承担。
 *  返回窗口是否真的撑到了目标尺寸——调用方据此决定要不要把主界面换上去。 */
export async function restoreBounds(
  bounds: Bounds,
  settleMs: number = BOUNDS_SETTLE_MS,
): Promise<boolean> {
  let b = bounds
  // 异常尺寸兜底：历史数据可能被写入窄条/弹窗尺寸，小于设计最小值时回退默认尺寸
  if (b.width < APP_MIN_WIDTH || b.height < APP_MIN_HEIGHT) {
    b = { ...b, width: APP_DEFAULT_WIDTH, height: APP_DEFAULT_HEIGHT }
  }
  const area = await currentWorkArea()
  if (area) {
    const width = Math.min(Math.max(b.width, 320), area.width)
    const height = Math.min(Math.max(b.height, 240), area.height)
    const x = Math.min(Math.max(b.x, area.x), area.x + area.width - width)
    const y = Math.min(Math.max(b.y, area.y), area.y + area.height - height)
    b = { x, y, width, height }
  }
  // 先撑尺寸再设回最小约束：反过来的话，保存的尺寸只要比「逻辑最小值 × 当前缩放」
  // 小一两像素就会被 WM_GETMINMAXINFO 顶住，applyBounds 永远回读不到目标尺寸
  const settled = await applyBounds(b, settleMs)
  await setMinSizeConstraint(true)
  // 窗口恢复正常尺寸后重新开启投影；展开失败（未撑开）时保持无投影，与窄条视觉一致
  if (settled) await setShadowEnabled(true)
  return settled
}
