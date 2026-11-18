import type { AiToolCall, AssistantPhase, AssistantToolStep } from '../types/ai'
import type { AgentFailure } from './agentFailure'
import type { ToolOutcome } from './agentToolExecutor'
import { describeToolCall, isReadOnlyTool } from './agentExecution'
import {
  buildExecutionSummary,
  deriveExecutionStatus,
  summarizeReadEffect,
  summarizeToolArguments,
  summarizeToolResult,
  toHistoryStepStatus,
  toOutcomeHistoryStepStatus,
  toTargetReferences,
  countHistorySteps,
} from './executionHistory'
import type {
  AgentExecutionRecord,
  AgentExecutionStatus,
  AgentExecutionStep,
  ExecutionFinishInput,
} from '../types/executionHistory'
import type { AgentExecutionRepository } from '../repository/agentExecutionRepository'
import { getAgentExecutionRepository } from '../repository/executionRepository'

/**
 * 执行历史记录器：
 * - 只记录真实进入执行链路的工具（start / finish 事件）；
 * - 所有写入串行排队，create 永远先于步骤与收尾更新；
 * - 历史写入失败只记录诊断日志，绝不改变 Agent 执行结果、权限守卫或幂等保护；
 * - 同一 requestId 只产生一条记录，重复 create 被仓储忽略。
 */

export interface ExecutionStartInput {
  id: string
  conversationId: string
  messageId: string
  requestId: string
  title: string
  userInput: string
  startedAt: number
}

export interface StepStartedInput {
  call: AiToolCall
  startedAt: number
}

export interface StepFinishedInput {
  call: AiToolCall
  outcome: ToolOutcome
  finishedAt: number
}

interface ExecutionSession {
  startedAt: number
  phase: AssistantPhase
  status: AgentExecutionStatus
  summary?: string
  failure?: AgentFailure
  errorMessage?: string
  finished: boolean
  steps: Map<string, AgentExecutionStep>
  nextOrdinal: number
}

function historyStepFromAssistantStep(
  executionId: string,
  step: AssistantToolStep,
  ordinal: number,
): AgentExecutionStep {
  return {
    id: `${executionId}:${step.callId}`,
    executionId,
    ordinal,
    toolCallId: step.callId,
    toolName: step.tool,
    ...(step.proposalId ? { proposalId: step.proposalId } : {}),
    label: step.label,
    status: toHistoryStepStatus(step),
    ...(step.effect ? { effect: step.effect } : {}),
    ...(step.failure ? { failure: step.failure as AgentFailure } : {}),
    ...(step.effect
      ? { targetReferences: toTargetReferences(step.effect) }
      : {}),
    safeOutputSummary: isReadOnlyTool(step.tool)
      ? summarizeReadEffect(step.effect)
      : summarizeToolResult(step.message),
  }
}

function sortedSteps(session: ExecutionSession): AgentExecutionStep[] {
  return Array.from(session.steps.values()).sort((a, b) => a.ordinal - b.ordinal)
}

const UNKNOWN_FAILURE: AgentFailure = {
  category: 'execution_unknown',
  writeState: 'unknown',
  autoRetryAllowed: false,
  requiresVerification: true,
}

export class ExecutionRecorder {
  private readonly sessions = new Map<string, ExecutionSession>()
  private chain: Promise<void> = Promise.resolve()

  private readonly repoProvider: () => AgentExecutionRepository

  constructor(repoProvider: () => AgentExecutionRepository = getAgentExecutionRepository) {
    this.repoProvider = repoProvider
  }

  private enqueue(task: () => Promise<void>): void {
    this.chain = this.chain.then(task).catch((error: unknown) => {
      // 历史写入失败不能影响主流程：只保留可诊断日志
      console.error('[AI] 执行历史写入失败', error)
    })
  }

  /** 测试 / 收尾：等待所有排队写入落盘 */
  async flush(): Promise<void> {
    await this.chain
  }

  start(input: ExecutionStartInput): void {
    if (this.sessions.has(input.id)) return
    const record: AgentExecutionRecord = {
      id: input.id,
      conversationId: input.conversationId,
      messageId: input.messageId,
      requestId: input.requestId,
      title: input.title,
      userInput: input.userInput,
      status: 'running',
      phase: 'understanding',
      startedAt: input.startedAt,
      toolCount: 0,
      successCount: 0,
      failedCount: 0,
      skippedCount: 0,
      createdAt: input.startedAt,
      updatedAt: input.startedAt,
    }
    this.sessions.set(input.id, {
      startedAt: input.startedAt,
      phase: 'understanding',
      status: 'running',
      finished: false,
      steps: new Map(),
      nextOrdinal: 0,
    })
    this.enqueue(async () => {
      await this.repoProvider().create(record)
    })
  }

  stepStarted(executionId: string, input: StepStartedInput): void {
    const session = this.sessions.get(executionId)
    if (!session || session.steps.has(input.call.id)) return
    const step: AgentExecutionStep = {
      id: `${executionId}:${input.call.id}`,
      executionId,
      ordinal: session.nextOrdinal,
      toolCallId: input.call.id,
      toolName: input.call.function.name,
      label: describeToolCall(input.call),
      status: 'running',
      startedAt: input.startedAt,
      safeInputSummary: summarizeToolArguments(
        input.call.function.name,
        input.call.function.arguments,
      ),
    }
    session.nextOrdinal += 1
    session.steps.set(input.call.id, step)
    this.enqueue(async () => {
      const repo = this.repoProvider()
      await repo.upsertStep(step)
      await repo.update(executionId, {
        toolCount: session.steps.size,
        updatedAt: input.startedAt,
      })
    })
  }

