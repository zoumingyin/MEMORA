import { create } from 'zustand'

/** 窄屏列表展示模式：网格 / 列表（宽屏固定贴纸墙，不使用该偏好） */
export type EntryViewMode = 'grid' | 'list'

/** 贴纸墙自由摆放坐标（相对画布左上角，单位 px） */
export interface WallPosition {
  x: number
  y: number
}

const ENTRY_VIEW_KEY = 'bianqian.entryView.v1'
/** 贴纸墙自由摆放坐标（按条目 id 保存，跨启动恢复） */
const WALL_POSITIONS_KEY = 'bianqian.wallPositions.v1'
/** 置顶条目（按 id 保存；贴纸墙红点即置顶标记） */
const PINNED_KEY = 'bianqian.pinned.v1'

function loadEntryView(): EntryViewMode {
  try {
    return localStorage.getItem(ENTRY_VIEW_KEY) === 'list' ? 'list' : 'grid'
  } catch {
    return 'grid'
  }
}

function persistEntryView(view: EntryViewMode): void {
  try {
    localStorage.setItem(ENTRY_VIEW_KEY, view)
  } catch {
    // 存储不可用时静默跳过
  }
}

function loadWallPositions(): Record<string, WallPosition> {
  try {
    const raw = localStorage.getItem(WALL_POSITIONS_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const result: Record<string, WallPosition> = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const { x, y } = value as Partial<WallPosition>
      if (typeof x === 'number' && typeof y === 'number' && isFinite(x) && isFinite(y)) {
        result[id] = { x, y }
      }
    }
    return result
  } catch {
    return {}
  }
}

function persistWallPositions(positions: Record<string, WallPosition>): void {
  try {
    localStorage.setItem(WALL_POSITIONS_KEY, JSON.stringify(positions))
  } catch {
    // 存储不可用时静默跳过
  }
}

function loadPinnedIds(): string[] {
  try {
    const raw = localStorage.getItem(PINNED_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string')
      : []
  } catch {
    return []
  }
}

function persistPinnedIds(ids: string[]): void {
  try {
    localStorage.setItem(PINNED_KEY, JSON.stringify(ids))
  } catch {
    // 存储不可用时静默跳过
  }
}

/** 跨组件界面状态：设置弹窗由标题栏渲染，AI 面板等入口可请求定位到指定设置页 */
interface UiState {
  settingsOpen: boolean
  /** 打开设置时定位的叶子节点 key（如 'ai-config'） */
  settingsSection: string | null
  /** 窄屏列表展示模式（持久化，宽屏切回窄屏时恢复用户选择） */
  entryView: EntryViewMode
  /** 贴纸墙自由摆放坐标；无记录 = 按默认网格铺开 */
  wallPositions: Record<string, WallPosition>
  /** 置顶条目的 id 列表：排序时置顶在前 */
  pinnedIds: string[]
  openSettings: (section?: string) => void
  closeSettings: () => void
  setEntryView: (view: EntryViewMode) => void
  setWallPosition: (id: string, position: WallPosition) => void
  clearWallPosition: (id: string) => void
  clearWallPositions: () => void
  togglePinned: (id: string) => void
}

export const useUiStore = create<UiState>((set) => ({
  settingsOpen: false,
  settingsSection: null,
  entryView: loadEntryView(),
  wallPositions: loadWallPositions(),
  pinnedIds: loadPinnedIds(),
  openSettings: (section) => set({ settingsOpen: true, settingsSection: section ?? null }),
  closeSettings: () => set({ settingsOpen: false, settingsSection: null }),
  setEntryView: (view) => {
    set({ entryView: view })
    persistEntryView(view)
  },
  setWallPosition: (id, position) => {
    set((state) => {
      const wallPositions = { ...state.wallPositions, [id]: position }
      persistWallPositions(wallPositions)
      return { wallPositions }
    })
  },
  clearWallPosition: (id) => {
    set((state) => {
      if (!(id in state.wallPositions)) return state
      const wallPositions = { ...state.wallPositions }
      delete wallPositions[id]
      persistWallPositions(wallPositions)
      return { wallPositions }
    })
  },
  clearWallPositions: () => {
    set({ wallPositions: {} })
    persistWallPositions({})
  },
  togglePinned: (id) => {
    set((state) => {
      const pinnedIds = state.pinnedIds.includes(id)
        ? state.pinnedIds.filter((pinnedId) => pinnedId !== id)
        : [...state.pinnedIds, id]
      persistPinnedIds(pinnedIds)
      return { pinnedIds }
    })
  },
}))
