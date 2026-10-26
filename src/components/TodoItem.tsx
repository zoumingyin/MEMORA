import { useState } from 'react'
import { Check, Pencil, Trash2 } from 'lucide-react'
import { useEntryStore } from '../store/useEntryStore'
import type { TodoEntry } from '../types/entry'
import { formatShort } from '../utils/format'
import { EntryEditor } from './EntryEditor'

interface TodoItemProps {
  entry: TodoEntry
  onToggle: (id: string) => void
  onRemove: (id: string) => void
}

export function TodoItem({ entry, onToggle, onRemove }: TodoItemProps) {
  const updateEntry = useEntryStore((state) => state.updateEntry)
  const [editing, setEditing] = useState(false)

  if (editing) {
    return (
      <article className="entry-card todo-card">
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
    <article className={`entry-card todo-card ${entry.done ? 'done' : ''}`}>
      <div className="entry-card-head">
        <button
          type="button"
          className={`todo-checkbox ${entry.done ? 'checked' : ''}`}
          title={entry.done ? '标记为未完成' : '标记为完成'}
          onClick={() => onToggle(entry.id)}
        >
          {entry.done && <Check size={13} />}
        </button>
        <span className={`entry-title ${entry.done ? 'done' : ''}`}>
          {entry.title}
        </span>
        <div className="entry-card-actions">
          {!entry.done && (
            <button
              type="button"
              className="icon-btn"
              title="编辑待办"
              onClick={() => setEditing(true)}
            >
              <Pencil size={14} />
            </button>
          )}
          <button
            type="button"
            className="icon-btn danger"
            title="删除待办"
            onClick={() => onRemove(entry.id)}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      {entry.content && <p className="entry-content">{entry.content}</p>}
      <div className="entry-meta">
        {entry.completedAt ? (
          <span>完成于 {formatShort(entry.completedAt)}</span>
        ) : (
          <span>创建于 {formatShort(entry.createdAt)}</span>
        )}
      </div>
    </article>
  )
}
