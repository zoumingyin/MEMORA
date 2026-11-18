import { parseToolArguments } from './agentToolArgs'
import { AGENT_TOOL_PROMPT, NO_TOOL_PROMPT } from './agentToolSchema'
import type { ToolConfirmAction, ToolOutcome } from './agentToolExecutor'
import type {
  AiChatMessage,
  AiToolCall,
  AssistantAlarmSelection,
  AssistantPhase,
  AssistantToolStep,
} from '../types/ai'

/**
 * Agent 执行编排的纯逻辑（不依赖 store / 网络）：
 * - 按模型给出的顺序执行同一轮的全部工具调用；
 * - 生成可持久化的执行记录，内容只来自工具真实返回；
 * - 达到轮次上限时生成确定性的「已完成 / 未完成」提示；
 * - 推导最终阶段（完成 / 部分完成 / 失败 / 等待补充）。
 */

/** agent loop 工具轮数上限：防止模型连环调用不收敛 */
export const MAX_TOOL_ROUNDS = 8

/** 单步记录里展示的结果摘要上限（完整结果仍回传给模型） */
const MAX_STEP_MESSAGE_CHARS = 300
const MAX_LABEL_TITLE_CHARS = 24

/** 这些错误码出现在「带 tools 的首次请求且无任何输出」时，按不支持工具降级重试 */
export const TOOL_UNSUPPORTED_CODES = new Set([
  'http_error',
  'endpoint_not_found',
  'server_error',
])

const READ_ONLY_TOOLS = new Set([
  'search_notes',
  'list_todos',
  'list_reminders',
  'get_note',
])

const KIND_SHORT: Record<string, string> = {
  note: '备忘',
  todo: '待办',
  reminder: '提醒',
  draw: '涂鸦',
}

export const STEP_STATUS_LABEL: Record<AssistantToolStep['status'], string> = {
  ok: '成功',
  error: '失败',
  cancelled: '已停止',
  duplicate: '已跳过',
  confirm: '待确认',
  execution_unknown: '状态待核对',
  interrupted: '已中断',
}

export function stepStatusLabel(step: AssistantToolStep): string {
  if (step.failure?.category === 'readback_failed') return '待核对'
  if (step.failure?.category === 'execution_unknown') return '状态未知'
  if (step.failure?.category === 'dependency_failed') return '依赖未完成'
  if (step.blockedCode) return '已拦截'
  if (step.needsInput) return '等待补充'
  return STEP_STATUS_LABEL[step.status] ?? step.status
}

export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name)
}

