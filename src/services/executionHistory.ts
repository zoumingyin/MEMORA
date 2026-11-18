import type {
  AssistantToolStep,
  AssistantToolTask,
  ToolEffect,
} from '../types/ai'
import type { AgentFailure } from './agentFailure'
import { failureCategoryLabel } from './agentFailure'
import type {
  AgentExecutionPage,
  AgentExecutionQuery,
  AgentExecutionRecord,
  AgentExecutionStatus,
  AgentExecutionStep,
  AgentExecutionStepStatus,
  AgentExecutionTargetReference,
} from '../types/executionHistory'

/**
 * 执行历史的纯逻辑：
 * - 状态只能由真实工具步骤与执行阶段推导，模型总结不参与成功判定；
 * - 未执行 / 跳过 / 取消的调用只能计入 skipped，不能算成功；
 * - 写入状态不确定时永远落到 execution_unknown，禁止通过历史记录自动重放。
 */

export const EXECUTION_STATUS_LABEL: Record<AgentExecutionStatus, string> = {
  success: '已完成',
  partial: '部分完成',
  failed: '执行失败',
  cancelled: '已停止',
  interrupted: '已中断',
  execution_unknown: '执行结果未知',
  needs_input: '等待用户补充',
  running: '执行中',
}

export const EXECUTION_STEP_STATUS_LABEL: Record<AgentExecutionStepStatus, string> = {
  pending: '待执行',
  running: '执行中',
  success: '已完成',
  failed: '已失败',
  skipped: '已跳过',
  cancelled: '已取消',
  needs_input: '等待补充',
  execution_unknown: '状态待核对',
}

const MAX_TITLE_CHARS = 40
const MAX_USER_INPUT_CHARS = 200
const MAX_OUTPUT_CHARS = 300
const MAX_SUMMARY_CHARS = 800

