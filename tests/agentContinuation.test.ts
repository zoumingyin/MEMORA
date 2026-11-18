import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildContinuationContext,
  hadExplicitCancellation,
  isCancellationMessage,
  isContinuationRequest,
} from '../src/services/agentContinuation'
import type {
  AssistantMessage,
  AssistantToolStep,
  AssistantToolTask,
} from '../src/types/ai'

function user(content: string, id = `u-${content.length}-${content}`): AssistantMessage {
  return { id, role: 'user', content, createdAt: 0, status: 'done' }
}

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: 'a1',
    role: 'assistant',
    content: '已处理',
    createdAt: 0,
    status: 'done',
    ...overrides,
  }
}

function step(overrides: Partial<AssistantToolStep> = {}): AssistantToolStep {
  return {
    callId: 'call-1',
    tool: 'create_entry',
    label: '新建待办「周报」',
    status: 'ok',
    message: '已创建',
    effect: { op: 'create', kind: 'todo', entryId: 'e1', title: '周报' },
    ...overrides,
  }
}

function task(overrides: Partial<AssistantToolTask> = {}): AssistantToolTask {
  return {
    callId: 'call-limit',
    tool: 'create_entry',
    label: '新建待办「复盘」',
    status: 'skipped',
    ...overrides,
  }
}