export function callsAreReadOnly(calls: AiToolCall[]): boolean {
  return calls.every((call) => isReadOnlyTool(call.function.name))
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

function quoted(title: string): string {
  return `「${clip(title, MAX_LABEL_TITLE_CHARS)}」`
}

/** 工具调用的用户可读标签：执行后优先使用工具返回的真实标题 */
export function describeToolCall(call: AiToolCall, outcome?: ToolOutcome): string {
  const name = call.function.name
  const effect = outcome?.effect
  if (effect?.title) {
    if (effect.op === 'create') {
      return `新建${KIND_SHORT[effect.kind ?? 'note'] ?? '便签'}${quoted(effect.title)}`
    }
    if (effect.op === 'update') return `修改${quoted(effect.title)}`
    if (effect.op === 'read') return `读取${quoted(effect.title)}`
    if (effect.op === 'delete') return `删除${quoted(effect.title)}`
  }

  const parsed = parseToolArguments(call.function.arguments)
  const args = parsed.ok ? parsed.value : {}
  const asText = (key: string): string =>
    typeof args[key] === 'string' ? (args[key] as string) : ''

  switch (name) {
    case 'search_notes':
      return `搜索便签${quoted(asText('query') || '关键词')}`
    case 'list_todos':
      return '查看未完成待办'
    case 'list_reminders':
      return '查看待触发提醒'
    case 'get_note':
      return `读取便签 ${asText('id')}`.trim()
    case 'create_entry': {
      const kind = KIND_SHORT[asText('kind')] ?? '便签'
      const title = asText('title')
      return title ? `新建${kind}${quoted(title)}` : `新建${kind}`
    }
    case 'update_entry':
      return `修改便签 ${asText('id')}`.trim()
    case 'delete_entry':
      return `请求删除便签 ${asText('id')}`.trim()
    default:
      return name
  }
}

export interface ToolBatchResult {
  steps: AssistantToolStep[]
  toolMessages: AiChatMessage[]
  confirmCards: ToolConfirmAction[]
  /** 提醒歧义时生成的候选选择卡片（需用户点击才产生授权） */
  alarmSelections: AssistantAlarmSelection[]
  /** 执行中途用户点了停止：后续工具未执行 */
  aborted: boolean
  /** 因停止而未执行的调用（含正在执行的调用之后的所有调用） */
  unexecutedCalls: AiToolCall[]
  hadError: boolean
  needsInput: boolean
}

export type ToolProgressEvent =
  | { type: 'start'; call: AiToolCall; index: number }
  | { type: 'finish'; call: AiToolCall; index: number; outcome: ToolOutcome }

/**
 * 执行同一轮的全部工具调用：严格按模型给出的顺序串行执行。
 * - 同一批次内的调用互相独立：模型在发出它们时看不到任何结果，
 *   结果只在整个批次结束后一次性回传，跨轮次依赖由下一轮模型调用完成；
 * - 每次调用前检查请求是否已停止，停止后未开始的工具一律不执行；
 * - 执行期间用户停止时，不把该次结果回传模型、不展示卡片；
 * - 某个调用失败不会中断后续调用，失败结果照实回传。
 */
export async function executeToolBatch(
  calls: AiToolCall[],
  execute: (call: AiToolCall) => Promise<ToolOutcome>,
  isStale: () => boolean,
  onComplete?: () => void,
  onProgress?: (event: ToolProgressEvent) => void,
): Promise<ToolBatchResult> {
  const steps: AssistantToolStep[] = []
  const toolMessages: AiChatMessage[] = []
  const confirmCards: ToolConfirmAction[] = []
  const alarmSelections: AssistantAlarmSelection[] = []
  let aborted = false
  let hadError = false
  let needsInput = false
  let executedCount = 0

  for (const [index, call] of calls.entries()) {
    if (isStale()) {
      aborted = true
      break
    }
    onProgress?.({ type: 'start', call, index })
    const outcome = await execute(call)
    executedCount = index + 1
    if (outcome.status === 'error') hadError = true
    if (outcome.needsInput) needsInput = true
    // 已执行的调用先记入执行记录：即使执行期间用户点停止，已完成的事实也要如实展示
    steps.push({
      callId: call.id,
      tool: call.function.name,
      label: describeToolCall(call, outcome),
      status: outcome.status,
      message: clip(outcome.result, MAX_STEP_MESSAGE_CHARS),
      ...(outcome.needsInput ? { needsInput: true } : {}),
      ...(outcome.confirmAction
        ? { proposalId: outcome.confirmAction.proposalId }
        : {}),
      ...(outcome.blockedCode ? { blockedCode: outcome.blockedCode } : {}),
      ...(outcome.failure ? { failure: { ...outcome.failure } } : {}),
      ...(outcome.effect ? { effect: outcome.effect } : {}),
    })
    onProgress?.({ type: 'finish', call, index, outcome })

    // 执行期间停止：已提交的写入不回滚，但不再回传结果、不展示删除卡片
    if (isStale()) {
      aborted = true
      break
    }
    if (outcome.confirmAction) confirmCards.push(outcome.confirmAction)
    if (outcome.alarmSelection) alarmSelections.push(outcome.alarmSelection)
    toolMessages.push({
      role: 'tool',
      tool_call_id: call.id,
      content: outcome.result,
    })
  }

  onComplete?.()
  return {
    steps,
    toolMessages,
    confirmCards,
    alarmSelections,
    aborted,
    unexecutedCalls: calls.slice(executedCount),
    hadError,
    needsInput,
  }
}

export interface ExecutionSummary {
  steps: AssistantToolStep[]
  searches: AssistantToolStep[]
  reads: AssistantToolStep[]
  lists: AssistantToolStep[]
  created: AssistantToolStep[]
  updated: AssistantToolStep[]
  deleteRequests: AssistantToolStep[]
  failed: AssistantToolStep[]
  /** 写入可能已生效但无法确认：不能当作普通失败，也不能自动重放 */
  unknown: AssistantToolStep[]
  needsInput: AssistantToolStep[]
  duplicates: AssistantToolStep[]
  blocked: AssistantToolStep[]
  successfulCount: number
}

/** 按工具真实返回的 effect 汇总执行结果，不推测未执行的计划 */
export function summarizeExecution(steps: AssistantToolStep[]): ExecutionSummary {
  const byOp = (op: string): AssistantToolStep[] =>
    steps.filter((step) => step.effect?.op === op)
  return {
    steps,
    searches: byOp('search'),
    reads: byOp('read'),
    lists: byOp('list'),
    created: byOp('create'),
    updated: byOp('update'),
    deleteRequests: byOp('delete'),
    failed: steps.filter(
      (step) =>
        step.status === 'error' &&
        !step.needsInput &&
        step.failure?.requiresVerification !== true,
    ),
    unknown: steps.filter((step) => step.failure?.requiresVerification === true),
    needsInput: steps.filter((step) => step.needsInput === true),
    duplicates: steps.filter((step) => step.status === 'duplicate'),
    blocked: steps.filter((step) => step.blockedCode !== undefined),
    successfulCount: steps.filter(
      (step) => step.status === 'ok' || step.status === 'confirm',
    ).length,
  }
}

function entryLabels(steps: AssistantToolStep[]): string {
  return steps
    .map((step) => {
      const effect = step.effect
      if (!effect) return step.label
      const kind = effect.kind ? `${KIND_SHORT[effect.kind] ?? '便签'}` : ''
      return effect.title ? `${kind}${quoted(effect.title)}` : step.label
    })
    .join('、')
}

/** 结果小结文案：全部来自真实执行记录 */
export function executionSummaryLines(summary: ExecutionSummary): string[] {
  const lines: string[] = []
  if (summary.created.length > 0) {
    lines.push(`新建 ${summary.created.length} 项：${entryLabels(summary.created)}`)
  }
  if (summary.updated.length > 0) {
    lines.push(`修改 ${summary.updated.length} 项：${entryLabels(summary.updated)}`)
  }
  if (summary.deleteRequests.length > 0) {
    lines.push(
      `等待确认删除 ${summary.deleteRequests.length} 项：${entryLabels(summary.deleteRequests)}`,
    )
  }
  if (summary.searches.length > 0) {
    lines.push(
      `搜索资料 ${summary.searches.length} 次：${summary.searches
        .map((step) => step.label)
        .join('、')}`,
    )
  }
  if (summary.reads.length > 0) {
    lines.push(`读取 ${summary.reads.length} 项：${entryLabels(summary.reads)}`)
  }
  if (summary.lists.length > 0) {
    lines.push(
      `查看清单 ${summary.lists.length} 次：${summary.lists
        .map((step) => step.label)
        .join('、')}`,
    )
  }
  if (summary.failed.length > 0) {
    lines.push(`失败 ${summary.failed.length} 项：${summary.failed.map((step) => step.label).join('、')}`)
  }
  if (summary.unknown.length > 0) {
    lines.push(
      `写入状态待核对 ${summary.unknown.length} 项：${summary.unknown
        .map((step) => step.label)
        .join('、')}（可能已生效，请先检查便签，不要直接重试）`,
    )
  }
  if (summary.needsInput.length > 0) {
    lines.push(
      `等待补充信息 ${summary.needsInput.length} 项：${summary.needsInput
        .map((step) => step.label)
        .join('、')}`,
    )
  }
  if (summary.duplicates.length > 0) {
    lines.push(`已跳过重复调用 ${summary.duplicates.length} 项（未重复写入）`)
  }
  if (summary.blocked.length > 0) {
    lines.push(`已拦截 ${summary.blocked.length} 项（权限、目标来源或目标歧义）`)
  }
  return lines
}

/**
 * 轮次上限提示：只陈述能确定的事实
 * - 已完成：来自真实执行记录；
 * - 未执行：本轮模型请求但被上限拦下的调用。
 */
export function buildRoundLimitNotice(
  steps: AssistantToolStep[],
  pending: AiToolCall[],
): string {
  const done = steps.filter(
    (step) => step.status === 'ok' || step.status === 'confirm',
  )
  const failed = steps.filter(
    (step) =>
      step.status === 'error' &&
      !step.needsInput &&
      step.failure?.requiresVerification !== true,
  )
  const unknown = steps.filter((step) => step.failure?.requiresVerification === true)
  const lines = [
    `已达到本次回答的工具调用上限（${MAX_TOOL_ROUNDS} 轮），以下为实际执行情况：`,
  ]
  if (done.length > 0) {
    const summary = executionSummaryLines(summarizeExecution(done))
    lines.push(`已完成 ${done.length} 项（${summary.join('；')}）`)
  } else {
    lines.push('已完成：无')
  }
  if (failed.length > 0) {
    lines.push(`失败 ${failed.length} 项：${failed.map((step) => step.label).join('、')}`)
  }
  if (unknown.length > 0) {
    lines.push(
      `写入状态待核对 ${unknown.length} 项：${unknown
        .map((step) => step.label)
        .join('、')}。可能已生效，请先检查便签，不要直接重试。`,
    )
  }
  if (pending.length > 0) {
    lines.push(
      `尚未执行的调用 ${pending.length} 项：${pending
        .map((call) => describeToolCall(call))
        .join('、')}。如需继续，请回复「继续」，我会接着处理剩余步骤。`,
    )
  } else {
    lines.push('尚未执行的调用：无（模型仍有后续步骤，但已达到上限）。')
  }
  return lines.join('\n')
}

/** 达到轮次上限/失败时追加到回答正文，保证用户能看到真实完成情况 */
export function appendNotice(content: string, notice: string): string {
  const base = content.trim()
  return base ? `${base}\n\n${notice}` : notice
}

export interface FinalPhaseInput {
  steps: AssistantToolStep[]
  needsInput: boolean
  limitReached: boolean
  stopped: boolean
  requestFailed: boolean
}

/**
 * 终态推导：宁可少报完成，也不把失败的步骤说成成功。
 * - 请求级错误：有成功步骤时 partial，否则 failed；
 * - 用户主动停止：partial（明确表示被中断）；
 * - 有信息缺口 → needs_input；
 * - 轮次上限 / 部分步骤失败 → partial；
 * - 其余 → done。
 */
export function deriveFinalPhase(input: FinalPhaseInput): AssistantPhase {
  const failed = input.steps.filter((step) => step.status === 'error').length
  const successful = input.steps.filter(
    (step) => step.status === 'ok' || step.status === 'confirm',
  ).length
  if (input.requestFailed) return successful > 0 ? 'partial' : 'failed'
  if (input.stopped) return 'partial'
  if (input.needsInput) return 'needs_input'
  if (input.limitReached) return 'partial'
  if (failed > 0) return successful > 0 ? 'partial' : 'failed'
  return 'done'
}

/** 首次带工具且无任何输出就报错时，才降级为普通对话（只重试一次） */
export function shouldDegradeTools(input: {
  toolsEnabled: boolean
  alreadyDegraded: boolean
  received: boolean
  code: string
}): boolean {
  return (
    input.toolsEnabled &&
    !input.alreadyDegraded &&
    !input.received &&
    TOOL_UNSUPPORTED_CODES.has(input.code)
  )
}

/** 降级时把工具说明替换为「只能回答、不能写数据」，避免模型继续声称能操作 */
export function degradeSystemContent(systemContent: string): string {
  return `${systemContent.replace(AGENT_TOOL_PROMPT, '').trim()}\n\n${NO_TOOL_PROMPT}`
}
