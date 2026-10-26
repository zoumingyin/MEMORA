import { useState } from 'react'
import { AlarmClock, Check, Pencil, Trash2 } from 'lucide-react'
import { useEntryStore } from '../store/useEntryStore'
import type { ReminderEntry } from '../types/entry'
import { useNow } from '../hooks/useNow'
import { formatRelative, formatShort } from '../utils/format'
import { EntryEditor } from './EntryEditor'

interface ReminderItemProps {
  entry: ReminderEntry
  onToggle: (id: string) => void
  onRemove: (id: string) => void
}

export function ReminderItem({ entry, onToggle, onRemove }: ReminderItemProps) {
  const updateEntry = useEntryStore((state) => state.updateEntry)
  const [editing, setEditing] = useState(false)
  const now = useNow()
  const overdue = !entry.done && entry.remindAt <= now

  if (editing) {
    return (
      <article className="entry-card reminder-card">
        <EntryEditor
          entry={entry}
          onCancel={() => setEditing(false)}
          onSave={async (patch) => {
            await updateEntry(entry.id, patch)
            setEditing(false)
          }}
        />
      </article>
    )
  }

  return (
    <article
      className={`entry-card reminder-card ${entry.done ? 'done' : ''} ${overdue ? 'overdue' : ''}`}
    >
      <div className="entry-card-head">
        <span className={`entry-title ${entry.done ? 'done' : ''}`}>
          {entry.title}
        </span>
        <div className="entry-card-actions">
          <button
            type="button"
            className="icon-btn"
            title={entry.done ? '取消处理标记' : '标记为已处理'}
            onClick={() => onToggle(entry.id)}
          >
            <Check size={14} />
          </button>
          {!entry.done && (
            <button
              type="button"
              className="icon-btn"
              title="编辑提醒"
              onClick={() => setEditing(true)}
            >
              <Pencil size={14} />
            </button>
          )}
          <button
            type="button"
            className="icon-btn danger"
            title="删除提醒"
            onClick={() => onRemove(entry.id)}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      {entry.content && <p className="entry-content">{entry.content}</p>}
      <div className="entry-meta">
        <span className={`reminder-time ${overdue ? 'overdue' : ''}`}>
          <AlarmClock size={12} />
          {entry.done ? '已处理' : overdue ? '已到期' : formatRelative(entry.remindAt)}
        </span>
        <span>{formatShort(entry.remindAt)}</span>
      </div>
    </article>
  )
}
