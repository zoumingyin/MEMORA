import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildExecutionOutcomeNotice,
  buildPlannedTasks,
  buildRoundLimitTasks,
  buildTaskChecklist,
  cancelUnfinishedTasks,
  countTaskStatuses,
  taskStatusFromOutcome,
} from '../src/services/agentProgress'
import type {
  AssistantMessage,
  AssistantToolStep,
  AssistantToolTask,
} from '../src/types/ai'
import { call } from './helpers'

function step(overrides: Partial<AssistantToolStep> = {}): AssistantToolStep {
  return {
    callId: 'call-1',
    tool: 'create_entry',
    label: '新建待办「A」',
    status: 'ok',
    message: '已创建',
    effect: { op: 'create', kind: 'todo', entryId: 'e1', title: 'A' },
    ...overrides,
  }
}

function task(overrides: Partial<AssistantToolTask> = {}): AssistantToolTask {
  return {
    callId: 'call-pending',
    tool: 'create_entry',
    label: '新建待办「B」',
    status: 'pending',
    ...overrides,
  }
}

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: '',
    createdAt: 0,
    status: 'done',
    ...overrides,
  }
}

describe('执行任务清单', () => {
  it('计划项与执行项分开：pending / running 不算完成', () => {
    const checklist = buildTaskChecklist(
      message({
        toolTasks: [
          task({ callId: 'a', status: 'pending' }),
          task({ callId: 'b', status: 'running', label: '新建待办「C」' }),
        ],
      }),
    )
    assert.deepEqual(
      checklist.map((item) => item.status),
      ['pending', 'running'],
    )
    assert.equal(checklist.every((item) => item.planned), true)
    assert.deepEqual(countTaskStatuses(checklist), {
      total: 2,
      success: 0,
      failed: 0,
      needsInput: 0,
      skipped: 0,
      cancelled: 0,
      running: 1,
      pending: 1,
      unknown: 0,
      interrupted: 0,
    })
  })

  it('执行项从真实 toolSteps 映射，未执行项不重复出现', () => {
    const checklist = buildTaskChecklist(
      message({
        toolSteps: [
          step({ callId: 'a', status: 'ok' }),
          step({ callId: 'b', status: 'error', message: '错误：标题为空' }),
          step({ callId: 'c', status: 'duplicate' }),
          step({
            callId: 'd',
            status: 'confirm',
            label: '请求删除「D」',
            effect: { op: 'delete', kind: 'note', entryId: 'e4', title: 'D' },
          }),
        ],
        toolTasks: [task({ callId: 'a' }), task({ callId: 'e' })],
      }),
    )
    assert.deepEqual(
      checklist.map((item) => [item.callId, item.status, item.planned]),
      [
        ['a', 'success', false],
        ['b', 'failed', false],
        ['c', 'skipped', false],
        ['d', 'needs_input', false],
        ['e', 'pending', true],
      ],
    )
    const counts = countTaskStatuses(checklist)
    assert.equal(counts.success, 1)
    assert.equal(counts.failed, 1)
    assert.equal(counts.needsInput, 1)
    assert.equal(counts.skipped, 1)
    assert.equal(counts.pending, 1)
  })

  it('真实结果状态映射：拦截、重复、取消与删除确认', () => {
    assert.equal(taskStatusFromOutcome({ status: 'error', blockedCode: 'target_untrusted' }), 'skipped')
    assert.equal(taskStatusFromOutcome({ status: 'error', needsInput: true }), 'needs_input')
    assert.equal(taskStatusFromOutcome({ status: 'duplicate' }), 'skipped')
    assert.equal(taskStatusFromOutcome({ status: 'cancelled' }), 'cancelled')
    assert.equal(taskStatusFromOutcome({ status: 'confirm' }), 'needs_input')
  })

  it('计划与轮次上限任务标记为待执行 / 已跳过', () => {
    const calls = [
      call('a', 'search_notes', { query: '周报' }),
      call('b', 'list_todos', {}),
    ]
    assert.deepEqual(
      buildPlannedTasks(calls).map((item) => item.status),
      ['pending', 'pending'],
    )
    assert.deepEqual(
      buildRoundLimitTasks(calls).map((item) => item.status),
      ['skipped', 'skipped'],
    )
    assert.equal(buildPlannedTasks(calls)[0].label, '搜索便签「周报」')
  })

  it('取消收尾：pending 取消，running 写入待核对，running 只读中断', () => {
    const tasks = [
      task({ callId: 'a', status: 'pending' }),
      task({ callId: 'b', status: 'running' }),
      task({ callId: 'c', status: 'skipped' }),
      task({ callId: 'd', status: 'cancelled' }),
      task({
        callId: 'e',
        status: 'running',
        tool: 'search_notes',
        label: '搜索「周报」',
      }),
    ]
    assert.deepEqual(
      cancelUnfinishedTasks(tasks)?.map((item) => item.status),
      [
        'cancelled',
        'execution_unknown',
        'skipped',
        'cancelled',
        'interrupted',
      ],
    )
  })
})

