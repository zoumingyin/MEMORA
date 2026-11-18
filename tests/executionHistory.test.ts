import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { LocalAgentExecutionRepository } from '../src/repository/localExecutionRepository'
import { setAgentExecutionRepositoryForTests } from '../src/repository/executionRepository'
import { ExecutionRecorder, resetExecutionRecorderForTests } from '../src/services/executionRecorder'
import {
  buildExecutionTitle,
  deriveExecutionStatus,
  failureGuidance,
  summarizeToolArguments,
  summarizeUserInput,
  toTargetReferences,
  buildExecutionSummary,
} from '../src/services/executionHistory'
import {
  recoverInterruptedExecutions,
  resetHistoryRecoveryForTests,
} from '../src/services/executionHistoryRecovery'
import type { AgentExecutionRecord, AgentExecutionStep } from '../src/types/executionHistory'
import type { AssistantToolStep, AssistantToolTask } from '../src/types/ai'
import { FakeStorage, call } from './helpers'

const BASE = new Date(2026, 10, 13, 9, 0, 0).getTime()

function makeRepo(): LocalAgentExecutionRepository {
  return new LocalAgentExecutionRepository(new FakeStorage())
}

function record(overrides: Partial<AgentExecutionRecord> = {}): AgentExecutionRecord {
  return {
    id: 'exec-1',
    conversationId: 'conv-1',
    messageId: 'msg-1',
    requestId: 'req-1',
    title: '整理最近笔记',
    userInput: '整理最近笔记',
    status: 'running',
    phase: 'executing',
    startedAt: BASE,
    toolCount: 0,
    successCount: 0,
    failedCount: 0,
    skippedCount: 0,
    createdAt: BASE,
    updatedAt: BASE,
    ...overrides,
  }
}

function step(overrides: Partial<AssistantToolStep> = {}): AssistantToolStep {
  return {
    callId: 'call-1',
    tool: 'search_notes',
    label: '检索笔记',
    status: 'ok',
    message: '找到 2 条笔记',
    ...overrides,
  }
}

function task(
  callId: string,
  status: AssistantToolTask['status'] = 'skipped',
): AssistantToolTask {
  return { callId, tool: 'create_entry', label: '创建备忘', status }
}

