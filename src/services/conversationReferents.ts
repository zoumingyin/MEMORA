import { hasWriteActionClause } from './agentTargets'
import type { ConversationMemory, MemoryEntity } from './conversationMemory'
import type { Entry, EntryKind } from '../types/entry'

/**
 * 多轮对话指代解析（纯逻辑）：
 * - 只把「工具真实返回过的条目」当作候选，来源由 conversationMemory 提供；
 * - 指代必须唯一解析才允许进入写入目标集合，多个候选一律询问；
 * - 解析结果仍要经过执行层的权限、目标来源与同名歧义校验；
 * - 条目已删除、类型变化时直接失效并询问，不默认选择第一条。
 */

export type ConversationReferentKind =
  | 'latest'
  | 'last'
  | 'ordinal'
  | 'demonstrative'
  | 'supplement'

export interface DetectedReferent {
  kind: ConversationReferentKind
  phrase: string
  ordinal?: number
  kindFilter?: EntryKind
}

export type ReferentStatus = 'resolved' | 'ambiguous' | 'missing' | 'stale'

export interface ReferentResolution {
  status: ReferentStatus
  kind: ConversationReferentKind
  phrase: string
  /** 当前仍存在、且符合类型过滤的候选（按时间顺序） */
  candidates: MemoryEntity[]
  entry: MemoryEntity | null
  /** 非 resolved 时必须向用户提出的唯一问题 */
  question: string | null
}

const ORDINAL_PATTERN = /第\s*([0-9一二三四五六七八九十两]+)\s*(?:条|个|项|款)/
const LAST_PATTERN = /最后\s*(?:一)?\s*(?:条|个|项)/
const SUPPLEMENT_PATTERN =
  /(?:再|继续)(?:补充|追加|完善|加)(?:一点|一些|一下|点|些)?|补充一下|追加一下|继续(?:刚才|上面|之前)|接着(?:刚才|上面|之前)/
const LATEST_PATTERN =
  /刚才|刚刚|上一条|上一个|前面(?:那条|那个|的|提到)|之前(?:那条|那个|的|提到)|上面提到的|刚才(?:创建|新建|添加|的)/
const DEMONSTRATIVE_PATTERN =
  /把它|将它|给它|把这条|把那条|把那个|把上面|(?<!其)它|这条|那条|这个|那个/

const CN_NUMBERS: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
}

function parseOrdinal(raw: string): number | null {
  if (/^\d+$/.test(raw)) {
    const value = Number.parseInt(raw, 10)
    return Number.isFinite(value) && value > 0 ? value : null
  }
  if (raw === '十') return 10
  if (raw.startsWith('十')) {
    const unit = CN_NUMBERS[raw.slice(1)]
    return unit ? 10 + unit : null
  }
  if (raw.endsWith('十')) {
    const tens = CN_NUMBERS[raw.slice(0, -1)]
    return tens ? tens * 10 : null
  }
  return CN_NUMBERS[raw] ?? null
}

function kindFilterOf(text: string): EntryKind | undefined {
  const kinds: EntryKind[] = []
  if (/(?:笔记|便签|备忘)/.test(text)) kinds.push('note')
  if (/(?:待办|清单)/.test(text)) kinds.push('todo')
  if (/(?:提醒|闹钟)/.test(text)) kinds.push('reminder')
  return kinds.length === 1 ? kinds[0] : undefined
}