describe('执行结果摘要真实性', () => {
  it('全部成功且正常完成时不追加重复报告', () => {
    const steps = [step({ callId: 'a' })]
    assert.equal(
      buildExecutionOutcomeNotice({ steps, phase: 'done', stopped: false }),
      '',
    )
  })

  it('部分成功明确给出完成 / 失败 / 未执行数量与失败原因', () => {
    const steps = [
      step({ callId: 'a', label: '新建待办「A」' }),
      step({ callId: 'b', label: '新建待办「B」' }),
      step({
        callId: 'c',
        label: '新建待办「C」',
        status: 'error',
        message: '错误：标题不能为空',
      }),
    ]
    const notice = buildExecutionOutcomeNotice({ steps, phase: 'partial', stopped: false })
    assert.match(notice, /完成 2 项，失败 1 项/)
    assert.match(notice, /写入成功 2 项、写入失败 1 项/)
    assert.match(notice, /新建待办「C」/)
    assert.match(notice, /标题不能为空/)
    assert.doesNotMatch(notice, /全部成功/)
  })

  it('混合任务区分查询结果与写入结果', () => {
    const steps = [
      step({
        callId: 's',
        tool: 'search_notes',
        label: '搜索「周报」',
        message: '找到 1 条',
        effect: { op: 'search', count: 1 },
      }),
      step({ callId: 'w', label: '新建待办「周报」', effect: undefined }),
    ]
    const notice = buildExecutionOutcomeNotice({ steps, phase: 'partial', stopped: false })
    assert.match(notice, /查询成功 1 项/)
    assert.match(notice, /写入成功 1 项/)
  })

  it('删除确认只算等待确认，不算写入成功', () => {
    const steps = [
      step({
        callId: 'd',
        label: '请求删除「D」',
        status: 'confirm',
        message: '等待用户确认',
        effect: { op: 'delete', kind: 'note', entryId: 'e4', title: 'D' },
      }),
    ]
    const notice = buildExecutionOutcomeNotice({ steps, phase: 'needs_input', stopped: false })
    assert.match(notice, /完成 0 项/)
    assert.match(notice, /等待你补充或确认 1 项/)
    assert.match(notice, /写入成功 0 项/)
  })

  it('用户停止时区分已完成与未执行，并说明写入不回滚', () => {
    const steps = [step({ callId: 'a' })]
    const tasks = [
      task({ callId: 'b', status: 'cancelled' }),
      task({ callId: 'c', status: 'pending' }),
    ]
    const notice = buildExecutionOutcomeNotice({
      steps,
      tasks,
      phase: 'partial',
      stopped: true,
    })
    assert.match(notice, /已按你的要求停止：完成 1 项，未执行 2 项/)
    assert.match(notice, /不会回滚/)
    assert.match(notice, /已取消 1 项/)
  })

  it('全部失败不会伪造成功，也不写成部分完成', () => {
    const steps = [
      step({
        callId: 'a',
        status: 'error',
        message: '错误：模型返回的 id 不存在',
        effect: undefined,
      }),
    ]
    const notice = buildExecutionOutcomeNotice({ steps, phase: 'failed', stopped: false })
    assert.match(notice, /完成 0 项，失败 1 项/)
    assert.doesNotMatch(notice, /完成 1 项/)
  })
})
