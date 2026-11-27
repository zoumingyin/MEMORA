import { create } from 'zustand'
import type { AlarmItem, Entry, EntryKind, NewEntryInput, TodoItem } from '../types/entry'
import { getRepository } from '../repository'
import { DatabaseUnavailableError, EntryWriteError, isEntryWriteError } from '../repository/errors'
import type { DbGateStatus } from '../repository/db'
import { nextAlarmAt, occurrenceKey } from '../reminder/nextAlarm'

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

export interface LoadErrorInfo {
  type: string
  message: string
  at: number
}

export interface ReminderIssue {
  id: string
  entryId: string
  alarmId: string
  message: string
  at: number
}

function toWriteError(error: unknown): EntryWriteError {
  if (isEntryWriteError(error)) return error
  const message = error instanceof Error ? error.message : String(error)
  return new EntryWriteError('io', message)
}

interface EntryState {
  currentKind: EntryKind
  filter: 'all' | EntryKind
  selectedId: string | null
  entries: Entry[]
  initialized: boolean
  loading: boolean
  /** 最近一次加载失败：界面展示错误与重试，不把失败当空列表 */
  loadError: LoadErrorInfo | null
  /** 数据库只读保护/不可用信息：存在时展示故障页，禁止写入 */
  dbFault: DbGateStatus | null
  /** 提醒触达失败/降级记录（应用内可见） */
  reminderIssues: ReminderIssue[]
  search: string
  tagFilter: string | null
  timeRange: 'all' | 'today' | '7d' | '30d'
  sortBy: 'updated' | 'created'
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
  retryLoad: () => Promise<void>
  addEntry: (input: NewEntryInput, kind?: EntryKind) => Promise<Entry | null>
  importEntries: (entries: Entry[]) => Promise<number>
  toggleTodo: (id: string) => Promise<void>
  toggleReminderDone: (id: string) => Promise<void>
  trash: Entry[]
  loadTrash: () => Promise<void>
  moveToTrash: (id: string) => Promise<void>
  restoreEntry: (id: string) => Promise<void>
  purgeEntry: (id: string) => Promise<void>
  /** 清理废纸篓中 deletedAt 超过保留期的条目，返回清理数量（启动时自动执行） */
  purgeExpiredTrash: (retentionDays: number) => Promise<number>
  emptyTrash: () => Promise<void>
  updateEntry: (id: string, patch: Partial<Entry>, expectedVersion?: number) => Promise<Entry>
  markNotified: (id: string) => Promise<void>
  markAlarmNotified: (entryId: string, alarmId: string) => Promise<void>
  /** 确认一次到期：单次标记已处理；重复模式在同一事务内推进到下一次 */
  confirmAlarm: (entryId: string, alarmId: string) => Promise<Entry>
  /** 稍后提醒：把单个闹钟推到新时间并重置投递状态 */
  snoozeAlarm: (entryId: string, alarmId: string, remindAt: number) => Promise<Entry>
  /** 记录一次自动呈现（仅诊断，不承诺 exactly-once） */
  presentAlarm: (entryId: string, alarmId: string) => Promise<void>
  /** 记录触达失败：不标记已处理，按冷却重试 */
  recordAlarmFailure: (entryId: string, alarmId: string, message: string) => Promise<void>
  reportReminderIssue: (issue: Omit<ReminderIssue, 'id' | 'at'>) => void
  clearReminderIssues: () => void
}

