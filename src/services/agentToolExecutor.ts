import dayjs from 'dayjs'
import {
  AGENT_TOOL_NAMES,
  MAX_ITEMS,
  toolCallSignature,
  validateToolCall,
  type AgentToolName,
  type CreateEntryArgs,
  type UpdateEntryArgs,
  type ValidatedToolCall,
} from './agentToolArgs'
import {
  findAmbiguousTargets,
  formatAmbiguousTargets,
  resolveExplicitIdTargets,
  resolveExplicitTitleTargets,
  sourceBypassesAmbiguity,
  toTargetCandidate,
  type TargetTrustSource,
} from './agentTargets'
import {
  applyReminderTime,
  describeAlarm,
} from './reminderAlarms'
import { createDeleteProposal, finishDeleteProposal } from './deleteProposals'
import {
  createAlarmSelection,
  pendingAlarmCandidates,
  toSelectionCard,
  type AlarmSelectionPatch,
} from './alarmSelections'
import {
  failureFor,
  readFailure,
  type AgentFailure,
  type AgentFailureCategory,
} from './agentFailure'
import type {
  AiToolCall,
  AlarmSelectionPatchField,
  AssistantAlarmSelection,
  EntryReference,
  ToolEffect,
} from '../types/ai'
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

export type ToolPermission = 'none' | 'read' | 'write'

export const READ_ONLY_TOOL_NAMES: ReadonlySet<AgentToolName> = new Set([
  'search_notes',
  'list_todos',
  'list_reminders',
  'get_note',
])

const ALL_TOOL_NAMES: ReadonlySet<AgentToolName> = new Set(AGENT_TOOL_NAMES)

export interface TrustedTarget {
  id: string
  source: TargetTrustSource
  kind?: EntryKind
  title?: string
  trustedAt: number
}

export interface TrustedTargetInput {
  id: string
  source?: TargetTrustSource
  kind?: EntryKind
  title?: string
}

export interface WriteAttempt {
  callId: string
  tool: AgentToolName
  signature: string
}

export interface AgentToolBlockEvent {
  tool: string
  code: ToolBlockCode
  message: string
}

/** 单次请求的执行作用域：权限、目标来源、幂等集合都只在本请求内有效 */
export interface AgentToolScope {
  requestId: string
  /** 发起请求的助手消息 id：只用于把候选选择卡片关联回消息 */
  messageId?: string
  isStale: () => boolean
  /** 执行层强制权限；缺省必须是 none，不能仅依赖下发给模型的 tools 数组 */
  permission: ToolPermission
  /** 已获用户明确授权的写入目标；查询结果不会进入这里 */
  trustedTargets: Map<string, TrustedTarget>
  /** 查询结果与用户提到但未唯一解析的目标：只能作为候选，不能授权写入 */
  candidateTargets: Map<string, TrustedTarget>
  /** 本批次查询结果：批次结束后转入候选集合，仍然不是写入授权 */
  stagedTargets: TrustedTarget[]
  /** 本次请求已执行过的 tool_call_id */
  executedCalls: Set<string>
  /** 本次请求已执行过的写入参数签名 */
  writeSignatures: Set<string>
  /** 已进入执行器的写调用，用于失败重试时识别重复风险 */
  writeAttempts: WriteAttempt[]
  /** 写入结果未确认的目标：后续依赖它的写入必须先核对，不能自动执行 */
  uncertainEntryIds: Set<string>
  /** 重试保护：这些写工具在本次重试中禁止自动执行 */
  retryBlockedWriteTools?: ReadonlySet<AgentToolName>
  /** 权限/来源拦截的观测回调；生产环境用于安全日志 */
  onBlocked?: (event: AgentToolBlockEvent) => void
}

export interface AgentToolScopeOptions {
  permission?: ToolPermission
  trustedTargets?: readonly TrustedTargetInput[]
  blockedWriteTools?: Iterable<AgentToolName>
  writeSignatures?: Iterable<string>
  onBlocked?: (event: AgentToolBlockEvent) => void
}

