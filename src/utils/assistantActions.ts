import dayjs from 'dayjs'
import type { EntryKind } from '../types/entry'

/** 单条回答最多采纳的操作数：模型偶尔会一口气列很多，界面只展示前几条 */
const MAX_ACTIONS = 3
const MAX_TITLE_CHARS = 120
const MAX_CONTENT_CHARS = 4000
const MAX_ITEM_CHARS = 200
const MAX_ITEMS = 20

/** 操作类型：create 新建便签；complete-todo 勾选已有待办的子任务；append-note 向已有备忘追加内容；delete 删除便签（进废纸篓，可恢复） */
export type AssistantActionOp = 'create' | 'complete-todo' | 'append-note' | 'delete'

/** AI 提议的一条操作（用户确认前不会写入仓储） */
export interface AssistantAction {
  /** 缺省视为 create（兼容旧回答里的动作块） */
  op?: AssistantActionOp
  kind: EntryKind
  title: string
  content: string
  /** 提醒专用：毫秒时间戳（已校验为未来时间） */
  remindAt?: number
  /** 待办专用：子任务文本（create 为新建项；complete-todo 为要勾选的现有项） */
  items?: string[]
  /** 操作已有便签时的目标 id（来自上下文） */
  targetId?: string
}

/** 系统提示词里的操作协议：模型按此格式提出操作请求，界面渲染确认卡片 */
export const ACTION_PROTOCOL = [
  '可执行操作：',
  '当用户要求新建便签、勾选已有待办的子任务、或向已有备忘追加内容时，先用一句话说明，再在回答末尾输出 1–3 个操作块，每个操作块单独一行。',
  '新建便签：',
  '<action>{"op":"create","kind":"reminder","title":"打开 epic","content":"","remindAt":"2026-10-30T15:50"}</action>',
  '- op：create（可省略）',
  '- kind：note（备忘）/ todo（待办）/ reminder（提醒）',
  '- title：必填，简明标题，不要把时间写进标题',
  '- content：可选，Markdown 正文',
  '- items：仅 todo 可选，子任务文本数组，例如 ["买牛奶","买鸡蛋"]',
  '- remindAt：仅 reminder 必填，格式 YYYY-MM-DDTHH:mm（用户本地时间），必须晚于当前时间；「半小时后」「明早」这类相对时间要先按当前时间换算成具体时刻',
  '勾选已有待办的子任务（targetId 必须原样复制 <notes> 中该条目后的 id）：',
  '<action>{"op":"complete-todo","targetId":"<notes 中的 id>","items":["买牛奶"]}</action>',
  '- items：要勾选的子任务文本，必须与待办中现有子任务文本一致',
  '向已有备忘追加内容（targetId 同样取自 <notes>）：',
  '<action>{"op":"append-note","targetId":"<notes 中的 id>","content":"追加的文本"}</action>',
  '输出要求：不要声称已经执行成功，界面会展示确认卡片、由用户点击执行；不要用代码块包裹 <action>；改标题、改提醒时间等操作仍请提示用户手动完成。',
  '删除已有便签（targetId 取自 <notes>；进入废纸篓，用户确认后才会真正删除）：',
  '<action>{"op":"delete","targetId":"<notes 中的 id>"}</action>',
].join('\n')

const ACTION_BLOCK = /<action\b[^>]*>([\s\S]*?)<\/action>/gi
/** 流式过程中可能只到达 <action> 的前缀，按前缀把尾巴整段丢弃 */
const ACTION_TAIL = /<\s*a?\s*c?\s*t?\s*i?\s*o?\s*n?\s*>?$/i

/**
 * 宽容重试：模型常见的 JSON 小毛病——全角引号、尾逗号。
 * 仅在原始 JSON.parse 失败时尝试，避免污染正常内容。
 */
function lenientJsonParse(body: string): unknown {
  const cleaned = body
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*([}\]])/g, '$1')
  try {
    return JSON.parse(cleaned)
  } catch {
    return null
  }
}

