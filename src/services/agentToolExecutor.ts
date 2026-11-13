import dayjs from 'dayjs'
import {
  MAX_ITEMS,
  toolCallSignature,
  validateToolCall,
  type CreateEntryArgs,
  type UpdateEntryArgs,
  type ValidatedToolCall,
} from './agentToolArgs'
import {
  applyReminderTime,
  describeAlarm,
} from './reminderAlarms'
import { createDeleteProposal, finishDeleteProposal } from './deleteProposals'
import type { AiToolCall } from '../types/ai'
import type {
  AlarmItem,
  Entry,
  EntryKind,
  NewEntryInput,
  ReminderEntry,
  TodoItem,
} from '../types/entry'

/**
 * Agent 工具执行器：
 * - 只依赖注入的数据访问接口，业务数据仍由 useEntryStore / 仓储负责；
 * - 写入后回读实际数据校验，失败就如实报错，不虚构成功；
 * - 每次调用开始前检查请求是否已过期（用户点停止后不再执行未开始的工具）；
 * - 同一次请求内按 tool_call_id 与参数签名去重，避免重试造成重复新增。
 */

const MAX_RESULT_CHARS = 1600
const MAX_SEARCH_HITS = 8
const MAX_NOTE_CHARS = 1500

const KIND_LABEL: Record<EntryKind, string> = {
  note: '备忘',
  todo: '待办',
  reminder: '提醒',
  draw: '涂鸦',
}

export interface AgentToolEnvironment {
  now: () => number
  listEntries: () => Entry[]
  addEntry: (input: NewEntryInput, kind: EntryKind) => Promise<Entry | null>
  updateEntry: (id: string, patch: Partial<Entry>) => Promise<void>
}

/** 单次请求的执行作用域：幂等集合与过期判断都只在本请求内有效 */
export interface AgentToolScope {
  requestId: string
  isStale: () => boolean
  /** 本次请求已执行过的 tool_call_id */
  executedCalls: Set<string>
  /** 本次请求已执行过的写入参数签名 */
  writeSignatures: Set<string>
}

export function createAgentToolScope(
  requestId: string,
  isStale: () => boolean = () => false,
): AgentToolScope {
  return {
    requestId,
    isStale,
    executedCalls: new Set<string>(),
    writeSignatures: new Set<string>(),
  }
}

export type ToolOutcomeStatus = 'ok' | 'error' | 'cancelled' | 'duplicate' | 'confirm'

/** 删除确认卡片数据：与 utils/assistantActions 的 AssistantAction 结构兼容 */
export interface ToolConfirmAction {
  op: 'delete'
  kind: EntryKind
  title: string
  content: string
  targetId: string
  proposalId: string
  expiresAt: number
}

export interface ToolOutcome {
  status: ToolOutcomeStatus
  result: string
  confirmAction?: ToolConfirmAction
}

function toolOk(result: string): ToolOutcome {
  return { status: 'ok', result }
}

function toolError(message: string): ToolOutcome {
  return { status: 'error', result: `错误：${message}` }
}

function toolCancelled(message: string): ToolOutcome {
  return { status: 'cancelled', result: `错误：${message}` }
}

function toolDuplicate(message: string): ToolOutcome {
  return { status: 'duplicate', result: message }
}

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

function nextPendingAlarmAt(entry: ReminderEntry): number | null {
  const pending = entry.alarms.filter((alarm) => !alarm.notified)
  if (pending.length === 0) return null
  return Math.min(...pending.map((alarm) => alarm.remindAt))
}

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
    const next = nextPendingAlarmAt(entry)
    const alarms = entry.alarms
      .slice(0, 4)
      .map((alarm) => describeAlarm(alarm))
      .join('；')
    lines.push(
      `  状态：${entry.done ? '已处理' : '待处理'}；下次提醒：${next ? dayjs(next).format('YYYY-MM-DD HH:mm') : '无待触发闹钟'}`,
    )
    if (alarms) lines.push(`  闹钟：${alarms}`)
  } else if (entry.kind !== 'draw') {
    const cleaned = cleanContent(entry.content)
    if (cleaned) lines.push(`  内容：${truncate(cleaned, contentLimit)}`)
  }
  if (entry.tags.length) lines.push(`  标签：${entry.tags.join('、')}`)
  return lines.join('\n')
}