/** 识别当前消息是否含有指向历史对话的指代；没有则返回 null */
export function detectConversationReferent(text: string): DetectedReferent | null {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return null
  const kindFilter = kindFilterOf(normalized)

  const ordinal = ORDINAL_PATTERN.exec(normalized)
  if (ordinal) {
    const value = parseOrdinal(ordinal[1])
    if (value !== null) {
      return {
        kind: 'ordinal',
        phrase: ordinal[0],
        ordinal: value,
        ...(kindFilter ? { kindFilter } : {}),
      }
    }
  }

  const last = LAST_PATTERN.exec(normalized)
  if (last) {
    return {
      kind: 'last',
      phrase: last[0],
      ...(kindFilter ? { kindFilter } : {}),
    }
  }

  const supplement = hasWriteActionClause(normalized)
    ? SUPPLEMENT_PATTERN.exec(normalized)
    : null
  if (supplement) {
    return {
      kind: 'supplement',
      phrase: supplement[0],
      ...(kindFilter ? { kindFilter } : {}),
    }
  }

  const latest = LATEST_PATTERN.exec(normalized)
  if (latest) {
    return {
      kind: 'latest',
      phrase: latest[0],
      ...(kindFilter ? { kindFilter } : {}),
    }
  }

  const demonstrative = hasWriteActionClause(normalized)
    ? DEMONSTRATIVE_PATTERN.exec(normalized)
    : null
  if (demonstrative) {
    return {
      kind: 'demonstrative',
      phrase: demonstrative[0],
      ...(kindFilter ? { kindFilter } : {}),
    }
  }
  return null
}

function dedupeRecentFirst(entities: MemoryEntity[]): MemoryEntity[] {
  const seen = new Set<string>()
  const result: MemoryEntity[] = []
  for (let index = entities.length - 1; index >= 0; index -= 1) {
    const entity = entities[index]
    if (seen.has(entity.id)) continue
    seen.add(entity.id)
    result.push(entity)
  }
  return result
}

/** 最近一条包含匹配实体的助手消息里的全部匹配实体（按步骤顺序） */
function lastBatchMatching(
  entities: MemoryEntity[],
  predicate: (entity: MemoryEntity) => boolean,
): MemoryEntity[] {
  for (let index = entities.length - 1; index >= 0; index -= 1) {
    if (!predicate(entities[index])) continue
    const messageId = entities[index].messageId
    return entities.filter((entity) => entity.messageId === messageId && predicate(entity))
  }
  return []
}

function lastSearchList(memory: ConversationMemory): MemoryEntity[] {
  if (memory.lastList.length > 0) return memory.lastList
  return lastBatchMatching(
    memory.entities,
    (entity) => entity.origin === 'created' || entity.origin === 'updated',
  )
}

function candidateQuestion(candidates: MemoryEntity[]): string {
  const items = candidates
    .slice(0, 5)
    .map((entity, index) => `${index + 1}. 「${entity.title}」`)
    .join('；')
  return `你指的是哪一条？请回复序号或标题（候选：${items}）。`
}

function staleQuestion(candidates: MemoryEntity[]): string {
  const titles = candidates
    .slice(0, 3)
    .map((entity) => `「${entity.title}」`)
    .join('、')
  return `你提到的${titles}已不存在或已被删除，请重新说明要操作哪一条。`
}

/**
 * 解析当前消息中的历史指代。
 * - entries 传入时按当前真实数据刷新并剔除已删除 / 类型变化的条目；
 * - 无法唯一解析时返回 question，调用方必须进入 needsInput，禁止写入。
 */