export function createAgentToolScope(
  requestId: string,
  isStale: () => boolean = () => false,
  messageId?: string,
  options: AgentToolScopeOptions = {},
): AgentToolScope {
  const now = Date.now()
  const trustedTargets = new Map<string, TrustedTarget>()
  for (const target of options.trustedTargets ?? []) {
    trustedTargets.set(target.id, {
      id: target.id,
      source: target.source ?? 'user_explicit',
      ...(target.kind ? { kind: target.kind } : {}),
      ...(target.title ? { title: target.title } : {}),
      trustedAt: now,
    })
  }
  return {
    requestId,
    messageId,
    isStale,
    permission: options.permission ?? 'none',
    trustedTargets,
    candidateTargets: new Map<string, TrustedTarget>(),
    stagedTargets: [],
    executedCalls: new Set<string>(),
    writeSignatures: new Set<string>(options.writeSignatures ?? []),
    writeAttempts: [],
    uncertainEntryIds: new Set<string>(),
    ...(options.blockedWriteTools
      ? { retryBlockedWriteTools: new Set(options.blockedWriteTools) }
      : {}),
    ...(options.onBlocked ? { onBlocked: options.onBlocked } : {}),
  }
}

export function isToolAllowed(scope: AgentToolScope, name: string): boolean {
  const tool = name as AgentToolName
  if (!ALL_TOOL_NAMES.has(tool)) return false
  switch (scope.permission) {
    case 'write':
      return true
    case 'read':
      return READ_ONLY_TOOL_NAMES.has(tool)
    default:
      return false
  }
}

function rememberCandidate(scope: AgentToolScope, entry: Entry): void {
  if (scope.trustedTargets.has(entry.id) || scope.candidateTargets.has(entry.id)) return
  const candidate = toTargetCandidate(entry)
  scope.candidateTargets.set(entry.id, {
    id: candidate.id,
    source: 'tool_result',
    kind: candidate.kind,
    title: candidate.title,
    trustedAt: Date.now(),
  })
}

export function stageCandidateTarget(scope: AgentToolScope, entry: Entry): void {
  if (scope.trustedTargets.has(entry.id)) return
  if (scope.stagedTargets.some((target) => target.id === entry.id)) return
  const candidate = toTargetCandidate(entry)
  scope.stagedTargets.push({
    id: candidate.id,
    source: 'tool_result',
    kind: candidate.kind,
    title: candidate.title,
    trustedAt: Date.now(),
  })
}

/** 批次结束后把查询结果转入候选集合；候选不是用户授权，不能直接用于写入 */
export function commitStagedCandidates(scope: AgentToolScope): void {
  for (const target of scope.stagedTargets) {
    if (!scope.trustedTargets.has(target.id) && !scope.candidateTargets.has(target.id)) {
      scope.candidateTargets.set(target.id, target)
    }
  }
  scope.stagedTargets = []
}

/**
 * 为请求建立初始可信目标：
 * - 用户原文里的显式 id / 唯一标题；
 * - 只有本轮明确说「这个/当前/这条」时，选中条目才成为授权目标；
 * - 本轮用户用「刚才那条 / 第二条 / 它」等指代、且对话记忆唯一解析出的目标，
 *   由调用方通过 conversationTargets 显式传入（仍会按真实数据校验并接受歧义拦截）；
 * - 用户提到但无法唯一解析的标题只登记为候选；
 * - <notes> 上下文、历史摘要、历史消息、查询结果和 get_note 一律不在此处登记为授权。
 */
export function seedTrustedTargets(
  scope: AgentToolScope,
  input: {
    userText: string
    entries: Entry[]
    selectedId?: string | null
    allowSelectedReferent?: boolean
    /** 只接受调用方已唯一解析、且在当前真实数据中存在的对话指代目标 */
    conversationTargets?: readonly { id: string; kind?: EntryKind; title?: string }[]
  },
): void {
  const byId = new Map(input.entries.map((entry) => [entry.id, entry]))
  const now = Date.now()
  for (const entry of resolveExplicitIdTargets(input.userText, input.entries)) {
    const candidate = toTargetCandidate(entry)
    scope.trustedTargets.set(entry.id, {
      id: entry.id,
      source: 'user_explicit',
      kind: candidate.kind,
      title: candidate.title,
      trustedAt: now,
    })
  }
  if (input.allowSelectedReferent && input.selectedId) {
    const entry = byId.get(input.selectedId)
    if (entry) {
      const candidate = toTargetCandidate(entry)
      scope.trustedTargets.set(entry.id, {
        id: entry.id,
        source: 'user_selected',
        kind: candidate.kind,
        title: candidate.title,
        trustedAt: now,
      })
    }
  }
  for (const target of input.conversationTargets ?? []) {
    const entry = byId.get(target.id)
    if (!entry) continue
    if (scope.trustedTargets.has(entry.id)) continue
    const candidate = toTargetCandidate(entry)
    scope.trustedTargets.set(entry.id, {
      id: entry.id,
      source: 'conversation_referent',
      kind: candidate.kind,
      title: candidate.title,
      trustedAt: now,
    })
  }
  const titled = resolveExplicitTitleTargets(input.userText, input.entries)
  for (const entry of titled) {
    if (titled.length === 1) {
      const candidate = toTargetCandidate(entry)
      if (!scope.trustedTargets.has(entry.id)) {
        scope.trustedTargets.set(entry.id, {
          id: entry.id,
          source: 'user_explicit',
          kind: candidate.kind,
          title: candidate.title,
          trustedAt: now,
        })
      }
    } else {
      rememberCandidate(scope, entry)
    }
  }
}

