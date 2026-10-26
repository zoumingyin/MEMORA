import { Empty } from 'antd'
import { BellOutlined, CheckSquareOutlined, FileTextOutlined } from '@ant-design/icons'
import type { ReactNode } from 'react'
import { useEntryStore } from '../store/useEntryStore'
import type { Entry, EntryKind } from '../types/entry'
import { useNow } from '../hooks/useNow'
import { formatRelative, formatShort } from '../utils/format'

const KIND_ICON: Record<EntryKind, ReactNode> = {
  note: <FileTextOutlined />,
  reminder: <BellOutlined />,
  todo: <CheckSquareOutlined />,
}

/** 待办完成判定：有子任务且全部勾选 */
function todoAllDone(entry: Entry): boolean {
  return entry.kind === 'todo' && entry.items.length > 0 && entry.items.every((item) => item.done)
}

/** 提醒状态：最近待提醒闹钟时间；全部已提醒视为处理完 */
function reminderStatus(entry: Entry): { at: number; allNotified: boolean } {
  if (entry.kind !== 'reminder') return { at: 0, allNotified: true }
  const alarms = entry.alarms
  if (alarms.length === 0) {
    return { at: entry.remindAt, allNotified: entry.done || entry.notified }
  }
  const pending = alarms.filter((alarm) => !alarm.notified)
  if (pending.length === 0) return { at: Math.max(...alarms.map((alarm) => alarm.remindAt)), allNotified: true }
  return { at: Math.min(...pending.map((alarm) => alarm.remindAt)), allNotified: false }
}

/** 分类排序：备忘按更新时间倒序，提醒按最近待提醒时间升序（未提醒在前），待办未完成在前 */
function sortEntries(
  filter: 'all' | EntryKind,
  entries: Entry[],
  sortBy: 'updated' | 'created' = 'updated',
): Entry[] {
  const byTime = (a: Entry, b: Entry) =>
    sortBy === 'created' ? b.createdAt - a.createdAt : b.updatedAt - a.updatedAt
  if (filter === 'all') {
    return [...entries].sort(byTime)
  }
  const list = entries.filter((entry) => entry.kind === filter)
  if (filter === 'note') {
    return list.sort(byTime)
  }
  if (filter === 'todo') {
    return list.sort((a, b) => {
      if (a.kind === 'todo' && b.kind === 'todo') {
        const aDone = todoAllDone(a)
        const bDone = todoAllDone(b)
        if (aDone !== bDone) return aDone ? 1 : -1
        return byTime(a, b)
      }
      return 0
    })
  }
  return list.sort((a, b) => {
    const aStatus = reminderStatus(a)
    const bStatus = reminderStatus(b)
    if (aStatus.allNotified !== bStatus.allNotified) return aStatus.allNotified ? 1 : -1
    return aStatus.at - bStatus.at
  })
}

/** 搜索/标签/时间范围过滤：query 匹配标题与正文，tag 精确匹配，range 按更新时间 */
function filterEntries(
  entries: Entry[],
  search: string,
  tagFilter: string | null,
  timeRange: 'all' | 'today' | '7d' | '30d',
): Entry[] {
  const query = search.trim().toLowerCase()
  const now = Date.now()
  const start =
    timeRange === 'today'
      ? (() => {
          const d = new Date()
          d.setHours(0, 0, 0, 0)
          return d.getTime()
        })()
      : timeRange === '7d'
        ? now - 7 * 24 * 3600_000
        : timeRange === '30d'
          ? now - 30 * 24 * 3600_000
          : 0
  return entries.filter((entry) => {
    if (tagFilter && !entry.tags.includes(tagFilter)) return false
    if (start && entry.updatedAt < start) return false
    if (query) {
      const haystack = `${entry.title}\n${entry.content}`.toLowerCase()
      if (!haystack.includes(query)) return false
    }
    return true
  })
}

function rowMeta(entry: Entry, now: number): { text: string; overdue?: boolean } {
  if (entry.kind === 'note') {
    return { text: `更新于 ${formatShort(entry.updatedAt)}` }
  }
  if (entry.kind === 'todo') {
    const items = entry.items
    if (items.length === 0) return { text: '无子任务' }
    const doneCount = items.filter((item) => item.done).length
    return doneCount === items.length
      ? { text: `已完成 ${doneCount}/${items.length}` }
      : { text: `${doneCount}/${items.length} 项` }
  }
  const status = reminderStatus(entry)
  const overdue = !status.allNotified && status.at <= now
  return {
    text: status.allNotified ? '已处理' : overdue ? '已到期' : formatRelative(status.at),
    overdue,
  }
}

interface EntryListProps {
  selectedId: string | null
  onSelect: (id: string) => void
}

/** 左侧主从列表：全部条目按行展示，点击选中后在右侧详情编辑；待办分类下已完成条目自动归入下方「已完成」分组 */
export function EntryList({ selectedId, onSelect }: EntryListProps) {
  const filter = useEntryStore((state) => state.filter)
  const entries = useEntryStore((state) => state.entries)
  const search = useEntryStore((state) => state.search)
  const tagFilter = useEntryStore((state) => state.tagFilter)
  const timeRange = useEntryStore((state) => state.timeRange)
  const sortBy = useEntryStore((state) => state.sortBy)
  const now = useNow()

  const filtered = filterEntries(entries, search, tagFilter, timeRange)
  const list = sortEntries(filter, filtered, sortBy)

  // 分组视图：待办分类与「全部」都拆「进行中/其他」与「已完成（待办）」两组，
  // 待办勾选完成后自动归入下方「已完成」区
  const isTodoFilter = filter === 'todo'
  const activeRows = isTodoFilter
    ? list.filter((entry) => entry.kind === 'todo' && !todoAllDone(entry))
    : list.filter((entry) => !(entry.kind === 'todo' && todoAllDone(entry)))
  const doneRows = list.filter((entry) => entry.kind === 'todo' && todoAllDone(entry))

  const renderRow = (entry: Entry) => {
    const icon = KIND_ICON[entry.kind]
    const meta = rowMeta(entry, now)
    const doneClass = entry.kind === 'todo' && todoAllDone(entry) ? 'done' : ''
    return (
      <button
        key={entry.id}
        type="button"
        className={`note-row kind-${entry.kind} ${selectedId === entry.id ? 'active' : ''} ${meta.overdue ? 'overdue' : ''} ${doneClass}`}
        onClick={() => onSelect(entry.id)}
      >
        <span className="row-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="row-main">
          <span className="row-title">{entry.title || '无标题'}</span>
          <span className={`row-meta ${meta.overdue ? 'overdue' : ''}`}>{meta.text}</span>
        </span>
      </button>
    )
  }

  if (list.length === 0) {
    return (
      <div className="entry-list flex-center flex-col gap-2 pt-8" data-tauri-drag-region="false">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有内容" />
        <span className="text-xs color-muted">点右上角 + 新建一条</span>
      </div>
    )
  }

  return (
    <div className="entry-list" data-tauri-drag-region="false">
      {activeRows.map(renderRow)}
      {doneRows.length > 0 && (
        <>
          <div className="list-group-head">已完成</div>
          {doneRows.map(renderRow)}
        </>
      )}
    </div>
  )
}
