import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  invalidatePendingSelections,
  invalidatePendingToolActions,
} from '../src/utils/assistantSelectionLifecycle'
import type { AssistantAlarmSelection, AssistantMessage } from '../src/types/ai'

function card(proposalId: string): AssistantAlarmSelection {
  return {
    proposalId,
    entryId: 'r1',
    title: '喝水提醒',
    remindAt: Date.now() + 3600_000,
    candidates: [
      { alarmId: 'a1', mode: 'daily', remindAt: Date.now() + 3600_000, method: 'dialog' },
      { alarmId: 'a2', mode: 'weekly', remindAt: Date.now() + 7200_000, method: 'dialog' },
    ],
    expiresAt: Date.now() + 600_000,
  }
}

function message(overrides: Partial<AssistantMessage>): AssistantMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: '',
    createdAt: 0,
    status: 'done',
    ...overrides,
  }
}

describe('候选选择失效标记', () => {
  it('重启/新任务时把未完成的卡片标记为失效', () => {
    const input = [
      message({ id: 'm1', toolSelections: [card('p1'), card('p2')] }),
      message({ role: 'user', content: '改时间', id: 'm2' }),
    ]
    const next = invalidatePendingSelections(input) as AssistantMessage[]
    assert.deepEqual(next[0].toolSelectionsInvalidated, ['p1', 'p2'])
    assert.equal(next[1], input[1], '非 assistant 消息保持原样')
  })

  it('已完成或已取消的卡片不会被重复标记', () => {
    const next = invalidatePendingSelections([
      message({
        toolSelections: [card('p1'), card('p2'), card('p3')],
        toolSelectionsDone: ['p1'],
        toolSelectionsCancelled: ['p2'],
        toolSelectionsInvalidated: ['p3'],
      }),
    ]) as AssistantMessage[]
    assert.equal(next[0].toolSelectionsInvalidated?.length, 1)
  })

  it('没有待处理卡片时返回原数组，避免无意义重渲染', () => {
    const input = [
      message({ toolSelections: [card('p1')], toolSelectionsDone: ['p1'] }),
      message({ id: 'm2', role: 'user', content: 'hi' }),
    ]
    assert.equal(invalidatePendingSelections(input), input)
  })

  it('重复调用不会产生重复的失效 ID', () => {
    const once = invalidatePendingSelections([
      message({ toolSelections: [card('p1')] }),
    ])
    const twice = invalidatePendingSelections(once)
    assert.equal(twice, once)
    assert.deepEqual((twice[0] as AssistantMessage).toolSelectionsInvalidated, ['p1'])
  })
})

describe('删除确认卡片失效标记', () => {
  const action = {
    op: 'delete' as const,
    kind: 'note' as const,
    title: '周报',
    content: '',
    targetId: 'e1',
    proposalId: 'p1',
    expiresAt: Date.now() + 600_000,
  }

  it('应用重启后未执行 / 未取消的删除卡片标记为失效', () => {
    const input = [
      message({ toolActions: [action, { ...action, targetId: 'e2' }] }),
      message({ id: 'm2', role: 'user', content: '删除' }),
    ]
    const next = invalidatePendingToolActions(input) as AssistantMessage[]
    assert.deepEqual(next[0].toolActionsInvalidated, [0, 1])
    assert.equal(next[1], input[1], '非 assistant 消息保持原样')
  })

  it('已执行、已取消或已失效的卡片不会被重复标记', () => {
    const input = [
      message({
        toolActions: [action, action, action],
        toolActionsDone: [0],
        toolActionsCancelled: [1],
        toolActionsInvalidated: [2],
      }),
    ]
    assert.equal(invalidatePendingToolActions(input), input)
  })

  it('没有待确认卡片时返回原数组', () => {
    const input = [message({ id: 'm2', role: 'user', content: '你好' })]
    assert.equal(invalidatePendingToolActions(input), input)
  })
})