function searchNotes(args: { query: string; kind?: EntryKind }, entries: Entry[]): string {
  const needle = args.query.toLowerCase()
  const hits = entries
    .filter((entry) => {
      if (args.kind && entry.kind !== args.kind) return false
      if (entry.title.toLowerCase().includes(needle)) return true
      if (entry.tags.some((tag) => tag.toLowerCase().includes(needle))) return true
      return cleanContent(entry.content).toLowerCase().includes(needle)
    })
    .slice(0, MAX_SEARCH_HITS)

  if (hits.length === 0) return `没有找到匹配「${args.query}」的便签。`
  return truncate(
    `找到 ${hits.length} 条：\n${hits.map((entry) => describeEntry(entry, 200)).join('\n')}`,
    MAX_RESULT_CHARS,
  )
}

function listTodos(entries: Entry[]): string {
  const todos = entries.filter((entry) => entry.kind === 'todo' && !entry.done)
  if (todos.length === 0) return '当前没有未完成的待办。'
  return truncate(
    `未完成待办 ${todos.length} 条：\n${todos.map((entry) => describeEntry(entry, 160)).join('\n')}`,
    MAX_RESULT_CHARS,
  )
}

function listReminders(entries: Entry[], now: number): string {
  const reminders = entries
    .filter(
      (entry): entry is ReminderEntry =>
        entry.kind === 'reminder' &&
        !entry.done &&
        entry.alarms.some((alarm) => !alarm.notified && alarm.remindAt > now - 3600_000),
    )
    .sort((a, b) => (nextPendingAlarmAt(a) ?? 0) - (nextPendingAlarmAt(b) ?? 0))
  if (reminders.length === 0) return '当前没有待触发的提醒。'
  return truncate(
    `待触发提醒 ${reminders.length} 条（按时间从近到远）：\n${reminders
      .map((entry) => describeEntry(entry, 160))
      .join('\n')}`,
    MAX_RESULT_CHARS,
  )
}

function getNote(id: string, entries: Entry[]): string {
  const entry = entries.find((item) => item.id === id)
  if (!entry) return `错误：找不到 id 为 ${id} 的便签，可能已被删除。`
  const header = `[${KIND_LABEL[entry.kind]}] ${entryTitle(entry)}（id: ${entry.id}）`
  if (entry.kind === 'todo') {
    const items = entry.items
      .map((item) => `- [${item.done ? 'x' : ' '}] ${item.text}`)
      .join('\n')
    return truncate(
      `${header}\n状态：${entry.done ? '已完成' : '未完成'}\n${items}`,
      MAX_NOTE_CHARS,
    )
  }
  if (entry.kind === 'reminder') {
    const alarms = entry.alarms
      .map(
        (alarm) =>
          `- ${describeAlarm(alarm)}（alarm_id: ${alarm.id}）${alarm.notified ? '（已触发）' : ''}`,
      )
      .join('\n')
    return truncate(`${header}\n闹钟：\n${alarms}`, MAX_NOTE_CHARS)
  }
  const content = cleanContent(entry.content) || '（无文字内容）'
  return truncate(`${header}\n${content}`, MAX_NOTE_CHARS)
}

async function createEntry(
  args: CreateEntryArgs,
  env: AgentToolEnvironment,
): Promise<ToolOutcome> {
  const input: NewEntryInput = {
    title: args.title,
    content: args.content,
    ...(args.remindAt !== undefined ? { remindAt: args.remindAt } : {}),
    ...(args.items && args.items.length > 0 ? { items: args.items } : {}),
  }
  const entry = await env.addEntry(input, args.kind)
  if (!entry) return toolError(`创建${KIND_LABEL[args.kind]}失败，仓储没有返回新条目`)

  // 回读实际数据：确认条目真实存在且类型一致，避免「已创建」与实际不符
  const stored = env.listEntries().find((item) => item.id === entry.id)
  if (!stored || stored.kind !== args.kind) {
    return toolError('创建未能在数据中确认，请重试或检查数据存储')
  }
  const extra =
    args.kind === 'reminder' && args.remindAt !== undefined
      ? `，提醒时间 ${dayjs(args.remindAt).format('YYYY-MM-DD HH:mm')}`
      : args.kind === 'todo' && args.items?.length
        ? `，含 ${args.items.length} 个子任务`
        : ''
  return toolOk(
    `已创建${KIND_LABEL[args.kind]}「${stored.title}」（id: ${stored.id}${extra}），已直接写入并生效，无需用户确认。`,
  )
}

interface ExpectedUpdate {
  title?: string
  content?: string
  items?: TodoItem[]
  tags?: string[]
  alarm?: { id: string; remindAt: number; mode: AlarmItem['mode'] }
}

