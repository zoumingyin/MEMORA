import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { LocalAgentExecutionRepository } from '../src/repository/localExecutionRepository'
import { setAgentExecutionRepositoryForTests } from '../src/repository/executionRepository'
import { resetExecutionRecorderForTests } from '../src/services/executionRecorder'
import {
  recordDeleteCancelled,
  recordDeleteConfirmed,
} from '../src/services/deleteConfirmationHistory'
import type { AgentExecutionRecord, AgentExecutionStep } from '../src/types/executionHistory'
import { FakeStorage } from './helpers'

const BASE = new Date(2026, 10, 18, 9, 0, 0).getTime()
const EXECUTION_ID = 'exec-del-1'
const STEP_ID = `${EXECUTION_ID}:call-del-1`
const PROPOSAL_ID = 'proposal-del-1'
const ENTRY_ID = 'entry-del-1'

let repo: LocalAgentExecutionRepository

beforeEach(() => {
  repo = new LocalAgentExecutionRepository(new FakeStorage())
  setAgentExecutionRepositoryForTests(repo)
  resetExecutionRecorderForTests()
})

async function seedDeleteHistory(
  overrides: Partial<AgentExecutionStep> = {},
): Promise<void> {
  const record: AgentExecutionRecord = {
    id: EXECUTION_ID,
    conversationId: 'conv-1',
    messageId: 'msg-1',
    requestId: EXECUTION_ID,
    title: '删除待确认便签',
    userInput: '删除待确认便签',
    status: 'needs_input',
    phase: 'done',
    startedAt: BASE,
    finishedAt: BASE + 100,
    durationMs: 100,
    toolCount: 1,
    successCount: 0,
    failedCount: 0,
    skippedCount: 1,
    createdAt: BASE,
    updatedAt: BASE + 100,
  }
  await repo.create(record)
  await repo.upsertStep({
    id: STEP_ID,
    executionId: EXECUTION_ID,
    ordinal: 0,
    toolCallId: 'call-del-1',
    toolName: 'delete_entry',
    proposalId: PROPOSAL_ID,
    label: '删除便签「待确认」',
    status: 'needs_input',
    startedAt: BASE + 10,
    finishedAt: BASE + 100,
    effect: { op: 'delete', kind: 'note', entryId: ENTRY_ID },
    targetReferences: [
      { entryId: ENTRY_ID, kind: 'note', effect: 'deleted' },
    ],
    safeOutputSummary: '等待用户确认删除',
    ...overrides,
  })
}

function link(overrides: Partial<Parameters<typeof recordDeleteCancelled>[0]> = {}) {
  return {
    executionId: EXECUTION_ID,
    stepId: STEP_ID,
    proposalId: PROPOSAL_ID,
    targetId: ENTRY_ID,
    ...overrides,
  }
}

