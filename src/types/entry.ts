/** 条目分类：备忘 / 提醒 / 待办 */
export type EntryKind = 'note' | 'reminder' | 'todo'

/** 同步状态：预留多设备同步，V1 仅本地写入 */
export type SyncStatus = 'pending' | 'synced' | 'conflict'

/** 三类条目共用的基础字段 */
export interface BaseEntry {
  id: string
  kind: EntryKind
  title: string
  content: string
  createdAt: number
  updatedAt: number
  syncStatus: SyncStatus
  /** 标签（本地过滤用，JSON 存于 entries.tags 列） */
  tags: string[]
}

/** 备忘：纯文本记录 */
export interface NoteEntry extends BaseEntry {
  kind: 'note'
}

/** 待办清单中的单个子任务 */
export interface TodoItem {
  id: string
  text: string
  done: boolean
}

/** 待办：内含多个可独立勾选的子任务，全部勾选后整条视为完成 */
export interface TodoEntry extends BaseEntry {
  kind: 'todo'
  done: boolean
  completedAt: number | null
  /** 子任务清单（JSON 存于 entries.items 列） */
  items: TodoItem[]
}

/** 闹钟提醒模式：单次 / 循环（每隔 N 天）/ 每天 / 每周 / 每月 / 每年阳历 / 每年农历（workday 仅为旧数据兼容） */
export type AlarmMode =
  | 'once'
  | 'loop'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'yearly'
  | 'lunar'
  | 'workday'

/** 闹钟提醒方式：弹窗提醒 / 系统通知 / 弹窗 + 提示音 */
export type AlarmMethod = 'dialog' | 'notification' | 'sound'

/** 循环提醒的间隔单位（mode='loop' 时生效，默认 day） */
export type AlarmIntervalUnit = 'second' | 'minute' | 'hour' | 'day'

/** 提醒条目内的单个闹钟 */
export interface AlarmItem {
  id: string
  remindAt: number
  mode: AlarmMode
  method: AlarmMethod
  notified: boolean
  /** 循环提醒的间隔数值（mode='loop' 时生效，默认 1） */
  interval?: number
  /** 循环提醒的间隔单位：秒 / 分 / 时 / 天（默认 day，兼容旧数据） */
  intervalUnit?: AlarmIntervalUnit
  /** 循环提醒的间隔毫秒数（mode='loop' 时生效；支持「X 时 Y 分」复合间隔，优先于 interval+intervalUnit） */
  intervalMs?: number
}

/** 提醒：内含多个可独立设置的闹钟，每个闹钟有自己的时间、提醒模式与提醒方式 */
export interface ReminderEntry extends BaseEntry {
  kind: 'reminder'
  remindAt: number
  notified: boolean
  done: boolean
  /** 闹钟清单（JSON 存于 entries.alarms 列） */
  alarms: AlarmItem[]
}

export type Entry = NoteEntry | TodoEntry | ReminderEntry

/** SQLite 行结构（snake_case，与迁移表一一对应） */
export interface EntryRow {
  id: string
  kind: EntryKind
  title: string
  content: string | null
  remind_at: number | null
  done: number
  completed_at: number | null
  notified: number
  created_at: number
  updated_at: number
  sync_status: SyncStatus
  /** 待办子任务清单（JSON 数组，非待办为 '[]'） */
  items: string | null
  /** 提醒闹钟清单（JSON 数组，非提醒为 '[]'） */
  alarms: string | null
  /** 标签（JSON 字符串数组） */
  tags: string | null
}

/** 新建条目时的输入载荷（按分类不同携带可选字段） */
export interface NewEntryInput {
  title: string
  content: string
  remindAt?: number
  /** 标签（可选，默认空数组） */
  tags?: string[]
}
