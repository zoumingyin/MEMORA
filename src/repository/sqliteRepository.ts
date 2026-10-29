import Database from '@tauri-apps/plugin-sql'
import type { AlarmItem, Entry, EntryKind, EntryRow, NewEntryInput, TodoItem } from '../types/entry'
import { parseAlarms, rowToEntry, type EntryRepository } from './repository'

let db: Database | null = null

async function getDb(): Promise<Database> {
  if (!db) {
    db = await Database.load('sqlite:bianqian.db')
  }
  return db
}

/** 本地 SQLite 仓储实现，数据库文件位于 Tauri 应用数据目录 */
export class SqliteEntryRepository implements EntryRepository {
  async listAll(): Promise<Entry[]> {
    const database = await getDb()
    const rows = await database.select<EntryRow[]>(
      'SELECT * FROM entries WHERE deleted_at IS NULL ORDER BY updated_at DESC',
    )
    return rows.map(rowToEntry)
  }

  async listByKind(kind: EntryKind): Promise<Entry[]> {
    const database = await getDb()
    const rows = await database.select<EntryRow[]>(
      'SELECT * FROM entries WHERE kind = $1 AND deleted_at IS NULL ORDER BY updated_at DESC',
      [kind],
    )
    return rows.map(rowToEntry)
  }

  async create(kind: EntryKind, input: NewEntryInput): Promise<Entry> {
    const now = Date.now()
    const id = crypto.randomUUID()
    const title = input.title.trim()
    const content = input.content.trim()
    const tags = input.tags ?? []

    let entry: Entry
    if (kind === 'note') {
      entry = {
        id,
        kind: 'note',
        title,
        content,
        createdAt: now,
        updatedAt: now,
        syncStatus: 'pending',
        tags,
      }
    } else if (kind === 'todo') {
      entry = {
        id,
        kind: 'todo',
        title,
        content,
        createdAt: now,
        updatedAt: now,
        syncStatus: 'pending',
        done: false,
        completedAt: null,
        items: [],
        tags,
      }
    } else {
      const defaultAlarm: AlarmItem = {
        id: crypto.randomUUID(),
        remindAt: input.remindAt ?? now,
        mode: 'once',
        method: 'dialog',
        notified: false,
      }
      entry = {
        id,
        kind: 'reminder',
        title,
        content,
        createdAt: now,
        updatedAt: now,
        syncStatus: 'pending',
        remindAt: defaultAlarm.remindAt,
        notified: false,
        done: false,
        alarms: [defaultAlarm],
        tags,
      }
    }

    const database = await getDb()
    if (entry.kind === 'note') {
      await database.execute(
        `INSERT INTO entries
          (id, kind, title, content, remind_at, done, completed_at, notified, created_at, updated_at, sync_status, tags)
         VALUES ($1, $2, $3, $4, NULL, 0, NULL, 0, $5, $6, 'pending', $7)`,
        [entry.id, entry.kind, entry.title, entry.content, entry.createdAt, entry.updatedAt, JSON.stringify(tags)],
      )
    } else if (entry.kind === 'todo') {
      const todo = entry
      await database.execute(
        `INSERT INTO entries
          (id, kind, title, content, remind_at, done, completed_at, notified, created_at, updated_at, sync_status, items, tags)
         VALUES ($1, $2, $3, $4, NULL, $5, $6, 0, $7, $8, 'pending', '[]', $9)`,
        [
          todo.id,
          todo.kind,
          todo.title,
          todo.content,
          todo.done ? 1 : 0,
          todo.completedAt,
          todo.createdAt,
          todo.updatedAt,
          JSON.stringify(tags),
        ],
      )
    } else {
      const reminder = entry
      await database.execute(
        `INSERT INTO entries
          (id, kind, title, content, remind_at, done, completed_at, notified, created_at, updated_at, sync_status, items, alarms, tags)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, 'pending', '[]', $10, $11)`,
        [
          reminder.id,
          reminder.kind,
          reminder.title,
          reminder.content,
          reminder.remindAt,
          reminder.done ? 1 : 0,
          reminder.notified ? 1 : 0,
          reminder.createdAt,
          reminder.updatedAt,
          JSON.stringify(reminder.alarms),
          JSON.stringify(tags),
        ],
      )
    }
    return entry
  }

