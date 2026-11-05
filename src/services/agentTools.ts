import dayjs from 'dayjs'
import { useEntryStore } from '../store/useEntryStore'
import type { AiToolCall, AiToolDefinition } from '../types/ai'
import type { AssistantAction } from '../utils/assistantActions'
import type { Entry, EntryKind, ReminderEntry } from '../types/entry'

/**
 * Agent 工具集（function calling）：
 * - 只读工具（检索便签）与写工具（create_entry / update_entry）自动执行；
 * - delete_entry 只生成确认卡片，用户点击后才进废纸篓（可恢复）；
 * - <action> 文本协议保留为不支持 function calling 模型的降级路径。
 */

/** 单条工具结果正文上限：控制 tool 消息体积，避免多轮后撑爆上下文 */
const MAX_RESULT_CHARS = 1600
/** 搜索结果条数上限 */
const MAX_SEARCH_HITS = 8
/** get_note 正文上限 */
const MAX_NOTE_CHARS = 1500
/** 自动写入的正文 / 标题上限（对齐 <action> 协议约束） */
const MAX_WRITE_TITLE_CHARS = 120
const MAX_WRITE_CONTENT_CHARS = 4000

const KIND_LABEL: Record<EntryKind, string> = {
  note: '备忘',
  todo: '待办',
  reminder: '提醒',
  draw: '涂鸦',
}

/** 与 assistantContext 一致：去掉 base64 图与 HTML 标签，压缩空白 */
function cleanContent(raw: string): string {
  return raw
    .replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, '[图片]')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_match, alt: string) =>
      alt ? `[图片：${alt}]` : '[图片]',
    )
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

function entryTitle(entry: Entry): string {
  const title = entry.title.trim()
  if (title) return title
  return cleanContent(entry.content).split('\n')[0]?.trim().slice(0, 30) || '无标题'
}

/** 单条便签的紧凑描述（id 必须原样给出，供模型在 <action> 中引用） */
function describeEntry(entry: Entry, contentLimit: number): string {
  const lines: string[] = [
    `- [${KIND_LABEL[entry.kind]}] ${entryTitle(entry)}（id: ${entry.id}，${dayjs(entry.updatedAt).format('YYYY-MM-DD')} 更新）`,
  ]
  if (entry.kind === 'todo') {
    const done = entry.items.filter((item) => item.done).length
    lines.push(
      `  状态：${entry.done ? '已完成' : '未完成'}；子任务 ${done}/${entry.items.length} 完成`,
    )
    const pending = entry.items
      .filter((item) => !item.done)
      .slice(0, 8)
      .map((item) => item.text)
      .join('、')
    if (pending) lines.push(`  未完成子任务：${pending}`)
  } else if (entry.kind === 'reminder') {
    const pending = entry.alarms.filter((alarm) => !alarm.notified)
    const next = pending.length
      ? dayjs(Math.min(...pending.map((alarm) => alarm.remindAt))).format(
          'YYYY-MM-DD HH:mm',
        )
      : '无待触发闹钟'
    lines.push(`  状态：${entry.done ? '已处理' : '待处理'}；下次提醒：${next}`)
  } else if (entry.kind !== 'draw') {
    const cleaned = cleanContent(entry.content)
    if (cleaned) lines.push(`  内容：${truncate(cleaned, contentLimit)}`)
  }
  if (entry.tags.length) lines.push(`  标签：${entry.tags.join('、')}`)
  return lines.join('\n')
}