  stepFinished(executionId: string, input: StepFinishedInput): void {
    const session = this.sessions.get(executionId)
    if (!session) return
    const previous = session.steps.get(input.call.id)
    const startedAt = previous?.startedAt ?? input.finishedAt
    const step: AgentExecutionStep = {
      id: `${executionId}:${input.call.id}`,
      executionId,
      ordinal: previous?.ordinal ?? session.nextOrdinal,
      toolCallId: input.call.id,
      toolName: input.call.function.name,
      ...(input.outcome.confirmAction
        ? { proposalId: input.outcome.confirmAction.proposalId }
        : {}),
      label: describeToolCall(input.call, input.outcome),
      status: toOutcomeHistoryStepStatus(input.outcome),
      startedAt,
      finishedAt: input.finishedAt,
      durationMs: Math.max(0, input.finishedAt - startedAt),
      ...(input.outcome.effect ? { effect: input.outcome.effect } : {}),
      ...(input.outcome.failure ? { failure: input.outcome.failure } : {}),
      ...(input.outcome.effect
        ? { targetReferences: toTargetReferences(input.outcome.effect) }
        : {}),
      ...(previous?.safeInputSummary
        ? { safeInputSummary: previous.safeInputSummary }
        : {}),
      safeOutputSummary: isReadOnlyTool(input.call.function.name)
        ? summarizeReadEffect(input.outcome.effect)
        : summarizeToolResult(input.outcome.result),
    }
    if (!previous) session.nextOrdinal += 1
    session.steps.set(input.call.id, step)

    const counts = countHistorySteps(session.steps.values(), 0)
    const upgradeUnknown =
      input.outcome.failure?.requiresVerification === true ||
      step.status === 'execution_unknown'
    if (upgradeUnknown) session.status = 'execution_unknown'

    this.enqueue(async () => {
      const repo = this.repoProvider()
      await repo.upsertStep(step)
      await repo.update(executionId, {
        ...counts,
        ...(session.finished && upgradeUnknown
          ? {
              status: 'execution_unknown',
              failure: UNKNOWN_FAILURE,
              summary: buildExecutionSummary({
                status: 'execution_unknown',
                steps: sortedSteps(session),
                tally: counts,
              }),
            }
          : {}),
        updatedAt: input.finishedAt,
      })
    })
  }

  finish(input: ExecutionFinishInput): void {
    const session = this.sessions.get(input.executionId)
    if (!session) return
    if (session.finished) return

    // 事件缺失时用 store 的真实步骤补齐；已有步骤保留事件采集的耗时
    const addedSteps: AgentExecutionStep[] = []
    for (const step of input.steps) {
      if (session.steps.has(step.callId)) continue
      const historyStep = historyStepFromAssistantStep(
        input.executionId,
        step,
        session.nextOrdinal,
      )
      session.steps.set(step.callId, historyStep)
      addedSteps.push(historyStep)
      session.nextOrdinal += 1
    }

    const stepCallIds = new Set(session.steps.keys())
    const unexecuted = (input.tasks ?? []).filter(
      (task) => !stepCallIds.has(task.callId),
    ).length
    const historySteps = sortedSteps(session)
    const counts = countHistorySteps(historySteps, unexecuted)
    const derived = deriveExecutionStatus({
      steps: input.steps,
      tasks: input.tasks,
    })
    // store 明确给出 unknown / 中断时以更保守者为准
    let status = input.status
    if (
      session.status === 'execution_unknown' ||
      derived === 'execution_unknown'
    ) {
      status = 'execution_unknown'
    }
    const errorMessage = input.errorMessage
      ? summarizeToolResult(input.errorMessage)
      : undefined
    // 记录级失败：store 明确给出的失败优先；未知结果即使来自步骤也必须落到记录
    const failure =
      input.failure ?? (status === 'execution_unknown' ? UNKNOWN_FAILURE : undefined)
    const summary =
      input.summary ??
      buildExecutionSummary({
        status,
        steps: historySteps,
        tally: counts,
        ...(failure ? { failure } : {}),
        ...(errorMessage ? { errorMessage } : {}),
        ...(input.status === 'cancelled' ? { stopped: true } : {}),
      })

    session.finished = true
    session.status = status
    session.phase = input.phase
    session.summary = summary
    if (failure) session.failure = failure
    if (errorMessage) session.errorMessage = errorMessage

    this.enqueue(async () => {
      const repo = this.repoProvider()
      for (const step of addedSteps) await repo.upsertStep(step)
      await repo.update(input.executionId, {
        status,
        phase: input.phase,
        finishedAt: input.finishedAt,
        durationMs: Math.max(0, input.finishedAt - session.startedAt),
        toolCount: counts.toolCount,
        successCount: counts.successCount,
        failedCount: counts.failedCount,
        skippedCount: counts.skippedCount,
        summary,
        ...(failure ? { failure } : {}),
        ...(errorMessage ? { errorMessage } : {}),
        updatedAt: input.finishedAt,
      })
    })
  }

  /** 测试使用：丢弃内存会话，不影响已落盘记录 */
  resetSessions(): void {
    this.sessions.clear()
  }
}

let recorder: ExecutionRecorder | null = null

/** 全局记录器：仓储延迟解析，测试可以替换仓储实例实现隔离 */
export function getExecutionRecorder(): ExecutionRecorder {
  if (!recorder) recorder = new ExecutionRecorder()
  return recorder
}

export function resetExecutionRecorderForTests(): void {
  recorder?.resetSessions()
  recorder = null
}
