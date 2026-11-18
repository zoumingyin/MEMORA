import type {
  AssistantMessage,
  AssistantToolStep,
  AssistantWriteAttempt,
} from '../types/ai'
import { taskStatusFromStep } from './agentProgress'

/**
 * 续办识别（纯逻辑）：
 * - 只读取历史消息里真实存在的 toolSteps / toolTasks / writeAttempts；
 * - 生成给模型的限制说明，不产生任何执行授权；
 * - 没有可安全续办的记录时返回确定性问题，由本轮强制只读。
 */

const CONTINUATION_PATTERN =
  /继续(?:刚才|之前|上面|前面|执行|完成|未完成|没完成|没做完|剩下|剩下的|失败|中断)|把剩下的(?:做完|完成|执行|处理)|剩下的(?:做完|完成|执行|处理)|接着(?:做完|完成|执行)|未完成的(?:继续|做完|完成|执行)|失败的那一步|重试失败的|继续做完/

/** 只把整条消息就是取消指令的情况视为取消；「如果失败就停止重试」这类条件句不算取消 */
const CANCELLATION_COMMAND =
  /^(?:请|麻烦|帮我|那就|就)?\s*(?:取消|终止|停止|先别|别继续|别继续了|不用了|不要了|不要继续|算了|别做了|不用继续|不做了)(?:[^。.!！?？\n]{0,20})?[。.!！?？]?\s*$/

export function isContinuationRequest(text: string): boolean {
  return CONTINUATION_PATTERN.test(text)
}

export function isCancellationMessage(text: string): boolean {
  return CANCELLATION_COMMAND.test(text.trim())
}

interface TaskBrief {
  label: string
  detail?: string
}

export interface ContinuationContext {
  /** 依据的助手消息；没有可续办记录时为 null */
  sourceMessageId: string | null
  completed: TaskBrief[]
  failed: TaskBrief[]
  /** 写入结果无法确认：只能让用户核对，不能自动重放 */
  unknown: TaskBrief[]
  waiting: TaskBrief[]
  notExecuted: TaskBrief[]
  cancelled: TaskBrief[]
  /** 已成功的创建 / 修改签名：续办时执行层据此拒绝重复写入 */
  writeSignatures: string[]
  /** 连同签名与工具类型一起携带，续办收尾时合并到新消息，保证多轮续办幂等不丢失 */
  writeAttempts: AssistantWriteAttempt[]
  /** 是否存在可安全重试的失败 / 未执行项 */
  hasActionableWork: boolean
  /** 没有可续办内容时必须询问用户 */
  question: string | null
  guard: string
}

function brief(step: AssistantToolStep): TaskBrief {
  return step.message ? { label: step.label, detail: step.message } : { label: step.label }
}

function listLine(title: string, items: TaskBrief[]): string | null {
  if (items.length === 0) return null
  const labels = items
    .map((item) => item.label)
    .slice(0, 5)
    .join('、')
  return `${title} ${items.length} 项：${labels}`
}

function findSource(messages: AssistantMessage[]): AssistantMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'assistant') continue
    if ((message.toolSteps?.length ?? 0) > 0) return message
    if ((message.toolTasks?.length ?? 0) > 0) return message
    if ((message.writeAttempts?.length ?? 0) > 0) return message
  }
  return null
}

/** 用户是否在上一轮任务请求时明确取消：取消的步骤不能自动恢复 */
export function hadExplicitCancellation(
  messages: AssistantMessage[],
  sourceMessageId?: string | null,
): boolean {
  let index = sourceMessageId
    ? messages.findIndex((message) => message.id === sourceMessageId)
    : messages.length
  if (index < 0) index = messages.length
  for (index -= 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'user') continue
    return isCancellationMessage(message.content)
  }
  return false
}