  async update(id: string, patch: Partial<Entry>): Promise<void> {
    const database = await getDb()
    const sets: string[] = []
    const params: (string | number | null)[] = []

    const pushField = (column: string, value: unknown) => {
      sets.push(`${column} = $${params.length + 1}`)
      params.push(value as string | number | null)
    }

    if (patch.title !== undefined) pushField('title', patch.title.trim())
    if (patch.content !== undefined) pushField('content', patch.content.trim())
    if (patch.tags !== undefined) pushField('tags', JSON.stringify(patch.tags))
    // 纸张外观：颜色 / 纹理 key（plain 也直接存 key，读取时统一解析）
    if (patch.color !== undefined) pushField('color', patch.color)
    if (patch.paper !== undefined) pushField('paper', patch.paper)

    if (patch.kind === 'todo' && 'items' in patch) {
      // 子任务清单变更：序列化入列，并据此派生整条完成态
      const items = (patch.items ?? []) as TodoItem[]
      const allDone = items.length > 0 && items.every((item) => item.done)
      pushField('items', JSON.stringify(items))
      pushField('done', allDone ? 1 : 0)
      pushField('completed_at', allDone ? Date.now() : null)
    } else if (patch.kind === 'todo' && 'done' in patch) {
      pushField('done', patch.done ? 1 : 0)
      pushField('completed_at', patch.done ? Date.now() : null)
    }
    if (patch.kind === 'reminder' && 'alarms' in patch) {
      // 闹钟清单变更：序列化入列；清单非空时条目级 remind_at 派生为最近一个未通知闹钟的时间（清空时保留原值）
      const alarms = (patch.alarms ?? []) as AlarmItem[]
      pushField('alarms', JSON.stringify(alarms))
      if (alarms.length > 0) {
        const pending = alarms.filter((alarm) => !alarm.notified)
        const nextDue = pending.length
          ? Math.min(...pending.map((alarm) => alarm.remindAt))
          : Math.min(...alarms.map((alarm) => alarm.remindAt))
        pushField('remind_at', nextDue)
      }
    }
    if (patch.kind === 'reminder' && 'done' in patch) {
      pushField('done', patch.done ? 1 : 0)
    }
    if (patch.kind === 'reminder' && 'remindAt' in patch) {
      pushField('remind_at', patch.remindAt ?? null)
    }
    if (patch.kind === 'reminder' && 'notified' in patch) {
      pushField('notified', patch.notified ? 1 : 0)
    }
    pushField('updated_at', Date.now())

    params.push(id)
    await database.execute(
      `UPDATE entries SET ${sets.join(', ')} WHERE id = $${params.length}`,
      params,
    )
  }

  async remove(id: string): Promise<void> {
    const database = await getDb()
    await database.execute('DELETE FROM entries WHERE id = $1', [id])
  }

  async listTrash(): Promise<Entry[]> {
    const database = await getDb()
    const rows = await database.select<EntryRow[]>(
      'SELECT * FROM entries WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC',
    )
    return rows.map(rowToEntry)
  }

  async moveToTrash(id: string): Promise<void> {
    const database = await getDb()
    // 仅写 deleted_at，不改动 updated_at：恢复后保留原编辑时间
    await database.execute('UPDATE entries SET deleted_at = $2 WHERE id = $1', [
      id,
      Date.now(),
    ])
  }

  async restore(id: string): Promise<void> {
    const database = await getDb()
    await database.execute('UPDATE entries SET deleted_at = NULL WHERE id = $1', [id])
  }

  async purge(id: string): Promise<void> {
    await this.remove(id)
  }

  async emptyTrash(): Promise<void> {
    const database = await getDb()
    await database.execute('DELETE FROM entries WHERE deleted_at IS NOT NULL')
  }

  async markNotified(id: string): Promise<void> {
    const database = await getDb()
    await database.execute('UPDATE entries SET notified = 1, updated_at = $2 WHERE id = $1', [
      id,
      Date.now(),
    ])
  }

  async markAlarmNotified(entryId: string, alarmId: string): Promise<void> {
    const database = await getDb()
    const rows = await database.select<Array<Pick<EntryRow, 'alarms' | 'notified'>>>(
      'SELECT alarms, notified FROM entries WHERE id = $1',
      [entryId],
    )
    if (rows.length === 0) return
    const alarms = parseAlarms(rows[0].alarms)
    const next = alarms.map((alarm) =>
      alarm.id === alarmId && !alarm.notified ? { ...alarm, notified: true } : alarm,
    )
    const allNotified = next.length > 0 && next.every((alarm) => alarm.notified)
    await database.execute(
      'UPDATE entries SET alarms = $2, notified = $3, updated_at = $4 WHERE id = $1',
      [entryId, JSON.stringify(next), allNotified ? 1 : rows[0].notified, Date.now()],
    )
  }

  async listPendingSync(): Promise<Entry[]> {
    const database = await getDb()
    const rows = await database.select<EntryRow[]>(
      "SELECT * FROM entries WHERE sync_status = 'pending'",
    )
    return rows.map(rowToEntry)
  }

  async markSynced(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    const database = await getDb()
    for (const id of ids) {
      await database.execute(
        "UPDATE entries SET sync_status = 'synced', updated_at = $2 WHERE id = $1",
        [id, Date.now()],
      )
    }
  }

  async importAll(entries: Entry[]): Promise<number> {
    if (entries.length === 0) return 0
    const database = await getDb()
    const existing = await database.select<{ id: string }[]>("SELECT id FROM entries")
    const ids = new Set(existing.map((row) => row.id))
    let imported = 0
    for (const entry of entries) {
      if (ids.has(entry.id)) continue
      await database.execute(
        `INSERT OR IGNORE INTO entries
          (id, kind, title, content, remind_at, done, completed_at, notified, created_at, updated_at, sync_status, items, alarms, tags)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'synced', $11, $12, $13)`,
        [
          entry.id,
          entry.kind,
          entry.title,
          entry.content,
          entry.kind === 'reminder' ? entry.remindAt : null,
          entry.kind === 'todo' ? (entry.done ? 1 : 0) : 0,
          entry.kind === 'todo' ? entry.completedAt : null,
          entry.kind === 'reminder' ? (entry.notified ? 1 : 0) : 0,
          entry.createdAt,
          entry.updatedAt,
          entry.kind === 'todo' ? JSON.stringify(entry.items) : '[]',
          entry.kind === 'reminder' ? JSON.stringify(entry.alarms) : '[]',
          JSON.stringify(entry.tags ?? []),
        ],
      )
      ids.add(entry.id)
      imported += 1
    }
    return imported
  }
}
