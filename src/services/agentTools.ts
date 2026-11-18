import { useEntryStore } from '../store/useEntryStore'
import type { AiToolCall } from '../types/ai'
import {
  createAgentToolScope,
  executeToolWithEnv,
  type AgentToolEnvironment,
  type AgentToolScope,
  type ToolOutcome,
} from './agentToolExecutor'

export type { ToolOutcome } from './agentToolExecutor'
export type { AgentToolScope } from './agentToolExecutor'
export { createAgentToolScope } from './agentToolExecutor'

/**
 * Agent 工具集（function calling）执行策略：
 * - 查询类（search_notes / list_todos / list_reminders / get_note）：直接执行；
 * - 新增 / 修改（create_entry / update_entry）：校验后直接执行，结果以仓储回读为准；
 * - 删除（delete_entry）：只生成删除提议与确认卡片，用户点击确认后才移入废纸篓。
 * 模型参数统一由 agentToolArgs 校验，执行逻辑在 agentToolExecutor 中，便于单独测试。
 */

export { AGENT_TOOLS, AGENT_TOOL_PROMPT, NO_TOOL_PROMPT } from './agentToolSchema'

/** 绑定应用真实 store 的执行环境（测试可传自己的 env） */
export function createAgentToolEnv(): AgentToolEnvironment {
  return {
    now: () => Date.now(),
    listEntries: () => useEntryStore.getState().entries,
    addEntry: (input, kind) => useEntryStore.getState().addEntry(input, kind),
    updateEntry: (id, patch) => useEntryStore.getState().updateEntry(id, patch),
  }
}

/** 执行模型发起的工具调用：绑定真实 store 与仓储，参数校验、回读校验在执行器内完成 */
export async function executeAgentTool(
  call: AiToolCall,
  scope: AgentToolScope = createAgentToolScope('direct'),
): Promise<ToolOutcome> {
  return executeToolWithEnv(call, createAgentToolEnv(), scope)
}