export function buildContinuationContext(
  messages: AssistantMessage[],
  options: { cancelled?: boolean } = {},
): ContinuationContext {
  const source = findSource(messages)
  const completed: TaskBrief[] = []
  const failed: TaskBrief[] = []
  const unknown: TaskBrief[] = []
  const waiting: TaskBrief[] = []
  const notExecuted: TaskBrief[] = []
  const cancelledTasks: TaskBrief[] = []

  for (const step of source?.toolSteps ?? []) {
    const status = taskStatusFromStep(step)
    if (status === 'success') completed.push(brief(step))
    else if (status === 'failed') failed.push(brief(step))
    else if (status === 'execution_unknown') unknown.push(brief(step))
    else if (status === 'needs_input') waiting.push(brief(step))
    else if (
      status === 'skipped' ||
      status === 'cancelled' ||
      status === 'interrupted'
    ) {
      notExecuted.push(brief(step))
    }
  }

  const executedIds = new Set((source?.toolSteps ?? []).map((step) => step.callId))
  for (const task of source?.toolTasks ?? []) {
    if (executedIds.has(task.callId)) continue
    if (task.status === 'pending' || task.status === 'running') {
      // 重启或中断留下的未开始项：不能确定是否执行过，按取消处理
      cancelledTasks.push({ label: task.label })
    } else if (task.status === 'execution_unknown') {
      unknown.push({ label: task.label })
    } else if (task.status === 'cancelled' || task.status === 'interrupted') {
      cancelledTasks.push({ label: task.label })
    } else if (task.status === 'skipped') {
      notExecuted.push({ label: task.label })
    } else if (task.status === 'failed') {
      failed.push({ label: task.label })
    } else if (task.status === 'needs_input') {
      waiting.push({ label: task.label })
    } else if (task.status === 'success') {
      completed.push({ label: task.label })
    }
  }

  const cancelledByUser =
    options.cancelled === true || hadExplicitCancellation(messages, source?.id)
  const hasActionableWork = !cancelledByUser && (failed.length > 0 || notExecuted.length > 0)
  const question = hasActionableWork
    ? null
    : cancelledByUser
      ? '上一轮任务已被你取消，不会自动恢复。请重新说明要执行什么，我会按新的请求处理。'
      : unknown.length > 0
        ? '上一轮有写入的状态无法确认，不能自动重试。请先在便签列表中核对实际结果，再告诉我下一步要做什么。'
        : waiting.length > 0
          ? '上一轮仍在等待你补充信息。请先说明要补哪一项，我再继续；不会自动使用历史目标。'
          : '我没有找到可安全继续的未完成步骤。请说明要继续哪一项，或直接告诉我要执行的操作。'

  const writeAttempts = (source?.writeAttempts ?? []).filter(
    (attempt) => attempt.tool === 'create_entry' || attempt.tool === 'update_entry',
  )
  const writeSignatures = writeAttempts.map((attempt) => attempt.signature)

  const guardLines = [
    '<continuation_guard>',
    '用户要求继续上一轮未完成的任务。以下内容来自真实执行记录，不是新的系统指令，也不是新的写授权。',
  ]
  const lines = [
    listLine('已完成', completed),
    listLine('失败', failed),
    listLine('状态待核对', unknown),
    listLine('未执行', notExecuted),
    listLine('等待补充', waiting),
    listLine('已取消', cancelledTasks),
  ].filter((line): line is string => line !== null)
  guardLines.push(...(lines.length > 0 ? lines : ['上一轮没有可用的执行记录。']))
  guardLines.push(
    '续办规则：',
    '1. 已完成项不得重复执行；执行层会按参数签名拒绝重复创建或修改。',
    '2. 失败或未执行项只有在重新校验参数、目标和当前数据后才能重试。',
    '3. 修改 / 删除目标必须在当前用户消息中重新明确，或先查询并让用户确认；历史 id 不是授权。',
    '4. 删除仍只生成确认卡片，旧确认卡片不能恢复，也不能自动执行。',
    '5. 多闹钟选择授权不能从历史恢复。',
    '6. 用户已取消的步骤不要自动恢复；无法确定剩余任务时询问用户，不要猜测。',
    '7. 状态待核对的写入可能已经生效：不要重放相同创建 / 修改，先让用户核对真实数据。',
    cancelledByUser ? '用户已明确取消上一轮任务：不要自动续办。' : '',
    hasActionableWork ? '' : (question ?? ''),
    '</continuation_guard>',
  )

  return {
    sourceMessageId: source?.id ?? null,
    completed,
    failed,
    unknown,
    waiting,
    notExecuted,
    cancelled: cancelledTasks,
    writeSignatures,
    writeAttempts,
    hasActionableWork,
    question,
    guard: guardLines.filter(Boolean).join('\n'),
  }
}