function verifyUpdate(entry: Entry, expected: ExpectedUpdate): string | null {
  if (expected.title !== undefined && entry.title !== expected.title) {
    return `标题未生效（当前为「${entry.title}」）`
  }
  if (expected.content !== undefined && entry.content !== expected.content) {
    return '正文未生效'
  }
  if (expected.items !== undefined) {
    if (entry.kind !== 'todo') return '目标条目已不是待办'
    const actual = entry.items.map((item) => `${item.done ? 'x' : ' '}:${item.text}`)
    const wanted = expected.items.map((item) => `${item.done ? 'x' : ' '}:${item.text}`)
    if (actual.length !== wanted.length || actual.some((text, index) => text !== wanted[index])) {
      return '子任务清单未生效'
    }
  }
  if (expected.tags !== undefined) {
    const missing = expected.tags.filter((tag) => !entry.tags.includes(tag))
    if (missing.length > 0) return `标签未生效：${missing.join('、')}`
  }
  if (expected.alarm) {
    if (entry.kind !== 'reminder') return '目标条目已不是提醒'
    const alarm = entry.alarms.find((item) => item.id === expected.alarm?.id)
    if (!alarm) return '目标闹钟已不存在'
    if (alarm.remindAt !== expected.alarm.remindAt) return '提醒时间未生效'
    if (alarm.mode !== expected.alarm.mode) return '闹钟重复规则被意外修改'
  }
  return null
}

async function updateEntry(
  args: UpdateEntryArgs,
  env: AgentToolEnvironment,
): Promise<ToolOutcome> {
  const entry = env.listEntries().find((item) => item.id === args.id)
  if (!entry) return toolError(`找不到 id 为 ${args.id} 的便签，可能已被删除`)
  if (entry.kind === 'draw') return toolError('涂鸦条目暂不支持由 AI 修改')

  const patch: Record<string, unknown> = {}
  const changes: string[] = []
  const expected: ExpectedUpdate = {}

  if (args.title !== undefined) {
    patch.title = args.title
    expected.title = args.title
    changes.push(`标题改为「${args.title}」`)
  }

  if (args.content !== undefined) {
    patch.content = args.content
    expected.content = args.content
    changes.push('正文（整体替换）')
  } else if (args.appendContent !== undefined) {
    const append = args.appendContent
    const next = entry.content ? `${entry.content}\n\n${append}` : append
    patch.content = next
    expected.content = next
    changes.push('正文（追加）')
  }

  if (args.completeItems !== undefined || args.addItems !== undefined) {
    if (entry.kind !== 'todo') {
      return toolError('complete_items / add_items 仅适用于待办类型便签')
    }
    let items: TodoItem[] = entry.items.map((item) => ({ ...item }))
    const existing = new Set(items.map((item) => item.text))

    if (args.completeItems) {
      const missing = args.completeItems.filter((text) => !existing.has(text))
      if (missing.length > 0) {
        return toolError(`待办中不存在这些子任务：${missing.join('、')}`)
      }
      const alreadyDone = args.completeItems.filter((text) =>
        items.some((item) => item.text === text && item.done),
      )
      if (alreadyDone.length > 0) {
        return toolError(`这些子任务已经是完成状态：${alreadyDone.join('、')}`)
      }
      const wanted = new Set(args.completeItems)
      items = items.map((item) =>
        wanted.has(item.text) ? { ...item, done: true } : item,
      )
      changes.push(`勾选子任务：${args.completeItems.join('、')}`)
    }

    if (args.addItems) {
      const duplicates = args.addItems.filter((text) => existing.has(text))
      if (duplicates.length > 0) {
        return toolError(`这些子任务已存在：${duplicates.join('、')}`)
      }
      if (items.length + args.addItems.length > MAX_ITEMS) {
        return toolError(`子任务总数不能超过 ${MAX_ITEMS} 项`)
      }
      items = [
        ...items,
        ...args.addItems.map((text) => ({
          id: crypto.randomUUID(),
          text,
          done: false,
        })),
      ]
      changes.push(`新增子任务：${args.addItems.join('、')}`)
    }

    patch.items = items
    expected.items = items
  }

  if (args.remindAt !== undefined) {
    if (entry.kind !== 'reminder') {
      return toolError('remind_at 仅适用于提醒类型便签')
    }
    const applied = applyReminderTime(entry.alarms, args.alarmId, args.remindAt, env.now())
    if (!applied.ok) return toolError(applied.error)
    patch.alarms = applied.alarms
    // 修改时间后提醒重新生效：清掉条目的已处理/已通知状态
    patch.done = false
    patch.notified = false
    expected.alarm = {
      id: applied.target.id,
      remindAt: args.remindAt,
      mode: applied.target.mode,
    }
    changes.push(
      `提醒时间改为 ${dayjs(args.remindAt).format('YYYY-MM-DD HH:mm')}（保留${applied.modeLabel}重复规则）`,
    )
  }

  if (args.addTags !== undefined || args.removeTags !== undefined) {
    const tags = new Set(entry.tags)
    if (args.removeTags) {
      const missing = args.removeTags.filter((tag) => !tags.has(tag))
      if (missing.length > 0) return toolError(`这些标签不存在：${missing.join('、')}`)
      for (const tag of args.removeTags) tags.delete(tag)
      changes.push(`移除标签：${args.removeTags.join('、')}`)
    }
    if (args.addTags) {
      for (const tag of args.addTags) tags.add(tag)
      changes.push(`添加标签：${args.addTags.join('、')}`)
    }
    const nextTags = Array.from(tags)
    patch.tags = nextTags
    expected.tags = nextTags
  }

  if (changes.length === 0) return toolError('没有产生任何有效修改')

  await env.updateEntry(entry.id, patch as Partial<Entry>)

  const stored = env.listEntries().find((item) => item.id === entry.id)
  if (!stored) return toolError('修改未能确认：目标条目已不存在')
  const mismatch = verifyUpdate(stored, expected)
  if (mismatch) return toolError(`修改未能确认：${mismatch}`)

  return toolOk(
    `已修改便签「${entryTitle(stored)}」（id: ${stored.id}）：${changes.join('；')}，已直接生效。`,
  )
}