describe('删除确认历史回写', () => {
  it('确认成功后步骤与记录变为成功，并记录真实目标', async () => {
    await seedDeleteHistory()
    const changed = await recordDeleteConfirmed(link(), { ok: true })
    assert.equal(changed, true)
    const record = await repo.getById(EXECUTION_ID)
    const steps = await repo.getSteps(EXECUTION_ID)
    assert.equal(record?.status, 'success')
    assert.equal(record?.successCount, 1)
    assert.equal(record?.failedCount, 0)
    assert.equal(steps.length, 1)
    assert.equal(steps[0].proposalId, PROPOSAL_ID)
    assert.equal(steps[0].status, 'success')
    assert.equal(steps[0].targetReferences?.[0]?.entryId, ENTRY_ID)
    assert.match(steps[0].safeOutputSummary ?? '', /已移入废纸篓/)
  })

  it('用户取消后步骤与记录变为 cancelled，不伪造删除成功', async () => {
    await seedDeleteHistory()
    const changed = await recordDeleteCancelled(link())
    assert.equal(changed, true)
    const record = await repo.getById(EXECUTION_ID)
    const steps = await repo.getSteps(EXECUTION_ID)
    assert.equal(record?.status, 'cancelled')
    assert.equal(record?.successCount, 0)
    assert.equal(steps[0].status, 'cancelled')
    assert.equal(steps[0].failure?.category, 'execution_cancelled')
    assert.equal(steps[0].failure?.requiresVerification, false)
    assert.match(steps[0].safeOutputSummary ?? '', /未移入废纸篓/)
  })

  it('业务执行失败时记录真实失败分类，而不是成功', async () => {
    await seedDeleteHistory()
    const changed = await recordDeleteConfirmed(link(), {
      ok: false,
      reason: 'failed',
      message: '删除未生效，请稍后重试',
    })
    assert.equal(changed, true)
    const record = await repo.getById(EXECUTION_ID)
    const steps = await repo.getSteps(EXECUTION_ID)
    assert.equal(record?.status, 'failed')
    assert.equal(record?.successCount, 0)
    assert.equal(record?.failedCount, 1)
    assert.equal(steps[0].status, 'failed')
    assert.equal(steps[0].failure?.category, 'business_execution_failed')
    assert.equal(steps[0].failure?.writeState, 'failed')
  })

  it('重复确认不制造第二条步骤，失败后重试成功会清除旧失败', async () => {
    await seedDeleteHistory()
    await recordDeleteConfirmed(link(), {
      ok: false,
      reason: 'failed',
      message: '删除未生效',
    })
    await recordDeleteConfirmed(link(), { ok: true })
    await recordDeleteConfirmed(link(), { ok: true })
    const record = await repo.getById(EXECUTION_ID)
    const steps = await repo.getSteps(EXECUTION_ID)
    assert.equal(steps.length, 1)
    assert.equal(steps[0].status, 'success')
    assert.equal(steps[0].failure, undefined)
    assert.equal(record?.status, 'success')
    assert.equal(record?.failedCount, 0)
    assert.equal(record?.successCount, 1)
  })

  it('已成功的删除不会被后来的取消覆盖', async () => {
    await seedDeleteHistory()
    await recordDeleteConfirmed(link(), { ok: true })
    const changed = await recordDeleteCancelled(link())
    assert.equal(changed, false)
    const record = await repo.getById(EXECUTION_ID)
    const steps = await repo.getSteps(EXECUTION_ID)
    assert.equal(record?.status, 'success')
    assert.equal(steps[0].status, 'success')
  })

  it('并发点击（busy）或已执行（done）不会制造新的历史结果', async () => {
    await seedDeleteHistory()
    assert.equal(
      await recordDeleteConfirmed(link(), {
        ok: false,
        reason: 'busy',
        message: '删除正在执行',
      }),
      false,
    )
    assert.equal(
      await recordDeleteConfirmed(link(), {
        ok: false,
        reason: 'done',
        message: '已经执行过',
      }),
      false,
    )
    const record = await repo.getById(EXECUTION_ID)
    const steps = await repo.getSteps(EXECUTION_ID)
    assert.equal(record?.status, 'needs_input')
    assert.equal(steps[0].status, 'needs_input')
  })

  it('缺少 stepId 或卡片 proposalId 时安静跳过', async () => {
    await seedDeleteHistory()
    assert.equal(await recordDeleteConfirmed(link({ stepId: undefined }), { ok: true }), false)
    assert.equal(await recordDeleteCancelled(link({ proposalId: undefined })), false)
    assert.equal(await recordDeleteConfirmed({}, { ok: true }), false)
    const record = await repo.getById(EXECUTION_ID)
    const steps = await repo.getSteps(EXECUTION_ID)
    assert.equal(record?.status, 'needs_input')
    assert.equal(steps[0].status, 'needs_input')
    assert.equal(steps[0].proposalId, PROPOSAL_ID)
  })

  it('executionId 不匹配时不回写', async () => {
    await seedDeleteHistory()
    assert.equal(
      await recordDeleteConfirmed(link({ executionId: 'other-execution' }), { ok: true }),
      false,
    )
    assert.equal((await repo.getById(EXECUTION_ID))?.status, 'needs_input')
    assert.equal((await repo.getSteps(EXECUTION_ID))[0].status, 'needs_input')
  })

  it('stepId 不匹配时不回写', async () => {
    await seedDeleteHistory()
    assert.equal(
      await recordDeleteConfirmed(link({ stepId: `${EXECUTION_ID}:other-call` }), { ok: true }),
      false,
    )
    assert.equal((await repo.getSteps(EXECUTION_ID))[0].status, 'needs_input')
  })

  it('历史步骤缺少 proposalId 时绝不回写', async () => {
    await seedDeleteHistory({ proposalId: undefined })
    assert.equal(await recordDeleteConfirmed(link(), { ok: true }), false)
    assert.equal(await recordDeleteCancelled(link()), false)
    const record = await repo.getById(EXECUTION_ID)
    const steps = await repo.getSteps(EXECUTION_ID)
    assert.equal(record?.status, 'needs_input')
    assert.equal(steps[0].status, 'needs_input')
    assert.equal(steps[0].proposalId, undefined)
  })

  it('proposalId 不一致时不回写', async () => {
    await seedDeleteHistory()
    assert.equal(
      await recordDeleteConfirmed(link({ proposalId: 'other-proposal' }), { ok: true }),
      false,
    )
    assert.equal((await repo.getSteps(EXECUTION_ID))[0].status, 'needs_input')
  })

  it('targetId 不在真实目标引用中时不回写', async () => {
    await seedDeleteHistory()
    assert.equal(
      await recordDeleteConfirmed(link({ targetId: 'other-entry' }), { ok: true }),
      false,
    )
    assert.equal((await repo.getSteps(EXECUTION_ID))[0].status, 'needs_input')
  })

  it('工具名不是 delete_entry 时不回写', async () => {
    await seedDeleteHistory({ toolName: 'update_entry' })
    assert.equal(await recordDeleteConfirmed(link(), { ok: true }), false)
    assert.equal((await repo.getSteps(EXECUTION_ID))[0].status, 'needs_input')
  })

  it('历史记录不存在时不创建记录', async () => {
    assert.equal(await recordDeleteConfirmed(link(), { ok: true }), false)
    assert.equal(await repo.getById(EXECUTION_ID), null)
    assert.deepEqual(await repo.getSteps(EXECUTION_ID), [])
  })

  it('历史记录被用户删除后，回写不会重建记录', async () => {
    await seedDeleteHistory()
    await repo.deleteById(EXECUTION_ID)
    const changed = await recordDeleteConfirmed(link(), { ok: true })
    assert.equal(changed, false)
    assert.equal(await repo.getById(EXECUTION_ID), null)
    assert.deepEqual(await repo.getSteps(EXECUTION_ID), [])
  })

  it('历史回写异常时返回 false，不向调用方抛出', async () => {
    await seedDeleteHistory()
    const failingRepo = new LocalAgentExecutionRepository(new FakeStorage())
    failingRepo.getById = (id) => repo.getById(id)
    failingRepo.getSteps = (id) => repo.getSteps(id)
    failingRepo.upsertStep = async () => {
      throw new Error('INJECTED_HISTORY_WRITE_FAILURE')
    }
    setAgentExecutionRepositoryForTests(failingRepo)
    const previousError = console.error
    const logged: unknown[] = []
    console.error = (...args: unknown[]) => {
      logged.push(args)
    }
    try {
      const changed = await recordDeleteConfirmed(link(), { ok: true })
      assert.equal(changed, false)
      assert.equal(logged.length, 1)
    } finally {
      console.error = previousError
    }
    // 业务状态没有被历史回写触碰
    assert.equal((await repo.getSteps(EXECUTION_ID))[0].status, 'needs_input')
    assert.equal((await repo.getById(EXECUTION_ID))?.status, 'needs_input')
  })
})
