import { describeToolCall, isReadOnlyTool } from './agentExecution'
import type {
  AiToolCall,
  AssistantMessage,
  AssistantPhase,
  AssistantTaskStatus,
  AssistantToolStep,
  AssistantToolTask,
} from '../types/ai'

/**
 * 执行进度与任务清单（纯逻辑）：
 * - 已执行项只从 toolSteps 推导，未执行项只从 toolTasks 推导，二者不重复保存；
 * - 清单状态只来自真实工具结果，pending / running 永远不算完成；
 * - 结果小结是执行记录的确定性投影，模型回答不能改变它。
 */

export interface ExecutionTaskItem {
  callId: string
  label: string
  status: AssistantTaskStatus
  /** 真实工具返回摘要；尚未执行的计划项没有 */
  detail?: string
  /** true 表示模型已请求但尚无真实执行结果 */
  planned: boolean
}

export interface ExecutionTaskCounts {
  total: number
  success: number
  failed: number
  needsInput: number
  skipped: number
  cancelled: number
  running: number
  pending: number
  /** 重启时仍在执行、结果无法确认 */
  unknown: number
  /** 中断时未完成的只读步骤 */
  interrupted: number
}

export const TASK_STATUS_LABEL: Record<AssistantTaskStatus, string> = {
  pending: '待执行',
  running: '执行中',
  success: '已完成',
  failed: '失败',
  skipped: '已跳过',
  cancelled: '已取消',
  needs_input: '等待补充',
  execution_unknown: '状态待核对',
  interrupted: '已中断',
}

export function taskStatusFromOutcome(outcome: {
  status: AssistantToolStep['status']
  needsInput?: boolean
  blockedCode?: string
  failure?: { requiresVerification?: boolean }
}): AssistantTaskStatus {
  if (outcome.failure?.requiresVerification) return 'execution_unknown'
  if (outcome.blockedCode) return 'skipped'
  if (outcome.needsInput) return 'needs_input'
  switch (outcome.status) {
    case 'ok':
      return 'success'
    case 'error':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    case 'duplicate':
      return 'skipped'
    case 'confirm':
      return 'needs_input'
    case 'execution_unknown':
      return 'execution_unknown'
    case 'interrupted':
      return 'interrupted'
  }
}

export function taskStatusFromStep(step: AssistantToolStep): AssistantTaskStatus {
  return taskStatusFromOutcome(step)
}

/** 模型本轮真实请求的工具调用：计划项，执行前只能是 pending */
export function buildPlannedTasks(calls: AiToolCall[]): AssistantToolTask[] {
  return calls.map((call) => ({
    callId: call.id,
    tool: call.function.name,
    label: describeToolCall(call),
    status: 'pending',
  }))
}

/** 达到轮次上限时未执行的调用：明确标记为 skipped，不能显示为完成 */
export function buildRoundLimitTasks(calls: AiToolCall[]): AssistantToolTask[] {
  return buildPlannedTasks(calls).map((task) => ({ ...task, status: 'skipped' }))
}

/**
 * 应用重启 / 中断收尾：未产生结果的 pending / running 不能再显示为执行中。
 * - pending 明确未开始 → cancelled；
 * - running 的只读步骤 → interrupted，可由用户重新发起；
 * - running 的写入步骤可能已生效 → execution_unknown，必须核对真实数据。
 */
export function cancelUnfinishedTasks(
  tasks: AssistantToolTask[] | undefined,
): AssistantToolTask[] | undefined {
  if (!tasks || tasks.length === 0) return tasks
  return tasks.map((task) => {
    if (task.status === 'pending') return { ...task, status: 'cancelled' }
    if (task.status === 'running') {
      return {
        ...task,
        status: isReadOnlyTool(task.tool) ? 'interrupted' : 'execution_unknown',
      }
    }
    return task
  })
}

export function buildTaskChecklist(message: AssistantMessage): ExecutionTaskItem[] {
  const steps = message.toolSteps ?? []
  const executedIds = new Set(steps.map((step) => step.callId))
  const executed: ExecutionTaskItem[] = steps.map((step) => ({
    callId: step.callId,
    label: step.label,
    status: taskStatusFromStep(step),
    detail: step.message,
    planned: false,
  }))
  const unexecuted: ExecutionTaskItem[] = (message.toolTasks ?? [])
    .filter((task) => !executedIds.has(task.callId))
    .map((task) => ({
      callId: task.callId,
      label: task.label,
      status: task.status,
      planned: true,
    }))
  return [...executed, ...unexecuted]
}

