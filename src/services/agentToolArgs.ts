import dayjs from 'dayjs'
import { toMinuteStart } from '../utils/format'

/**
 * Agent 工具参数校验：模型返回的参数一律先过这里，再进入执行器。
 * - 工具名白名单；
 * - 未知字段直接拒绝（id / createdAt / deletedAt 等受保护字段无法写入）；
 * - 长度、类型、时间与业务前提逐项校验，失败返回明确错误；
 * - 不做静默截断或静默忽略，避免模型以为改成功了。
 */

export const MAX_TITLE_CHARS = 120
export const MAX_CONTENT_CHARS = 4000
export const MAX_ITEM_CHARS = 200
export const MAX_ITEMS = 20
export const MAX_TAG_CHARS = 24
export const MAX_TAGS = 12

export const AGENT_TOOL_NAMES = [
  'search_notes',
  'list_todos',
  'list_reminders',
  'get_note',
  'create_entry',
  'update_entry',
  'delete_entry',
] as const

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number]

export type WriteKind = 'note' | 'todo' | 'reminder'

export interface SearchNotesArgs {
  query: string
  kind?: WriteKind
}

export interface GetNoteArgs {
  id: string
}

export interface CreateEntryArgs {
  kind: WriteKind
  title: string
  content: string
  /** 已归整到分钟且校验为未来时间 */
  remindAt?: number
  items?: string[]
}

export interface UpdateEntryArgs {
  id: string
  title?: string
  content?: string
  appendContent?: string
  completeItems?: string[]
  addItems?: string[]
  remindAt?: number
  alarmId?: string
  addTags?: string[]
  removeTags?: string[]
}

export interface DeleteEntryArgs {
  id: string
}

export type ValidatedToolCall =
  | { name: 'search_notes'; args: SearchNotesArgs }
  | { name: 'list_todos'; args: Record<string, never> }
  | { name: 'list_reminders'; args: Record<string, never> }
  | { name: 'get_note'; args: GetNoteArgs }
  | { name: 'create_entry'; args: CreateEntryArgs }
  | { name: 'update_entry'; args: UpdateEntryArgs }
  | { name: 'delete_entry'; args: DeleteEntryArgs }

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string }

function ok<T>(value: T): ValidationResult<T> {
  return { ok: true, value }
}

function fail<T>(error: string): ValidationResult<T> {
  return { ok: false, error }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 解析模型给出的 arguments JSON；非法时返回校验错误而不是空对象 */
export function parseToolArguments(
  argumentsJson: string,
): ValidationResult<Record<string, unknown>> {
  if (!argumentsJson.trim()) return ok({})
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsJson)
  } catch {
    return fail('工具参数不是合法 JSON')
  }
  if (!isPlainObject(parsed)) return fail('工具参数必须是 JSON 对象')
  return ok(parsed)
}

/** 未列入白名单的字段一律拒绝：防止模型写入 id / createdAt / deletedAt 等受保护字段 */
function rejectUnknownKeys(
  args: Record<string, unknown>,
  allowed: readonly string[],
): string | null {
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key))
  if (unknown.length === 0) return null
  return `不支持的参数：${unknown.join('、')}（允许：${allowed.join('、')}）`
}

function requireNonEmptyString(
  args: Record<string, unknown>,
  key: string,
): ValidationResult<string> {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim()) {
    return fail(`缺少 ${key} 参数或参数为空`)
  }
  return ok(value.trim())
}

function validateTitle(value: string): ValidationResult<string> {
  const title = value.trim()
  if (!title) return fail('标题不能为空')
  if (title.length > MAX_TITLE_CHARS) {
    return fail(`标题超过 ${MAX_TITLE_CHARS} 字（当前 ${title.length} 字），请精简后重试`)
  }
  return ok(title)
}

function validateContent(value: string): ValidationResult<string> {
  if (value.length > MAX_CONTENT_CHARS) {
    return fail(`正文超过 ${MAX_CONTENT_CHARS} 字（当前 ${value.length} 字），请精简后重试`)
  }
  return ok(value)
}

function validateItems(value: unknown, key: string): ValidationResult<string[]> {
  if (!Array.isArray(value)) return fail(`${key} 必须是字符串数组`)
  if (value.length > MAX_ITEMS) {
    return fail(`${key} 最多 ${MAX_ITEMS} 项（当前 ${value.length} 项）`)
  }
  const items: string[] = []
  for (const raw of value) {
    if (typeof raw !== 'string') return fail(`${key} 中包含非字符串项`)
    const text = raw.trim()
    if (!text) return fail(`${key} 中包含空子任务`)
    if (text.length > MAX_ITEM_CHARS) {
      return fail(`子任务超过 ${MAX_ITEM_CHARS} 字，请精简：${text.slice(0, 20)}…`)
    }
    if (items.includes(text)) return fail(`${key} 中包含重复子任务「${text}」`)
    items.push(text)
  }
  return ok(items)
}

