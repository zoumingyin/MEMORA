import type { AssistantToolStep } from '../types/ai'
import type { AgentToolName } from './agentToolArgs'
import type { WriteAttempt } from './agentToolExecutor'

/**
 * 失败重试账本（仅内存）：
 * - 记录上一轮真正进入执行器的写调用与真实结果；
 * - 同一用户操作重试时，如果已有创建/修改尝试，执行层禁止自动重复写；
 * - 只覆盖同一次失败后的 retry，新用户消息不会继承任何授权；
 * - 不做数据库迁移，不改变新增/普通修改的“直接执行”语义。
 */

export interface RetryWriteRecord extends WriteAttempt {
  status: string
  entryId?: string
  /** 统一失败分类：用于区分「明确失败」与「写入状态不确定」 */
  failureCategory?: string
}

export interface RetryLedger {
  requestId: string
  assistantMessageId: string
  userContent: string
  writes: RetryWriteRecord[]
  /** 有创建/修改尝试（成功、失败或结果不确定）时，重试禁止再次创建/修改 */
  blockedCreateUpdate: boolean
  createdAt: number
}

export function buildRetryLedger(input: {
  requestId: string
  assistantMessageId: string
  userContent: string
  steps: AssistantToolStep[]
  attempts: WriteAttempt[]
  now?: number
}): RetryLedger {
  const stepByCall = new Map(input.steps.map((step) => [step.callId, step]))
  const writes: RetryWriteRecord[] = input.attempts.map((attempt) => {
    const step = stepByCall.get(attempt.callId)
    return {
      ...attempt,
      status: step?.status ?? 'unknown',
      ...(step?.effect?.entryId ? { entryId: step.effect.entryId } : {}),
      ...(step?.failure?.category ? { failureCategory: step.failure.category } : {}),
    }
  })
  return {
    requestId: input.requestId,
    assistantMessageId: input.assistantMessageId,
    userContent: input.userContent,
    writes,
    blockedCreateUpdate: writes.some(
      (write) => write.tool === 'create_entry' || write.tool === 'update_entry',
    ),
    createdAt: input.now ?? Date.now(),
  }
}

/** 重试再次失败时保留上一轮的写记录与保护标记，避免第二次重试丢失保护 */
export function mergeRetryLedger(
  previous: RetryLedger | null,
  current: RetryLedger,
): RetryLedger {
  if (!previous) return current
  return {
    ...current,
    writes: [...previous.writes, ...current.writes],
    blockedCreateUpdate: previous.blockedCreateUpdate || current.blockedCreateUpdate,
  }
}

export function retryBlockedWriteTools(
  ledger: RetryLedger | null,
): ReadonlySet<AgentToolName> | undefined {
  if (!ledger?.blockedCreateUpdate) return undefined
  return new Set<AgentToolName>(['create_entry', 'update_entry'])
}

export function retryWriteSignatures(ledger: RetryLedger | null): string[] {
  if (!ledger) return []
  return ledger.writes
    .filter((write) => write.tool === 'create_entry' || write.tool === 'update_entry')
    .map((write) => write.signature)
}

/** 重试提示只陈述执行器实际记录的事实，不携带用户标题正文等数据 */
export function retrySystemNote(ledger: RetryLedger | null): string {
  if (!ledger) return ''
  const created = ledger.writes.filter(
    (write) => write.tool === 'create_entry' && write.status === 'ok',
  ).length
  const updated = ledger.writes.filter(
    (write) => write.tool === 'update_entry' && write.status === 'ok',
  ).length
  const deleteCards = ledger.writes.filter(
    (write) => write.tool === 'delete_entry' && write.status === 'confirm',
  ).length
  const attempted = ledger.writes.length
  const unknown = ledger.writes.filter(
    (write) =>
      write.failureCategory === 'execution_unknown' ||
      write.failureCategory === 'readback_failed',
  ).length
  if (attempted === 0) return ''
  return [
    '<retry_guard>',
    '这是对上一轮失败请求的重试。',
    `上一轮进入执行器的写入尝试 ${attempted} 项：新建成功 ${created} 项、修改成功 ${updated} 项、删除确认卡片 ${deleteCards} 项。`,
    unknown > 0
      ? `其中 ${unknown} 项写入状态无法确认，可能已经生效；必须先让用户核对便签真实内容，绝不能再执行相同写入。`
      : '',
    ledger.blockedCreateUpdate
      ? '执行层本轮禁止自动再次新建或修改，避免重复写入；请先如实说明上一轮可能已完成或结果不确定的内容，让用户确认当前状态后再发起新的操作。'
      : '本轮没有已执行的创建/修改，可以按正常规则继续；删除仍只生成确认卡片，不会自动执行。',
    '查询工具可以正常使用；不要把本次重试当成新的用户授权。',
    '</retry_guard>',
  ]
    .filter(Boolean)
    .join('\n')
}
