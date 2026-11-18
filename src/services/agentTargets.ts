import type { Entry, EntryKind } from '../types/entry'

/**
 * Agent 目标来源与歧义判定（纯逻辑）：
 * - 只判断「这个 id 来自哪里」和「标题是否歧义」，不读取 store；
 * - 执行层据此决定 update / delete 是否放行；
 * - 不把标题相似度当作执行授权，只用作拦截信号。
 */

export type TargetTrustSource =
  | 'user_explicit'
  | 'user_selected'
  | 'tool_result'
  | 'created'
  | 'authorized_selection'
  /** 本轮用户用「刚才那条 / 第二条 / 它」指代，且对话记忆唯一解析出的真实目标 */
  | 'conversation_referent'

export interface TargetCandidate {
  id: string
  kind: EntryKind
  title: string
  updatedAt: number
}

const TITLE_SEPARATOR = /[\s，,。；;：:！!？?、（）()【】[\]「」『』"'“”‘’·—\-_/\\]+/g

export function compactTitle(title: string): string {
  return title.replace(TITLE_SEPARATOR, '').toLowerCase()
}

function bigrams(text: string): Set<string> {
  const result = new Set<string>()
  for (let index = 0; index < text.length - 1; index += 1) {
    result.add(text.slice(index, index + 2))
  }
  return result
}

/** 高相似：完全相同、包含关系，或字符二元组 Dice 系数达到阈值 */
export function titlesAreSimilar(left: string, right: string): boolean {
  const a = compactTitle(left)
  const b = compactTitle(right)
  if (!a || !b) return false
  if (a === b) return true
  const shorter = a.length <= b.length ? a : b
  const longer = a.length <= b.length ? b : a
  if (shorter.length >= 3 && longer.includes(shorter)) return true
  if (shorter.length >= 2 && longer.startsWith(shorter) && longer.length - shorter.length <= 4) {
    return true
  }
  if (shorter.length >= 2 && longer.endsWith(shorter) && longer.length - shorter.length <= 4) {
    return true
  }
  const leftPairs = bigrams(a)
  const rightPairs = bigrams(b)
  if (leftPairs.size === 0 || rightPairs.size === 0) return false
  let overlap = 0
  for (const pair of leftPairs) if (rightPairs.has(pair)) overlap += 1
  return (2 * overlap) / (leftPairs.size + rightPairs.size) >= 0.8
}

export function toTargetCandidate(entry: Entry): TargetCandidate {
  const title = entry.title.trim() || '无标题'
  return {
    id: entry.id,
    kind: entry.kind,
    title,
    updatedAt: entry.updatedAt,
  }
}

/**
 * 找出与目标同名或高度相似的其它条目。
 * 返回结果包含目标自身，便于用户在执行记录里看到完整候选。
 */
export function findAmbiguousTargets(
  target: Entry,
  entries: Entry[],
): { exact: Entry[]; similar: Entry[] } {
  const title = target.title.trim() || '无标题'
  const exact: Entry[] = []
  const similar: Entry[] = []
  for (const entry of entries) {
    if (entry.id === target.id) continue
    const otherTitle = entry.title.trim() || '无标题'
    if (compactTitle(otherTitle) === compactTitle(title)) {
      exact.push(entry)
    } else if (titlesAreSimilar(title, otherTitle)) {
      similar.push(entry)
    }
  }
  return { exact, similar }
}

export function formatAmbiguousTargets(
  target: Entry,
  exact: Entry[],
  similar: Entry[],
): string {
  const all = [target, ...exact, ...similar]
  const unique = Array.from(new Map(all.map((entry) => [entry.id, entry])).values()).slice(0, 6)
  return unique
    .map((entry) => {
      const candidate = toTargetCandidate(entry)
      const kind = { note: '备忘', todo: '待办', reminder: '提醒', draw: '涂鸦' }[
        candidate.kind
      ]
      return `id=${candidate.id} [${kind}]「${candidate.title}」`
    })
    .join('；')
}

/** 从用户原文里提取显式 id：UUID，或 id: xxx / id=xxx 形式 */
export function extractExplicitEntryIds(text: string): string[] {
  const ids = new Set<string>()
  const uuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
  for (const match of text.matchAll(uuid)) ids.add(match[0])
  const labeled = /\bid\s*[:：=]?\s*([A-Za-z0-9_-]{8,})/gi
  for (const match of text.matchAll(labeled)) ids.add(match[1])
  return Array.from(ids)
}

/**
 * 显式 id 也必须与写动作处于同一从句。
 * 例如「查看 id xxx」只是查询，不能因为原文出现 id 就授权修改或删除。
 */
export function resolveExplicitIdTargets(text: string, entries: Entry[]): Entry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const targets = new Map<string, Entry>()
  for (const clause of splitClauses(text)) {
    if (!hasTargetAction(clause)) continue
    for (const id of extractExplicitEntryIds(clause)) {
      const entry = byId.get(id)
      if (entry) targets.set(entry.id, entry)
    }
  }
  return Array.from(targets.values())
}

const CLAUSE_SEPARATOR =
  /(?:[，,。；;！!？?\n]+|然后|接着|之后|同时|顺便|再(?=\s*(?:把|将|修改|更改|改动|改|更新|删除|删|移除|清理|清掉|去掉|重命名|调整|补充|追加|替换|勾选|标记|设置|设|编辑|完善|添加|加|移除)))/g

