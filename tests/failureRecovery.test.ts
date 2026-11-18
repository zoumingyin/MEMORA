import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { executeToolWithEnv } from '../src/services/agentToolExecutor'
import type { AgentToolScope, ToolOutcome } from '../src/services/agentToolExecutor'
import {
  classifyModelFailure,
  failureFor,
  readFailure,
} from '../src/services/agentFailure'
import { buildExecutionOutcomeNotice } from '../src/services/agentProgress'
import type { AssistantToolStep } from '../src/types/ai'
import {
  call,
  createHarness,
  makeBase,
  nextId,
  seed,
  type TestHarness,
} from './helpers'

let h!: TestHarness
beforeEach(async () => {
  h = await createHarness()
})

function run(
  name: string,
  args: unknown,
  id = nextId('call'),
  scope: AgentToolScope = h.scope(),
): Promise<ToolOutcome> {
  return executeToolWithEnv(call(id, name, args), h.env, scope)
}

describe('统一失败分类与重试边界', () => {
  it('只有未执行业务工具的模型失败允许自动重试', () => {
    assert.equal(classifyModelFailure('network_error', '断网', false).autoRetryAllowed, true)
    assert.equal(classifyModelFailure('network_error', '断网', true).autoRetryAllowed, false)
    const timeout = classifyModelFailure('stream_error', 'request timed out', false)
    assert.equal(timeout.category, 'model_timeout')
    assert.equal(timeout.autoRetryAllowed, true)
  })

  it('写入状态不确定时禁止自动重试并要求核对', () => {
    for (const category of ['execution_unknown', 'readback_failed'] as const) {
      const failure = failureFor(category, 'unknown')
      assert.equal(failure.autoRetryAllowed, false)
      assert.equal(failure.requiresVerification, true)
    }
  })

  it('权限、目标与取消类失败都不允许自动重试', () => {
    for (const category of [
      'permission_denied',
      'target_not_found',
      'target_ambiguous',
      'execution_cancelled',
      'dependency_failed',
    ] as const) {
      assert.equal(failureFor(category).autoRetryAllowed, false)
    }
    assert.equal(readFailure().autoRetryAllowed, true)
  })
})

describe('写入后回读一致性', () => {
  it('创建回读失败标记 readback_failed，不报告为普通失败也不提示重试', async () => {
    const scope = h.scope()
    const env = { ...h.env, listEntries: () => [] }
    const out = await executeToolWithEnv(
      call('c1', 'create_entry', { kind: 'note', title: '回读失败' }),
      env,
      scope,
    )
    assert.equal(out.status, 'error')
    assert.equal(out.failure?.category, 'readback_failed')
    assert.equal(out.failure?.writeState, 'unknown')
    assert.equal(out.failure?.requiresVerification, true)
    assert.doesNotMatch(out.result, /请重试/)
    // 仓储实际已经写入：不能声称创建失败，也不能自动重复创建
    assert.equal(h.entries().length, 1)
  })

  it('修改回读不一致时标记不确定，并阻止依赖同一目标的后续写入', async () => {
    await seed(h, makeBase('note', { id: 'e1', title: '旧标题' }))
    const stale = h.entries()
    const scope = h.scope()
    const env = { ...h.env, listEntries: () => stale }

    const first = await executeToolWithEnv(
      call('u1', 'update_entry', { id: 'e1', title: '新标题' }),
      env,
      scope,
    )
    assert.equal(first.status, 'error')
    assert.equal(first.failure?.category, 'readback_failed')
    assert.equal(first.failure?.writeState, 'unknown')
    assert.equal(scope.uncertainEntryIds.has('e1'), true)
    // 写入其实已经生效，只是回读拿不到
    assert.equal(h.entries()[0].title, '新标题')

    const second = await executeToolWithEnv(
      call('u2', 'update_entry', { id: 'e1', title: '再次修改' }),
      h.env,
      scope,
    )
    assert.equal(second.status, 'error')
    assert.equal(second.failure?.category, 'dependency_failed')
    assert.equal(h.entries()[0].title, '新标题', '依赖未确认时不得继续写入')
  })

  it('仓储写入抛异常时标记 execution_unknown，不自动重放', async () => {
    await seed(h, makeBase('note', { id: 'e2', title: '原始' }))
    const scope = h.scope()
    const env = {
      ...h.env,
      updateEntry: async () => {
        throw new Error('db locked')
      },
    }
    const out = await executeToolWithEnv(
      call('u3', 'update_entry', { id: 'e2', title: '修改后' }),
      env,
      scope,
    )
    assert.equal(out.status, 'error')
    assert.equal(out.failure?.category, 'execution_unknown')
    assert.equal(out.failure?.requiresVerification, true)
    assert.equal(scope.uncertainEntryIds.has('e2'), true)
    assert.doesNotMatch(out.result, /请重试/)
  })
})

describe('重复调用与部分成功', () => {
  it('相同参数换一个 tool_call_id 也不会重复创建', async () => {
    const scope = h.scope()
    const args = { kind: 'note', title: '唯一一条' }
    const first = await run('create_entry', args, 'c1', scope)
    const second = await run('create_entry', args, 'c2', scope)
    assert.equal(first.status, 'ok')
    assert.equal(second.status, 'duplicate')
    assert.equal(h.entries().length, 1)
  })

  it('部分成功的结果摘要把状态不明单独列出，不写成功也不要求重试', () => {
    const steps: AssistantToolStep[] = [
      {
        callId: 'a',
        tool: 'create_entry',
        label: '新建待办「A」',
        status: 'ok',
        message: '已创建',
        effect: { op: 'create', kind: 'todo', entryId: 'e1', title: 'A' },
      },
      {
        callId: 'b',
        tool: 'update_entry',
        label: '修改「B」',
        status: 'error',
        message: '错误：修改未能确认',
        failure: {
          category: 'readback_failed',
          writeState: 'unknown',
          autoRetryAllowed: false,
          requiresVerification: true,
        },
      },
    ]
    const notice = buildExecutionOutcomeNotice({
      steps,
      phase: 'partial',
      stopped: false,
    })
    assert.match(notice, /完成 1 项，失败 0 项/)
    assert.match(notice, /写入状态待核对 1 项/)
    assert.match(notice, /不要直接重试/)
    assert.doesNotMatch(notice, /失败 1 项：/)
  })
})