function parseRemindAt(value: unknown): number | null {
  let ms: number
  if (typeof value === 'number') {
    ms = value
  } else if (typeof value === 'string' && value.trim()) {
    const parsed = dayjs(value.trim())
    if (!parsed.isValid()) return null
    ms = parsed.valueOf()
  } else {
    return null
  }
  if (!Number.isFinite(ms)) return null
  return ms > Date.now() ? ms : null
}

function parseItems(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const items: string[] = []
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const text = raw.trim().slice(0, MAX_ITEM_CHARS)
    if (!text || items.includes(text)) continue
    items.push(text)
    if (items.length >= MAX_ITEMS) break
  }
  return items
}

function parseAction(body: string): AssistantAction | null {
  let data: unknown
  try {
    data = JSON.parse(body.trim())
  } catch {
    data = lenientJsonParse(body)
    if (data === null) return null
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null

  const item = data as Record<string, unknown>
  const opValue =
    item.op === 'complete-todo' || item.op === 'append-note' || item.op === 'delete'
      ? item.op
      : 'create'
  const targetId =
    typeof item.targetId === 'string' ? item.targetId.trim() : ''

  // 勾选已有待办：只需目标 id 与子任务文本，标题 / 类型由客户端按 id 解析
  if (opValue === 'complete-todo') {
    const items = parseItems(item.items)
    if (!targetId || items.length === 0) return null
    return { op: opValue, kind: 'todo', title: '', content: '', targetId, items }
  }
  if (opValue === 'append-note') {
    const content =
      typeof item.content === 'string'
        ? item.content.trim().slice(0, MAX_CONTENT_CHARS)
        : ''
    if (!targetId || !content) return null
    return { op: opValue, kind: 'note', title: '', content, targetId }
  }
  // 删除：只需目标 id，标题 / 类型由客户端按 id 解析；进废纸篓可恢复
  if (opValue === 'delete') {
    if (!targetId) return null
    return { op: opValue, kind: 'note', title: '', content: '', targetId }
  }

  const kind = item.kind
  if (kind !== 'note' && kind !== 'todo' && kind !== 'reminder') return null
  const title =
    typeof item.title === 'string'
      ? item.title.trim().slice(0, MAX_TITLE_CHARS)
      : ''
  if (!title) return null
  const content =
    typeof item.content === 'string'
      ? item.content.trim().slice(0, MAX_CONTENT_CHARS)
      : ''

  if (kind === 'todo') {
    const items = parseItems(item.items)
    return items.length ? { kind, title, content, items } : { kind, title, content }
  }
  if (kind !== 'reminder') return { kind, title, content }
  const remindAt = parseRemindAt(item.remindAt)
  return remindAt === null ? null : { kind, title, content, remindAt }
}

/**
 * 把模型回答拆成「可展示文本 + 待确认操作」：
 * - 剔除完整的 <action> 块，避免把 JSON 当正文渲染
 * - 流式输出时操作块可能只到一半，从该处截断
 * - 解析失败的完整块不再静默丢弃：计入 invalidCount 供界面提示
 */
export function parseAssistantActions(raw: string): {
  text: string
  actions: AssistantAction[]
  /** 完整出现但无法解析为有效操作的 <action> 块数量（格式异常 / 字段不合法） */
  invalidCount: number
} {
  const actions: AssistantAction[] = []
  let invalidCount = 0
  let text = raw.replace(ACTION_BLOCK, (_match, body: string) => {
    const action = parseAction(body)
    if (action && actions.length < MAX_ACTIONS) {
      actions.push(action)
    } else if (!action) {
      invalidCount += 1
      if (import.meta.env.DEV) {
        console.warn('[AI] 操作块解析失败（原始内容）：', body)
      }
    }
    return ''
  })

  const openIndex = text.toLowerCase().indexOf('<action')
  if (openIndex >= 0) {
    text = text.slice(0, openIndex)
  } else {
    const tail = ACTION_TAIL.exec(text)
    if (tail) text = text.slice(0, tail.index)
  }

  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), actions, invalidCount }
}
