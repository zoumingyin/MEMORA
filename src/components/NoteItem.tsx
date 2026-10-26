import { useState } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import { useEntryStore } from '../store/useEntryStore'
import type { NoteEntry } from '../types/entry'
import { formatShort } from '../utils/format'
import { EntryEditor } from './EntryEditor'

interface NoteItemProps {
  entry: NoteEntry
  onRemove: (id: string) => void
}

export function NoteItem({ entry, onRemove }: NoteItemProps) {
  const updateEntry = useEntryStore((state) => state.updateEntry)
  const [editing, setEditing] = useState(false)

  if (editing) {
    return (
      <article className="entry-card note-card">
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
    <article className="entry-card note-card">
      <div className="entry-card-head">
        <span className="entry-title">{entry.title}</span>
        <div className="entry-card-actions">
          <button
            type="button"
            className="icon-btn"
            title="编辑备忘"
            onClick={() => setEditing(true)}
          >
            <Pencil size={14} />
          </button>
          <button
            type="button"
            className="icon-btn danger"
            title="删除备忘"
            onClick={() => onRemove(entry.id)}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      {entry.content && <p className="entry-content">{entry.content}</p>}
      <div className="entry-meta">
        <span>更新于 {formatShort(entry.updatedAt)}</span>
      </div>
    </article>
  )
}