function validateTags(value: unknown, key: string): ValidationResult<string[]> {
  if (!Array.isArray(value)) return fail(`${key} 必须是字符串数组`)
  if (value.length > MAX_TAGS) return fail(`${key} 最多 ${MAX_TAGS} 个标签`)
  const tags: string[] = []
  for (const raw of value) {
    if (typeof raw !== 'string') return fail(`${key} 中包含非字符串项`)
    const tag = raw.trim()
    if (!tag) return fail(`${key} 中包含空标签`)
    if (tag.length > MAX_TAG_CHARS) {
      return fail(`标签超过 ${MAX_TAG_CHARS} 字：${tag.slice(0, 20)}…`)
    }
    if (tags.includes(tag)) return fail(`${key} 中包含重复标签「${tag}」`)
    tags.push(tag)
  }
  return ok(tags)
}

/** 提醒时间：解析合法、归整到分钟，且必须晚于当前时间 */
export function validateRemindAt(value: unknown, now: number): ValidationResult<number> {
  let ms: number
  if (typeof value === 'number') {
    ms = value
  } else if (typeof value === 'string' && value.trim()) {
    const parsed = dayjs(value.trim())
    if (!parsed.isValid()) return fail('remindAt 不是有效时间，请使用 YYYY-MM-DDTHH:mm 格式')
    ms = parsed.valueOf()
  } else {
    return fail('缺少 remindAt 参数或参数为空')
  }
  if (!Number.isFinite(ms)) return fail('remindAt 不是有效时间')
  const minute = toMinuteStart(ms)
  if (minute <= now) {
    return fail('提醒时间必须晚于当前时间（按分钟计）')
  }
  return ok(minute)
}

function validateKind(value: unknown): ValidationResult<WriteKind> {
  if (value === 'note' || value === 'todo' || value === 'reminder') {
    return ok(value)
  }
  return fail('kind 必须是 note / todo / reminder')
}

function validateCreate(args: Record<string, unknown>, now: number): ValidationResult<CreateEntryArgs> {
  const unknown = rejectUnknownKeys(args, ['kind', 'title', 'content', 'remindAt', 'items'])
  if (unknown) return fail(unknown)

  const kind = validateKind(args.kind)
  if (!kind.ok) return fail(kind.error)

  const rawTitle = args.title
  if (typeof rawTitle !== 'string') return fail('缺少 title 参数')
  const title = validateTitle(rawTitle)
  if (!title.ok) return fail(title.error)

  const content: ValidationResult<string> = (() => {
    if (!('content' in args)) return ok('')
    if (typeof args.content !== 'string') return fail('content 必须是字符串')
    return validateContent(args.content)
  })()
  if (!content.ok) return fail(content.error)

  let remindAt: number | undefined
  if (kind.value === 'reminder') {
    if (!('remindAt' in args)) return fail('提醒类型必须提供 remindAt（YYYY-MM-DDTHH:mm）')
    const parsed = validateRemindAt(args.remindAt, now)
    if (!parsed.ok) return fail(parsed.error)
    remindAt = parsed.value
  } else if ('remindAt' in args) {
    return fail('remindAt 仅适用于提醒类型便签')
  }

  let items: string[] | undefined
  if ('items' in args) {
    if (kind.value !== 'todo') return fail('items 仅适用于待办类型便签')
    const parsed = validateItems(args.items, 'items')
    if (!parsed.ok) return fail(parsed.error)
    items = parsed.value
  }

  return ok({
    kind: kind.value,
    title: title.value,
    content: content.value,
    ...(remindAt !== undefined ? { remindAt } : {}),
    ...(items !== undefined ? { items } : {}),
  })
}