function clip(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}…`
}

/** 防御性脱敏：历史数据不保存密钥、认证头与完整提示词 */
export function redactSensitive(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-***')
    .replace(/(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
    .replace(/(authorization\s*[:=]\s*)([^\s,;]+)/gi, '$1***')
    .replace(/(api[-_]?key\s*["':=]?\s*)([^\s,;}"']+)/gi, '$1***')
    .replace(/(access[-_]?token\s*["':=]?\s*)([^\s,;}"']+)/gi, '$1***')
}

export function buildExecutionTitle(userInput: string): string {
  const firstLine = userInput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  return clip(redactSensitive(firstLine ?? 'AI 任务'), MAX_TITLE_CHARS) || 'AI 任务'
}

export function summarizeUserInput(userInput: string): string {
  return clip(redactSensitive(userInput), MAX_USER_INPUT_CHARS)
}

export function summarizeToolResult(text: string): string {
  return clip(redactSensitive(text), MAX_OUTPUT_CHARS)
}

/** 只读工具的步骤只记录结果数量，不落笔记正文 */
export function summarizeReadEffect(effect: ToolEffect | undefined): string {
  if (!effect) return '已完成读取'
  const count =
    effect.count ??
    effect.references?.length ??
    (effect.entryId ? 1 : 0)
  const op =
    effect.op === 'search' ? '检索' : effect.op === 'list' ? '列出' : '读取'
  return `${op} ${count} 条结果`
}

const CONTENT_FIELDS = new Set([
  'content',
  'append_content',
  'new_content',
  'body',
  'text',
  'note',
])

const COUNT_FIELDS = new Set(['items', 'tags', 'remove_tags', 'add_tags', 'alarms'])

/** 工具参数的安全摘要：正文只留字数，不保存完整笔记内容 */
export function summarizeToolArguments(toolName: string, rawArguments: string): string {
  let args: unknown
  try {
    args = JSON.parse(rawArguments)
  } catch {
    return redactSensitive(clip(rawArguments, 80)) || '（无法解析的参数）'
  }
  if (typeof args !== 'object' || args === null) {
    return redactSensitive(clip(String(args), 80))
  }
  const parts: string[] = []
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (value === null || value === undefined) continue
    if (CONTENT_FIELDS.has(key)) {
      if (typeof value === 'string') parts.push(`${key}=正文 ${value.length} 字`)
      continue
    }
    if (COUNT_FIELDS.has(key) && Array.isArray(value)) {
      parts.push(`${key}=${value.length} 项`)
      continue
    }
    if (typeof value === 'string') {
      parts.push(`${key}=${clip(redactSensitive(value), key === 'title' ? 40 : 60)}`)
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      parts.push(`${key}=${value}`)
    }
  }
  return parts.join(' · ') || `（${toolName} 无参数）`
}

/** 步骤状态映射：unknown / needs_input 优先于普通 success / error */
export function toHistoryStepStatus(
  step: AssistantToolStep,
): AgentExecutionStepStatus {
  if (step.failure?.requiresVerification === true) return 'execution_unknown'
  if (step.status === 'execution_unknown') return 'execution_unknown'
  if (step.needsInput === true) return 'needs_input'
  switch (step.status) {
    case 'ok':
      return 'success'
    case 'error':
      return 'failed'
    case 'duplicate':
      return 'skipped'
    case 'cancelled':
      return 'cancelled'
    case 'confirm':
      return 'needs_input'
    case 'interrupted':
      return 'cancelled'
  }
}

export function toOutcomeHistoryStepStatus(outcome: {
  status: AssistantToolStep['status']
  needsInput?: boolean
  failure?: AgentFailure
}): AgentExecutionStepStatus {
  return toHistoryStepStatus({
    callId: '',
    tool: '',
    label: '',
    message: '',
    ...outcome,
  })
}

export function isUnknownStep(step: AssistantToolStep): boolean {
  return (
    step.failure?.requiresVerification === true ||
    step.status === 'execution_unknown'
  )
}

interface StepTally {
  toolCount: number
  successCount: number
  failedCount: number
  skippedCount: number
}

/** 历史步骤统计：未执行调用只计入 skipped */
export function countHistorySteps(
  steps: Iterable<AgentExecutionStep>,
  unexecutedCount = 0,
): StepTally {
  let successCount = 0
  let failedCount = 0
  let skippedCount = unexecutedCount
  let toolCount = unexecutedCount
  for (const step of steps) {
    toolCount += 1
    if (step.status === 'success') successCount += 1
    else if (step.status === 'failed' || step.status === 'execution_unknown') {
      failedCount += 1
    } else skippedCount += 1
  }
  return { toolCount, successCount, failedCount, skippedCount }
}

/** 统计以真实调用为准：步骤 + 未执行调用，三类计数之和等于 toolCount */
export function countExecution(input: {
  steps: AssistantToolStep[]
  tasks?: AssistantToolTask[]
}): StepTally {
  const stepCallIds = new Set(input.steps.map((step) => step.callId))
  const unexecuted = (input.tasks ?? []).filter(
    (task) => !stepCallIds.has(task.callId),
  )
  let successCount = 0
  let failedCount = 0
  let skippedCount = unexecuted.length
  for (const step of input.steps) {
    const status = toHistoryStepStatus(step)
    if (status === 'success') successCount += 1
    else if (status === 'failed' || status === 'execution_unknown') failedCount += 1
    else skippedCount += 1
  }
  return {
    toolCount: input.steps.length + unexecuted.length,
    successCount,
    failedCount,
    skippedCount,
  }
}

export function deriveExecutionStatus(input: {
  steps: AssistantToolStep[]
  tasks?: AssistantToolTask[]
  stopped?: boolean
  restarted?: boolean
  requestFailed?: boolean
  needsInput?: boolean
  limitReached?: boolean
}): AgentExecutionStatus {
  const tally = countExecution(input)
  const unknown =
    input.steps.some(isUnknownStep) ||
    (input.tasks ?? []).some((task) => task.status === 'execution_unknown')
  if (unknown) return 'execution_unknown'
  if (input.restarted) return 'interrupted'
  if (input.stopped) return 'cancelled'
  const failed = input.steps.filter(
    (step) =>
      step.status === 'error' &&
      step.needsInput !== true &&
      step.failure?.requiresVerification !== true,
  ).length
  if (failed > 0) return tally.successCount > 0 ? 'partial' : 'failed'
  if (input.requestFailed) return tally.successCount > 0 ? 'partial' : 'failed'
  // 删除确认 / 闹钟选择等待用户操作：即使模型没有显式上报，也必须显示为待补充
  const awaitingUser =
    input.needsInput === true ||
    input.steps.some((step) => toHistoryStepStatus(step) === 'needs_input') ||
    (input.tasks ?? []).some((task) => task.status === 'needs_input')
  if (awaitingUser) return 'needs_input'
  if (input.limitReached) return tally.successCount > 0 ? 'partial' : 'failed'
  if (tally.skippedCount > 0) return tally.successCount > 0 ? 'partial' : 'failed'
  return 'success'
}

/**
 * 用户确认后回写历史时，从已落盘步骤重新推导记录状态。
 * 不能复用执行期推导：此时没有 store 的 stopped / needsInput 等瞬时上下文。
 */
export function deriveStatusFromHistorySteps(
  steps: AgentExecutionStep[],
): AgentExecutionStatus {
  const tally = countHistorySteps(steps)
  if (
    steps.some(
      (step) =>
        step.status === 'execution_unknown' ||
        step.failure?.requiresVerification === true,
    )
  ) {
    return 'execution_unknown'
  }
  if (
    steps.some(
      (step) =>
        step.status === 'needs_input' ||
        step.status === 'running' ||
        step.status === 'pending',
    )
  ) {
    return 'needs_input'
  }
  const failed = steps.filter((step) => step.status === 'failed').length
  if (failed > 0) return tally.successCount > 0 ? 'partial' : 'failed'
  const cancelled = steps.filter((step) => step.status === 'cancelled').length
  if (cancelled > 0) return tally.successCount > 0 ? 'partial' : 'cancelled'
  if (tally.skippedCount > 0) return tally.successCount > 0 ? 'partial' : 'failed'
  return 'success'
}

const REF_EFFECT: Record<string, AgentExecutionTargetReference['effect']> = {
  create: 'created',
  update: 'updated',
  delete: 'deleted',
  read: 'read',
}

/** 业务对象追溯：只使用工具真实返回的 effect / references */
export function toTargetReferences(
  effect: ToolEffect | undefined,
): AgentExecutionTargetReference[] {
  if (!effect) return []
  const refs: AgentExecutionTargetReference[] = []
  const seen = new Set<string>()
  const push = (ref: AgentExecutionTargetReference) => {
    const key = ref.entryId
    if (!ref.entryId || seen.has(key) || refs.length >= 8) return
    seen.add(key)
    refs.push(ref)
  }
  if (effect.entryId) {
    push({
      entryId: effect.entryId,
      kind: effect.kind ?? 'note',
      ...(effect.title ? { title: effect.title } : {}),
      effect: REF_EFFECT[effect.op] ?? 'read',
    })
  }
  for (const reference of effect.references ?? []) {
    push({
      entryId: reference.id,
      kind: reference.kind,
      ...(reference.title ? { title: reference.title } : {}),
      effect: 'read',
    })
  }
  return refs
}

function stepLabel(step: Pick<AgentExecutionStep, 'label' | 'toolName'>): string {
  return step.label || step.toolName
}

function failureLines(steps: AgentExecutionStep[]): string[] {
  const lines: string[] = []
  for (const step of steps) {
    if (step.status !== 'failed' && step.status !== 'execution_unknown') continue
    const category = step.failure
      ? failureCategoryLabel(step.failure.category)
      : '执行失败'
    lines.push(
      `${stepLabel(step)}：${category}${step.safeOutputSummary ? `（${clip(step.safeOutputSummary, 80)}）` : ''}`,
    )
  }
  return lines
}

/** 记录摘要：确定性事实，不复制模型自然语言总结 */
export function buildExecutionSummary(input: {
  status: AgentExecutionStatus
  steps: AgentExecutionStep[]
  tally: StepTally
  failure?: AgentFailure
  errorMessage?: string
  stopped?: boolean
}): string {
  const lines: string[] = []
  lines.push(
    `执行结果：${EXECUTION_STATUS_LABEL[input.status]}；工具 ${input.tally.toolCount} 项，完成 ${input.tally.successCount} 项，失败 ${input.tally.failedCount} 项，跳过 ${input.tally.skippedCount} 项。`,
  )
  if (input.status === 'execution_unknown') {
    lines.push('存在写入状态无法确认的步骤：请先在便签列表核对，不要直接重试。')
  }
  if (input.stopped) {
    lines.push('已按用户要求停止；停止前完成的写入不会回滚。')
  }
  if (input.failure) {
    lines.push(
      `记录级失败：${failureCategoryLabel(input.failure.category)}${input.errorMessage ? `（${redactSensitive(clip(input.errorMessage, 120))}）` : ''}`,
    )
  }
  const failures = failureLines(input.steps)
  if (failures.length > 0) {
    lines.push(`失败步骤：${failures.join('；')}`)
  }
  return clip(lines.join('\n'), MAX_SUMMARY_CHARS)
}

/** 失败诊断：把固定分类翻译成可执行的下一步建议 */
export function failureGuidance(
  failure: AgentFailure | undefined,
  status?: AgentExecutionStatus,
): string {
  if (failure) {
    switch (failure.category) {
      case 'execution_unknown':
      case 'readback_failed':
        return '先在便签列表中核对这一步是否已经生效；不要直接重试相同写入。'
      case 'invalid_tool_arguments':
        return '补充必要字段（如标题、目标或时间）后重新发起。'
      case 'permission_denied':
        return '需要明确指定操作目标：先选中便签或完整说出标题，再重新发起。'
      case 'target_not_found':
        return '目标可能已被删除或改动；刷新列表后重新选择目标。'
      case 'target_ambiguous':
        return '存在多个同名目标，请明确指定唯一目标后重新发起。'
      case 'dependency_failed':
        return '上一步写入结果尚未确认，先核对便签内容再继续。'
      case 'execution_cancelled':
        return '该任务已停止；如需继续，请重新发起新的任务。'
      case 'business_execution_failed':
        return '检查目标便签的当前状态后，重新发起操作。'
      case 'model_request_failed':
      case 'model_timeout':
        return '检查模型配置与网络后重试；已成功的工具步骤不会回滚。'
    }
  }
  switch (status) {
    case 'execution_unknown':
      return '先在便签列表中核对真实结果；不要直接重试相同写入，确认后再决定是否重新发起。'
    case 'interrupted':
      return '应用重启导致执行中断；未完成的步骤不会自动重放，可重新发起。'
    case 'cancelled':
      return '任务已停止；如需继续，请重新发起并明确目标。'
    case 'needs_input':
      return '补充缺失的目标或参数后，再发起新的任务。'
    case 'partial':
      return '失败或未完成的步骤需要单独核对，确认后用新的指令重新发起。'
    case 'failed':
      return '查看失败步骤的原因，修正条件后重新发起。'
    case 'success':
      return '本次执行未发现需要处理的问题。'
    case 'running':
      return '任务仍在执行中。'
  }
  return ''
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}分${seconds}秒`
}

