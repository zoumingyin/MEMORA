import { useState } from 'react'
import { Check, X } from 'lucide-react'
import type { Entry, ReminderEntry } from '../types/entry'
import { toInputValue } from '../utils/format'

interface EntryEditorProps {
  entry: Entry
  onSave: (patch: Partial<Entry>) => Promise<void> | void
  onCancel: () => void
}

/** 条目内联编辑表单：预填现有标题 / 备注 / 提醒时间，保存或取消 */
export function EntryEditor({ entry, onSave, onCancel }: EntryEditorProps) {
  const [title, setTitle] = useState(entry.title)
  const [content, setContent] = useState(entry.content)
  const [remindAt, setRemindAt] = useState(() =>
    entry.kind === 'reminder' ? toInputValue(entry.remindAt) : '',
  )
  const [saving, setSaving] = useState(false)

  const remindTimestamp = new Date(remindAt).getTime()
  const remindValid = entry.kind !== 'reminder' || Number.isFinite(remindTimestamp)
  const canSubmit = title.trim().length > 0 && remindValid && !saving

  const handleSave = async (): Promise<void> => {
    if (!canSubmit) return
    setSaving(true)
    try {
      if (entry.kind === 'reminder') {
        const reminderPatch: Partial<ReminderEntry> = {
          title: title.trim(),
          content: content.trim(),
          remindAt: remindTimestamp,
          // 重新设定提醒时间后重置已通知标记，重新纳入到期调度
          notified: false,
        }
        await onSave(reminderPatch)
      } else {
        await onSave({
          title: title.trim(),
          content: content.trim(),
        })
      }
    } finally {
      setSaving(false)
    }
  }

  const titlePlaceholder =
    entry.kind === 'todo' ? '要做什么？' : entry.kind === 'reminder' ? '提醒什么事？' : '备忘标题'

  return (
    <div
      className="entry-editor"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel()
      }}
    >
      <input
        type="text"
        value={title}
        placeholder={titlePlaceholder}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void handleSave()
        }}
        autoFocus
      />
      <textarea
        value={content}
        placeholder="备注（可选）"
        onChange={(event) => setContent(event.target.value)}
      />
      {entry.kind === 'reminder' && (
        <input
          type="datetime-local"
          value={remindAt}
          onChange={(event) => setRemindAt(event.target.value)}
        />
      )}
      <div className="entry-editor-footer">
        <button type="button" className="ghost-btn" onClick={onCancel}>
          <X size={13} />
          取消
        </button>
        <button
          type="button"
          className="primary-btn"
          disabled={!canSubmit}
          onClick={() => void handleSave()}
        >
          <Check size={13} />
          保存
        </button>
      </div>
    </div>
  )
}
