import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  cancelDeleteProposal,
  confirmDeleteProposal,
  deleteFailureMessage,
} from '../src/services/deleteExecution'
import {
  createDeleteProposal,
  getDeleteProposal,
  resetDeleteProposals,
} from '../src/services/deleteProposals'
import { BASE_TIME } from './helpers'
import type { EntryKind } from '../src/types/entry'

function makeProposal(kind: EntryKind = 'note', ttlMs?: number) {
  return createDeleteProposal({
    entryId: 'entry-1',
    kind,
    title: '标题',
    requestId: 'req',
    now: BASE_TIME,
    ...(ttlMs !== undefined ? { ttlMs } : {}),
  })
}

function access(state: { exists: boolean; kind: EntryKind; moves: number; fail?: boolean }) {
  return {
    findEntry: () => (state.exists ? { kind: state.kind } : undefined),
    moveToTrash: async () => {
      if (state.fail) throw new Error('db locked')
      state.moves += 1
      state.exists = false
    },
    stillExists: () => state.exists,
  }
}

beforeEach(() => {
  resetDeleteProposals()
})

describe('confirmDeleteProposal', () => {
  it('校验通过后只执行一次软删除', async () => {
    const proposal = makeProposal()
    const state = { exists: true, kind: 'note' as EntryKind, moves: 0 }
    const result = await confirmDeleteProposal({
      proposalId: proposal.id,
      targetId: 'entry-1',
      expectedKind: 'note',
      access: access(state),
      now: BASE_TIME + 1000,
    })
    assert.equal(result.ok, true)
    assert.equal(state.moves, 1)
    assert.equal(getDeleteProposal(proposal.id)?.status, 'done')
  })

  it('缺少 proposalId 或 targetId 时视为失效', async () => {
    const result = await confirmDeleteProposal({
      proposalId: undefined,
      targetId: 'entry-1',
      expectedKind: 'note',
      access: access({ exists: true, kind: 'note', moves: 0 }),
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'invalid')
  })

  it('提议不存在时报 not_found（应用重启后场景）', async () => {
    const result = await confirmDeleteProposal({
      proposalId: 'gone',
      targetId: 'entry-1',
      expectedKind: 'note',
      access: access({ exists: true, kind: 'note', moves: 0 }),
    })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.reason, 'not_found')
      assert.match(result.message, /重启/)
    }
  })

  it('超过有效期后不能执行，且提议标记为 expired', async () => {
    const proposal = makeProposal('note', 1000)
    const state = { exists: true, kind: 'note' as EntryKind, moves: 0 }
    const result = await confirmDeleteProposal({
      proposalId: proposal.id,
      targetId: 'entry-1',
      expectedKind: 'note',
      access: access(state),
      now: BASE_TIME + 2000,
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'expired')
    assert.equal(state.moves, 0)
    assert.equal(getDeleteProposal(proposal.id)?.status, 'expired')
  })

  it('取消后不能再执行', async () => {
    const proposal = makeProposal()
    cancelDeleteProposal(proposal.id)
    const state = { exists: true, kind: 'note' as EntryKind, moves: 0 }
    const result = await confirmDeleteProposal({
      proposalId: proposal.id,
      targetId: 'entry-1',
      expectedKind: 'note',
      access: access(state),
      now: BASE_TIME + 1000,
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'cancelled')
    assert.equal(state.moves, 0)
  })

  it('重复确认第二次报 done 且不再写库', async () => {
    const proposal = makeProposal()
    const state = { exists: true, kind: 'note' as EntryKind, moves: 0 }
    const input = {
      proposalId: proposal.id,
      targetId: 'entry-1',
      expectedKind: 'note' as const,
      access: access(state),
      now: BASE_TIME + 1000,
    }
    assert.equal((await confirmDeleteProposal(input)).ok, true)
    const second = await confirmDeleteProposal(input)
    assert.equal(second.ok, false)
    if (!second.ok) assert.equal(second.reason, 'done')
    assert.equal(state.moves, 1)
  })

  it('并发确认只有一次进入执行', async () => {
    const proposal = makeProposal()
    const state = { exists: true, kind: 'note' as EntryKind, moves: 0 }
    const input = {
      proposalId: proposal.id,
      targetId: 'entry-1',
      expectedKind: 'note' as const,
      access: access(state),
      now: BASE_TIME + 1000,
    }
    const results = await Promise.all([confirmDeleteProposal(input), confirmDeleteProposal(input)])
    assert.equal(results.filter((item) => item.ok).length, 1)
    const busy = results.find((item) => !item.ok)
    assert.equal(busy && !busy.ok ? busy.reason : null, 'busy')
    assert.equal(state.moves, 1)
  })

  it('确认目标与提议绑定的目标不一致时作废，不执行删除', async () => {
    const proposal = makeProposal()
    const state = { exists: true, kind: 'note' as EntryKind, moves: 0 }
    const result = await confirmDeleteProposal({
      proposalId: proposal.id,
      targetId: 'entry-2',
      expectedKind: 'note',
      access: access(state),
      now: BASE_TIME + 1000,
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'target_mismatch')
    assert.equal(state.moves, 0)
    assert.equal(getDeleteProposal(proposal.id)?.status, 'invalid')
  })

  it('确认时传入的类型与提议不一致时同样作废', async () => {
    const proposal = makeProposal('note')
    const state = { exists: true, kind: 'note' as EntryKind, moves: 0 }
    const result = await confirmDeleteProposal({
      proposalId: proposal.id,
      targetId: 'entry-1',
      expectedKind: 'todo',
      access: access(state),
      now: BASE_TIME + 1000,
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'target_mismatch')
    assert.equal(state.moves, 0)
    assert.equal(getDeleteProposal(proposal.id)?.status, 'invalid')
  })

  it('moveToTrash 抛错时释放提议并如实报失败', async () => {
    const proposal = makeProposal()
    const state = { exists: true, kind: 'note' as EntryKind, moves: 0, fail: true }
    const result = await confirmDeleteProposal({
      proposalId: proposal.id,
      targetId: 'entry-1',
      expectedKind: 'note',
      access: access(state),
      now: BASE_TIME + 1000,
    })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.reason, 'failed')
      assert.match(result.message, /删除未生效/)
    }
    assert.equal(getDeleteProposal(proposal.id)?.status, 'pending', '失败后应允许重试')
  })

  it('移入废纸篓后条目仍在时释放提议，不谎报成功', async () => {
    const proposal = makeProposal()
    const state = { exists: true, kind: 'note' as EntryKind, moves: 0 }
    const stuck = {
      findEntry: () => ({ kind: 'note' as EntryKind }),
      moveToTrash: async () => {
        state.moves += 1
      },
      stillExists: () => true,
    }
    const result = await confirmDeleteProposal({
      proposalId: proposal.id,
      targetId: 'entry-1',
      expectedKind: 'note',
      access: stuck,
      now: BASE_TIME + 1000,
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'failed')
    assert.equal(getDeleteProposal(proposal.id)?.status, 'pending')
  })
})

describe('deleteFailureMessage', () => {
  it('每种失败原因都有明确中文说明', () => {
    const reasons = [
      'not_found',
      'expired',
      'cancelled',
      'done',
      'busy',
      'invalid',
      'missing',
      'kind_changed',
      'target_mismatch',
      'failed',
    ] as const
    const messages = reasons.map((reason) => deleteFailureMessage(reason))
    assert.equal(new Set(messages).size, reasons.length)
    for (const message of messages) assert.ok(message.length > 6)
  })
})
