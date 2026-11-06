import type { Entry } from '../types/entry'
import { useEntryStore } from '../store/useEntryStore'

/** 标签聚合信息：标签名 + 使用条数 */
export interface TagCount {
  tag: string
  count: number
}

/** 收集全部标签并聚合计数：按使用次数降序、次数相同按中文拼音排序 */
export function collectTagCounts(entries: Entry[]): TagCount[] {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    for (const tag of entry.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
    .map(([tag, count]) => ({ tag, count }))
}

/**
 * 批量改写标签：把 source 批量改为 target；target 为 null 时移除该标签。
 * 重命名到已存在标签等价于合并（去重）；当前标签筛选指向被改写标签时同步到新值。
 */
export async function rewriteTag(source: string, target: string | null): Promise<void> {
  const state = useEntryStore.getState()
  const affected = state.entries.filter((entry) => entry.tags.includes(source))
  for (const entry of affected) {
    const nextTags = target
      ? [...new Set(entry.tags.map((tag) => (tag === source ? target : tag)))]
      : entry.tags.filter((tag) => tag !== source)
    await state.updateEntry(entry.id, { tags: nextTags })
  }
  if (useEntryStore.getState().tagFilter === source) {
    useEntryStore.getState().setTagFilter(target)
  }
}
