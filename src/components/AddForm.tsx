import { useState } from 'react'
import { Plus } from 'lucide-react'
import { useEntryStore } from '../store/useEntryStore'
import { toInputValue } from '../utils/format'

const HINT: Record<string, string> = {
  note: '随手记下，自动保存到本机',
  todo: '完成后点击方框勾选归档',
  reminder: '到点弹出居中提醒弹窗',
}

export function AddForm() {
  const currentKind = useEntryStore((state) => state.currentKind)
  const addEntry = useEntryStore((state) => state.addEntry)

  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [remindAt, setRemindAt] = useState(() =>
    toInputValue(Date.now() + 3600_000),
  )

  const remindTimestamp = new Date(remindAt).getTime()
  const remindValid =
    currentKind !== 'reminder' || Number.isFinite(remindTimestamp)
  const canSubmit = title.trim().length > 0 && remindValid

  const handleSubmit = async () => {
    if (!canSubmit) return
    await addEntry({
      title,
      content,
      remindAt:
        currentKind === 'reminder' ? remindTimestamp : undefined,
    })
    setTitle('')
    setContent('')
    if (currentKind === 'reminder') {
      setRemindAt(toInputValue(Date.now() + 3600_000))
    }
  }

  const titlePlaceholder =
    currentKind === 'todo' ? '要做什么？' : currentKind === 'reminder' ? '提醒什么事？' : '备忘标题'
  const contentPlaceholder =
    currentKind === 'note' ? '记点什么…' : '备注（可选）'

  return (
    <section className="add-form">
      <input
        type="text"
        value={title}
        placeholder={titlePlaceholder}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void handleSubmit()
        }}
      />
      <textarea
        value={content}
        placeholder={contentPlaceholder}
        onChange={(event) => setContent(event.target.value)}
      />
      {currentKind === 'reminder' && (
        <input
          type="datetime-local"
          value={remindAt}
          onChange={(event) => setRemindAt(event.target.value)}
        />
      )}
      <div className="add-form-footer">
        <span className="add-form-hint">{HINT[currentKind]}</span>
        <button
          type="button"
          className="primary-btn"
          disabled={!canSubmit}
          onClick={() => void handleSubmit()}
        >
          <Plus size={14} />
          添加
        </button>
      </div>
    </section>
  )
}