describe('执行历史仓储', () => {
  it('创建后按开始时间倒序分页，并有稳定的总数与 hasMore', async () => {
    const repo = makeRepo()
    for (let i = 0; i < 12; i += 1) {
      await repo.create(record({ id: `exec-${i}`, startedAt: BASE + i * 1000 }))
    }
    const first = await repo.list({ page: 1, pageSize: 10 })
    assert.equal(first.total, 12)
    assert.equal(first.items.length, 10)
    assert.equal(first.hasMore, true)
    assert.equal(first.items[0].id, 'exec-11')
    const second = await repo.list({ page: 2, pageSize: 10 })
    assert.equal(second.items.length, 2)
    assert.equal(second.hasMore, false)
    assert.equal(second.items[0].id, 'exec-1')
  })

  it('同一 requestId / 记录 id 重复创建不会产生重复记录', async () => {
    const repo = makeRepo()
    await repo.create(record({ id: 'exec-1' }))
    await repo.create(record({ id: 'exec-1', title: '重复' }))
    const list = await repo.list({})
    assert.equal(list.total, 1)
    assert.equal(list.items[0].title, '整理最近笔记')
  })

  it('更新只合并字段，不改变记录 id', async () => {
    const repo = makeRepo()
    await repo.create(record())
    await repo.update('exec-1', {
      status: 'success',
      finishedAt: BASE + 2000,
      durationMs: 2000,
      successCount: 1,
    })
    const got = await repo.getById('exec-1')
    assert.equal(got?.id, 'exec-1')
    assert.equal(got?.status, 'success')
    assert.equal(got?.durationMs, 2000)
  })

  it('步骤按 ordinal 顺序读取，重复 upsert 保持幂等', async () => {
    const repo = makeRepo()
    await repo.create(record())
    const steps: AgentExecutionStep[] = [
      { id: 'exec-1:c2', executionId: 'exec-1', ordinal: 1, toolCallId: 'c2', toolName: 'create_entry', label: '创建', status: 'success' },
      { id: 'exec-1:c1', executionId: 'exec-1', ordinal: 0, toolCallId: 'c1', toolName: 'search_notes', label: '检索', status: 'success' },
    ]
    for (const item of steps) await repo.upsertStep(item)
    await repo.upsertStep({ ...steps[0], status: 'failed' })
    const got = await repo.getSteps('exec-1')
    assert.deepEqual(got.map((item) => item.toolCallId), ['c1', 'c2'])
    assert.equal(got.length, 2)
    assert.equal(got[1].status, 'failed')
  })

  it('关键词、状态、时间范围与未完成筛选只返回匹配记录', async () => {
    const repo = makeRepo()
    await repo.create(record({ id: 'a', title: '购物清单', startedAt: BASE }))
    await repo.create(record({ id: 'b', title: '项目提纲', userInput: '包含购物事项', startedAt: BASE + 5000, status: 'success', finishedAt: BASE + 6000 }))
    await repo.create(record({ id: 'c', title: '其他', startedAt: BASE + 9000, status: 'failed', finishedAt: BASE + 9500 }))
    const keyword = await repo.list({ keyword: '购物' })
    assert.deepEqual(keyword.items.map((item) => item.id).sort(), ['a', 'b'])
    const status = await repo.list({ statuses: ['success'] })
    assert.deepEqual(status.items.map((item) => item.id), ['b'])
    const range = await repo.list({ from: BASE + 4000, to: BASE + 8000 })
    assert.deepEqual(range.items.map((item) => item.id), ['b'])
    const unfinished = await repo.list({ unfinishedOnly: true })
    assert.deepEqual(unfinished.items.map((item) => item.id), ['a'])
  })

  it('删除单条只移除该记录及步骤，清空只影响历史数据', async () => {
    const repo = makeRepo()
    await repo.create(record({ id: 'a' }))
    await repo.create(record({ id: 'b' }))
    await repo.upsertStep({ id: 'a:c1', executionId: 'a', ordinal: 0, toolCallId: 'c1', toolName: 'search_notes', label: '检索', status: 'success' })
    await repo.upsertStep({ id: 'b:c1', executionId: 'b', ordinal: 0, toolCallId: 'c1', toolName: 'search_notes', label: '检索', status: 'success' })
    await repo.deleteById('a')
    assert.equal(await repo.getById('a'), null)
    assert.deepEqual(await repo.getSteps('a'), [])
    assert.equal((await repo.getSteps('b')).length, 1)
    await repo.clear()
    assert.equal((await repo.list({})).total, 0)
    assert.deepEqual(await repo.getSteps('b'), [])
  })
})

describe('执行历史安全摘要', () => {
  it('用户输入与工具参数不保存密钥和完整正文', () => {
    const input = summarizeUserInput('用密钥 sk-abcdefgh12345678 和 Bearer abc.def.ghi 总结正文')
    assert.doesNotMatch(input, /sk-abcdefgh12345678/)
    assert.doesNotMatch(input, /abc\.def\.ghi/)
    assert.match(input, /sk-\*\*\*/)
    const args = summarizeToolArguments(
      'update_entry',
      JSON.stringify({ id: 'e1', title: '标题', content: '这是一段很长的笔记正文内容', authorization: 'Bearer secret-token-123' }),
    )
    assert.doesNotMatch(args, /很长的笔记正文内容/)
    assert.doesNotMatch(args, /secret-token-123/)
    assert.match(args, /content=正文 13 字/)
    const title = buildExecutionTitle('用 sk-abcdefgh12345678 创建备忘')
    assert.doesNotMatch(title, /sk-abcdefgh12345678/)
    assert.match(title, /sk-\*\*\*/)
  })

  it('只读工具的步骤结果只记录数量，不保存笔记正文', async () => {
    const repo = makeRepo()
    const recorder = new ExecutionRecorder(() => repo)
    recorder.start({ id: 'exec-read-safe', conversationId: 'c', messageId: 'm', requestId: 'r', title: '总结笔记', userInput: '总结笔记', startedAt: BASE })
    recorder.stepFinished('exec-read-safe', {
      call: call('c1', 'search_notes', { query: '项目' }),
      outcome: {
        status: 'ok',
        result: '项目复盘：内部机密正文内容，不应写入历史',
        effect: { op: 'search', count: 1, references: [{ id: 'e1', kind: 'note', title: '项目复盘' }] },
      },
      finishedAt: BASE + 100,
    })
    recorder.finish({ executionId: 'exec-read-safe', status: 'success', phase: 'done', finishedAt: BASE + 200, steps: [] })
    await recorder.flush()
    const steps = await repo.getSteps('exec-read-safe')
    assert.equal(steps[0].safeOutputSummary, '检索 1 条结果')
    assert.doesNotMatch(JSON.stringify(steps), /内部机密正文内容/)
  })

  it('业务对象引用只来自工具真实 effect，并去重、限制数量', () => {
    const refs = toTargetReferences({
      op: 'create',
      kind: 'note',
      entryId: 'e1',
      title: '标题',
      references: [
        { id: 'e1', kind: 'note', title: '标题' },
        { id: 'e2', kind: 'todo', title: '待办' },
      ],
    })
    assert.deepEqual(refs.map((item) => item.entryId), ['e1', 'e2'])
    assert.equal(refs[0].effect, 'created')
    assert.equal(refs[1].effect, 'read')
  })
})