export function countTaskStatuses(tasks: ExecutionTaskItem[]): ExecutionTaskCounts {
  const counts: ExecutionTaskCounts = {
    total: tasks.length,
    success: 0,
    failed: 0,
    needsInput: 0,
    skipped: 0,
    cancelled: 0,
    running: 0,
    pending: 0,
    unknown: 0,
    interrupted: 0,
  }
  for (const task of tasks) {
    switch (task.status) {
      case 'success':
        counts.success += 1
        break
      case 'failed':
        counts.failed += 1
        break
      case 'needs_input':
        counts.needsInput += 1
        break
      case 'skipped':
        counts.skipped += 1
        break
      case 'cancelled':
        counts.cancelled += 1
        break
      case 'running':
        counts.running += 1
        break
      case 'pending':
        counts.pending += 1
        break
      case 'execution_unknown':
        counts.unknown += 1
        break
      case 'interrupted':
        counts.interrupted += 1
        break
    }
  }
  return counts
}

function clip(text: string, limit = 80): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}…`
}

function taskLabels(tasks: ExecutionTaskItem[]): string {
  return tasks
    .map((task) => task.label)
    .slice(0, 4)
    .join('、')
}

/**
 * 终态结果补充：只陈述 toolSteps / toolTasks 中的真实事实。
 * 全部成功且未被中断时返回空串，避免与模型的正常总结重复。
 */
export function buildExecutionOutcomeNotice(input: {
  steps: AssistantToolStep[]
  tasks?: AssistantToolTask[]
  phase: AssistantPhase
  stopped: boolean
  limitReached?: boolean
}): string {
  if (input.limitReached) return ''
  if (input.phase === 'done' && !input.stopped) return ''

  const checklist = buildTaskChecklist({
    id: '',
    role: 'assistant',
    content: '',
    createdAt: 0,
    status: 'done',
    toolSteps: input.steps,
    toolTasks: input.tasks,
  })
  if (checklist.length === 0) return ''
  const counts = countTaskStatuses(checklist)
  const failed = checklist.filter((task) => task.status === 'failed')
  const waiting = checklist.filter((task) => task.status === 'needs_input')
  const unknownWrites = checklist.filter(
    (task) => task.status === 'execution_unknown',
  )
  const notExecuted = checklist.filter(
    (task) =>
      task.status === 'skipped' ||
      task.status === 'cancelled' ||
      task.status === 'pending' ||
      task.status === 'running' ||
      task.status === 'interrupted',
  )
  // 以工具名识别写入尝试：失败的写入没有 effect，但仍必须计入「写入失败」
  const writes = input.steps.filter(
    (step) =>
      step.tool === 'create_entry' ||
      step.tool === 'update_entry' ||
      step.tool === 'delete_entry',
  )
  const readSuccess = input.steps.filter(
    (step) =>
      (step.tool === 'search_notes' ||
        step.tool === 'list_todos' ||
        step.tool === 'list_reminders' ||
        step.tool === 'get_note') &&
      step.status === 'ok',
  ).length
  const writeSuccess = writes.filter((step) => step.status === 'ok').length
  const writeUnknown = writes.filter(
    (step) => step.failure?.requiresVerification === true,
  ).length
  const writeFailed = writes.filter(
    (step) =>
      step.status === 'error' &&
      !step.needsInput &&
      step.failure?.requiresVerification !== true,
  ).length

  const lines: string[] = []
  if (input.stopped) {
    lines.push(
      `已按你的要求停止：完成 ${counts.success} 项，未执行 ${notExecuted.length} 项。已完成的写入不会回滚，请检查便签列表。`,
    )
  } else {
    lines.push(
      `执行结果：完成 ${counts.success} 项，失败 ${counts.failed} 项，未执行 ${notExecuted.length} 项。`,
    )
  }
  if (writes.length > 0 || readSuccess > 0) {
    const parts: string[] = []
    if (readSuccess > 0) parts.push(`查询成功 ${readSuccess} 项`)
    if (writes.length > 0) {
      parts.push(`写入成功 ${writeSuccess} 项`, `写入失败 ${writeFailed} 项`)
      if (writeUnknown > 0) parts.push(`写入状态待核对 ${writeUnknown} 项`)
    }
    lines.push(`其中${parts.join('、')}。`)
  }
  if (failed.length > 0) {
    const reasons = failed
      .map((task) => (task.detail ? `${task.label}（${clip(task.detail)}）` : task.label))
      .join('；')
    lines.push(`失败项：${reasons}。`)
  }
  if (unknownWrites.length > 0) {
    lines.push(
      `写入状态待核对 ${unknownWrites.length} 项：${taskLabels(unknownWrites)}。` +
        '这些写入可能已经生效，请不要直接重试；请先在便签列表中核对实际结果，再决定是否继续。',
    )
  }
  if (waiting.length > 0) {
    lines.push(`等待你补充或确认 ${waiting.length} 项：${taskLabels(waiting)}。`)
  }
  if (counts.skipped > 0) {
    lines.push(`已跳过 ${counts.skipped} 项（重复调用或被安全规则拦截，未产生新的写入）。`)
  }
  if (counts.cancelled > 0) {
    lines.push(`已取消 ${counts.cancelled} 项，不会自动恢复。`)
  }
  if (counts.interrupted > 0) {
    lines.push(`已中断 ${counts.interrupted} 项，未确认执行；如需继续，请重新发起。`)
  }
  return lines.join('\n')
}