export function resolveConversationReferent(
  text: string,
  memory: ConversationMemory,
  entries?: Entry[],
): ReferentResolution | null {
  const detected = detectConversationReferent(text)
  if (!detected) return null

  const byId = entries ? new Map(entries.map((entry) => [entry.id, entry])) : null
  const isLive = (entity: MemoryEntity): boolean => {
    if (!byId) return true
    const entry = byId.get(entity.id)
    return entry !== undefined && entry.kind === entity.kind
  }
  const currentTitle = (entity: MemoryEntity): string => {
    if (!byId) return entity.title
    const entry = byId.get(entity.id)
    return entry ? entry.title.trim() || '无标题' : entity.title
  }

  const all = dedupeRecentFirst(memory.entities)
  const scoped = detected.kindFilter
    ? all.filter((entity) => entity.kind === detected.kindFilter)
    : all
  const live = scoped.filter(isLive).map((entity) => ({
    ...entity,
    title: currentTitle(entity),
  }))
  const stale = scoped.filter((entity) => !isLive(entity))

  const unresolved = (): ReferentResolution => ({
    status: stale.length > 0 ? 'stale' : 'missing',
    kind: detected.kind,
    phrase: detected.phrase,
    candidates: live,
    entry: null,
    question: stale.length > 0 ? staleQuestion(stale) : '我没有找到你刚才提到的条目，请说明要操作的笔记标题，或重新告诉我是哪一条。',
  })

  const ambiguous = (candidates: MemoryEntity[]): ReferentResolution => ({
    status: 'ambiguous',
    kind: detected.kind,
    phrase: detected.phrase,
    candidates,
    entry: null,
    question: candidateQuestion(candidates),
  })

  const resolved = (entity: MemoryEntity): ReferentResolution => ({
    status: 'resolved',
    kind: detected.kind,
    phrase: detected.phrase,
    candidates: live,
    entry: entity,
    question: null,
  })

  if (detected.kind === 'ordinal') {
    const base = lastSearchList(memory)
      .filter((entity) => (detected.kindFilter ? entity.kind === detected.kindFilter : true))
      .filter(isLive)
      .map((entity) => ({ ...entity, title: currentTitle(entity) }))
    const ordinal = detected.ordinal ?? 0
    if (ordinal < 1 || ordinal > base.length) {
      return {
        status: 'missing',
        kind: detected.kind,
        phrase: detected.phrase,
        candidates: base,
        entry: null,
        question:
          base.length === 0
            ? '当前对话里没有可编号的候选列表，请先查询，或直接说明要操作的笔记标题。'
            : `候选列表里没有第 ${ordinal} 条（共 ${base.length} 条），请确认序号或标题。`,
      }
    }
    return resolved(base[ordinal - 1])
  }

  if (detected.kind === 'last') {
    // 优先按「最近一次查询结果的展示顺序」取最后一条；没有查询时取最后创建/修改的一条
    const list = lastSearchList(memory)
      .filter((entity) => (detected.kindFilter ? entity.kind === detected.kindFilter : true))
      .filter(isLive)
      .map((entity) => ({ ...entity, title: currentTitle(entity) }))
    if (list.length > 0) return resolved(list[list.length - 1])
    if (live.length === 0) return unresolved()
    return resolved(live[0])
  }

  if (detected.kind === 'supplement') {
    const batch = lastBatchMatching(
      memory.entities,
      (entity) => entity.origin === 'created' || entity.origin === 'updated',
    )
      .filter((entity) => (detected.kindFilter ? entity.kind === detected.kindFilter : true))
      .filter(isLive)
      .map((entity) => ({ ...entity, title: currentTitle(entity) }))
    if (batch.length === 1) return resolved(batch[0])
    if (batch.length > 1) return ambiguous(batch)
    if (live.length === 1) return resolved(live[0])
    if (live.length > 1) return ambiguous(live)
    return unresolved()
  }

  if (detected.kind === 'latest') {
    const batch = lastBatchMatching(memory.entities, () => true)
      .filter((entity) => (detected.kindFilter ? entity.kind === detected.kindFilter : true))
      .filter(isLive)
      .map((entity) => ({ ...entity, title: currentTitle(entity) }))
    if (batch.length === 1) return resolved(batch[0])
    if (batch.length > 1) return ambiguous(batch)
    if (live.length === 1) return resolved(live[0])
    if (live.length > 1) return ambiguous(live)
    return unresolved()
  }

  // demonstrative：本轮唯一候选优先，其次最后一批里恰好一条
  if (live.length === 0) return unresolved()
  if (live.length === 1) return resolved(live[0])
  const batch = lastBatchMatching(memory.entities, () => true)
    .filter((entity) => (detected.kindFilter ? entity.kind === detected.kindFilter : true))
    .filter(isLive)
    .map((entity) => ({ ...entity, title: currentTitle(entity) }))
  if (batch.length === 1) return resolved(batch[0])
  return ambiguous(live)
}
