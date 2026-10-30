import type { AlarmItem, Entry, EntryKind, NewEntryInput, TodoItem } from '../types/entry'
import { todoItemsFromTexts, type EntryRepository } from './repository'

const STORAGE_KEY = 'bianqian.entries.v1'

function loadAll(): Entry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const entries = raw ? (JSON.parse(raw) as Entry[]) : []
    return entries.map((entry) => {
      if (entry.kind === 'todo' && !Array.isArray(entry.items)) {
        return { ...entry, items: [] as TodoItem[] }
      }
      // 兼容旧数据：提醒无闹钟清单时收敛为一条 legacy 闹钟，保持原触发时间
      if (entry.kind === 'reminder' && !Array.isArray(entry.alarms)) {
        return {
          ...entry,
          alarms: [
            {
              id: 'legacy',
              remindAt: entry.remindAt,
              mode: 'once' as const,
              method: 'dialog' as const,
              notified: entry.notified,
            },
          ],
        }
      }
      // 兼容旧数据：无标签时补空数组
      if (!Array.isArray(entry.tags)) {
        return { ...entry, tags: [] as string[] }
      }
      return entry
    })
  } catch {
    return []
  }
}

function saveAll(entries: Entry[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
}

/** 非 Tauri 运行环境下的兜底仓储，数据存浏览器 localStorage，仅用于页面预览 */
export class MemoryEntryRepository implements EntryRepository {
  async listAll(): Promise<Entry[]> {
    return loadAll()
      .filter((entry) => entry.deletedAt == null)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async listByKind(kind: EntryKind): Promise<Entry[]> {
    return loadAll()
      .filter((entry) => entry.kind === kind && entry.deletedAt == null)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async create(kind: EntryKind, input: NewEntryInput): Promise<Entry> {
    const now = Date.now()
    const id = crypto.randomUUID()
    const title = input.title.trim()
    const content = input.content.trim()
    const base = {
      id,
      title,
      content,
      createdAt: now,
      updatedAt: now,
      syncStatus: 'pending' as const,
      tags: input.tags ?? [],
    }

    let entry: Entry
    if (kind === 'note') {
      entry = { kind: 'note', ...base }
    } else if (kind === 'todo') {
      entry = { kind: 'todo', ...base, done: false, completedAt: null, items: todoItemsFromTexts(input.items) }
    } else {
      entry = {
        kind: 'reminder',
        ...base,
        remindAt: input.remindAt ?? now,
        notified: false,
        done: false,
        alarms: [
          {
            id: crypto.randomUUID(),
            remindAt: input.remindAt ?? now,
            mode: 'once',
            method: 'dialog',
            notified: false,
          },
        ],
      }
    }

    const entries = loadAll()
    entries.push(entry)
    saveAll(entries)
    return entry
  }

  async update(id: string, patch: Partial<Entry>): Promise<void> {
    const entries = loadAll()
    const index = entries.findIndex((entry) => entry.id === id)
    if (index === -1) return
    const current = entries[index]
    const updatedAt = Date.now()
    let next: Entry

    if (current.kind === 'note') {
      next = {
        ...current,
        title: patch.title ?? current.title,
        content: patch.content ?? current.content,
        tags: patch.tags ?? current.tags,
        color: patch.color ?? current.color,
        paper: patch.paper ?? current.paper,
        updatedAt,
      }
    } else if (current.kind === 'todo') {
      const hasItems = 'items' in patch && Array.isArray(patch.items)
      const items = hasItems ? (patch.items as TodoItem[]) : current.items
      const allDone = items.length > 0 && items.every((item) => item.done)
      const done = hasItems
        ? allDone
        : 'done' in patch && typeof patch.done === 'boolean'
          ? patch.done
          : current.done
      next = {
        ...current,
        title: patch.title ?? current.title,
        content: patch.content ?? current.content,
        tags: patch.tags ?? current.tags,
        color: patch.color ?? current.color,
        paper: patch.paper ?? current.paper,
        updatedAt,
        items,
        done,
        completedAt: done ? current.completedAt ?? Date.now() : null,
      }
    } else {
      const hasAlarms = 'alarms' in patch && Array.isArray(patch.alarms)
      const alarms = hasAlarms ? (patch.alarms as AlarmItem[]) : current.alarms
      const pending = alarms.filter((alarm) => !alarm.notified)
      const nextDue = pending.length
        ? Math.min(...pending.map((alarm) => alarm.remindAt))
        : Math.min(...alarms.map((alarm) => alarm.remindAt))
      next = {
        ...current,
        title: patch.title ?? current.title,
        content: patch.content ?? current.content,
        tags: patch.tags ?? current.tags,
        color: patch.color ?? current.color,
        paper: patch.paper ?? current.paper,
        updatedAt,
        alarms,
        remindAt: hasAlarms
          ? alarms.length > 0
            ? nextDue
            : current.remindAt
          : 'remindAt' in patch && patch.remindAt != null
            ? patch.remindAt
            : current.remindAt,
        done:
          'done' in patch && typeof patch.done === 'boolean'
            ? patch.done
            : current.done,
        notified:
          'notified' in patch && typeof patch.notified === 'boolean'
            ? patch.notified
            : current.notified,
      }
    }

    entries[index] = next
    saveAll(entries)
  }

  async remove(id: string): Promise<void> {
    saveAll(loadAll().filter((entry) => entry.id !== id))
  }

  async listTrash(): Promise<Entry[]> {
    return loadAll()
      .filter((entry) => entry.deletedAt != null)
      .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))
  }

  async moveToTrash(id: string): Promise<void> {
    // 仅写 deletedAt，不改动 updatedAt：恢复后保留原编辑时间
    const entries = loadAll()
    const target = entries.find((entry) => entry.id === id)
    if (!target) return
    target.deletedAt = Date.now()
    saveAll(entries)
  }

  async restore(id: string): Promise<void> {
    const entries = loadAll()
    const target = entries.find((entry) => entry.id === id)
    if (!target) return
    target.deletedAt = null
    saveAll(entries)
  }

  async purge(id: string): Promise<void> {
    await this.remove(id)
  }

  async emptyTrash(): Promise<void> {
    saveAll(loadAll().filter((entry) => entry.deletedAt == null))
  }

  async markNotified(id: string): Promise<void> {
    const entries = loadAll()
    const target = entries.find((entry) => entry.id === id)
    if (target && target.kind === 'reminder') {
      target.notified = true
      saveAll(entries)
    }
  }

  async markAlarmNotified(entryId: string, alarmId: string): Promise<void> {
    const entries = loadAll()
    const target = entries.find((entry) => entry.id === entryId)
    if (!target || target.kind !== 'reminder') return
    const alarms = target.alarms.map((alarm) =>
      alarm.id === alarmId && !alarm.notified ? { ...alarm, notified: true } : alarm,
    )
    target.alarms = alarms
    if (alarms.length > 0 && alarms.every((alarm) => alarm.notified)) target.notified = true
    saveAll(entries)
  }

  async listPendingSync(): Promise<Entry[]> {
    return loadAll().filter((entry) => entry.syncStatus === 'pending')
  }

  async markSynced(ids: string[]): Promise<void> {
    const entries = loadAll()
    for (const entry of entries) {
      if (ids.includes(entry.id)) entry.syncStatus = 'synced'
    }
    saveAll(entries)
  }

  async importAll(entries: Entry[]): Promise<number> {
    if (entries.length === 0) return 0
    const existing = loadAll()
    const ids = new Set(existing.map((entry) => entry.id))
    const fresh = entries.filter((entry) => !ids.has(entry.id))
    if (fresh.length > 0) saveAll([...existing, ...fresh])
    return fresh.length
  }
}
