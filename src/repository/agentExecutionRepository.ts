import type {
  AgentExecutionPage,
  AgentExecutionQuery,
  AgentExecutionRecord,
  AgentExecutionStep,
} from '../types/executionHistory'

/**
 * 执行历史仓储：记录与步骤分开存储，步骤按真实执行顺序读取。
 * 所有写操作都只影响历史表本身，不接触业务条目。
 */
export interface AgentExecutionRepository {
  create(record: AgentExecutionRecord): Promise<void>
  update(
    id: string,
    patch: Partial<AgentExecutionRecord>,
  ): Promise<void>
  getById(id: string): Promise<AgentExecutionRecord | null>
  list(query: AgentExecutionQuery): Promise<AgentExecutionPage>
  /** 未完成记录：应用重启后恢复中断状态 */
  listUnfinished(): Promise<AgentExecutionRecord[]>
  getSteps(executionId: string): Promise<AgentExecutionStep[]>
  /** 写入 / 更新单个步骤（同一 callId 幂等） */
  upsertStep(step: AgentExecutionStep): Promise<void>
  deleteById(id: string): Promise<void>
  clear(): Promise<void>
}