export type ToolOutcomeStatus = 'ok' | 'error' | 'cancelled' | 'duplicate' | 'confirm'

export type ToolBlockCode =
  | 'permission_denied'
  | 'target_untrusted'
  | 'target_ambiguous'
  | 'retry_duplicate_risk'

/** 删除确认卡片数据：与 utils/assistantActions 的 AssistantAction 结构兼容 */
export interface ToolConfirmAction {
  op: 'delete'
  kind: EntryKind
  title: string
  content: string
  targetId: string
  proposalId: string
  /** 生成该步骤的执行历史 id：仅用于回写真实结果 */
  executionId: string
  /** 生成该步骤的历史步骤 id：仅用于精确回写 */
  stepId: string
  expiresAt: number
}

export interface ToolOutcome {
  status: ToolOutcomeStatus
  result: string
  confirmAction?: ToolConfirmAction
  /** 这次调用真实产生的数据影响（供执行记录与结果小结使用） */
  effect?: ToolEffect
  /** 信息不足，需要用户补充后才能继续（如多个闹钟未指定目标） */
  needsInput?: boolean
  /** 多闹钟歧义：生成的候选选择卡片，只有用户点击才产生修改授权 */
  alarmSelection?: AssistantAlarmSelection
  /** 执行层拦截原因：只用于日志与测试，不进入业务写入 */
  blockedCode?: ToolBlockCode
  /** 统一失败分类：结果不确定时禁止自动重放，必须由用户核对 */
  failure?: AgentFailure
}

const BLOCK_FAILURE_CATEGORY: Record<ToolBlockCode, AgentFailureCategory> = {
  permission_denied: 'permission_denied',
  target_untrusted: 'permission_denied',
  target_ambiguous: 'target_ambiguous',
  retry_duplicate_risk: 'execution_unknown',
}

function toolBlocked(
  code: ToolBlockCode,
  message: string,
  options: { needsInput?: boolean } = {},
): ToolOutcome {
  return {
    status: 'error',
    result: `已拦截：${message}`,
    blockedCode: code,
    failure: failureFor(
      BLOCK_FAILURE_CATEGORY[code],
      code === 'retry_duplicate_risk' ? 'unknown' : 'none',
    ),
    ...(options.needsInput ? { needsInput: true } : {}),
  }
}

function reportBlocked(
  scope: AgentToolScope,
  tool: string,
  code: ToolBlockCode,
  message: string,
): void {
  scope.onBlocked?.({ tool, code, message })
}

function toolOk(result: string, effect?: ToolEffect): ToolOutcome {
  return { status: 'ok', result, effect }
}

function toolError(
  message: string,
  failure: AgentFailure = failureFor('business_execution_failed'),
): ToolOutcome {
  return { status: 'error', result: `错误：${message}`, failure }
}

function toolCancelled(message: string): ToolOutcome {
  return {
    status: 'cancelled',
    result: `错误：${message}`,
    failure: failureFor('execution_cancelled'),
  }
}

/** 写入可能已经生效但无法确认：禁止自动重试，只能让用户核对真实数据 */
function toolUnknown(
  message: string,
  category: 'execution_unknown' | 'readback_failed',
): ToolOutcome {
  return {
    status: 'error',
    result: `错误：${message}`,
    failure: failureFor(category, 'unknown'),
  }
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

/** 结构化条目引用：只来自工具真实返回，供对话记忆理解指代 */
function toEntryReferences(entries: Entry[]): EntryReference[] {
  return entries.slice(0, MAX_SEARCH_HITS).map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    title: entryTitle(entry),
  }))
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

/** 标题归一化：仅用于判断「同名结果」这一确定性歧义信号 */
function normalizedTitle(title: string): string {
  return title.replace(/\s+/g, '').toLowerCase()
}

interface SearchResult {
  text: string
  count: number
  entries: Entry[]
}