export const AGENT_TOOLS: AiToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'search_notes',
      description:
        '按关键词搜索用户的便签（备忘/待办/提醒），返回标题、类型、id、状态与内容摘要。回答「上下文摘要里没有提到的问题」或需要引用具体便签 id 时使用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词，匹配标题、正文与标签' },
          kind: {
            type: 'string',
            enum: ['note', 'todo', 'reminder'],
            description: '限定便签类型，可选；不传则搜全部类型',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_todos',
      description:
        '列出当前未完成的待办，含每条的子任务完成度与未完成子任务清单。用户问「我有哪些待办/任务」时使用。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_reminders',
      description:
        '列出待触发的提醒（按时间从近到远），含下次提醒时间。用户问「最近有什么提醒/日程」时使用。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_note',
      description: '按 id 读取单条便签的完整内容（正文上限 1500 字）。需要展开某条便签详情时使用。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '便签 id，来自 search_notes 或上下文摘要' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_entry',
      description:
        '新建一条便签并立即生效（无需用户确认）。kind=reminder 时 remindAt 必填且必须晚于当前时间；「半小时后」「明早」等相对时间先按当前时间换算成具体时刻。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['note', 'todo', 'reminder'], description: '便签类型' },
          title: { type: 'string', description: '简明标题（≤120 字），不要把时间写进标题' },
          content: { type: 'string', description: 'Markdown 正文，可选' },
          remindAt: {
            type: 'string',
            description: '仅 reminder：提醒时间，格式 YYYY-MM-DDTHH:mm（用户本地时间）',
          },
          items: {
            type: 'array',
            items: { type: 'string' },
            description: '仅 todo：子任务文本数组，可选',
          },
        },
        required: ['kind', 'title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_entry',
      description:
        '修改已有便签并立即生效（无需用户确认）：改标题、替换或追加正文、勾选或新增待办子任务、修改提醒时间。至少提供一个修改字段。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '便签 id，来自 search_notes 或上下文摘要' },
          title: { type: 'string', description: '新标题（整体替换），可选' },
          content: { type: 'string', description: '新正文（整体替换），可选' },
          append_content: { type: 'string', description: '追加到现有正文末尾的文本，可选' },
          complete_items: {
            type: 'array',
            items: { type: 'string' },
            description: '仅 todo：要勾选的现有子任务文本（需与现有文本一致），可选',
          },
          add_items: {
            type: 'array',
            items: { type: 'string' },
            description: '仅 todo：新增的子任务文本，可选',
          },
          remind_at: {
            type: 'string',
            description:
              '仅 reminder：新的提醒时间，格式 YYYY-MM-DDTHH:mm（用户本地时间），必须晚于当前时间；会把该提醒现有闹钟整体替换为单次提醒',
          },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_entry',
      description:
        '请求删除一条便签。调用后界面会出现删除确认卡片，用户点击确认才移入废纸篓（可恢复）；你不应假设删除已完成，确认结果由用户操作决定。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '要删除的便签 id' },
        },
        required: ['id'],
      },
    },
  },
]

