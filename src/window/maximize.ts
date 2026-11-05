import { getCurrentWindow } from '@tauri-apps/api/window'
import { isTauriRuntime } from '../repository'
import {
  applyBounds,
  currentWorkArea,
  getBounds,
  isMaximized,
  restoreBounds,
  type Bounds,
  type WorkArea,
} from './tauriWindow'

/** 伪最大化判定容差（物理像素）：矩形盖住工作区即视为最大化态 */
const PSEUDO_MAX_TOLERANCE = 8

/** 还原矩形持久化键：双击最大化前把当前矩形存这里，双击还原时恢复 */
const PRE_MAX_BOUNDS_KEY = 'bianqian.window.preMaxBounds.v1'

/** 还原矩形缺失时的兜底尺寸（对齐 tauri.conf.json 默认窗口大小） */
const DEFAULT_WIDTH = 422
const DEFAULT_HEIGHT = 540

/** 按窗口标签隔离存储键（与 tauriWindow boundsKey 同一套口径） */
function preMaxBoundsKey(): string {
  try {
    return `${PRE_MAX_BOUNDS_KEY}.${getCurrentWindow().label}`
  } catch {
    return PRE_MAX_BOUNDS_KEY
  }
}

function savePreMaxBounds(bounds: Bounds): void {
  try {
    localStorage.setItem(preMaxBoundsKey(), JSON.stringify(bounds))
  } catch {
    // 存储不可用时静默跳过，不影响切换功能
  }
}

function loadPreMaxBounds(): Bounds | null {
  try {
    const raw = localStorage.getItem(preMaxBoundsKey())
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

/**
 * 窗口是否处于「伪最大化」态：可见矩形盖满当前工作区。
 * 本应用透明窗口进入 OS 最大化态会渲染空白（tauri.conf.json 因此 maximizable:false，
 * App.tsx 启动时也有还原防御），「最大化」用程序化撑满工作区代替——
 * 该口径供调用方跳过边界落盘，避免把撑满尺寸写进启动恢复存储。
 */
export function isPseudoMaximized(bounds: Bounds, area: WorkArea): boolean {
  return (
    bounds.width >= area.width - PSEUDO_MAX_TOLERANCE &&
    bounds.height >= area.height - PSEUDO_MAX_TOLERANCE &&
    bounds.x <= area.x + PSEUDO_MAX_TOLERANCE &&
    bounds.y <= area.y + PSEUDO_MAX_TOLERANCE
  )
}

/**
 * 双击标题栏的「最大化 / 还原」：
 * - 最大化：记住当前矩形后，程序化撑满工作区（不进 OS 最大化态，避开透明窗口渲染 bug）；
 * - 还原：恢复记住的矩形；无记录时回退默认尺寸 422×540。
 * 返回切换结果；窗口信息不可读（非 Tauri 环境等）返回 null。
 */
export async function toggleMaximize(): Promise<'max' | 'restore' | null> {
  if (!isTauriRuntime()) return null

  // 异常兜底：窗口若已处于 OS 最大化态（历史遗留场景），先还原退出该态
  if (await isMaximized().catch(() => false)) {
    await getCurrentWindow().unmaximize()
    return 'restore'
  }

  const [bounds, area] = await Promise.all([getBounds(), currentWorkArea()])
  if (!bounds || !area) return null

  if (isPseudoMaximized(bounds, area)) {
    // 最大化 → 还原：优先恢复记住的矩形；无记录时回退默认尺寸，
    // restoreBounds 负责工作区钳制与最小约束恢复
    const preMax =
      loadPreMaxBounds() ?? {
        x: bounds.x + Math.round((area.width - DEFAULT_WIDTH) / 2),
        y: bounds.y + Math.round((area.height - DEFAULT_HEIGHT) / 3),
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
      }
    const settled = await restoreBounds(preMax)
    return settled ? 'restore' : null
  }

  // 还原 → 最大化：记住当前矩形，撑满工作区（单条 SetWindowPos 原子下发）
  savePreMaxBounds(bounds)
  const settled = await applyBounds({
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
  })
  // 撑窗失败时不保留还原记录：下次双击仍按普通窗口处理
  if (!settled) return null
  return 'max'
}
