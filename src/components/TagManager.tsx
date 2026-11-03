import { useMemo, useState } from 'react'
import { Button, Input, Popconfirm, Select } from 'antd'
import { DeleteOutlined, EditOutlined, SwapOutlined } from '@ant-design/icons'
import { useEntryStore } from '../store/useEntryStore'

interface TagCount {
  tag: string
  count: number
}

/**
 * 标签管理：列出全部标签及使用计数，支持重命名、合并到其他标签、删除。
 * 删除只移除引用，不会删除便签；重命名到已存在的标签等价于合并（自动去重）。
 */
export function TagManager() {
  const entries = useEntryStore((state) => state.entries)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [merging, setMerging] = useState<string | null>(null)
  const [mergeTarget, setMergeTarget] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const tags = useMemo<TagCount[]>(() => {
    const counts = new Map<string, number>()
    for (const entry of entries) {
      for (const tag of entry.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1)
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
      .map(([tag, count]) => ({ tag, count }))
  }, [entries])

  /** 把 source 标签批量改写为 target；target 为 null 时移除 */
  const rewriteTag = async (source: string, target: string | null): Promise<void> => {
    setBusy(true)
    try {
      const state = useEntryStore.getState()
      const affected = state.entries.filter((entry) => entry.tags.includes(source))
      for (const entry of affected) {
        const nextTags = target
          ? [...new Set(entry.tags.map((tag) => (tag === source ? target : tag)))]
          : entry.tags.filter((tag) => tag !== source)
        await state.updateEntry(entry.id, { tags: nextTags })
      }
      // 当前筛选指向被改写的标签时同步到新值（删除则回到全部标签）
      if (useEntryStore.getState().tagFilter === source) {
        useEntryStore.getState().setTagFilter(target)
      }
    } finally {
      setBusy(false)
    }
  }

  const startRename = (tag: string): void => {
    setEditing(tag)
    setDraft(tag)
    setMerging(null)
    setMergeTarget(null)
  }

  const commitRename = async (): Promise<void> => {
    if (!editing) return
    const target = draft.trim()
    if (!target || target === editing) {
      setEditing(null)
      return
    }
    await rewriteTag(editing, target)
    setEditing(null)
  }

  const startMerge = (tag: string): void => {
    setMerging(tag)
    setMergeTarget(null)
    setEditing(null)
  }

  const commitMerge = async (): Promise<void> => {
    if (!merging || !mergeTarget) return
    await rewriteTag(merging, mergeTarget)
    setMerging(null)
    setMergeTarget(null)
  }

  if (tags.length === 0) {
    return (
      <div className="settings-item">
        <div className="settings-item-main">
          <span className="settings-item-label">标签</span>
          <span className="settings-item-hint">
            还没有标签，可在便签详情标题下方添加
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1">
      {tags.map(({ tag, count }) => {
        const isEditing = editing === tag
        const isMerging = merging === tag
        return (
          <div key={tag} className="settings-item">
            <div className="settings-item-main">
              {isEditing ? (
                <Input
                  size="small"
                  autoFocus
                  value={draft}
                  maxLength={20}
                  onChange={(event) => setDraft(event.target.value)}
                  onPressEnter={() => void commitRename()}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setEditing(null)
                  }}
                />
              ) : isMerging ? (
                <Select
                  size="small"
                  autoFocus
                  className="min-w-[140px]"
                  placeholder="选择目标标签"
                  value={mergeTarget}
                  onChange={setMergeTarget}
                  options={tags
                    .filter((item) => item.tag !== tag)
                    .map((item) => ({ value: item.tag, label: item.tag }))}
                />
              ) : (
                <>
                  <span className="settings-item-label">{tag}</span>
                  <span className="settings-item-hint">{count} 条便签</span>
                </>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-1">
              {isEditing ? (
                <>
                  <Button size="small" type="primary" disabled={busy} onClick={() => void commitRename()}>
                    保存
                  </Button>
                  <Button size="small" disabled={busy} onClick={() => setEditing(null)}>
                    取消
                  </Button>
                </>
              ) : isMerging ? (
                <>
                  <Button
                    size="small"
                    type="primary"
                    disabled={busy || !mergeTarget}
                    onClick={() => void commitMerge()}
                  >
                    合并
                  </Button>
                  <Button size="small" disabled={busy} onClick={() => setMerging(null)}>
                    取消
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    size="small"
                    type="text"
                    title={`重命名「${tag}」`}
                    aria-label={`重命名 ${tag}`}
                    icon={<EditOutlined />}
                    disabled={busy}
                    onClick={() => startRename(tag)}
                  />
                  <Button
                    size="small"
                    type="text"
                    title={`把「${tag}」合并到其他标签`}
                    aria-label={`合并 ${tag}`}
                    icon={<SwapOutlined />}
                    disabled={busy || tags.length < 2}
                    onClick={() => startMerge(tag)}
                  />
                  <Popconfirm
                    title={`删除标签「${tag}」？`}
                    description="只移除标签，不会删除便签"
                    okText="删除"
                    cancelText="取消"
                    onConfirm={() => void rewriteTag(tag, null)}
                  >
                    <Button
                      size="small"
                      type="text"
                      danger
                      title={`删除「${tag}」`}
                      aria-label={`删除 ${tag}`}
                      icon={<DeleteOutlined />}
                      disabled={busy}
                    />
                  </Popconfirm>
                </>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