/** 解析模型给出的 arguments JSON；非法时返回空对象（各工具自行兜底） */
function parseArguments(argumentsJson: string): Record<string, unknown> {
  if (!argumentsJson.trim()) return {}
  try {
    const parsed = JSON.parse(argumentsJson) as unknown
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function requireString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function searchNotes(args: Record<string, unknown>): string {
  const query = requireString(args, 'query')
  if (!query) return '错误：缺少 query 参数'
  const kindArg = requireString(args, 'kind')
  const kind =
    kindArg === 'note' || kindArg === 'todo' || kindArg === 'reminder'
      ? (kindArg as EntryKind)
      : null
  const needle = query.toLowerCase()
  const hits = useEntryStore
    .getState()
    .entries.filter((entry) => {
      if (kind && entry.kind !== kind) return false
      if (entry.title.toLowerCase().includes(needle)) return true
      if (entry.tags.some((tag) => tag.toLowerCase().includes(needle))) return true
      return cleanContent(entry.content).toLowerCase().includes(needle)
    })
    .slice(0, MAX_SEARCH_HITS)

  if (hits.length === 0) {
    return `没有找到匹配「${query}」的便签。`
  }
  const body = hits.map((entry) => describeEntry(entry, 200)).join('\n')
  return truncate(`找到 ${hits.length} 条：\n${body}`, MAX_RESULT_CHARS)
}

function listTodos(): string {
  const todos = useEntryStore
    .getState()
    .entries.filter((entry) => entry.kind === 'todo' && !entry.done)
  if (todos.length === 0) return '当前没有未完成的待办。'
  const body = todos
    .map((entry) => describeEntry(entry, 160))
    .join('\n')
  return truncate(`未完成待办 ${todos.length} 条：\n${body}`, MAX_RESULT_CHARS)
}

function listReminders(): string {
  const now = Date.now()
  const nextAlarmAt = (entry: ReminderEntry): number =>
    Math.min(...entry.alarms.filter((alarm) => !alarm.notified).map((alarm) => alarm.remindAt))
  const reminders = useEntryStore
    .getState()
    .entries.filter(
      (entry): entry is ReminderEntry =>
        entry.kind === 'reminder' &&
        !entry.done &&
        entry.alarms.some((alarm) => !alarm.notified && alarm.remindAt > now - 3600_000),
    )
    .sort((a, b) => nextAlarmAt(a) - nextAlarmAt(b))
  if (reminders.length === 0) return '当前没有待触发的提醒。'
  const body = reminders.map((entry) => describeEntry(entry, 160)).join('\n')
  return truncate(`待触发提醒 ${reminders.length} 条（按时间从近到远）：\n${body}`, MAX_RESULT_CHARS)
}

function getNote(args: Record<string, unknown>): string {
  const id = requireString(args, 'id')
  if (!id) return '错误：缺少 id 参数'
  const entry = useEntryStore.getState().entries.find((item) => item.id === id)
  if (!entry) return `错误：找不到 id 为 ${id} 的便签，可能已被删除。`
  const header = `[${KIND_LABEL[entry.kind]}] ${entryTitle(entry)}（id: ${entry.id}）`
  if (entry.kind === 'todo') {
    const items = entry.items
      .map((item) => `- [${item.done ? 'x' : ' '}] ${item.text}`)
      .join('\n')
    return truncate(`${header}\n状态：${entry.done ? '已完成' : '未完成'}\n${items}`, MAX_NOTE_CHARS)
  }
  if (entry.kind === 'reminder') {
    const alarms = entry.alarms
      .map(
        (alarm) =>
          `- ${dayjs(alarm.remindAt).format('YYYY-MM-DD HH:mm')}${alarm.notified ? '（已触发）' : ''}`,
      )
      .join('\n')
    return truncate(`${header}\n闹钟：\n${alarms}`, MAX_NOTE_CHARS)
  }
  const content = cleanContent(entry.content) || '（无文字内容）'
  return truncate(`${header}\n${content}`, MAX_NOTE_CHARS)
}

/** 工具执行结果：result 回传给模型；confirmAction 需要用户确认的操作（删除），渲染为确认卡片 */
export interface ToolOutcome {
  result: string
  confirmAction?: AssistantAction
}

function toolError(message: string): ToolOutcome {
  return { result: `错误：${message}` }
}

function parseRemindAt(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = dayjs(value.trim())
  if (!parsed.isValid()) return null
  const ms = parsed.valueOf()
  return ms > Date.now() ? ms : null
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim().slice(0, 200))
    .slice(0, 20)
}

async function createEntry(args: Record<string, unknown>): Promise<ToolOutcome> {
  const kindArg = args.kind
  if (kindArg !== 'note' && kindArg !== 'todo' && kindArg !== 'reminder') {
    return toolError('kind 必须是 note / todo / reminder')
  }
  const title = (requireString(args, 'title') ?? '').slice(0, MAX_WRITE_TITLE_CHARS)
  if (!title) return toolError('缺少 title')
  const content =
    typeof args.content === 'string' ? args.content.slice(0, MAX_WRITE_CONTENT_CHARS) : ''

  let remindAt: number | undefined
  if (kindArg === 'reminder') {
    const ms = parseRemindAt(args.remindAt)
    if (ms === null) {
      return toolError(
        'reminder 必须提供晚于当前时间的 remindAt（格式 YYYY-MM-DDTHH:mm）',
      )
    }
    remindAt = ms
  }
  const items = kindArg === 'todo' ? parseStringArray(args.items) : []
  const entry = await useEntryStore.getState().addEntry(
    {
      title,
      content,
      ...(remindAt !== undefined ? { remindAt } : {}),
      ...(items.length > 0 ? { items } : {}),
    },
    kindArg,
  )
  if (!entry) return toolError('创建失败，请稍后重试')
  return {
    result: `已创建${KIND_LABEL[kindArg]}「${title}」（id: ${entry.id}），已直接生效，无需用户再确认。`,
  }
}

async function updateEntry(args: Record<string, unknown>): Promise<ToolOutcome> {
  const id = requireString(args, 'id')
  if (!id) return toolError('缺少 id')
  const entry = useEntryStore.getState().entries.find((item) => item.id === id)
  if (!entry) return toolError(`找不到 id 为 ${id} 的便签，可能已被删除`)

  const patch: Record<string, unknown> = {}
  const changes: string[] = []
  const title = typeof args.title === 'string' ? args.title.trim() : ''
  if (title) {
    patch.title = title.slice(0, MAX_WRITE_TITLE_CHARS)
    changes.push('标题')
  }
  if (typeof args.content === 'string' && args.content.trim()) {
    patch.content = args.content.slice(0, MAX_WRITE_CONTENT_CHARS)
    changes.push('正文（整体替换）')
  }
  if (typeof args.append_content === 'string' && args.append_content.trim()) {
    const append = args.append_content.slice(0, MAX_WRITE_CONTENT_CHARS)
    patch.content = entry.content ? `${entry.content}\n\n${append}` : append
    changes.push('正文（追加）')
  }

  if (entry.kind === 'todo') {
    const todo = entry
    const complete = parseStringArray(args.complete_items)
    const add = parseStringArray(args.add_items)
    if (complete.length > 0 || add.length > 0) {
      let items = todo.items.map((item) => ({ ...item }))
      if (complete.length > 0) {
        const wanted = new Set(complete)
        let matched = 0
        items = items.map((item) => {
          if (!item.done && wanted.has(item.text)) {
            matched += 1
            return { ...item, done: true }
          }
          return item
        })
        if (matched > 0) changes.push(`勾选 ${matched} 项子任务`)
      }
      if (add.length > 0) {
        const existing = new Set(items.map((item) => item.text))
        const fresh = add
          .filter((text) => !existing.has(text))
          .map((text) => ({ id: crypto.randomUUID(), text, done: false }))
        if (fresh.length > 0) {
          items = [...items, ...fresh]
          changes.push(`新增 ${fresh.length} 项子任务`)
        }
      }
      patch.items = items
    }
  }

  // 修改提醒时间：把现有闹钟整体替换为单次提醒（与 DetailPane 的 AlarmItem 结构一致）
  if (args.remind_at !== undefined && args.remind_at !== null) {
    if (entry.kind !== 'reminder') {
      return toolError('remind_at 仅适用于提醒类型便签')
    }
    const ms = parseRemindAt(args.remind_at)
    if (ms === null) {
      return toolError(
        'remind_at 必须是晚于当前时间的时刻（格式 YYYY-MM-DDTHH:mm）',
      )
    }
    patch.alarms = [
      {
        id: crypto.randomUUID(),
        remindAt: ms,
        mode: 'once',
        method: 'dialog',
        notified: false,
      },
    ]
    changes.push('提醒时间（覆盖为单次提醒）')
  }

  if (changes.length === 0) {
    return toolError(
      '没有提供任何有效修改字段（title / content / append_content / complete_items / add_items / remind_at）',
    )
  }
  await useEntryStore.getState().updateEntry(id, patch as Partial<Entry>)
  return { result: `已修改便签「${entryTitle(entry)}」（id: ${id}）：${changes.join('、')}，已直接生效。` }
}

function deleteEntry(args: Record<string, unknown>): ToolOutcome {
  const id = requireString(args, 'id')
  if (!id) return toolError('缺少 id')
  const entry = useEntryStore.getState().entries.find((item) => item.id === id)
  if (!entry) return toolError(`找不到 id 为 ${id} 的便签，可能已被删除`)
  return {
    result: `已为便签「${entryTitle(entry)}」（id: ${id}）生成删除确认卡片，等待用户点击确认；用户确认后才会移入废纸篓。不要假设删除已完成。`,
    confirmAction: {
      op: 'delete',
      kind: entry.kind,
      title: entryTitle(entry),
      content: '',
      targetId: id,
    },
  }
}

/** 执行模型发起的工具调用：只读与写入自动执行，删除只生成确认卡片 */
export async function executeAgentTool(call: AiToolCall): Promise<ToolOutcome> {
  const name = call.function.name
  const args = parseArguments(call.function.arguments)
  try {
    switch (name) {
      case 'search_notes':
        return { result: searchNotes(args) }
      case 'list_todos':
        return { result: listTodos() }
      case 'list_reminders':
        return { result: listReminders() }
      case 'get_note':
        return { result: getNote(args) }
      case 'create_entry':
        return await createEntry(args)
      case 'update_entry':
        return await updateEntry(args)
      case 'delete_entry':
        return deleteEntry(args)
      default:
        return toolError(`未知工具 ${name}`)
    }
  } catch (error) {
    return toolError(`工具执行失败（${error instanceof Error ? error.message : String(error)}）`)
  }
}

/** system prompt 中追加的工具使用说明（仅在工具可用时附加） */
export const AGENT_TOOL_PROMPT = [
  '除 <notes> 摘要外，你还可以调用工具操作用户的便签数据：',
  '检索（只读）：search_notes 关键词搜索（summary 里看不到的内容用它查）、list_todos / list_reminders 列出待办与提醒、get_note 按 id 读全文。',
  '写入（自动生效，无需用户确认）：create_entry 新建便签、update_entry 修改便签（改标题 / 替换或追加正文 / 勾选与新增待办子任务 / 修改提醒时间）。',
  '删除（需用户确认）：delete_entry 会生成删除确认卡片，用户点击后才移入废纸篓；调用后不要声称已删除。',
  '批量任务（如「把这周的提醒整理成待办」「给这几条备忘补充内容」）：先用检索工具确认目标清单，再逐条调用写入工具完成，全部执行完后再总结结果；一次回复里可以同时发起多个工具调用。',
  '回答中提到具体便签时，用 <note-ref data-id="便签id">便签标题</note-ref> 标记，界面会渲染成可点击的引用胶囊；id 必须来自工具结果或 <notes>，不要虚构。',
  '注意：工具可用时新建 / 修改 / 删除一律使用工具完成，不要再输出 <action> 块（那会导致重复操作）；需要引用具体便签时先用检索工具拿到 id，再原样复制到写操作或 note-ref 的 id 参数。update_entry 的 remind_at 会把现有闹钟整体替换为单次提醒，用户想保留重复规则时请提示手动修改。不要向用户复述工具调用过程，也不要编造工具返回之外的数据。',
].join('\n')