export const useEntryStore = create<EntryState>((set, get) => ({
  currentKind: 'note',
  filter: 'all',
  selectedId: null,
  entries: [],
  initialized: false,
  loading: false,
  loadError: null,
  dbFault: null,
  reminderIssues: [],
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
      set({
        entries,
        initialized: true,
        loading: false,
        loadError: null,
        dbFault: null,
      })
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
      if (error instanceof DatabaseUnavailableError) {
        set({
          loading: false,
          dbFault: {
            status: 'readonly',
            errorType: error.errorType,
            message: error.message,
            dbPath: error.dbPath,
            schemaVersion: 0,
            migrationPending: false,
            preMigrationBackup: null,
          },
          loadError: { type: error.errorType, message: error.message, at: Date.now() },
        })
      } else {
        set({
          loading: false,
          loadError: {
            type: 'load_failed',
            message: error instanceof Error ? error.message : String(error),
            at: Date.now(),
          },
        })
      }
    }
  },

  retryLoad: async () => {
    set({ loadError: null })
    await get().loadAll()
  },

  addEntry: async (input, kind) => {
    const targetKind = kind ?? get().currentKind
    try {
      const entry = await getRepository().create(targetKind, input)
      set((state) => ({ entries: [entry, ...state.entries] }))
      return entry
    } catch (error) {
      console.error('新增条目失败', error)
      throw toWriteError(error)
    }
  },

  importEntries: async (entries) => {
    try {
      const imported = await getRepository().importAll(entries)
      if (imported > 0) await get().loadAll()
      return imported
    } catch (error) {
      console.error('批量导入失败', error)
      throw toWriteError(error)
    }
  },

  toggleTodo: async (id) => {
    const target = get().entries.find((entry) => entry.id === id)
    if (!target || target.kind !== 'todo') return
    const done = !target.done
    const stored = await get().updateEntry(id, { kind: 'todo', done }, target.version)
    void stored
  },

  toggleReminderDone: async (id) => {
    const target = get().entries.find((entry) => entry.id === id)
    if (!target || target.kind !== 'reminder') return
    const done = !target.done
    const alarms = target.alarms.map((alarm) => ({ ...alarm, notified: done }))
    await get().updateEntry(
      id,
      { kind: 'reminder', done, alarms, notified: done },
      target.version,
    )
  },

  trash: [],

  loadTrash: async () => {
    try {
      const trash = await getRepository().listTrash()
      set({ trash })
    } catch (error) {
      console.error('加载废纸篓失败', error)
      set({
        loadError: {
          type: 'trash_load_failed',
          message: error instanceof Error ? error.message : String(error),
          at: Date.now(),
        },
      })
    }
  },

  moveToTrash: async (id) => {
    const target = get().entries.find((entry) => entry.id === id)
    try {
      await getRepository().moveToTrash(id)
      set((state) => ({
        entries: state.entries.filter((entry) => entry.id !== id),
        trash: target
          ? [{ ...target, deletedAt: Date.now(), version: target.version + 1 }, ...state.trash]
          : state.trash,
      }))
    } catch (error) {
      console.error('移入废纸篓失败', error)
      throw toWriteError(error)
    }
  },

  restoreEntry: async (id) => {
    try {
      await getRepository().restore(id)
      set((state) => ({ trash: state.trash.filter((entry) => entry.id !== id) }))
      await get().loadAll()
    } catch (error) {
      console.error('从废纸篓恢复失败', error)
      throw toWriteError(error)
    }
  },

  purgeEntry: async (id) => {
    try {
      await getRepository().purge(id)
      set((state) => ({ trash: state.trash.filter((entry) => entry.id !== id) }))
    } catch (error) {
      console.error('彻底删除条目失败', error)
      throw toWriteError(error)
    }
  },

  purgeExpiredTrash: async (retentionDays) => {
    const cutoff = Date.now() - retentionDays * 86_400_000
    // deletedAt 缺失时保守跳过（脏数据宁可多留不误删）
    const expired = get().trash.filter(
      (entry) => entry.deletedAt != null && entry.deletedAt <= cutoff,
    )
    for (const entry of expired) {
      try {
        await getRepository().purge(entry.id)
        set((state) => ({ trash: state.trash.filter((item) => item.id !== entry.id) }))
      } catch (error) {
        console.error('自动清理废纸篓条目失败', entry.id, error)
        // 单条失败跳过继续，不阻塞其余清理
      }
    }
    return expired.length
  },

  emptyTrash: async () => {
    try {
      await getRepository().emptyTrash()
      set({ trash: [] })
    } catch (error) {
      console.error('清空废纸篓失败', error)
      throw toWriteError(error)
    }
  },

  updateEntry: async (id, patch, expectedVersion) => {
    const target = get().entries.find((entry) => entry.id === id)
    if (!target) throw new EntryWriteError('not_found', '条目不存在或已被删除')
    const normalized = { ...patch, kind: target.kind } as Partial<Entry>
    if (target.kind === 'todo' && Array.isArray((normalized as { items?: TodoItem[] }).items)) {
      const items = (normalized as { items: TodoItem[] }).items
      const allDone = items.length > 0 && items.every((item) => item.done)
      ;(normalized as { done?: boolean }).done = allDone
      ;(normalized as { completedAt?: number | null }).completedAt = allDone
        ? target.completedAt ?? Date.now()
        : null
    }
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
      const stored = await getRepository().update(
        id,
        normalized,
        expectedVersion ?? target.version,
      )
      set((state) => ({
        entries: state.entries.map((entry) => (entry.id === id ? stored : entry)),
      }))
      return stored
    } catch (error) {
      if (error instanceof EntryWriteError && error.latest) {
        const latest = error.latest
        set((state) => ({
          entries: state.entries.map((entry) => (entry.id === id ? latest : entry)),
        }))
      }
      throw toWriteError(error)
    }
  },

  markNotified: async (id) => {
    const target = get().entries.find((entry) => entry.id === id)
    if (!target) return
    await get().updateEntry(id, { kind: 'reminder', notified: true }, target.version)
  },

  markAlarmNotified: async (entryId, alarmId) => {
    const target = get().entries.find((entry) => entry.id === entryId)
    if (!target || target.kind !== 'reminder') return
    try {
      const stored = await getRepository().markAlarmNotified(
        entryId,
        alarmId,
        target.version,
      )
      set((state) => ({
        entries: state.entries.map((entry) => (entry.id === entryId ? stored : entry)),
      }))
    } catch (error) {
      if (error instanceof EntryWriteError && error.latest) {
        set((state) => ({
          entries: state.entries.map((entry) => (entry.id === entryId ? error.latest! : entry)),
        }))
      }
      throw toWriteError(error)
    }
  },

  confirmAlarm: async (entryId, alarmId) => {
    const target = get().entries.find((entry) => entry.id === entryId)
    if (!target || target.kind !== 'reminder') {
      throw new EntryWriteError('not_found', '提醒条目不存在或已被删除')
    }
    const alarm = target.alarms.find((item) => item.id === alarmId)
    if (!alarm) throw new EntryWriteError('not_found', '闹钟不存在或已被删除')
    const now = Date.now()
    const alarms = target.alarms.map((item) => {
      if (item.id !== alarmId) return item
      if (item.mode === 'once') {
        return {
          ...item,
          notified: true,
          lastAttemptAt: now,
          lastDeliveryStatus: 'delivered' as const,
          lastDeliveryError: undefined,
          occurrenceKey: occurrenceKey(item),
        }
      }
      const advanced = nextAlarmAt(item)
      return {
        ...item,
        remindAt: advanced,
        notified: false,
        lastAttemptAt: now,
        lastDeliveryStatus: 'delivered' as const,
        lastDeliveryError: undefined,
        occurrenceKey: `${item.id}:${advanced}`,
      }
    })
    const allNotified = alarms.length > 0 && alarms.every((item) => item.notified)
    return get().updateEntry(
      entryId,
      { kind: 'reminder', alarms, notified: allNotified },
      target.version,
    )
  },

  snoozeAlarm: async (entryId, alarmId, remindAt) => {
    const target = get().entries.find((entry) => entry.id === entryId)
    if (!target || target.kind !== 'reminder') {
      throw new EntryWriteError('not_found', '提醒条目不存在或已被删除')
    }
    try {
      const stored = await getRepository().snoozeAlarm(
        entryId,
        alarmId,
        remindAt,
        target.version,
      )
      set((state) => ({
        entries: state.entries.map((entry) => (entry.id === entryId ? stored : entry)),
      }))
      return stored
    } catch (error) {
      if (error instanceof EntryWriteError && error.latest) {
        set((state) => ({
          entries: state.entries.map((entry) => (entry.id === entryId ? error.latest! : entry)),
        }))
      }
      throw toWriteError(error)
    }
  },

  presentAlarm: async (entryId, alarmId) => {
    try {
      await mutateAlarm(get, set, entryId, alarmId, (alarm) => ({
        ...alarm,
        lastAttemptAt: Date.now(),
        lastDeliveryStatus: 'delivered',
        lastDeliveryError: undefined,
        occurrenceKey: occurrenceKey(alarm),
        presentationCount: (alarm.presentationCount ?? 0) + 1,
      }))
    } catch (error) {
      console.error('记录提醒呈现失败', error)
    }
  },

  recordAlarmFailure: async (entryId, alarmId, message) => {
    try {
      await mutateAlarm(get, set, entryId, alarmId, (alarm) => ({
        ...alarm,
        lastAttemptAt: Date.now(),
        lastDeliveryStatus: 'failed',
        lastDeliveryError: message.slice(0, 200),
        occurrenceKey: occurrenceKey(alarm),
      }))
    } catch (error) {
      console.error('记录提醒触达失败状态失败', error)
    }
    get().reportReminderIssue({
      entryId,
      alarmId,
      message: message.slice(0, 200),
    })
  },

  reportReminderIssue: (issue) => {
    set((state) => ({
      reminderIssues: [
        {
          ...issue,
          id: `${issue.entryId}:${issue.alarmId}:${Date.now()}`,
          at: Date.now(),
        },
        ...state.reminderIssues.filter(
          (item) => !(item.entryId === issue.entryId && item.alarmId === issue.alarmId),
        ),
      ].slice(0, 20),
    }))
  },

  clearReminderIssues: () => set({ reminderIssues: [] }),
}))