function searchNotes(
  args: { query: string; kind?: EntryKind },
  entries: Entry[],
): SearchResult {
  const needle = args.query.toLowerCase()
  const hits = entries
    .filter((entry) => {
      if (args.kind && entry.kind !== args.kind) return false
      if (entry.title.toLowerCase().includes(needle)) return true
      if (entry.tags.some((tag) => tag.toLowerCase().includes(needle))) return true
      return cleanContent(entry.content).toLowerCase().includes(needle)
    })
    .slice(0, MAX_SEARCH_HITS)

  if (hits.length === 0) {
    return { text: `没有找到匹配「${args.query}」的便签。`, count: 0, entries: [] }
  }

  // 同名结果：修改/删除前必须让用户指明具体条目，避免模型默认取第一条
  const titleCount = new Map<string, { title: string; count: number }>()
  for (const hit of hits) {
    const key = normalizedTitle(entryTitle(hit))
    const current = titleCount.get(key)
    if (current) current.count += 1
    else titleCount.set(key, { title: entryTitle(hit), count: 1 })
  }
  const duplicates = Array.from(titleCount.values()).filter((item) => item.count > 1)
  const hint =
    duplicates.length > 0
      ? `\n注意：以下标题存在多条记录：${duplicates
          .map((item) => `「${item.title}」×${item.count}`)
          .join('、')}。用户要修改或删除时必须先询问是哪一条（用 id 区分），不要自行挑选或批量修改。`
      : ''

  return {
    text: truncate(
      `找到 ${hits.length} 条：\n${hits.map((entry) => describeEntry(entry, 200)).join('\n')}${hint}`,
      MAX_RESULT_CHARS,
    ),
    count: hits.length,
    entries: hits,
  }
}

function listTodos(entries: Entry[]): SearchResult {
  const todos = entries.filter((entry) => entry.kind === 'todo' && !entry.done)
  if (todos.length === 0) return { text: '当前没有未完成的待办。', count: 0, entries: [] }
  return {
    text: truncate(
      `未完成待办 ${todos.length} 条：\n${todos.map((entry) => describeEntry(entry, 160)).join('\n')}`,
      MAX_RESULT_CHARS,
    ),
    count: todos.length,
    entries: todos,
  }
}

function listReminders(entries: Entry[], now: number): SearchResult {
  const reminders = entries
    .filter(
      (entry): entry is ReminderEntry =>
        entry.kind === 'reminder' &&
        !entry.done &&
        entry.alarms.some((alarm) => !alarm.notified && alarm.remindAt > now - 3600_000),
    )
    .sort((a, b) => (nextPendingAlarmAt(a) ?? 0) - (nextPendingAlarmAt(b) ?? 0))
  if (reminders.length === 0) {
    return { text: '当前没有待触发的提醒。', count: 0, entries: [] }
  }
  return {
    text: truncate(
      `待触发提醒 ${reminders.length} 条（按时间从近到远）：\n${reminders
        .map((entry) => describeEntry(entry, 160))
        .join('\n')}`,
      MAX_RESULT_CHARS,
    ),
    count: reminders.length,
    entries: reminders,
  }
}

function getNote(id: string, entries: Entry[]): { text: string; entry: Entry } | null {
  const entry = entries.find((item) => item.id === id)
  if (!entry) return null
  const header = `[${KIND_LABEL[entry.kind]}] ${entryTitle(entry)}（id: ${entry.id}）`
  if (entry.kind === 'todo') {
    const items = entry.items
      .map((item) => `- [${item.done ? 'x' : ' '}] ${item.text}`)
      .join('\n')
    return {
      text: truncate(`${header}\n状态：${entry.done ? '已完成' : '未完成'}\n${items}`, MAX_NOTE_CHARS),
      entry,
    }
  }
  if (entry.kind === 'reminder') {
    const alarms = entry.alarms
      .map(
        (alarm) =>
          `- ${describeAlarm(alarm)}（alarm_id: ${alarm.id}）${alarm.notified ? '（已触发）' : ''}`,
      )
      .join('\n')
    return { text: truncate(`${header}\n闹钟：\n${alarms}`, MAX_NOTE_CHARS), entry }
  }
  const content = cleanContent(entry.content) || '（无文字内容）'
  return { text: truncate(`${header}\n${content}`, MAX_NOTE_CHARS), entry }
}

function trustCreatedTarget(scope: AgentToolScope, entry: Entry): void {
  const candidate = toTargetCandidate(entry)
  scope.trustedTargets.set(entry.id, {
    id: entry.id,
    source: 'created',
    kind: candidate.kind,
    title: candidate.title,
    trustedAt: Date.now(),
  })
}

