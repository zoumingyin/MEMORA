import {
  currentMonitor,
  getCurrentWindow,
  type Window as TauriWindow,
} from '@tauri-apps/api/window'
import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi'
import { isTauriRuntime } from '../repository'

/** 窗口物理边界（坐标均为物理像素） */
export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/** 窗口位置/尺寸持久化键：异常退出后重启恢复上次窗口形态 */
const BOUNDS_STORAGE_KEY = 'bianqian.window.bounds.v1'

/** 保存窗口边界到本地存储（异常恢复用） */
export function saveBoundsToStorage(bounds: Bounds): void {
  try {
    localStorage.setItem(BOUNDS_STORAGE_KEY, JSON.stringify(bounds))
  } catch {
    // 存储不可用时静默跳过，不影响正常功能
  }
}

/** 读取上次保存的窗口边界；无记录或数据损坏返回 null */
export function loadBoundsFromStorage(): Bounds | null {
  try {
    const raw = localStorage.getItem(BOUNDS_STORAGE_KEY)
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

/** 读取当前窗口位置与尺寸 */
export async function getBounds(): Promise<Bounds | null> {
  if (!isTauriRuntime()) return null
  const [position, size] = await Promise.all([
    win().outerPosition(),
    win().outerSize(),
  ])
  return { x: position.x, y: position.y, width: size.width, height: size.height }
}

/** 移动窗口到物理坐标 (x, y) */
export async function setPosition(x: number, y: number): Promise<void> {
  if (!isTauriRuntime()) return
  await win().setPosition(new PhysicalPosition(Math.round(x), Math.round(y)))
}

/** 设置窗口物理尺寸 */
export async function setSize(width: number, height: number): Promise<void> {
  if (!isTauriRuntime()) return
  await win().setSize(
    new PhysicalSize(Math.round(width), Math.round(height)),
  )
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

/** 恢复窗口到指定边界（物理坐标与尺寸）；尺寸与位置并行下发，减少展开/收回的串行等待。
 *  对越界/超大边界做工作区钳制：若保存的边界来自最大化状态（全屏尺寸）或显示器变化
 *  （屏幕外坐标），恢复时收缩/移回可见区域，避免透明窗口恢复成异常尺寸后不显示。 */
export async function restoreBounds(bounds: Bounds): Promise<void> {
  let b = bounds
  const area = await currentWorkArea()
  if (area) {
    const width = Math.min(Math.max(b.width, 320), area.width)
    const height = Math.min(Math.max(b.height, 240), area.height)
    const x = Math.min(
      Math.max(b.x, area.x),
      area.x + area.width - width,
    )
    const y = Math.min(
      Math.max(b.y, area.y),
      area.y + area.height - height,
    )
    b = { x, y, width, height }
  }
  await Promise.all([
    setSize(b.width, b.height),
    setPosition(b.x, b.y),
  ])
}
