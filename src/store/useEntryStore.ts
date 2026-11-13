import { create } from 'zustand'
import type { AlarmItem, Entry, EntryKind, NewEntryInput, TodoItem } from '../types/entry'
import { getRepository } from '../repository'

/** 界面状态持久化键：异常退出/重启后恢复上次筛选、选中条目与默认分类 */
const UI_STORAGE_KEY = 'bianqian.ui.v1'

interface PersistedUI {
  currentKind: EntryKind
  filter: 'all' | EntryKind
  selectedId: string | null
  /** 左侧视图：列表 / 日历 */
  view: 'list' | 'calendar'
}

function loadPersistedUI(): PersistedUI | null {
  try {
    const raw = localStorage.getItem(UI_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PersistedUI
    if (
      (parsed.filter !== 'all' &&
        parsed.filter !== 'note' &&
        parsed.filter !== 'reminder' &&
        parsed.filter !== 'todo' &&
        parsed.filter !== 'draw') ||
      (parsed.currentKind !== 'note' &&
        parsed.currentKind !== 'reminder' &&
        parsed.currentKind !== 'todo' &&
        parsed.currentKind !== 'draw')
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function persistUI(ui: PersistedUI): void {
  try {
    localStorage.setItem(UI_STORAGE_KEY, JSON.stringify(ui))
  } catch {
    // 存储不可用时静默跳过
  }
}
interface EntryState {
  /** 新建条目时的默认分类（点「+」新建时使用；filter 为 all 时生效） */
  currentKind: EntryKind
  /** 左侧列表筛选：全部 / 备忘 / 提醒 / 待办 / 涂鸦 */
  filter: 'all' | EntryKind
  /** 右侧详情当前选中的条目 id（可由提醒弹窗「进入便签」跳转设置） */
  selectedId: string | null
  entries: Entry[]
  initialized: boolean
  loading: boolean
  /** 全局搜索关键词：匹配标题与正文全文 */
  search: string
  /** 标签筛选：null=全部标签 */
  tagFilter: string | null
  /** 时间范围（按更新时间）：全部 / 今天 / 近 7 天 / 近 30 天 */
  timeRange: 'all' | 'today' | '7d' | '30d'
  /** 列表排序：最近编辑（更新时间）/ 创建时间 */
  sortBy: 'updated' | 'created'
  /** 左侧视图：列表（搜索+分类筛选） / 日历（月历打点+当日条目） */
  view: 'list' | 'calendar'
  setCurrentKind: (kind: EntryKind) => void
  setFilter: (filter: 'all' | EntryKind) => void
  setSelectedId: (id: string | null) => void
  setSearch: (query: string) => void
  setTagFilter: (tag: string | null) => void
  setTimeRange: (range: 'all' | 'today' | '7d' | '30d') => void
  setSortBy: (sort: 'updated' | 'created') => void
  setView: (view: 'list' | 'calendar') => void
  loadAll: () => Promise<void>
  addEntry: (input: NewEntryInput, kind?: EntryKind) => Promise<Entry | null>
  /** 批量导入（数据导入）：按 id 合并，返回实际新增条数 */
  importEntries: (entries: Entry[]) => Promise<number>
  toggleTodo: (id: string) => Promise<void>
  toggleReminderDone: (id: string) => Promise<void>
  /** 废纸篓内容（软删除条目，按删除时间倒序） */
  trash: Entry[]
  loadTrash: () => Promise<void>
  /** 删除 = 移入废纸篓（软删除），可从废纸篓恢复或彻底删除 */
  moveToTrash: (id: string) => Promise<void>
  restoreEntry: (id: string) => Promise<void>
  purgeEntry: (id: string) => Promise<void>
  emptyTrash: () => Promise<void>
  updateEntry: (id: string, patch: Partial<Entry>) => Promise<void>
  markNotified: (id: string) => Promise<void>
  /** 标记某条提醒下的单个闹钟已通知（按闹钟 id） */
  markAlarmNotified: (entryId: string, alarmId: string) => Promise<void>
}

export const useEntryStore = create<EntryState>((set, get) => ({
  currentKind: 'note',
  filter: 'all',
  selectedId: null,
  entries: [],
  initialized: false,
  loading: false,
  search: '',
  tagFilter: null,
  timeRange: 'all',
  sortBy: 'updated',
  view: 'list',

  setCurrentKind: (kind) => {
    set({ currentKind: kind })
    persistUI({
      currentKind: kind,
      filter: get().filter,
      selectedId: get().selectedId,
      view: get().view,
    })
  },
  setFilter: (filter) => {
    set({ filter })
    persistUI({
      currentKind: get().currentKind,
      filter,
      selectedId: get().selectedId,
      view: get().view,
    })
  },
  setSelectedId: (id) => {
    set({ selectedId: id })
    persistUI({
      currentKind: get().currentKind,
      filter: get().filter,
      selectedId: id,
      view: get().view,
    })
  },
  setSearch: (query) => set({ search: query }),
  setTagFilter: (tag) => set({ tagFilter: tag }),
  setTimeRange: (range) => set({ timeRange: range }),
  setSortBy: (sort) => set({ sortBy: sort }),
  setView: (view) => {
    set({ view })
    persistUI({
      currentKind: get().currentKind,
      filter: get().filter,
      selectedId: get().selectedId,
      view,
    })
  },
  loadAll: async () => {
    if (get().loading) return
    set({ loading: true })
    try {
      const entries = await getRepository().listAll()
      set({ entries, initialized: true, loading: false })
      // 异常恢复：数据就绪后恢复上次筛选/默认分类/选中条目（选中须仍存在，否则回落第一条由视图层处理）
      const persisted = loadPersistedUI()
      if (persisted) {
        const selectedStillExists = persisted.selectedId
          ? entries.some((entry) => entry.id === persisted.selectedId)
          : false
        set({
          currentKind: persisted.currentKind,
          filter: persisted.filter,
          selectedId: selectedStillExists ? persisted.selectedId : null,
          view: persisted.view === 'calendar' ? 'calendar' : 'list',
        })
      }
    } catch (error) {
      console.error('加载条目失败', error)
      set({ loading: false })
    }
  },

  addEntry: async (input, kind) => {
    const targetKind = kind ?? get().currentKind
    try {
      const entry = await getRepository().create(targetKind, input)
      set((state) => ({ entries: [entry, ...state.entries] }))
      return entry
    } catch (error) {
      console.error('新增条目失败', error)
      return null
    }
  },

  importEntries: async (entries) => {
    try {
      const imported = await getRepository().importAll(entries)
      if (imported > 0) await get().loadAll()
      return imported
    } catch (error) {
      console.error('批量导入失败', error)
      return 0
    }
  },
  toggleTodo: async (id) => {
    const target = get().entries.find((entry) => entry.id === id)
    if (!target || target.kind !== 'todo') return
    const done = !target.done
    try {
      await getRepository().update(id, { kind: 'todo', done })
      set((state) => ({
        entries: state.entries.map((entry) =>
          entry.id === id && entry.kind === 'todo'
            ? { ...entry, done, completedAt: done ? Date.now() : null }
            : entry,
        ),
      }))
    } catch (error) {
      console.error('更新待办状态失败', error)
    }
  },

  toggleReminderDone: async (id) => {
    const target = get().entries.find((entry) => entry.id === id)
    if (!target || target.kind !== 'reminder') return
    const done = !target.done
    // 「标记已处理」＝整条所有闹钟一并标记已通知；恢复处理则全部重新纳入调度
    const alarms = target.alarms.map((alarm) => ({ ...alarm, notified: done }))
    try {
      await getRepository().update(id, { kind: 'reminder', done, alarms })
      set((state) => ({
        entries: state.entries.map((entry) =>
          entry.id === id && entry.kind === 'reminder'
            ? { ...entry, done, alarms, notified: done }
            : entry,
        ),
      }))
    } catch (error) {
      console.error('更新提醒状态失败', error)
    }
  },

  trash: [],

  loadTrash: async () => {
    try {
      const trash = await getRepository().listTrash()
      set({ trash })
    } catch (error) {
      console.error('加载废纸篓失败', error)
    }
  },

  moveToTrash: async (id) => {
    const target = get().entries.find((entry) => entry.id === id)
    try {
      await getRepository().moveToTrash(id)
      set((state) => ({
        entries: state.entries.filter((entry) => entry.id !== id),
        // 本地先补 deletedAt，无需重新拉取即可在废纸篓视图立即可见
        trash: target
          ? [{ ...target, deletedAt: Date.now() }, ...state.trash]
          : state.trash,
      }))
    } catch (error) {
      console.error('移入废纸篓失败', error)
    }
  },

  restoreEntry: async (id) => {
    try {
      await getRepository().restore(id)
      set((state) => ({ trash: state.trash.filter((entry) => entry.id !== id) }))
      // 恢复后重新拉取主列表（恢复条目可能落在任意分类）
      await get().loadAll()
    } catch (error) {
      console.error('从废纸篓恢复失败', error)
    }
  },

  purgeEntry: async (id) => {
    try {
      await getRepository().purge(id)
      set((state) => ({ trash: state.trash.filter((entry) => entry.id !== id) }))
    } catch (error) {
      console.error('彻底删除条目失败', error)
    }
  },

  emptyTrash: async () => {
    try {
      await getRepository().emptyTrash()
      set({ trash: [] })
    } catch (error) {
      console.error('清空废纸篓失败', error)
    }
  },

  updateEntry: async (id, patch) => {
    const target = get().entries.find((entry) => entry.id === id)
    if (!target) return
    // 仓储按 patch.kind 判别写列，这里补全条目自身类型，避免调用方漏传
    const normalized = { ...patch, kind: target.kind } as Partial<Entry>
    // 待办子任务变更时同步派生整条完成态，保证界面与数据库一致
    if (target.kind === 'todo' && Array.isArray((normalized as { items?: TodoItem[] }).items)) {
      const items = (normalized as { items: TodoItem[] }).items
      const allDone = items.length > 0 && items.every((item) => item.done)
      ;(normalized as { done?: boolean }).done = allDone
      ;(normalized as { completedAt?: number | null }).completedAt = allDone
        ? target.completedAt ?? Date.now()
        : null
    }
    // 提醒条目改闹钟清单时同步派生条目级 remind_at（最近一个未通知闹钟），供列表排序与显示；清空清单时保留原值
    if (target.kind === 'reminder' && Array.isArray((normalized as { alarms?: AlarmItem[] }).alarms)) {
      const alarms = (normalized as { alarms: AlarmItem[] }).alarms
      if (alarms.length > 0) {
        const pending = alarms.filter((alarm) => !alarm.notified)
        ;(normalized as { remindAt?: number }).remindAt = pending.length
          ? Math.min(...pending.map((alarm) => alarm.remindAt))
          : Math.min(...alarms.map((alarm) => alarm.remindAt))
      }
    }
    try {
      await getRepository().update(id, normalized)
      set((state) => ({
        entries: state.entries.map((entry) => {
          if (entry.id !== id) return entry
          return { ...entry, ...normalized, updatedAt: Date.now() } as Entry
        }),
      }))
    } catch (error) {
      console.error('更新条目失败', error)
    }
  },

  markNotified: async (id) => {
    try {
      await getRepository().markNotified(id)
      set((state) => ({
        entries: state.entries.map((entry) =>
          entry.id === id && entry.kind === 'reminder' ? { ...entry, notified: true } : entry,
        ),
      }))
    } catch (error) {
      console.error('更新提醒通知状态失败', error)
    }
  },

  markAlarmNotified: async (entryId, alarmId) => {
    try {
      await getRepository().markAlarmNotified(entryId, alarmId)
      set((state) => ({
        entries: state.entries.map((entry) => {
          if (entry.id !== entryId || entry.kind !== 'reminder') return entry
          const alarms = entry.alarms.map((alarm) =>
            alarm.id === alarmId && !alarm.notified ? { ...alarm, notified: true } : alarm,
          )
          const allNotified = alarms.length > 0 && alarms.every((alarm) => alarm.notified)
          return { ...entry, alarms, notified: allNotified ? true : entry.notified }
        }),
      }))
    } catch (error) {
      console.error('更新闹钟通知状态失败', error)
    }
  },
}))
