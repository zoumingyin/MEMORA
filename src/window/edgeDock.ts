import {
  currentWorkArea,
  getBounds,
  isMaximized,
  isMinimized,
  setPosition,
  setSize,
  type Bounds,
  type WorkArea,
} from './tauriWindow'

export type DockEdge = 'left' | 'right' | 'top'

/** 距屏幕边缘多少像素内判定为贴近，触发吸附 */
export const DOCK_THRESHOLD = 16
/** 收纳后边缘窄条的厚度（物理像素） */
export const STRIP_THICKNESS = 10

/** 判断当前窗口贴近哪条边缘，未贴近返回 null */
export function detectDockEdge(
  bounds: Bounds,
  workArea: WorkArea,
): DockEdge | null {
  if (bounds.x - workArea.x <= DOCK_THRESHOLD) return 'left'
  if (workArea.x + workArea.width - (bounds.x + bounds.width) <= DOCK_THRESHOLD)
    return 'right'
  if (bounds.y - workArea.y <= DOCK_THRESHOLD) return 'top'
  return null
}

/** 吸附对齐：尺寸不变，把窗口贴齐对应边缘；已贴边则短路，避免重复移动事件触发回拉 */
export async function snapToEdge(
  edge: DockEdge,
  bounds: Bounds,
  workArea: WorkArea,
): Promise<void> {
  let x = bounds.x
  let y = bounds.y
  if (edge === 'left') {
    x = workArea.x
  } else if (edge === 'right') {
    x = workArea.x + workArea.width - bounds.width
  } else if (edge === 'top') {
    y = workArea.y
  }
  if (Math.abs(x - bounds.x) < 2 && Math.abs(y - bounds.y) < 2) return
  await setPosition(Math.round(x), Math.round(y))
}

/** 收纳为边缘窄条；收纳前的边界由调用方保存，供展开恢复。尺寸与位置并行下发，减少收回等待 */
export async function collapseToStrip(
  edge: DockEdge,
  bounds: Bounds,
  workArea: WorkArea,
): Promise<void> {
  if (edge === 'left') {
    await Promise.all([
      setSize(STRIP_THICKNESS, bounds.height),
      setPosition(workArea.x, bounds.y),
    ])
  } else if (edge === 'right') {
    await Promise.all([
      setSize(STRIP_THICKNESS, bounds.height),
      setPosition(workArea.x + workArea.width - STRIP_THICKNESS, bounds.y),
    ])
  } else {
    await Promise.all([
      setSize(bounds.width, STRIP_THICKNESS),
      setPosition(bounds.x, workArea.y),
    ])
  }
}

export interface SnapResult {
  edge: DockEdge
  bounds: Bounds
}

/**
 * 拖拽结束后的自动吸附：贴近边缘则对齐停靠，返回停靠边缘与边界。
 * 吸附开关关闭时不调用。由窗口移动事件防抖触发，避免读到拖动中的旧坐标。
 */
export async function autoSnapIfNearEdge(): Promise<SnapResult | null> {
  // 最大化状态下不做任何吸附/移动：最大化窗口被 setPosition 会被 Windows 立即还原，
  // 双击标题栏最大化后「马上变回来」即由此路径引发
  if (await isMaximized()) return null
  // 最小化窗口矩形在屏幕外（如 -25600,-25600），会被误判为贴左边并吸附，
  // 把窗口的正常位置改写成一个屏幕外的坏坐标
  if (await isMinimized()) return null
  const bounds = await getBounds()
  const workArea = await currentWorkArea()
  if (!bounds || !workArea) return null
  const edge = detectDockEdge(bounds, workArea)
  if (!edge) return null
  await snapToEdge(edge, bounds, workArea)
  return { edge, bounds }
}
