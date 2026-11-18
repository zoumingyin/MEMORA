import type { AssistantMessage } from '../types/ai'

/**
 * 旧删除确认卡片失效：删除提议只保存在内存中，应用重启后无法再 claim。
 * 尚未执行 / 取消的卡片必须标记为失效，避免界面继续显示「待确认」。
 */
export function invalidatePendingToolActions(
  messages: AssistantMessage[],
): AssistantMessage[] {
  let changed = false
  const next = messages.map((message) => {
    if (message.role !== 'assistant') return message
    const actions = message.toolActions ?? []
    if (actions.length === 0) return message
    const done = new Set(message.toolActionsDone ?? [])
    const cancelled = new Set(message.toolActionsCancelled ?? [])
    const invalidated = new Set(message.toolActionsInvalidated ?? [])
    const pending = actions
      .map((_, index) => index)
      .filter(
        (index) => !done.has(index) && !cancelled.has(index) && !invalidated.has(index),
      )
    if (pending.length === 0) return message
    changed = true
    return {
      ...message,
      toolActionsInvalidated: [
        ...(message.toolActionsInvalidated ?? []),
        ...pending,
      ],
    }
  })
  return changed ? next : messages
}

/**
 * 旧候选卡片失效：内存授权不随消息持久化，重启、新任务或停止后必须把
 * 尚未完成的 proposalId 标成无效，避免界面继续显示「等待选择」。
 */
export function invalidatePendingSelections(
  messages: AssistantMessage[],
): AssistantMessage[] {
  let changed = false
  const next = messages.map((message) => {
    if (message.role !== 'assistant') return message
    const done = new Set(message.toolSelectionsDone ?? [])
    const cancelled = new Set(message.toolSelectionsCancelled ?? [])
    const invalidated = new Set(message.toolSelectionsInvalidated ?? [])
    const pending = (message.toolSelections ?? [])
      .map((selection) => selection.proposalId)
      .filter(
        (id) => !done.has(id) && !cancelled.has(id) && !invalidated.has(id),
      )
    if (pending.length === 0) return message
    changed = true
    return {
      ...message,
      toolSelectionsInvalidated: [
        ...(message.toolSelectionsInvalidated ?? []),
        ...pending,
      ],
    }
  })
  return changed ? next : messages
}