function deleteEntry(
  id: string,
  env: AgentToolEnvironment,
  scope: AgentToolScope,
): ToolOutcome {
  const entry = env.listEntries().find((item) => item.id === id)
  if (!entry) return toolError(`找不到 id 为 ${id} 的便签，可能已被删除`)
  const proposal = createDeleteProposal({
    entryId: entry.id,
    kind: entry.kind,
    title: entryTitle(entry),
    requestId: scope.requestId,
    now: env.now(),
  })
  // 生成提议期间用户可能已停止：过期请求不展示删除卡片
  if (scope.isStale()) {
    finishDeleteProposal(proposal.id, 'cancelled')
    return toolCancelled('请求已停止，删除提议作废，未修改任何数据')
  }
  return {
    status: 'confirm',
    result: `已为便签「${entryTitle(entry)}」（id: ${entry.id}）生成删除确认卡片，等待用户点击确认；用户确认后才会移入废纸篓。不要假设删除已完成。`,
    confirmAction: {
      op: 'delete',
      kind: entry.kind,
      title: entryTitle(entry),
      content: '',
      targetId: entry.id,
      proposalId: proposal.id,
      expiresAt: proposal.expiresAt,
    },
  }
}

/** 执行一次模型发起的工具调用（参数校验 → 业务执行 → 真实结果回读） */
export async function executeToolWithEnv(
  call: AiToolCall,
  env: AgentToolEnvironment,
  scope: AgentToolScope,
): Promise<ToolOutcome> {
  const name = call.function.name

  if (scope.isStale()) {
    return toolCancelled('请求已停止，未执行该工具调用')
  }
  if (scope.executedCalls.has(call.id)) {
    return toolDuplicate(`重复的工具调用 ${call.id} 已忽略，未重复执行。`)
  }

  const validated = validateToolCall(name, call.function.arguments, env.now())
  if (!validated.ok) return toolError(validated.error)
  scope.executedCalls.add(call.id)
  const parsed: ValidatedToolCall = validated.value

  const isWrite =
    parsed.name === 'create_entry' ||
    parsed.name === 'update_entry' ||
    parsed.name === 'delete_entry'
  if (isWrite) {
    const signature = toolCallSignature(parsed)
    if (scope.writeSignatures.has(signature)) {
      return toolDuplicate('相同参数的重复调用已忽略，未重复写入。')
    }
    // 写入前登记签名：即使执行中途失败也不允许同参数重放，宁可少写不可重复写
    scope.writeSignatures.add(signature)
  }

  const entries = env.listEntries()
  try {
    switch (parsed.name) {
      case 'search_notes':
        return toolOk(searchNotes(parsed.args, entries))
      case 'list_todos':
        return toolOk(listTodos(entries))
      case 'list_reminders':
        return toolOk(listReminders(entries, env.now()))
      case 'get_note':
        return toolOk(getNote(parsed.args.id, entries))
      case 'create_entry':
        return await createEntry(parsed.args, env)
      case 'update_entry':
        return await updateEntry(parsed.args, env)
      case 'delete_entry':
        return deleteEntry(parsed.args.id, env, scope)
    }
  } catch (error) {
    return toolError(
      `工具执行失败（${error instanceof Error ? error.message : String(error)}）`,
    )
  }
}