/** 对象操作意图必须出现在从句的谓语位置，避免把「有哪些修改」这类名词用法当成写指令 */
const TARGET_ACTION_AT_START =
  /^(?:请(?:你)?|帮我|给我|替我|麻烦(?:你)?|我想|我要|想要|需要|把|将|再|然后|接着|之后|同时|顺便)?\s*(?:修改|更改|改动|改一下|改下|改(?!天|变|口|观|善)|更新|删除|删掉|删|移除|清理|清掉|去掉|重命名|改名|调整|补充|追加|替换|勾选|标记|设为|设置为|设成|编辑|完善|添加标签|加标签|移除标签)/
const TARGET_ACTION_WITH_SUFFIX =
  /(?:修改|更改|改动|改|更新|删除|删掉|移除|清理|清掉|去掉|重命名|改名|调整|补充|追加|替换|勾选|标记|设为|设置为|设成|编辑|完善|添加标签|加标签|移除标签)(?:一下|下|为|成|掉|除|到|完成|标签|标题)/
const DIRECTED_TARGET = /(?:把|将)[^，,。；;！!？?]{0,40}(?:修改|更改|改动|改|更新|删除|删|移除|清理|清掉|去掉|重命名|调整|补充|追加|替换|勾选|标记|设为|设置|编辑|完善|添加标签|加标签|移除标签)/
const CREATE_CLAUSE =
  /(?:创建|新建|新增|添加|加一条|加个|记一下|记一条|记一笔|保存为|建一个|建一条|提醒我|安排)/
const DESTINATION =
  /(?:改成|改为|修改为|更新为|更新成|重命名为|改名成|改名为|换成|换为|命名为|叫做|改叫|设为|设成|设置为|定为|调整为|标记为|修改标题为|改标题为|标题设为|标题设置为|标题定为|标题调整为)[^，,。；;\n]*/g

function hasTargetAction(clause: string): boolean {
  return (
    TARGET_ACTION_AT_START.test(clause) ||
    TARGET_ACTION_WITH_SUFFIX.test(clause) ||
    DIRECTED_TARGET.test(clause)
  )
}

function splitClauses(text: string): string[] {
  return text
    .split(CLAUSE_SEPARATOR)
    .map((clause) => clause.trim())
    .filter(Boolean)
}

/** 文本中是否存在同时包含写动作的从句（供对话指代解析复用同一套写意图词表） */
export function hasWriteActionClause(text: string): boolean {
  return splitClauses(text).some(hasTargetAction)
}

const CLAUSE_BOUNDARY = /[，,。；;！!？?\n]|然后|接着|之后|同时|顺便/g

/**
 * 指代词是否与写动作处于同一从句。
 * 防止「刚才那条是什么？另外把周报改成……」把旧目标带进写入授权。
 */
export function hasReferentWriteClause(text: string, phraseIndex: number): boolean {
  if (phraseIndex < 0) return hasWriteActionClause(text)
  let start = 0
  let end = text.length
  for (const match of text.matchAll(CLAUSE_BOUNDARY)) {
    const at = match.index ?? 0
    if (at <= phraseIndex) {
      start = at + match[0].length
      continue
    }
    end = at
    break
  }
  return hasTargetAction(text.slice(start, end))
}

/** 文本中是否存在某个从句同时包含写动作与指定指代（用于选中条目授权） */
export function hasSelectedReferentWriteIntent(text: string): boolean {
  return splitClauses(text).some(
    (clause) =>
      hasTargetAction(clause) &&
      /(?:这个|当前|选中|这条|这篇|本条|该便签|该条目)/.test(clause),
  )
}

function matchTitles(clause: string, entries: Entry[]): Entry[] {
  const compact = compactTitle(clause.replace(DESTINATION, ''))
  if (!compact) return []
  const matches = entries.filter((entry) => {
    const title = compactTitle(entry.title)
    return title.length >= 2 && compact.includes(title)
  })
  if (matches.length === 0) return []
  const longest = Math.max(...matches.map((entry) => compactTitle(entry.title).length))
  return matches.filter((entry) => compactTitle(entry.title).length === longest)
}

/**
 * 用户在原文中明确写出条目标题时，只有「唯一命中」才可作为显式目标。
 * - 按从句判断，创建从句里的标题不是修改/删除目标；
 * - 先剔除「改成 / 改为 / 重命名为」后面的新标题，避免把新名字误当成操作对象；
 * - 「有哪些修改」这类名词用法不算写意图；
 * - 同名多条会返回全部候选，由调用方视为未解析，不做默认选择。
 */
export function resolveExplicitTitleTargets(text: string, entries: Entry[]): Entry[] {
  const clauses = text
    .split(CLAUSE_SEPARATOR)
    .map((clause) => clause.trim())
    .filter(Boolean)

  const createOnlyTitleIds = new Set<string>()
  for (const clause of clauses) {
    if (CREATE_CLAUSE.test(clause) && !hasTargetAction(clause)) {
      for (const entry of matchTitles(clause, entries)) createOnlyTitleIds.add(entry.id)
    }
  }

  const targets = new Map<string, Entry>()
  for (const clause of clauses) {
    if (!hasTargetAction(clause)) continue
    if (CREATE_CLAUSE.test(clause) && !DIRECTED_TARGET.test(clause)) continue
    for (const entry of matchTitles(clause, entries)) {
      if (!createOnlyTitleIds.has(entry.id)) targets.set(entry.id, entry)
    }
  }
  return Array.from(targets.values())
}

export function sourceBypassesAmbiguity(source: TargetTrustSource): boolean {
  // 对话指代只说明「用户指的是这条」，不跳过同名/高相似检查：
  // 同名的多条记录仍然必须由用户明确指定。
  return (
    source === 'user_explicit' ||
    source === 'user_selected' ||
    source === 'created' ||
    source === 'authorized_selection'
  )
}