describe('执行状态推导', () => {
  it('未知写入优先于停止与普通失败，永远不能算成功', () => {
    const unknown = step({
      status: 'execution_unknown',
      failure: { category: 'execution_unknown', writeState: 'unknown', autoRetryAllowed: false, requiresVerification: true },
    })
    assert.equal(deriveExecutionStatus({ steps: [step(), unknown], stopped: true }), 'execution_unknown')
    assert.equal(deriveExecutionStatus({ steps: [step()], stopped: true }), 'cancelled')
  })

  it('部分成功、全部失败与未执行调用不会标记为成功', () => {
    assert.equal(deriveExecutionStatus({ steps: [step(), step({ callId: 'c2', status: 'error' })] }), 'partial')
    assert.equal(deriveExecutionStatus({ steps: [step({ status: 'error' })] }), 'failed')
    assert.equal(deriveExecutionStatus({ steps: [], tasks: [task('c1')], limitReached: true }), 'failed')
    assert.equal(deriveExecutionStatus({ steps: [step()] }), 'success')
  })

  it('删除确认等等待用户操作的状态不会被推导为失败或成功', () => {
    const confirm = step({ status: 'confirm', needsInput: true })
    assert.equal(deriveExecutionStatus({ steps: [confirm] }), 'needs_input')
    assert.equal(
      deriveExecutionStatus({ steps: [step(), confirm] }),
      'needs_input',
    )
  })

  it('失败建议覆盖未知写入、权限与中断，且不提供重放授权', () => {
    const unknown = failureGuidance(undefined, 'execution_unknown')
    assert.match(unknown, /核对/)
    assert.match(unknown, /不要直接重试|不会自动重放/)
    assert.match(failureGuidance(undefined, 'interrupted'), /不会自动重放/)
    assert.match(failureGuidance(undefined, 'needs_input'), /补充/)
  })

  it('摘要基于真实计数生成，不依赖模型自然语言', () => {
    const summary = buildExecutionSummary({
      status: 'partial',
      steps: [
        {
          id: 's1',
          executionId: 'e1',
          ordinal: 0,
          toolCallId: 'c1',
          toolName: 'create_entry',
          label: '创建备忘',
          status: 'success',
        },
        {
          id: 's2',
          executionId: 'e1',
          ordinal: 1,
          toolCallId: 'c2',
          toolName: 'update_entry',
          label: '修改备忘',
          status: 'failed',
          failure: { category: 'business_execution_failed', writeState: 'failed', autoRetryAllowed: false, requiresVerification: false },
        },
      ],
      tally: { toolCount: 2, successCount: 1, failedCount: 1, skippedCount: 0 },
    })
    assert.match(summary, /工具 2 项，完成 1 项，失败 1 项/)
    assert.match(summary, /失败步骤/)
  })
})

