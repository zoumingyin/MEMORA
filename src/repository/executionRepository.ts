import type { AgentExecutionRepository } from './agentExecutionRepository'
import { LocalAgentExecutionRepository } from './localExecutionRepository'
import { SqliteAgentExecutionRepository } from './sqliteExecutionRepository'
import { isTauriRuntime } from './index'

let repository: AgentExecutionRepository | null = null

/**
 * 执行历史仓储单例：Tauri 使用独立 SQLite 表；浏览器预览使用 localStorage。
 * 历史仓储与业务条目仓储完全分离，删除历史不会影响便签 / 待办 / 提醒。
 */
export function getAgentExecutionRepository(): AgentExecutionRepository {
  if (!repository) {
    repository = isTauriRuntime()
      ? new SqliteAgentExecutionRepository()
      : new LocalAgentExecutionRepository()
  }
  return repository
}

/** 测试 / 隔离验收使用：替换当前仓储实例（不会触碰用户真实数据） */
export function setAgentExecutionRepositoryForTests(
  next: AgentExecutionRepository | null,
): void {
  repository = next
}
