import type { AgentExecutionRepository } from '../repository/agentExecutionRepository'
import { getAgentExecutionRepository } from '../repository/executionRepository'
import { isReadOnlyTool } from './agentExecution'
import {
  buildExecutionSummary,
  countHistorySteps,
} from './executionHistory'
import type {
  AgentExecutionRecord,
  AgentExecutionStatus,
  AgentExecutionStep,
} from '../types/executionHistory'
import type { AgentFailure } from './agentFailure'

/**
 * 应用重启恢复：
 * - 只处理本次启动之前创建、且没有 finishedAt 的记录；
 * - 未完成的写入 → execution_unknown，禁止自动重试；
 * - 未完成的只读步骤 → cancelled，可重新发起；
 * - 未开始的步骤不会被标记为成功。
 */

const BOOT_AT = Date.now()

const UNKNOWN_WRITE_FAILURE: AgentFailure = {
  category: 'execution_unknown',
  writeState: 'unknown',
  autoRetryAllowed: false,
  requiresVerification: true,
}

const CANCELLED_FAILURE: AgentFailure = {
  category: 'execution_cancelled',
  writeState: 'none',
  autoRetryAllowed: false,
  requiresVerification: false,
}

let recovery: Promise<void> | null = null

async function recover(
  repo: AgentExecutionRepository,
  now = Date.now(),
): Promise<void> {
  const unfinished = await repo.listUnfinished()
  for (const record of unfinished) {
    // 本进程启动后新建的活跃任务不能被重启恢复误伤
    if (record.startedAt >= BOOT_AT) continue
    await recoverRecord(repo, record, now)
  }
}

async function recoverRecord(
  repo: AgentExecutionRepository,
  record: AgentExecutionRecord,
  now: number,
): Promise<void> {
  const steps = await repo.getSteps(record.id)
  const recoveredSteps: AgentExecutionStep[] = []
  let unknown = false

  for (const step of steps) {
    if (step.status === 'execution_unknown') {
      unknown = true
      recoveredSteps.push(step)
      continue
    }
    if (step.status !== 'running' && step.status !== 'pending') {
      if (step.failure?.requiresVerification === true) unknown = true
      recoveredSteps.push(step)
      continue
    }
    const write = !isReadOnlyTool(step.toolName)
    const startedAt = step.startedAt ?? record.startedAt
    const finishedAt = Math.max(now, startedAt)
    const next: AgentExecutionStep = write
      ? {
          ...step,
          status: 'execution_unknown',
          finishedAt,
          durationMs: finishedAt - startedAt,
          failure: UNKNOWN_WRITE_FAILURE,
          safeOutputSummary:
            '应用退出时该写入仍在执行，无法确认是否生效。请先在便签列表核对，不要直接重试。',
        }
      : {
          ...step,
          status: 'cancelled',
          finishedAt,
          durationMs: finishedAt - startedAt,
          failure: CANCELLED_FAILURE,
          safeOutputSummary: '应用退出时该只读步骤尚未完成，未产生任何写入。',
        }
    if (write) unknown = true
    recoveredSteps.push(next)
    await repo.upsertStep(next)
  }

  const tally = countHistorySteps(recoveredSteps)
  const status: AgentExecutionStatus = unknown ? 'execution_unknown' : 'interrupted'
  const summary = [
    buildExecutionSummary({ status, steps: recoveredSteps, tally }),
    '应用重启：上次执行已中断，未完成的步骤不会自动重放。',
  ].join('\n')
  await repo.update(record.id, {
    status,
    finishedAt: now,
    durationMs: Math.max(0, now - record.startedAt),
    toolCount: tally.toolCount,
    successCount: tally.successCount,
    failedCount: tally.failedCount,
    skippedCount: tally.skippedCount,
    summary,
    ...(unknown ? { failure: UNKNOWN_WRITE_FAILURE } : {}),
    updatedAt: now,
  })
}

/** 每个进程只执行一次；重复调用复用同一 Promise */
export function recoverInterruptedExecutions(
  repo: AgentExecutionRepository = getAgentExecutionRepository(),
): Promise<void> {
  if (!recovery) {
    recovery = recover(repo).catch((error: unknown) => {
      // 恢复失败不能阻塞应用启动或历史查询
      console.error('[AI] 执行历史重启恢复失败', error)
    })
  }
  return recovery
}

export function resetHistoryRecoveryForTests(): void {
  recovery = null
}