describe('续办识别', () => {
  it('识别明确的续办表达，不把普通“继续”当成续办', () => {
    assert.equal(isContinuationRequest('继续刚才没完成的任务'), true)
    assert.equal(isContinuationRequest('把剩下的做完'), true)
    assert.equal(isContinuationRequest('继续执行失败的那一步'), true)
    assert.equal(isContinuationRequest('继续'), false)
    assert.equal(isContinuationRequest('继续讲讲这个方案'), false)
  })

  it('从真实执行记录区分已完成、失败、未执行与等待补充', () => {
    const context = buildContinuationContext([
      user('帮我建三个任务'),
      assistant({
        toolSteps: [
          step({ callId: 'a', status: 'ok' }),
          step({
            callId: 'b',
            status: 'error',
            label: '新建待办「B」',
            message: '错误：参数不合法',
          }),
          step({
            callId: 'c',
            status: 'confirm',
            label: '请求删除「C」',
            message: '等待用户确认',
            effect: { op: 'delete', kind: 'note', entryId: 'e3', title: 'C' },
          }),
        ],
        toolTasks: [
          task({ callId: 'd', status: 'skipped' }),
          task({ callId: 'e', status: 'cancelled' }),
        ],
        writeAttempts: [
          { callId: 'a', tool: 'create_entry', signature: 'sig-a' },
          { callId: 'b', tool: 'create_entry', signature: 'sig-b' },
        ],
      }),
    ])
    assert.equal(context.hasActionableWork, true)
    assert.equal(context.question, null)
    assert.deepEqual(
      context.completed.map((item) => item.label),
      ['新建待办「周报」'],
    )
    assert.deepEqual(
      context.failed.map((item) => item.label),
      ['新建待办「B」'],
    )
    assert.deepEqual(
      context.waiting.map((item) => item.label),
      ['请求删除「C」'],
    )
    assert.deepEqual(
      context.notExecuted.map((item) => item.label),
      ['新建待办「复盘」'],
    )
    assert.deepEqual(
      context.cancelled.map((item) => item.label),
      ['新建待办「复盘」'],
    )
    assert.deepEqual(context.writeSignatures, ['sig-a', 'sig-b'])
  })

  it('全部成功时没有可续办项，只询问不授权写入', () => {
    const context = buildContinuationContext([
      user('建一个任务'),
      assistant({ toolSteps: [step()] }),
    ])
    assert.equal(context.hasActionableWork, false)
    assert.match(context.question ?? '', /没有找到可安全继续的未完成步骤/)
    assert.match(context.guard, /历史 id 不是授权/)
    assert.match(context.guard, /无法确定剩余任务时询问用户/)
  })

  it('只有等待补充时先问补充，不自动恢复历史目标', () => {
    const context = buildContinuationContext([
      user('改提醒'),
      assistant({
        toolSteps: [
          step({
            callId: 'a',
            status: 'error',
            needsInput: true,
            label: '修改提醒「喝水」',
            message: '有多个闹钟，请选择',
          }),
        ],
      }),
    ])
    assert.equal(context.hasActionableWork, false)
    assert.match(context.question ?? '', /仍在等待你补充信息/)
    assert.match(context.guard, /多闹钟选择授权不能从历史恢复/)
  })

  it('用户已取消的任务不能自动恢复', () => {
    const messages = [
      user('取消刚才那些操作'),
      assistant({
        toolSteps: [
          step({ callId: 'a' }),
          step({
            callId: 'b',
            status: 'error',
            label: '新建待办「B」',
            message: '错误：参数不合法',
          }),
        ],
        writeAttempts: [{ callId: 'a', tool: 'create_entry', signature: 'sig-a' }],
      }),
    ]
    assert.equal(hadExplicitCancellation(messages, 'a1'), true)
    const context = buildContinuationContext(messages)
    assert.equal(context.hasActionableWork, false)
    assert.match(context.question ?? '', /已被你取消，不会自动恢复/)
    assert.match(context.guard, /不要自动续办/)
  })

  it('写入状态不确定时只要求核对，不允许自动重放', () => {
    const context = buildContinuationContext([
      user('改一下标题'),
      assistant({
        toolSteps: [
          step({
            callId: 'a',
            status: 'error',
            label: '修改「周报」',
            message: '错误：修改未能确认',
            failure: {
              category: 'readback_failed',
              writeState: 'unknown',
              autoRetryAllowed: false,
              requiresVerification: true,
            },
          }),
        ],
        toolTasks: [
          task({
            callId: 'b',
            status: 'execution_unknown',
            label: '修改「复盘」',
          }),
        ],
        writeAttempts: [
          { callId: 'a', tool: 'update_entry', signature: 'sig-a' },
        ],
      }),
    ])
    assert.equal(context.hasActionableWork, false)
    assert.deepEqual(
      context.unknown.map((item) => item.label),
      ['修改「周报」', '修改「复盘」'],
    )
    assert.match(context.question ?? '', /状态无法确认/)
    assert.match(context.guard, /状态待核对/)
    assert.match(context.guard, /不要重放相同创建/)
    assert.deepEqual(context.writeSignatures, ['sig-a'])
  })

  it('条件句里的停止重试不算取消任务', () => {
    assert.equal(
      isCancellationMessage('如果某个待办创建失败，请停止重试并如实告诉我失败项。'),
      false,
    )
    assert.equal(isCancellationMessage('如果失败就停止重试'), false)
    assert.equal(isCancellationMessage('失败后不要继续重试'), false)
    assert.equal(isCancellationMessage('停止当前任务'), true)
    assert.equal(isCancellationMessage('取消刚才那些操作'), true)
    assert.equal(isCancellationMessage('不用了，谢谢'), true)
  })

  it('重启留下的 pending / running 任务按取消处理，不直接续办', () => {
    const context = buildContinuationContext([
      user('建三个任务'),
      assistant({
        toolSteps: [step({ callId: 'a' })],
        toolTasks: [
          task({ callId: 'b', status: 'pending' }),
          task({ callId: 'c', status: 'running' }),
        ],
      }),
    ])
    assert.deepEqual(
      context.cancelled.map((item) => item.label),
      ['新建待办「复盘」', '新建待办「复盘」'],
    )
    assert.equal(context.hasActionableWork, false)
  })

  it('没有历史执行记录时生成询问，不伪造剩余任务', () => {
    const context = buildContinuationContext([user('继续刚才没完成的任务')])
    assert.equal(context.sourceMessageId, null)
    assert.equal(context.hasActionableWork, false)
    assert.match(context.question ?? '', /没有找到可安全继续的未完成步骤/)
    assert.match(context.guard, /上一轮没有可用的执行记录/)
  })
})
