import type { AgentFailure } from './agentFailure'
import { failureFor } from './agentFailure'
import {
  buildExecutionSummary,
  countHistorySteps,
  deriveStatusFromHistorySteps,
} from './executionHistory'
import type { DeleteConfirmationResult, DeleteFailureReason } from './deleteExecution'
import { deleteFailureMessage } from './deleteExecution'
import { getExecutionRecorder } from './executionRecorder'
import type { AgentExecutionStep } from '../types/executionHistory'
import { getAgentExecutionRepository } from '../repository/executionRepository'

/**
 * Loop 外删除确认的历史回写：
 * - 只根据 executionId + stepId + proposalId + targetId 精确匹配一条真实步骤；
 * - 只更新历史表，不调用 moveToTrash，不读取 / 恢复任何授权；
 * - 记录不存在、关联不完整或历史已被删除时安静跳过，绝不影响业务删除流程。
 */

export interface DeleteHistoryLink {
  executionId?: string
  stepId?: string
  proposalId?: string
  targetId?: string
}

type DeleteStepOutcome =
  | { kind: 'cancelled' }
  | { kind: 'confirmed'; result: DeleteConfirmationResult }

const DELETE_FAILURE_CATEGORY: Partial<
  Record<DeleteFailureReason, AgentFailure['category']>
> = {
  missing: 'target_not_found',
  kind_changed: 'business_execution_failed',
  target_mismatch: 'business_execution_failed',
  invalid: 'business_execution_failed',
  not_found: 'business_execution_failed',
  expired: 'business_execution_failed',
  failed: 'business_execution_failed',
  cancelled: 'execution_cancelled',
}

function failureForDeleteReason(
  reason: DeleteFailureReason,
): AgentFailure | undefined {
  const category = DELETE_FAILURE_CATEGORY[reason]
  if (!category) return undefined
  return failureFor(
    category,
    reason === 'failed' ? 'failed' : 'none',
  )
}

function outcomeText(
  outcome: DeleteStepOutcome,
): { status: AgentExecutionStep['status']; failure?: AgentFailure; text: string } {
  if (outcome.kind === 'cancelled') {
    return {
      status: 'cancelled',
      failure: failureFor('execution_cancelled'),
      text: '用户取消删除，未移入废纸篓，便签没有变化。',
    }
  }
  if (outcome.result.ok) {
    return {
      status: 'success',
      text: '用户已在界面确认删除，便签已移入废纸篓（可恢复）。',
    }
  }
  if (outcome.result.reason === 'cancelled') {
    return {
      status: 'cancelled',
      failure: failureFor('execution_cancelled'),
      text: '删除提议已取消，用户确认未执行任何删除。',
    }
  }
  return {
    status: 'failed',
    failure: failureForDeleteReason(outcome.result.reason),
    text: `用户确认删除失败：${deleteFailureMessage(outcome.result.reason)}；未确认删除生效。`,
  }
}

function stepMatches(
  step: AgentExecutionStep,
  stepId: string,
  targetId: string,
  proposalId: string,
): boolean {
  if (step.id !== stepId) return false
  if (step.toolName !== 'delete_entry') return false
  // 旧步骤没有 proposalId 时不能回写：缺少关联字段就无法证明它属于这张卡片
  if (step.proposalId !== proposalId) return false
  const targets = step.targetReferences ?? []
  return targets.some((reference) => reference.entryId === targetId)
}

async function writeDeleteHistory(
  link: DeleteHistoryLink,
  outcome: DeleteStepOutcome,
): Promise<boolean> {
  const { executionId, stepId, proposalId, targetId } = link
  if (!executionId || !stepId || !proposalId || !targetId) return false

  const nextOutcome = outcomeText(outcome)
  // busy / done 表示业务层没有产生新的结果：重复点击不能制造第二条历史事实
  if (
    outcome.kind === 'confirmed' &&
    !outcome.result.ok &&
    (outcome.result.reason === 'busy' || outcome.result.reason === 'done')
  ) {
    return false
  }

  try {
    // 卡片可点击时 Agent Loop 已收尾；先落盘排队中的记录，避免竞态覆盖
    await getExecutionRecorder().flush()
    const repo = getAgentExecutionRepository()
    const record = await repo.getById(executionId)
    if (!record) return false
    const steps = await repo.getSteps(executionId)
    const step = steps.find((item) =>
      stepMatches(item, stepId, targetId, proposalId),
    )
    if (!step) return false
    // 已成功的删除不能被后来的取消 / 失败覆盖
    if (step.status === 'success' && nextOutcome.status !== 'success') {
      return false
    }

    const now = Date.now()
    const updated: AgentExecutionStep = {
      ...step,
      status: nextOutcome.status,
      failure: nextOutcome.failure,
      safeOutputSummary: nextOutcome.text,
      finishedAt: now,
      durationMs: Math.max(0, now - (step.startedAt ?? now)),
    }
    await repo.upsertStep(updated)

    const nextSteps = steps.map((item) => (item.id === updated.id ? updated : item))
    const tally = countHistorySteps(nextSteps)
    const status = deriveStatusFromHistorySteps(nextSteps)
    await repo.update(executionId, {
      status,
      finishedAt: now,
      durationMs: Math.max(0, now - record.startedAt),
      toolCount: tally.toolCount,
      successCount: tally.successCount,
      failedCount: tally.failedCount,
      skippedCount: tally.skippedCount,
      summary: buildExecutionSummary({ status, steps: nextSteps, tally }),
      updatedAt: now,
    })
    return true
  } catch (error) {
    // 历史回写失败不能影响用户已经完成的业务操作
    console.error('[AI] 删除确认历史回写失败', error)
    return false
  }
}

/** 用户取消删除：历史步骤改为 cancelled，业务数据不变 */
export function recordDeleteCancelled(link: DeleteHistoryLink): Promise<boolean> {
  return writeDeleteHistory(link, { kind: 'cancelled' })
}

/** 用户点击确认：根据真实执行结果回写成功 / 失败，不采信模型文字 */
export function recordDeleteConfirmed(
  link: DeleteHistoryLink,
  result: DeleteConfirmationResult,
): Promise<boolean> {
  return writeDeleteHistory(link, { kind: 'confirmed', result })
}
