import type { AssistantPhase, AssistantToolStep, AssistantToolTask, ToolEffect } from './ai'
import type { AgentFailure } from '../services/agentFailure'

/**
 * Agent 执行历史：独立于聊天消息持久化，记录真实执行事实。
 * - 记录与步骤只来自工具真实返回，模型总结不参与成功判定；
 * - 历史记录不构成任何写入授权，也不能恢复删除 / 闹钟候选授权。
 */

export type AgentExecutionStatus =
  | 'success'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'execution_unknown'
  | 'needs_input'
  /** 运行中的瞬态状态：重启恢复时会被收敛为 interrupted / execution_unknown */
  | 'running'

export type AgentExecutionStepStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'skipped'
  | 'cancelled'
  | 'needs_input'
  | 'execution_unknown'

/** 工具真实影响的业务对象：只记录真实返回的 id / 标题 */
export interface AgentExecutionTargetReference {
  entryId: string
  kind: string
  title?: string
  effect: 'created' | 'updated' | 'deleted' | 'read'
}

export interface AgentExecutionStep {
  id: string
  executionId: string
  /** 真实执行顺序，从 0 开始 */
  ordinal: number
  toolCallId: string
  toolName: string
  /** 删除确认步骤关联的一次性提议 id：只用于与 ActionCard 精确对账 */
  proposalId?: string
  /** 用户可读标签：执行后优先使用工具返回的真实标题 */
  label: string
  status: AgentExecutionStepStatus
  startedAt?: number
  finishedAt?: number
  durationMs?: number
  effect?: ToolEffect
  failure?: AgentFailure
  targetReferences?: AgentExecutionTargetReference[]
  /** 脱敏后的输入摘要（不含完整正文 / 密钥 / 认证头） */
  safeInputSummary?: string
  /** 工具真实返回的脱敏摘要 */
  safeOutputSummary?: string
}

export interface AgentExecutionRecord {
  id: string

  conversationId: string
  messageId: string
  requestId: string

  title: string
  userInput: string

  status: AgentExecutionStatus
  phase: AssistantPhase

  startedAt: number
  finishedAt?: number
  durationMs?: number

  toolCount: number
  successCount: number
  failedCount: number
  skippedCount: number

  summary?: string
  /** 记录级失败：模型请求失败等不归属于单个工具步骤的失败 */
  failure?: AgentFailure
  errorMessage?: string

  createdAt: number
  updatedAt: number
}

export interface AgentExecutionQuery {
  keyword?: string
  statuses?: AgentExecutionStatus[]
  /** 起始时间（毫秒，含） */
  from?: number
  /** 结束时间（毫秒，含） */
  to?: number
  /** 1 开始 */
  page?: number
  pageSize?: number
  /** 只查询未完成记录（重启恢复用） */
  unfinishedOnly?: boolean
}

export interface AgentExecutionPage {
  items: AgentExecutionRecord[]
  total: number
  page: number
  pageSize: number
  hasMore: boolean
}

/** store → 历史记录的收尾输入：只携带真实执行事实 */
export interface ExecutionFinishInput {
  executionId: string
  status: AgentExecutionStatus
  phase: AssistantPhase
  finishedAt: number
  steps: AssistantToolStep[]
  /** 真实请求但未执行的调用（停止 / 轮次上限 / 重启），只计入 skippedCount */
  tasks?: AssistantToolTask[]
  summary?: string
  failure?: AgentFailure
  errorMessage?: string
}