async function createEntry(
  args: CreateEntryArgs,
  env: AgentToolEnvironment,
  scope: AgentToolScope,
): Promise<ToolOutcome> {
  const input: NewEntryInput = {
    title: args.title,
    content: args.content,
    ...(args.remindAt !== undefined ? { remindAt: args.remindAt } : {}),
    ...(args.items && args.items.length > 0 ? { items: args.items } : {}),
  }
  let entry: Entry | null
  try {
    entry = await env.addEntry(input, args.kind)
  } catch {
    // 仓储异常可能发生在写入中途：不能断言未创建，也不能自动重试
    return toolUnknown(
      `创建${KIND_LABEL[args.kind]}时执行异常，无法确认是否已写入。请先检查便签列表，不要直接重试创建。`,
      'execution_unknown',
    )
  }
  if (!entry) {
    // store 捕获仓储异常后返回 null：无法区分「未写入」和「写入后失败」
    return toolUnknown(
      `创建${KIND_LABEL[args.kind]}未能确认结果，可能已写入也可能未写入。请先检查便签列表，不要直接重试创建。`,
      'execution_unknown',
    )
  }

  // 回读实际数据：确认条目真实存在且类型一致，避免「已创建」与实际不符
  const stored = env.listEntries().find((item) => item.id === entry.id)
  if (!stored || stored.kind !== args.kind) {
    scope.uncertainEntryIds.add(entry.id)
    return toolUnknown(
      '创建结果无法在数据中确认，可能已写入也可能未写入。请先检查便签列表，不要直接重试创建。',
      'readback_failed',
    )
  }
  trustCreatedTarget(scope, stored)
  const extra =
    args.kind === 'reminder' && args.remindAt !== undefined
      ? `，提醒时间 ${dayjs(args.remindAt).format('YYYY-MM-DD HH:mm')}`
      : args.kind === 'todo' && args.items?.length
        ? `，含 ${args.items.length} 个子任务`
        : ''
  return toolOk(
    `已创建${KIND_LABEL[args.kind]}「${stored.title}」（id: ${stored.id}${extra}），已直接写入并生效，无需用户确认。`,
    {
      op: 'create',
      kind: stored.kind,
      entryId: stored.id,
      title: entryTitle(stored),
      references: toEntryReferences([stored]),
    },
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

interface AlarmUpdateAuthorization {
  entryId: string
  alarmId: string
  /** 用户点击候选时明确授权过的字段；未列出的字段一律拒绝 */
  allowedFields: ReadonlySet<AlarmSelectionPatchField>
}

const AUTHORIZED_FIELD_LABEL: Record<AlarmSelectionPatchField, string> = {
  remindAt: '提醒时间',
  title: '标题',
  content: '正文',
  appendContent: '追加正文',
  completeItems: '勾选子任务',
  addItems: '新增子任务',
  addTags: '添加标签',
  removeTags: '移除标签',
}

const AUTHORIZED_FIELDS: AlarmSelectionPatchField[] = [
  'remindAt',
  'title',
  'content',
  'appendContent',
  'completeItems',
  'addItems',
  'addTags',
  'removeTags',
]

/**
 * 写入目标守卫：
 * - id 必须来自本请求已登记的用户授权，存在、查询命中或模型传参本身都不等于授权；
 * - 同名或高相似时，除非用户已明确指定/选择，否则必须先让用户确认；
 * - 只返回拦截结果，不产生任何写入。
 */
function guardWriteTarget(
  entry: Entry,
  entries: Entry[],
  scope: AgentToolScope,
  tool: string,
): ToolOutcome | null {
  const trusted = scope.trustedTargets.get(entry.id)
  const authorized = trusted !== undefined && trusted.source !== 'tool_result'
  const { exact, similar } = findAmbiguousTargets(entry, entries)
  const ambiguous = exact.length > 0 || similar.length > 0

  if (!authorized) {
    if (ambiguous) {
      const list = formatAmbiguousTargets(entry, exact, similar)
      const message =
        `目标「${entry.title.trim() || '无标题'}」存在同名或高度相似的条目：${list}。` +
        '查询结果只是候选，不能代替用户选择；请让用户明确指定具体条目，未执行任何修改或删除。'
      reportBlocked(scope, tool, 'target_ambiguous', message)
      return toolBlocked('target_ambiguous', message, { needsInput: true })
    }
    const candidates = Array.from(scope.candidateTargets.values())
      .slice(0, 6)
      .map((item) => `id=${item.id}「${item.title}」`)
      .join('；')
    const hint = candidates ? `当前候选：${candidates}。` : ''
    const message =
      '目标 id 尚未获得用户明确授权（查询结果、历史消息和模型自行选择的 id 都不是授权）。' +
      `${hint}请先向用户确认要操作的具体条目，未执行任何写入。`
    reportBlocked(scope, tool, 'target_untrusted', message)
    return toolBlocked('target_untrusted', message, { needsInput: true })
  }

  if (ambiguous && !sourceBypassesAmbiguity(trusted.source)) {
    const list = formatAmbiguousTargets(entry, exact, similar)
    const message =
      `目标「${entry.title.trim() || '无标题'}」存在同名或高度相似的条目：${list}。` +
      '请让用户明确指定具体条目（回复 id 或完整标题），未执行任何修改或删除。'
    reportBlocked(scope, tool, 'target_ambiguous', message)
    return toolBlocked('target_ambiguous', message, { needsInput: true })
  }
  return null
}

async function updateEntry(
  args: UpdateEntryArgs,
  env: AgentToolEnvironment,
  scope: AgentToolScope,
  callId: string,
  authorization?: AlarmUpdateAuthorization,
  entriesSnapshot?: Entry[],
): Promise<ToolOutcome> {
  const entries = entriesSnapshot ?? env.listEntries()
  const entry = entries.find((item) => item.id === args.id)
  if (!entry) {
    return toolError(
      `找不到 id 为 ${args.id} 的便签，可能已被删除`,
      failureFor('target_not_found'),
    )
  }
  const blocked = guardWriteTarget(entry, entries, scope, 'update_entry')
  if (blocked) return blocked
  if (entry.kind === 'draw') return toolError('涂鸦条目暂不支持由 AI 修改')

  if (authorization) {
    // 授权再校验：点击候选只允许执行卡片展示过的字段，不接受任何额外参数
    if (args.remindAt === undefined || !authorization.allowedFields.has('remindAt')) {
      return toolError('授权只适用于提醒时间修改，未执行')
    }
    const outside = AUTHORIZED_FIELDS.filter(
      (field) =>
        field !== 'remindAt' &&
        args[field] !== undefined &&
        !authorization.allowedFields.has(field),
    )
    if (outside.length > 0) {
      return toolError(
        `授权范围不包括：${outside
          .map((field) => AUTHORIZED_FIELD_LABEL[field])
          .join('、')}，未执行修改`,
      )
    }
  }

  // 多闹钟歧义：模型提供的 alarm_id 不是用户授权，必须先由用户点击候选
  if (args.remindAt !== undefined && entry.kind === 'reminder') {
    const candidates = pendingAlarmCandidates(entry.alarms)
    if (authorization) {
      if (authorization.entryId !== entry.id) {
        return toolError('用户选择的目标与本次修改不一致，未执行')
      }
      if (args.alarmId !== undefined && args.alarmId !== authorization.alarmId) {
        return toolError('模型指定的闹钟与用户选择不一致，未执行修改')
      }
      if (!candidates.some((alarm) => alarm.id === authorization.alarmId)) {
        return toolError('用户选择的闹钟已不存在或已触发，请重新选择')
      }
    } else if (candidates.length > 1) {
      const proposal = createAlarmSelection({
        entry,
        args,
        requestId: scope.requestId,
        messageId: scope.messageId,
        toolCallId: callId,
        now: env.now(),
      })
      const list = candidates
        .map((alarm) => `alarm_id=${alarm.id}（${describeAlarm(alarm)}）`)
        .join('；')
      return {
        ...toolError(
          `该提醒有 ${candidates.length} 个可修改闹钟：${list}。已向用户展示选择卡片，等待用户选择，不要自行挑选或重复调用`,
        ),
        needsInput: true,
        alarmSelection: toSelectionCard(proposal),
      }
    }
  }
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
    // 有用户授权时只允许改授权选中的闹钟，绝不改选其它闹钟
    const targetAlarmId = authorization ? authorization.alarmId : args.alarmId
    const applied = applyReminderTime(
      entry.alarms,
      targetAlarmId,
      args.remindAt,
      env.now(),
    )
    if (!applied.ok) {
      // 多闹钟未指定目标属于「信息不足」，需要用户补充而不是重试同样的参数
      const ambiguous = applied.code === 'ambiguous_alarm'
      return {
        ...toolError(
          applied.error,
          ambiguous
            ? failureFor('target_ambiguous')
            : failureFor('business_execution_failed', 'failed'),
        ),
        needsInput: ambiguous,
      }
    }
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

  try {
    await env.updateEntry(entry.id, patch as Partial<Entry>)
  } catch {
    // 写入已提交但异常中断：不能断言失败，更不能自动重放相同修改
    scope.uncertainEntryIds.add(entry.id)
    return toolUnknown(
      '修改时执行异常，结果无法确认。请先检查便签实际内容，不要直接重试相同修改。',
      'execution_unknown',
    )
  }

  const stored = env.listEntries().find((item) => item.id === entry.id)
  if (!stored) {
    scope.uncertainEntryIds.add(entry.id)
    return toolUnknown(
      '修改未能确认：目标条目在回读时不存在，状态可能已变化。请先检查便签列表。',
      'readback_failed',
    )
  }
  const mismatch = verifyUpdate(stored, expected)
  if (mismatch) {
    scope.uncertainEntryIds.add(entry.id)
    return toolUnknown(
      `修改未能确认：${mismatch}。请先检查便签实际内容，不要直接重试相同修改。`,
      'readback_failed',
    )
  }

  return toolOk(
    `已修改便签「${entryTitle(stored)}」（id: ${stored.id}）：${changes.join('；')}，已直接生效。`,
    {
      op: 'update',
      kind: stored.kind,
      entryId: stored.id,
      title: entryTitle(stored),
      references: toEntryReferences([stored]),
    },
  )
}

function deleteEntry(
  id: string,
  env: AgentToolEnvironment,
  scope: AgentToolScope,
  callId: string,
  entriesSnapshot?: Entry[],
): ToolOutcome {
  const entries = entriesSnapshot ?? env.listEntries()
  const entry = entries.find((item) => item.id === id)
  if (!entry) {
    return toolError(
      `找不到 id 为 ${id} 的便签，可能已被删除`,
      failureFor('target_not_found'),
    )
  }
  const blocked = guardWriteTarget(entry, entries, scope, 'delete_entry')
  if (blocked) return blocked
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
    effect: { op: 'delete', kind: entry.kind, entryId: entry.id, title: entryTitle(entry) },
    confirmAction: {
      op: 'delete',
      kind: entry.kind,
      title: entryTitle(entry),
      content: '',
      targetId: entry.id,
      proposalId: proposal.id,
      executionId: scope.requestId,
      stepId: `${scope.requestId}:${callId}`,
      expiresAt: proposal.expiresAt,
    },
  }
}

/** 执行一次模型发起的工具调用（权限 → 来源 → 参数 → 幂等 → 业务执行 → 真实结果回读） */
export async function executeToolWithEnv(
  call: AiToolCall,
  env: AgentToolEnvironment,
  scope: AgentToolScope,
): Promise<ToolOutcome> {
  const name = call.function.name

  if (scope.isStale()) {
    return toolCancelled('请求已停止，未执行该工具调用')
  }

  // 执行层强制权限：模型返回的 tools 数组只是建议，不是授权
  if (!isToolAllowed(scope, name)) {
    const message = `当前请求的工具范围不允许调用 ${name}，未执行任何操作。`
    reportBlocked(scope, name, 'permission_denied', message)
    return toolBlocked('permission_denied', message)
  }

  if (scope.executedCalls.has(call.id)) {
    return toolDuplicate(`重复的工具调用 ${call.id} 已忽略，未重复执行。`)
  }

  const validated = validateToolCall(name, call.function.arguments, env.now())
  if (!validated.ok) {
    return toolError(validated.error, failureFor('invalid_tool_arguments'))
  }
  const parsed: ValidatedToolCall = validated.value

  const isWrite =
    parsed.name === 'create_entry' ||
    parsed.name === 'update_entry' ||
    parsed.name === 'delete_entry'

  // 重试保护：上一轮已有创建/修改尝试时，本次重试不自动重复写
  if (isWrite && scope.retryBlockedWriteTools?.has(parsed.name)) {
    const message =
      '上一次请求已有创建或修改尝试，重试时执行层禁止自动重复写入，避免生成重复数据。' +
      '请先向用户说明上一轮可能已完成的内容，由用户确认当前状态后再发起新的操作。'
    reportBlocked(scope, name, 'retry_duplicate_risk', message)
    return toolBlocked('retry_duplicate_risk', message, { needsInput: true })
  }

  // 依赖失败：目标此前写入结果未确认时，后续修改 / 删除不能继续，先让用户核对
  if (
    (parsed.name === 'update_entry' || parsed.name === 'delete_entry') &&
    scope.uncertainEntryIds.has(parsed.args.id)
  ) {
    return {
      status: 'error',
      result:
        '错误：该便签上一次写入的状态尚未确认，依赖它的后续操作已停止，未执行任何新的修改。请先核对便签实际内容，再重新发起操作。',
      failure: failureFor('dependency_failed', 'unknown'),
    }
  }

  const entries = env.listEntries()

  // 写入目标来源守卫：在登记幂等签名之前判断，避免被拦截的调用占掉后续合法重试
  if (parsed.name === 'update_entry' || parsed.name === 'delete_entry') {
    const target = entries.find((entry) => entry.id === parsed.args.id)
    if (target) {
      const blocked = guardWriteTarget(target, entries, scope, parsed.name)
      if (blocked) return blocked
    }
  }

  scope.executedCalls.add(call.id)
  if (isWrite) {
    const signature = toolCallSignature(parsed)
    if (scope.writeSignatures.has(signature)) {
      return toolDuplicate('相同参数的重复调用已忽略，未重复写入。')
    }
    // 写入前登记签名：即使执行中途失败也不允许同参数重放，宁可少写不可重复写
    scope.writeSignatures.add(signature)
    scope.writeAttempts.push({ callId: call.id, tool: parsed.name, signature })
  }

  try {
    switch (parsed.name) {
      case 'search_notes': {
        const found = searchNotes(parsed.args, entries)
        for (const entry of found.entries) stageCandidateTarget(scope, entry)
        return toolOk(found.text, {
          op: 'search',
          count: found.count,
          references: toEntryReferences(found.entries),
        })
      }
      case 'list_todos': {
        const found = listTodos(entries)
        for (const entry of found.entries) stageCandidateTarget(scope, entry)
        return toolOk(found.text, {
          op: 'list',
          count: found.count,
          references: toEntryReferences(found.entries),
        })
      }
      case 'list_reminders': {
        const found = listReminders(entries, env.now())
        for (const entry of found.entries) stageCandidateTarget(scope, entry)
        return toolOk(found.text, {
          op: 'list',
          count: found.count,
          references: toEntryReferences(found.entries),
        })
      }
      case 'get_note': {
        const found = getNote(parsed.args.id, entries)
        if (!found) {
          return toolError(
            `找不到 id 为 ${parsed.args.id} 的便签，可能已被删除`,
            failureFor('target_not_found'),
          )
        }
        // 读取成功只证明条目存在，不登记为目标授权
        return toolOk(found.text, {
          op: 'read',
          kind: found.entry.kind,
          entryId: found.entry.id,
          title: entryTitle(found.entry),
          references: toEntryReferences([found.entry]),
        })
      }
      case 'create_entry':
        return await createEntry(parsed.args, env, scope)
      case 'update_entry':
        return await updateEntry(parsed.args, env, scope, call.id, undefined, entries)
      case 'delete_entry':
        return deleteEntry(parsed.args.id, env, scope, call.id, entries)
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (isWrite) {
      return toolUnknown(
        `工具执行失败（${detail}），写入状态无法确认。请先检查便签列表，不要直接重试。`,
        'execution_unknown',
      )
    }
    return toolError(`工具执行失败（${detail}）`, readFailure())
  }
}

/**
 * 用户已点击候选闹钟后执行修改：只走提醒时间这一条已授权路径。
 * - 不经过模型、不接受模型重新指定的 alarm_id；
 * - 授权是否仍有效由调用方在 claim 时与写入前复查；
 * - 复用 update_entry 的其余字段逻辑，避免丢掉同一次请求里的标题/正文等变更。
 */
export async function executeAuthorizedAlarmUpdate(input: {
  entryId: string
  alarmId: string
  patch: AlarmSelectionPatch
  /** 来自候选提议的字段白名单；调用方不得在点击后追加字段 */
  allowedFields: readonly AlarmSelectionPatchField[]
  env: AgentToolEnvironment
}): Promise<ToolOutcome> {
  const scope = createAgentToolScope('authorized-alarm-selection', () => false, undefined, {
    permission: 'write',
    trustedTargets: [{ id: input.entryId, source: 'authorized_selection' }],
  })
  return updateEntry(
    { ...input.patch, id: input.entryId, alarmId: input.alarmId },
    input.env,
    scope,
    'authorized-alarm-selection',
    {
      entryId: input.entryId,
      alarmId: input.alarmId,
      allowedFields: new Set(input.allowedFields),
    },
  )
}