export function matchesExecutionQuery(
  record: AgentExecutionRecord,
  query: AgentExecutionQuery,
): boolean {
  if (query.unfinishedOnly === true && record.finishedAt !== undefined) return false
  if (query.statuses && query.statuses.length > 0 && !query.statuses.includes(record.status)) {
    return false
  }
  if (query.from !== undefined && record.startedAt < query.from) return false
  if (query.to !== undefined && record.startedAt > query.to) return false
  const keyword = query.keyword?.trim().toLowerCase()
  if (keyword) {
    const haystack = `${record.title}\n${record.userInput}\n${record.summary ?? ''}`.toLowerCase()
    if (!haystack.includes(keyword)) return false
  }
  return true
}

export function normalizeExecutionQuery(
  query: AgentExecutionQuery,
): Required<Pick<AgentExecutionQuery, 'page' | 'pageSize'>> {
  const page = Number.isFinite(query.page) ? Math.max(1, Math.floor(query.page as number)) : 1
  const pageSize = Number.isFinite(query.pageSize)
    ? Math.min(100, Math.max(1, Math.floor(query.pageSize as number)))
    : 10
  return { page, pageSize }
}

export function emptyExecutionPage(
  query: AgentExecutionQuery,
): AgentExecutionPage {
  const { page, pageSize } = normalizeExecutionQuery(query)
  return { items: [], total: 0, page, pageSize, hasMore: false }
}