/** 提醒字段读改写：版本冲突时用最新 store 数据重试，避免提醒写入被普通编辑冲突吞掉 */
async function mutateAlarm(
  get: () => EntryState,
  set: (partial: Partial<EntryState>) => void,
  entryId: string,
  alarmId: string,
  mutate: (alarm: AlarmItem) => AlarmItem,
): Promise<Entry> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const target = get().entries.find((entry) => entry.id === entryId)
    if (!target || target.kind !== 'reminder') {
      throw new EntryWriteError('not_found', '提醒条目不存在或已被删除')
    }
    const alarm = target.alarms.find((item) => item.id === alarmId)
    if (!alarm) throw new EntryWriteError('not_found', '闹钟不存在或已被删除')
    const alarms = target.alarms.map((item) =>
      item.id === alarmId ? mutate(item) : item,
    )
    try {
      const stored = await get().updateEntry(
        entryId,
        { kind: 'reminder', alarms },
        target.version,
      )
      set({
        entries: get().entries.map((entry) => (entry.id === entryId ? stored : entry)),
      })
      return stored
    } catch (error) {
      lastError = error
      if (!(error instanceof EntryWriteError) || error.code !== 'conflict') throw error
    }
  }
  throw lastError instanceof Error ? lastError : new EntryWriteError('conflict', '提醒写入冲突')
}