describe('执行记录器', () => {
  it('按真实步骤事件写入记录、计数与耗时', async () => {
    const repo = makeRepo()
    const recorder = new ExecutionRecorder(() => repo)
    recorder.start({
      id: 'exec-1',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      requestId: 'req-1',
      title: '整理笔记',
      userInput: '整理笔记',
      startedAt: BASE,
    })
    recorder.stepStarted('exec-1', { call: call('c1', 'search_notes', { query: '项目' }), startedAt: BASE + 100 })
    recorder.stepFinished('exec-1', {
      call: call('c1', 'search_notes', { query: '项目' }),
      outcome: { status: 'ok', result: '找到 2 条笔记', effect: { op: 'search', count: 2 } },
      finishedAt: BASE + 900,
    })
    recorder.finish({
      executionId: 'exec-1',
      status: 'success',
      phase: 'done',
      finishedAt: BASE + 1200,
      steps: [step({ callId: 'c1', tool: 'search_notes', label: '检索笔记' })],
    })
    await recorder.flush()
    const got = await repo.getById('exec-1')
    const steps = await repo.getSteps('exec-1')
    assert.equal(got?.status, 'success')
    assert.equal(got?.durationMs, 1200)
    assert.equal(got?.toolCount, 1)
    assert.equal(got?.successCount, 1)
    assert.equal(steps[0].durationMs, 800)
    assert.equal(steps[0].status, 'success')
  })

  it('事件缺失时用 store 步骤补齐，未执行调用只计入跳过', async () => {
    const repo = makeRepo()
    const recorder = new ExecutionRecorder(() => repo)
    recorder.start({
      id: 'exec-2',
      conversationId: 'conv-1',
      messageId: 'msg-2',
      requestId: 'req-2',
      title: '创建待办',
      userInput: '创建待办',
      startedAt: BASE,
    })
    recorder.finish({
      executionId: 'exec-2',
      status: 'partial',
      phase: 'partial',
      finishedAt: BASE + 500,
      steps: [step({ callId: 'c1', tool: 'create_entry', label: '创建待办', message: '已创建待办「购物」' })],
      tasks: [task('c1', 'success'), task('c2', 'skipped')],
    })
    await recorder.flush()
    const got = await repo.getById('exec-2')
    assert.equal(got?.toolCount, 2)
    assert.equal(got?.successCount, 1)
    assert.equal(got?.skippedCount, 1)
    assert.equal((await repo.getSteps('exec-2')).length, 1)
  })

  it('未知写入即使 store 传入 success 也升级为 execution_unknown', async () => {
    const repo = makeRepo()
    const recorder = new ExecutionRecorder(() => repo)
    recorder.start({ id: 'exec-3', conversationId: 'c', messageId: 'm', requestId: 'r', title: '创建', userInput: '创建', startedAt: BASE })
    recorder.finish({
      executionId: 'exec-3',
      status: 'success',
      phase: 'done',
      finishedAt: BASE + 500,
      steps: [
        step({
          callId: 'c1',
          tool: 'create_entry',
          status: 'execution_unknown',
          failure: { category: 'execution_unknown', writeState: 'unknown', autoRetryAllowed: false, requiresVerification: true },
          message: '回读失败',
        }),
      ],
    })
    await recorder.flush()
    const got = await repo.getById('exec-3')
    assert.equal(got?.status, 'execution_unknown')
    assert.equal(got?.failure?.requiresVerification, true)
    assert.match(got?.summary ?? '', /不要直接重试/)
  })

  it('历史仓储报错不会改变执行结果，也不会抛出', async () => {
    const broken = {
      create: async () => { throw new Error('disk full') },
      update: async () => { throw new Error('disk full') },
      getById: async () => null,
      list: async () => ({ items: [], total: 0, page: 1, pageSize: 10, hasMore: false }),
      listUnfinished: async () => [],
      getSteps: async () => [],
      upsertStep: async () => { throw new Error('disk full') },
      deleteById: async () => undefined,
      clear: async () => undefined,
    }
    const recorder = new ExecutionRecorder(() => broken)
    assert.doesNotThrow(() =>
      recorder.start({ id: 'exec-4', conversationId: 'c', messageId: 'm', requestId: 'r', title: 't', userInput: 'u', startedAt: BASE }),
    )
    assert.doesNotThrow(() =>
      recorder.finish({ executionId: 'exec-4', status: 'success', phase: 'done', finishedAt: BASE + 1, steps: [] }),
    )
    await recorder.flush()
  })

  it('重复 start 不会产生第二条记录', async () => {
    const repo = makeRepo()
    const recorder = new ExecutionRecorder(() => repo)
    const input = { id: 'exec-5', conversationId: 'c', messageId: 'm', requestId: 'r', title: 't', userInput: 'u', startedAt: BASE }
    recorder.start(input)
    recorder.start({ ...input, title: '重复' })
    await recorder.flush()
    assert.equal((await repo.list({})).total, 1)
  })
})

