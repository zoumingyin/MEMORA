import type {
  AlarmItem,
  Entry,
  EntryKind,
  EntryRow,
  NewEntryInput,
  PaperColor,
  PaperStyle,
  TodoItem,
} from '../types/entry'

/**
 * 仓储抽象：本地 SQLite 为 V1 实现；后续多设备同步时在此接口上叠加
 * RemoteRepository，store 只依赖本接口，不感知存储位置。
 */
export interface EntryRepository {
  /** 启动时全量加载 */
  listAll(): Promise<Entry[]>
  listByKind(kind: EntryKind): Promise<Entry[]>
  create(kind: EntryKind, input: NewEntryInput): Promise<Entry>
  update(id: string, patch: Partial<Entry>): Promise<void>
  /** 彻底删除（硬删除，仅废纸篓内部使用；常规删除请走 moveToTrash） */
  remove(id: string): Promise<void>
  /** 废纸篓：列出全部软删除条目 */
  listTrash(): Promise<Entry[]>
  /** 移入废纸篓（软删除：写入 deleted_at，不改动 updated_at） */
  moveToTrash(id: string): Promise<void>
  /** 从废纸篓恢复（清除 deleted_at） */
  restore(id: string): Promise<void>
  /** 彻底删除单条废纸篓条目 */
  purge(id: string): Promise<void>
  /** 清空废纸篓（彻底删除全部软删除条目） */
  emptyTrash(): Promise<void>
  /** 标记提醒已通知，避免重复弹窗 */
  markNotified(id: string): Promise<void>
  /** 标记某条提醒下的单个闹钟已通知（按闹钟 id） */
  markAlarmNotified(entryId: string, alarmId: string): Promise<void>
  /** 预留：取出待同步条目 */
  listPendingSync(): Promise<Entry[]>
  /** 预留：同步完成后批量标记 */
  markSynced(ids: string[]): Promise<void>
  /**
   * 批量导入（数据导入导出用）：按 id 合并，已存在（含任意 kind）跳过不覆盖；
   * 返回实际新增条数。
   */
  importAll(entries: Entry[]): Promise<number>
}

/** 待办子任务清单：列内 JSON 数组，解析失败或缺失时回退为空清单 */
export function parseTodoItems(raw: string | null | undefined): TodoItem[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (item): item is TodoItem =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as TodoItem).id === 'string' &&
          typeof (item as TodoItem).text === 'string' &&
          typeof (item as TodoItem).done === 'boolean',
      )
    }
  } catch {
    // 忽略损坏数据，回退为空清单
  }
  return []
}

/** 新建待办时把子任务文本转成清单项：去空白、去重，id 本地生成 */
export function todoItemsFromTexts(texts: string[] | undefined): TodoItem[] {
  if (!texts) return []
  return texts
    .map((text) => text.trim())
    .filter((text, index, all) => text.length > 0 && all.indexOf(text) === index)
    .map((text) => ({ id: crypto.randomUUID(), text, done: false }))
}

/** 闹钟清单：列内 JSON 数组，解析失败或缺失时回退为空清单 */
export function parseAlarms(raw: string | null | undefined): AlarmItem[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (item): item is AlarmItem =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as AlarmItem).id === 'string' &&
          typeof (item as AlarmItem).remindAt === 'number' &&
          typeof (item as AlarmItem).notified === 'boolean',
      )
    }
  } catch {
    // 忽略损坏数据，回退为空清单
  }
  return []
}

/** 标签：列内 JSON 字符串数组，解析失败或缺失时回退为空数组 */
export function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (item): item is string => typeof item === 'string' && item.length > 0,
      )
    }
  } catch {
    // 忽略损坏数据，回退为空数组
  }
  return []
}

/** 纸张底色合法 key 集合：列值超出时回退 plain，防脏数据 */
const PAPER_COLOR_KEYS: readonly PaperColor[] = [
  'plain',
  'yellow',
  'mint',
  'blue',
  'lavender',
  'cream',
  'pink',
  'peach',
]
/** 纸张纹理合法 key 集合 */
const PAPER_STYLE_KEYS: readonly PaperStyle[] = ['plain', 'ruled', 'grid', 'dots']

function parsePaperColor(raw: string | null | undefined): PaperColor {
  return PAPER_COLOR_KEYS.includes(raw as PaperColor) ? (raw as PaperColor) : 'plain'
}

function parsePaperStyle(raw: string | null | undefined): PaperStyle {
  return PAPER_STYLE_KEYS.includes(raw as PaperStyle) ? (raw as PaperStyle) : 'plain'
}

/**
 * 数据库行 → 领域实体。
 * 提醒条目兼容旧数据：无闹钟清单时把旧的 remind_at / notified 收敛为一条 legacy 闹钟，
 * 保证升级前的提醒仍按原时间触发。
 */
export function rowToEntry(row: EntryRow): Entry {
  const base = {
    id: row.id,
    title: row.title,
    content: row.content ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    syncStatus: row.sync_status,
    tags: parseTags(row.tags),
    color: parsePaperColor(row.color),
    paper: parsePaperStyle(row.paper),
    deletedAt: row.deleted_at ?? null,
  }

  if (row.kind === 'note') {
    return { kind: 'note', ...base }
  }
  if (row.kind === 'todo') {
    return {
      kind: 'todo',
      ...base,
      done: row.done === 1,
      completedAt: row.completed_at,
      items: parseTodoItems(row.items),
    }
  }

  let alarms = parseAlarms(row.alarms)
  if (alarms.length === 0 && row.remind_at != null) {
    alarms = [
      {
        id: 'legacy',
        remindAt: row.remind_at,
        mode: 'once',
        method: 'dialog',
        notified: row.notified === 1,
      },
    ]
  }
  return {
    kind: 'reminder',
    ...base,
    remindAt: row.remind_at ?? 0,
    notified: row.notified === 1,
    done: row.done === 1,
    alarms,
  }
}