function validateUpdate(args: Record<string, unknown>, now: number): ValidationResult<UpdateEntryArgs> {
  const unknown = rejectUnknownKeys(args, [
    'id',
    'title',
    'content',
    'append_content',
    'complete_items',
    'add_items',
    'remind_at',
    'alarm_id',
    'add_tags',
    'remove_tags',
  ])
  if (unknown) return fail(unknown)

  const id = requireNonEmptyString(args, 'id')
  if (!id.ok) return fail(id.error)

  const result: UpdateEntryArgs = { id: id.value }

  if ('title' in args) {
    if (typeof args.title !== 'string') return fail('title 必须是字符串')
    const title = validateTitle(args.title)
    if (!title.ok) return fail(title.error)
    result.title = title.value
  }

  if ('content' in args) {
    if (typeof args.content !== 'string') return fail('content 必须是字符串')
    const content = validateContent(args.content)
    if (!content.ok) return fail(content.error)
    result.content = content.value
  }

  if ('append_content' in args) {
    if (typeof args.append_content !== 'string' || !args.append_content.trim()) {
      return fail('append_content 必须是非空字符串')
    }
    const content = validateContent(args.append_content)
    if (!content.ok) return fail(content.error)
    result.appendContent = args.append_content
  }

  if (result.content !== undefined && result.appendContent !== undefined) {
    return fail('content 与 append_content 不能同时提供：整体替换与追加只能选一种')
  }

  if ('complete_items' in args) {
    const items = validateItems(args.complete_items, 'complete_items')
    if (!items.ok) return fail(items.error)
    if (items.value.length === 0) return fail('complete_items 不能为空数组')
    result.completeItems = items.value
  }

  if ('add_items' in args) {
    const items = validateItems(args.add_items, 'add_items')
    if (!items.ok) return fail(items.error)
    if (items.value.length === 0) return fail('add_items 不能为空数组')
    result.addItems = items.value
  }

  if ('remind_at' in args) {
    const remindAt = validateRemindAt(args.remind_at, now)
    if (!remindAt.ok) return fail(remindAt.error)
    result.remindAt = remindAt.value
  }

  if ('alarm_id' in args) {
    const alarmId = requireNonEmptyString(args, 'alarm_id')
    if (!alarmId.ok) return fail(alarmId.error)
    result.alarmId = alarmId.value
  }
  if (result.alarmId !== undefined && result.remindAt === undefined) {
    return fail('alarm_id 必须与 remind_at 一起使用')
  }

  if ('add_tags' in args) {
    const tags = validateTags(args.add_tags, 'add_tags')
    if (!tags.ok) return fail(tags.error)
    if (tags.value.length === 0) return fail('add_tags 不能为空数组')
    result.addTags = tags.value
  }
  if ('remove_tags' in args) {
    const tags = validateTags(args.remove_tags, 'remove_tags')
    if (!tags.ok) return fail(tags.error)
    if (tags.value.length === 0) return fail('remove_tags 不能为空数组')
    result.removeTags = tags.value
  }

  const hasChange =
    result.title !== undefined ||
    result.content !== undefined ||
    result.appendContent !== undefined ||
    result.completeItems !== undefined ||
    result.addItems !== undefined ||
    result.remindAt !== undefined ||
    result.addTags !== undefined ||
    result.removeTags !== undefined
  if (!hasChange) {
    return fail(
      '没有提供任何有效修改字段（title / content / append_content / complete_items / add_items / remind_at / add_tags / remove_tags）',
    )
  }

  return ok(result)
}

/** 工具名 + 参数统一校验入口 */
export function validateToolCall(
  name: string,
  argumentsJson: string,
  now: number = Date.now(),
): ValidationResult<ValidatedToolCall> {
  if (!(AGENT_TOOL_NAMES as readonly string[]).includes(name)) {
    return fail(`未知工具 ${name}`)
  }
  const parsed = parseToolArguments(argumentsJson)
  if (!parsed.ok) return fail(parsed.error)
  const args = parsed.value

  switch (name as AgentToolName) {
    case 'search_notes': {
      const unknown = rejectUnknownKeys(args, ['query', 'kind'])
      if (unknown) return fail(unknown)
      const query = requireNonEmptyString(args, 'query')
      if (!query.ok) return fail(query.error)
      if (query.value.length > 100) return fail('query 超过 100 字，请缩短关键词')
      if ('kind' in args) {
        const kind = validateKind(args.kind)
        if (!kind.ok) return fail(kind.error)
        return ok({ name: 'search_notes', args: { query: query.value, kind: kind.value } })
      }
      return ok({ name: 'search_notes', args: { query: query.value } })
    }
    case 'list_todos': {
      const unknown = rejectUnknownKeys(args, [])
      if (unknown) return fail(unknown)
      return ok({ name: 'list_todos', args: {} })
    }
    case 'list_reminders': {
      const unknown = rejectUnknownKeys(args, [])
      if (unknown) return fail(unknown)
      return ok({ name: 'list_reminders', args: {} })
    }
    case 'get_note': {
      const unknown = rejectUnknownKeys(args, ['id'])
      if (unknown) return fail(unknown)
      const id = requireNonEmptyString(args, 'id')
      if (!id.ok) return fail(id.error)
      return ok({ name: 'get_note', args: { id: id.value } })
    }
    case 'create_entry': {
      const create = validateCreate(args, now)
      if (!create.ok) return fail(create.error)
      return ok({ name: 'create_entry', args: create.value })
    }
    case 'update_entry': {
      const update = validateUpdate(args, now)
      if (!update.ok) return fail(update.error)
      return ok({ name: 'update_entry', args: update.value })
    }
    case 'delete_entry': {
      const unknown = rejectUnknownKeys(args, ['id'])
      if (unknown) return fail(unknown)
      const id = requireNonEmptyString(args, 'id')
      if (!id.ok) return fail(id.error)
      return ok({ name: 'delete_entry', args: { id: id.value } })
    }
    default:
      return fail(`未知工具 ${name}`)
  }
}

/** 重复调用判定用签名：工具名 + 规范化参数（同一次请求内生效） */
export function toolCallSignature(call: ValidatedToolCall): string {
  return `${call.name}:${JSON.stringify(call.args)}`
}