describe('中断恢复', () => {
  it('重启时未完成的写入转为 execution_unknown，只读步骤转为 cancelled', async () => {
    const repo = makeRepo()
    const startedAt = Date.now() - 60_000
    await repo.create(record({ id: 'exec-r', startedAt, status: 'running' }))
    await repo.upsertStep({
      id: 'exec-r:w', executionId: 'exec-r', ordinal: 0, toolCallId: 'w', toolName: 'create_entry', label: '创建备忘', status: 'running', startedAt: startedAt + 100,
    })
    await repo.upsertStep({
      id: 'exec-r:r', executionId: 'exec-r', ordinal: 1, toolCallId: 'r', toolName: 'search_notes', label: '检索', status: 'running', startedAt: startedAt + 200,
    })
    setAgentExecutionRepositoryForTests(repo)
    resetHistoryRecoveryForTests()
    try {
      await recoverInterruptedExecutions()
      const got = await repo.getById('exec-r')
      assert.equal(got?.status, 'execution_unknown')
      assert.equal(got?.failure?.requiresVerification, true)
      assert.match(got?.summary ?? '', /不会自动重放/)
      const steps = await repo.getSteps('exec-r')
      assert.equal(steps[0].status, 'execution_unknown')
      assert.equal(steps[0].failure?.writeState, 'unknown')
      assert.equal(steps[1].status, 'cancelled')
    } finally {
      setAgentExecutionRepositoryForTests(null)
      resetHistoryRecoveryForTests()
    }
  })

  it('只读中断恢复为 interrupted，且已完成记录不被改写', async () => {
    const repo = makeRepo()
    const startedAt = Date.now() - 60_000
    await repo.create(record({ id: 'exec-read', startedAt, status: 'running' }))
    await repo.upsertStep({
      id: 'exec-read:r', executionId: 'exec-read', ordinal: 0, toolCallId: 'r', toolName: 'search_notes', label: '检索', status: 'running', startedAt: startedAt + 100,
    })
    await repo.create(record({ id: 'exec-done', startedAt, status: 'success', finishedAt: startedAt + 1000 }))
    setAgentExecutionRepositoryForTests(repo)
    resetHistoryRecoveryForTests()
    try {
      await recoverInterruptedExecutions()
      assert.equal((await repo.getById('exec-read'))?.status, 'interrupted')
      const done = await repo.getById('exec-done')
      assert.equal(done?.status, 'success')
      assert.equal(done?.finishedAt, startedAt + 1000)
      const steps = await repo.getSteps('exec-read')
      assert.equal(steps[0].status, 'cancelled')
    } finally {
      setAgentExecutionRepositoryForTests(null)
      resetHistoryRecoveryForTests()
    }
  })

  it('恢复每个进程只执行一次', async () => {
    const repo = makeRepo()
    const startedAt = Date.now() - 60_000
    await repo.create(record({ id: 'exec-once', startedAt, status: 'running' }))
    setAgentExecutionRepositoryForTests(repo)
    resetHistoryRecoveryForTests()
    try {
      await recoverInterruptedExecutions()
      await repo.update('exec-once', { status: 'running', finishedAt: undefined })
      await recoverInterruptedExecutions()
      assert.equal((await repo.getById('exec-once'))?.status, 'running')
    } finally {
      setAgentExecutionRepositoryForTests(null)
      resetHistoryRecoveryForTests()
    }
  })
})

describe('记录器单例隔离', () => {
  it('测试重置后不会复用旧会话', () => {
    resetExecutionRecorderForTests()
    assert.doesNotThrow(() => resetExecutionRecorderForTests())
  })
})
