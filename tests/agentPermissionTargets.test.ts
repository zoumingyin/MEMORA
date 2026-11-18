import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  commitStagedCandidates,
  createAgentToolScope,
  executeToolWithEnv,
  seedTrustedTargets,
  type AgentToolScope,
  type ToolOutcome,
  type WriteAttempt,
} from '../src/services/agentToolExecutor'
import { executeToolBatch } from '../src/services/agentExecution'
import { getDeleteProposal, resetDeleteProposals } from '../src/services/deleteProposals'
import {
  buildRetryLedger,
  mergeRetryLedger,
  retryBlockedWriteTools,
  retrySystemNote,
} from '../src/services/agentRetryLedger'
import { hasSelectedReferentWriteIntent } from '../src/services/agentTargets'
import type { AssistantToolStep } from '../src/types/ai'
import {
  BASE_TIME,
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

function untrustedScope(requestId = nextId('req')): AgentToolScope {
  return h.scope(requestId, { trustedTargets: [] })
}

function run(
  scope: AgentToolScope,
  name: string,
  args: unknown,
  id = nextId('call'),
): Promise<ToolOutcome> {
  return executeToolWithEnv(call(id, name, args), h.env, scope)
}

function runBatch(scope: AgentToolScope, calls: ReturnType<typeof call>[]) {
  return executeToolBatch(
    calls,
    (toolCall) => executeToolWithEnv(toolCall, h.env, scope),
    scope.isStale,
    () => commitStagedCandidates(scope),
  )
}

describe('执行层权限守卫', () => {
  it('缺少权限时默认 none，所有工具都被拒绝', async () => {
    const scope = createAgentToolScope('req-default-none')
    const events: string[] = []
    scope.onBlocked = (event) => events.push(`${event.tool}:${event.code}`)

    const created = await run(scope, 'create_entry', { kind: 'note', title: '不该创建' })
    const searched = await run(scope, 'search_notes', { query: '任何' })

    assert.equal(created.status, 'error')
    assert.equal(created.blockedCode, 'permission_denied')
    assert.equal(searched.status, 'error')
    assert.equal(searched.blockedCode, 'permission_denied')
    assert.equal(h.entries().length, 0)
    assert.deepEqual(events, [
      'create_entry:permission_denied',
      'search_notes:permission_denied',
    ])
  })

  it('read 权限只允许查询，新增/修改/删除都不产生副作用', async () => {
    const target = await seed(h, makeBase('note', { title: '只读目标' }))
    const scope = h.scope('req-read', { permission: 'read' })
    const searched = await run(scope, 'search_notes', { query: '只读' })
    assert.equal(searched.status, 'ok')

    const created = await run(scope, 'create_entry', { kind: 'note', title: '新条目' })
    const updated = await run(scope, 'update_entry', { id: target.id, title: '改掉' })
    const deleted = await run(scope, 'delete_entry', { id: target.id })

    for (const outcome of [created, updated, deleted]) {
      assert.equal(outcome.status, 'error')
      assert.equal(outcome.blockedCode, 'permission_denied')
    }
    assert.equal(h.entries().length, 1)
    assert.equal(h.entries()[0].title, '只读目标')
    assert.equal(deleted.confirmAction, undefined)
  })

  it('write 权限允许写入，且被权限拦截的调用不占用幂等记录', async () => {
    const scope = h.scope('req-write', { permission: 'none', trustedTargets: [] })
    const args = { kind: 'note' as const, title: '权限恢复后创建' }
    const first = await run(scope, 'create_entry', args, 'same-call')
    assert.equal(first.status, 'error')
    assert.equal(first.blockedCode, 'permission_denied')
    assert.equal(h.entries().length, 0)

    scope.permission = 'write'
    const second = await run(scope, 'create_entry', args, 'same-call')
    assert.equal(second.status, 'ok')
    assert.equal(h.entries().length, 1)
  })

  it('未知工具不会被当作合法工具执行', async () => {
    const scope = h.scope('req-unknown', { permission: 'write', trustedTargets: [] })
    const out = await run(scope, 'drop_database', {})
    assert.equal(out.status, 'error')
    assert.equal(out.blockedCode, 'permission_denied')
    assert.match(out.result, /已拦截/)
  })
})

describe('目标 ID 来源守卫', () => {
  it('仅在上下文出现、未在本轮查询/选中/明确指定的 id 不能写入', async () => {
    const target = await seed(h, makeBase('note', { title: '上下文里的条目' }))
    const scope = untrustedScope()
    const out = await run(scope, 'update_entry', { id: target.id, title: '越权修改' })
    assert.equal(out.status, 'error')
    assert.equal(out.blockedCode, 'target_untrusted')
    assert.equal(h.entries()[0].title, '上下文里的条目')
  })

  it('get_note 读取成功只证明存在，不会升级为写入授权', async () => {
    const target = await seed(h, makeBase('note', { title: '可读不可写' }))
    const scope = untrustedScope()
    const read = await run(scope, 'get_note', { id: target.id })
    assert.equal(read.status, 'ok')

    const update = await run(scope, 'update_entry', { id: target.id, title: '仍然不行' })
    assert.equal(update.status, 'error')
    assert.equal(update.blockedCode, 'target_untrusted')
    assert.equal(h.entries()[0].title, '可读不可写')
  })

  it('同批查询结果不能立即写入，下一批也只是候选而非授权', async () => {
    const target = await seed(h, makeBase('note', { title: '项目周报' }))
    const scope = untrustedScope()
    const first = await runBatch(scope, [
      call('s1', 'search_notes', { query: '周报' }),
      call('u1', 'update_entry', { id: target.id, title: '同批修改' }),
    ])
    assert.equal(first.steps[0].status, 'ok')
    assert.equal(first.steps[1].status, 'error')
    assert.equal(first.steps[1].blockedCode, 'target_untrusted')
    assert.equal(first.steps[1].needsInput, true)
    assert.equal(h.entries()[0].title, '项目周报')
    assert.equal(scope.candidateTargets.has(target.id), true)
    assert.equal(scope.trustedTargets.has(target.id), false)

    const second = await run(scope, 'update_entry', { id: target.id, title: '下一批修改' })
    assert.equal(second.status, 'error')
    assert.equal(second.blockedCode, 'target_untrusted')
    assert.equal(second.needsInput, true)
    assert.equal(h.entries()[0].title, '项目周报')
  })

  it('用户当前选中条目只有在本轮明确指代时才成为授权目标', async () => {
    const target = await seed(h, makeBase('note', { title: '当前条目' }))
    const entries = h.entries()

    const noReferent = untrustedScope()
    seedTrustedTargets(noReferent, {
      userText: '帮我整理一下工作',
      entries,
      selectedId: target.id,
      allowSelectedReferent: false,
    })
    const blocked = await run(noReferent, 'update_entry', {
      id: target.id,
      title: '不该改',
    })
    assert.equal(blocked.status, 'error')
    assert.equal(blocked.blockedCode, 'target_untrusted')

    const withReferent = untrustedScope()
    seedTrustedTargets(withReferent, {
      userText: '把这个标题改成新的',
      entries,
      selectedId: target.id,
      allowSelectedReferent: true,
    })
    const allowed = await run(withReferent, 'update_entry', {
      id: target.id,
      title: '明确指代后修改',
    })
    assert.equal(allowed.status, 'ok')
    assert.equal(h.entries()[0].title, '明确指代后修改')
  })

  it('用户原文中的显式 id 和唯一标题是可信来源', async () => {
    const id = '11111111-1111-4111-8111-111111111111'
    const target = await seed(h, makeBase('note', { id, title: '显式目标' }))
    const entries = h.entries()

    const byTitle = untrustedScope()
    seedTrustedTargets(byTitle, {
      userText: '把「显式目标」改成「按标题修改」',
      entries,
    })
    const titleUpdate = await run(byTitle, 'update_entry', {
      id: target.id,
      title: '按标题修改',
    })
    assert.equal(titleUpdate.status, 'ok')

    const byId = untrustedScope()
    seedTrustedTargets(byId, {
      userText: `把 id ${id} 的标题改成「按 id 修改」`,
      entries: h.entries(),
    })
    const idUpdate = await run(byId, 'update_entry', {
      id: target.id,
      title: '按 id 修改',
    })
    assert.equal(idUpdate.status, 'ok')
    assert.equal(h.entries()[0].title, '按 id 修改')
  })

  it('仅在创建请求中提到标题，不会授权修改已有同名条目', async () => {
    const existing = await seed(h, makeBase('note', { title: '项目周报' }))
    const scope = untrustedScope()
    seedTrustedTargets(scope, {
      userText: '给我创建一条项目周报',
      entries: h.entries(),
    })
    assert.equal(scope.trustedTargets.has(existing.id), false)
    const out = await run(scope, 'update_entry', {
      id: existing.id,
      title: '不该被授权的修改',
    })
    assert.equal(out.status, 'error')
    assert.equal(out.blockedCode, 'target_untrusted')
    assert.equal(h.entries()[0].title, '项目周报')
  })

  it('目标的新标题即使恰好是已有条目，也不会被当作操作目标', async () => {
    const source = await seed(h, makeBase('note', { title: '项目周报' }))
    const destination = await seed(h, makeBase('note', { title: '项目周报终稿' }))
    const scope = untrustedScope()
    seedTrustedTargets(scope, {
      userText: '把「项目周报」改成「项目周报终稿」',
      entries: h.entries(),
    })
    assert.equal(scope.trustedTargets.get(source.id)?.source, 'user_explicit')
    assert.equal(scope.trustedTargets.has(destination.id), false)

    const wrong = await run(scope, 'update_entry', {
      id: destination.id,
      title: '误改另一条',
    })
    assert.equal(wrong.status, 'error')
    assert.equal(wrong.blockedCode, 'target_ambiguous')
    assert.equal(wrong.needsInput, true)
    assert.equal(h.entries().find((entry) => entry.id === destination.id)?.title, '项目周报终稿')

    const right = await run(scope, 'update_entry', { id: source.id, title: '真正修改' })
    assert.equal(right.status, 'ok')
    assert.equal(h.entries().find((entry) => entry.id === source.id)?.title, '真正修改')
  })

  it('本轮刚创建的真实 id 可以在后续调用中继续修改', async () => {
    const scope = untrustedScope()
    const created = await run(scope, 'create_entry', { kind: 'note', title: '刚创建' })
    assert.equal(created.status, 'ok')
    const entry = h.entries()[0]
    const updated = await run(scope, 'update_entry', {
      id: entry.id,
      append_content: '后续补充',
    })
    assert.equal(updated.status, 'ok')
    assert.match(h.entries()[0].content, /后续补充/)
  })
})

describe('查询候选与用户写授权边界', () => {
  it('只要求搜索时，下一轮模型强行修改查询结果仍被拦截', async () => {
    const target = await seed(h, makeBase('note', { title: '项目周报' }))
    const scope = untrustedScope()
    seedTrustedTargets(scope, {
      userText: '帮我找一下项目周报',
      entries: h.entries(),
    })
    const searched = await runBatch(scope, [call('s', 'search_notes', { query: '周报' })])
    assert.equal(searched.steps[0].status, 'ok')
    assert.equal(scope.trustedTargets.has(target.id), false)

    const out = await run(scope, 'update_entry', { id: target.id, title: '搜索后擅自修改' })
    assert.equal(out.status, 'error')
    assert.equal(out.blockedCode, 'target_untrusted')
    assert.equal(out.needsInput, true)
    assert.equal(h.entries()[0].title, '项目周报')
  })

  it('多个查询候选时模型自选一个也会被拦截，并进入等待补充', async () => {
    const first = await seed(h, makeBase('note', { title: '工作笔记A' }))
    const second = await seed(h, makeBase('note', { title: '工作笔记B' }))
    const scope = untrustedScope()
    seedTrustedTargets(scope, {
      userText: '整理一下我的工作笔记',
      entries: h.entries(),
    })
    const searched = await runBatch(scope, [call('s', 'search_notes', { query: '工作笔记' })])
    assert.equal(searched.steps[0].effect?.count, 2)
    assert.equal(scope.trustedTargets.size, 0)

    const out = await run(scope, 'update_entry', { id: second.id, append_content: '模型自选' })
    assert.equal(out.status, 'error')
    assert.equal(out.needsInput, true)
    assert.equal(h.entries().find((entry) => entry.id === first.id)?.content, '')
    assert.equal(h.entries().find((entry) => entry.id === second.id)?.content, '')
  })

  it('搜索命中唯一结果但没有写指令时，结果只是候选', async () => {
    const target = await seed(h, makeBase('note', { title: '唯一候选' }))
    const scope = untrustedScope()
    const batch = await runBatch(scope, [call('s', 'search_notes', { query: '唯一' })])
    assert.equal(batch.steps[0].status, 'ok')
    assert.equal(scope.candidateTargets.has(target.id), true)
    assert.equal(scope.trustedTargets.has(target.id), false)

    const out = await run(scope, 'delete_entry', { id: target.id })
    assert.equal(out.status, 'error')
    assert.equal(out.needsInput, true)
    assert.equal(h.entries().length, 1)
  })

  it('用户明确说出唯一标题时才直接授权修改', async () => {
    const target = await seed(h, makeBase('note', { title: '项目总结' }))
    const scope = untrustedScope()
    seedTrustedTargets(scope, {
      userText: '把标题为项目总结的那条笔记修改为新版总结',
      entries: h.entries(),
    })
    assert.equal(scope.trustedTargets.get(target.id)?.source, 'user_explicit')

    const out = await run(scope, 'update_entry', { id: target.id, title: '新版总结' })
    assert.equal(out.status, 'ok')
    assert.equal(h.entries()[0].title, '新版总结')
  })

  it('用户点击候选条目后，本请求内可以修改该条但不能改其它条', async () => {
    const selected = await seed(h, makeBase('note', { title: '周报草稿' }))
    const other = await seed(h, makeBase('note', { title: '购物清单' }))
    const scope = untrustedScope()
    seedTrustedTargets(scope, {
      userText: '把这条笔记改成已整理',
      entries: h.entries(),
      selectedId: selected.id,
      allowSelectedReferent: true,
    })
    assert.equal(scope.trustedTargets.get(selected.id)?.source, 'user_selected')

    const wrong = await run(scope, 'update_entry', { id: other.id, title: '误改' })
    assert.equal(wrong.status, 'error')
    assert.equal(wrong.blockedCode, 'target_untrusted')
    assert.equal(wrong.needsInput, true)
    assert.equal(h.entries().find((entry) => entry.id === other.id)?.title, '购物清单')

    const right = await run(scope, 'update_entry', { id: selected.id, title: '已整理' })
    assert.equal(right.status, 'ok')
    assert.equal(h.entries().find((entry) => entry.id === selected.id)?.title, '已整理')
  })

  it('用户选择后目标已不存在时不能凭旧选择写入', async () => {
    const target = await seed(h, makeBase('note', { title: '会被删除的候选' }))
    const scope = untrustedScope()
    seedTrustedTargets(scope, {
      userText: '把这条改成完成',
      entries: h.entries(),
      selectedId: target.id,
      allowSelectedReferent: true,
    })
    await h.repo.moveToTrash(target.id)
    await h.refresh()

    const out = await run(scope, 'update_entry', { id: target.id, title: '完成' })
    assert.equal(out.status, 'error')
    assert.match(out.result, /找不到/)
  })

  it('新建同名标题不会授权修改已有条目', async () => {
    const existing = await seed(h, makeBase('note', { title: '项目总结' }))
    const scope = untrustedScope()
    seedTrustedTargets(scope, {
      userText: '帮我新建一条叫项目总结的笔记',
      entries: h.entries(),
    })
    assert.equal(scope.trustedTargets.has(existing.id), false)

    const created = await run(scope, 'create_entry', { kind: 'note', title: '项目总结' })
    assert.equal(created.status, 'ok')
    const out = await run(scope, 'update_entry', {
      id: existing.id,
      title: '把旧条目改掉',
    })
    assert.equal(out.status, 'error')
    assert.equal(out.needsInput, true)
    assert.equal(h.entries().find((entry) => entry.id === existing.id)?.title, '项目总结')
    assert.equal(h.entries().length, 2)
  })

  it('“修改 A 为 B”只把 A 当目标，不把已有 B 当目标', async () => {
    const source = await seed(h, makeBase('note', { title: '旧标题' }))
    const destination = await seed(h, makeBase('note', { title: '新标题' }))
    const scope = untrustedScope()
    seedTrustedTargets(scope, {
      userText: '把旧标题修改为新标题',
      entries: h.entries(),
    })
    assert.equal(scope.trustedTargets.has(source.id), true)
    assert.equal(scope.trustedTargets.has(destination.id), false)

    const wrong = await run(scope, 'update_entry', { id: destination.id, append_content: '误改' })
    assert.equal(wrong.status, 'error')
    assert.equal(h.entries().find((entry) => entry.id === destination.id)?.content, '')
    const right = await run(scope, 'update_entry', { id: source.id, title: '新标题' })
    assert.equal(right.status, 'ok')
  })

  it('修改工作笔记遇到同名条目时必须询问，不能默认选第一条', async () => {
    const first = await seed(h, makeBase('note', { title: '工作笔记' }))
    const second = await seed(h, makeBase('note', { title: '工作笔记' }))
    const scope = untrustedScope()
    seedTrustedTargets(scope, {
      userText: '修改工作笔记',
      entries: h.entries(),
    })
    assert.equal(scope.trustedTargets.size, 0)
    assert.equal(scope.candidateTargets.size, 2)

    const out = await run(scope, 'update_entry', { id: first.id, title: '改第一条' })
    assert.equal(out.status, 'error')
    assert.equal(out.blockedCode, 'target_ambiguous')
    assert.equal(out.needsInput, true)
    assert.equal(h.entries().find((entry) => entry.id === first.id)?.title, '工作笔记')
    assert.equal(h.entries().find((entry) => entry.id === second.id)?.title, '工作笔记')
  })

  it('查询句里的“修改”是名词用法，不构成写授权', async () => {
    const target = await seed(h, makeBase('note', { title: '项目总结' }))
    const scope = untrustedScope()
    seedTrustedTargets(scope, {
      userText: '项目总结里有哪些修改',
      entries: h.entries(),
    })
    assert.equal(scope.trustedTargets.has(target.id), false)

    const out = await run(scope, 'update_entry', { id: target.id, title: '误改' })
    assert.equal(out.status, 'error')
    assert.equal(out.needsInput, true)
    assert.equal(h.entries()[0].title, '项目总结')
  })

  it('查询、建议和含糊整理都不产生标题写授权', async () => {
    const target = await seed(h, makeBase('note', { title: '项目总结' }))
    for (const userText of [
      '帮我找一下项目总结',
      '项目总结有什么内容',
      '帮我想一个项目总结的标题',
      '帮我整理一下最近的笔记',
    ]) {
      const scope = untrustedScope()
      seedTrustedTargets(scope, { userText, entries: h.entries() })
      assert.equal(scope.trustedTargets.size, 0, userText)
      assert.equal(scope.candidateTargets.size, 0, userText)
      const out = await run(scope, 'update_entry', { id: target.id, title: '误改' })
      assert.equal(out.status, 'error', userText)
      assert.equal(out.needsInput, true, userText)
    }
    assert.equal(h.entries()[0].title, '项目总结')
  })

  it('一次提到多个可修改标题时不做默认选择', async () => {
    const first = await seed(h, makeBase('note', { title: '项目周报' }))
    const second = await seed(h, makeBase('note', { title: '项目复盘' }))
    const scope = untrustedScope()
    seedTrustedTargets(scope, {
      userText: '修改项目周报和项目复盘',
      entries: h.entries(),
    })
    assert.equal(scope.trustedTargets.size, 0)
    assert.equal(scope.candidateTargets.has(first.id), true)
    assert.equal(scope.candidateTargets.has(second.id), true)

    const out = await run(scope, 'update_entry', { id: first.id, append_content: '批量误改' })
    assert.equal(out.status, 'error')
    assert.equal(out.needsInput, true)
    assert.equal(h.entries().find((entry) => entry.id === first.id)?.content, '')
    assert.equal(h.entries().find((entry) => entry.id === second.id)?.content, '')
  })

  it('创建目标与修改目标分属不同从句时，只授权修改目标', async () => {
    const createdName = await seed(h, makeBase('note', { title: '笔记A' }))
    const updateTarget = await seed(h, makeBase('note', { title: '笔记B' }))
    const scope = untrustedScope()
    seedTrustedTargets(scope, {
      userText: '创建笔记A，然后修改笔记B',
      entries: h.entries(),
    })
    assert.equal(scope.trustedTargets.has(createdName.id), false)
    assert.equal(scope.trustedTargets.get(updateTarget.id)?.source, 'user_explicit')

    const wrong = await run(scope, 'update_entry', { id: createdName.id, title: '误改创建目标' })
    assert.equal(wrong.status, 'error')
    assert.equal(h.entries().find((entry) => entry.id === createdName.id)?.title, '笔记A')
    const right = await run(scope, 'update_entry', { id: updateTarget.id, append_content: '已修改' })
    assert.equal(right.status, 'ok')
  })

  it('历史消息或“刚才那个”不能把 id 变成授权目标', async () => {
    const target = await seed(h, makeBase('note', { title: '历史目标' }))
    const scope = untrustedScope()
    seedTrustedTargets(scope, {
      userText: '把刚才那个改一下',
      entries: h.entries(),
      selectedId: target.id,
      allowSelectedReferent: false,
    })
    assert.equal(scope.trustedTargets.size, 0)

    const out = await run(scope, 'update_entry', { id: target.id, title: '历史误改' })
    assert.equal(out.status, 'error')
    assert.equal(out.needsInput, true)
    assert.equal(h.entries()[0].title, '历史目标')
  })

  it('查询语句里出现显式 id 也不等于写授权', async () => {
    const target = await seed(
      h,
      makeBase('note', { id: 'note-query-0001', title: '只读 id 目标' }),
    )
    const scope = untrustedScope()
    seedTrustedTargets(scope, {
      userText: `查看 id: ${target.id} 的内容`,
      entries: h.entries(),
    })
    assert.equal(scope.trustedTargets.size, 0)

    const out = await run(scope, 'update_entry', { id: target.id, title: '查询后误改' })
    assert.equal(out.status, 'error')
    assert.equal(out.needsInput, true)
    assert.equal(h.entries()[0].title, '只读 id 目标')
  })

  it('“这条笔记有哪些修改”不是选中条目的写授权', async () => {
    const target = await seed(h, makeBase('note', { title: '选中目标' }))
    assert.equal(hasSelectedReferentWriteIntent('把这条笔记改成完成'), true)
    assert.equal(hasSelectedReferentWriteIntent('这条笔记里有哪些修改'), false)

    const scope = untrustedScope()
    seedTrustedTargets(scope, {
      userText: '这条笔记里有哪些修改',
      entries: h.entries(),
      selectedId: target.id,
      allowSelectedReferent: hasSelectedReferentWriteIntent('这条笔记里有哪些修改'),
    })
    assert.equal(scope.trustedTargets.size, 0)

    const out = await run(scope, 'update_entry', { id: target.id, title: '查询后误改' })
    assert.equal(out.status, 'error')
    assert.equal(out.needsInput, true)
    assert.equal(h.entries()[0].title, '选中目标')
  })

  it('删除唯一明确标题仍只生成确认卡片，不直接删除', async () => {
    const target = await seed(h, makeBase('note', { title: '删除目标' }))
    const scope = untrustedScope()
    seedTrustedTargets(scope, {
      userText: '删除「删除目标」',
      entries: h.entries(),
    })
    const out = await run(scope, 'delete_entry', { id: target.id })
    assert.equal(out.status, 'confirm')
    assert.equal(out.confirmAction?.targetId, target.id)
    assert.equal(h.entries().length, 1)
  })
})

describe('同名与高相似目标拦截', () => {
  it('同名目标未获用户明确指定时拒绝修改，并列出候选 id', async () => {
    const first = await seed(h, makeBase('note', { title: '周报', content: '第一份' }))
    const second = await seed(h, makeBase('note', { title: '周报', content: '第二份' }))
    const scope = untrustedScope()
    scope.candidateTargets.set(first.id, {
      id: first.id,
      source: 'tool_result',
      kind: 'note',
      title: '周报',
      trustedAt: BASE_TIME,
    })

    const out = await run(scope, 'update_entry', { id: first.id, title: '改错目标' })
    assert.equal(out.status, 'error')
    assert.equal(out.blockedCode, 'target_ambiguous')
    assert.equal(out.needsInput, true)
    assert.match(out.result, /同名或高度相似/)
    assert.ok(out.result.includes(first.id))
    assert.ok(out.result.includes(second.id))
    assert.equal(h.entries().find((entry) => entry.id === first.id)?.title, '周报')
    assert.equal(h.entries().find((entry) => entry.id === second.id)?.title, '周报')
  })

  it('标题高度相似也会拦截，不会默认选择其中一条', async () => {
    const first = await seed(h, makeBase('note', { title: '项目周报' }))
    const second = await seed(h, makeBase('note', { title: '项目周报终稿' }))
    const scope = untrustedScope()
    scope.candidateTargets.set(first.id, {
      id: first.id,
      source: 'tool_result',
      kind: 'note',
      title: '项目周报',
      trustedAt: BASE_TIME,
    })
    const out = await run(scope, 'delete_entry', { id: first.id })
    assert.equal(out.status, 'error')
    assert.equal(out.blockedCode, 'target_ambiguous')
    assert.equal(out.confirmAction, undefined)
    assert.ok(out.result.includes(second.id))
    assert.equal(h.entries().length, 2)
  })

  it('用户明确指定目标时允许执行，即使存在同名条目', async () => {
    const first = await seed(h, makeBase('note', { title: '周报' }))
    const second = await seed(h, makeBase('note', { title: '周报' }))
    const scope = untrustedScope()
    scope.trustedTargets.set(first.id, {
      id: first.id,
      source: 'user_explicit',
      kind: 'note',
      title: '周报',
      trustedAt: BASE_TIME,
    })
    const out = await run(scope, 'update_entry', { id: first.id, title: '指定第一条' })
    assert.equal(out.status, 'ok')
    assert.equal(h.entries().find((entry) => entry.id === first.id)?.title, '指定第一条')
    assert.equal(h.entries().find((entry) => entry.id === second.id)?.title, '周报')
  })

  it('查询得到唯一候选也不能直接修改，必须等待用户明确目标', async () => {
    const target = await seed(h, makeBase('note', { title: '唯一目标' }))
    const scope = untrustedScope()
    const batch = await runBatch(scope, [call('s', 'search_notes', { query: '唯一' })])
    assert.equal(batch.steps[0].status, 'ok')
    assert.equal(scope.candidateTargets.has(target.id), true)
    assert.equal(scope.trustedTargets.has(target.id), false)

    const out = await run(scope, 'update_entry', { id: target.id, title: '唯一修改' })
    assert.equal(out.status, 'error')
    assert.equal(out.blockedCode, 'target_untrusted')
    assert.equal(out.needsInput, true)
    assert.equal(h.entries()[0].title, '唯一目标')
  })
})

describe('失败重试写入保护', () => {
  it('重试账本识别上一轮创建/修改尝试，并禁止再次自动写入', async () => {
    const steps: AssistantToolStep[] = [
      {
        callId: 'c1',
        tool: 'create_entry',
        label: '新建',
        status: 'ok',
        message: 'ok',
        effect: { op: 'create', kind: 'note', entryId: 'n1', title: '已创建' },
      },
      {
        callId: 'u1',
        tool: 'update_entry',
        label: '修改',
        status: 'error',
        message: '错误：结果不确定',
      },
    ]
    const attempts: WriteAttempt[] = [
      { callId: 'c1', tool: 'create_entry', signature: 'create_entry:{}' },
      { callId: 'u1', tool: 'update_entry', signature: 'update_entry:{}' },
    ]
    const ledger = buildRetryLedger({
      requestId: 'req-failed',
      assistantMessageId: 'msg-1',
      userContent: '创建并修改',
      steps,
      attempts,
      now: BASE_TIME,
    })
    assert.equal(ledger.blockedCreateUpdate, true)
    assert.deepEqual(
      ledger.writes.map((write) => [write.tool, write.status]),
      [
        ['create_entry', 'ok'],
        ['update_entry', 'error'],
      ],
    )
    const note = retrySystemNote(ledger)
    assert.match(note, /新建成功 1 项/)
    assert.match(note, /修改成功 0 项/)
    assert.match(note, /禁止自动再次新建或修改/)
    assert.deepEqual(
      Array.from(retryBlockedWriteTools(ledger) ?? []).sort(),
      ['create_entry', 'update_entry'],
    )
    assert.equal(retrySystemNote(null), '')

    const next = buildRetryLedger({
      requestId: 'req-retry',
      assistantMessageId: 'msg-2',
      userContent: '创建并修改',
      steps: [],
      attempts: [],
    })
    const merged = mergeRetryLedger(ledger, next)
    assert.equal(merged.blockedCreateUpdate, true)
    assert.equal(merged.writes.length, 2)
  })

  it('重试作用域拒绝创建/修改，但仍允许查询和生成删除确认卡片', async () => {
    const target = await seed(h, makeBase('note', { title: '重试目标' }))
    const scope = h.scope('req-retry', {
      permission: 'write',
      trustedTargets: [{ id: target.id, source: 'user_explicit' }],
      blockedWriteTools: ['create_entry', 'update_entry'],
    })
    const created = await run(scope, 'create_entry', { kind: 'note', title: '重复创建' })
    const updated = await run(scope, 'update_entry', { id: target.id, title: '重复修改' })
    assert.equal(created.status, 'error')
    assert.equal(created.blockedCode, 'retry_duplicate_risk')
    assert.equal(created.needsInput, true)
    assert.equal(updated.status, 'error')
    assert.equal(updated.blockedCode, 'retry_duplicate_risk')
    assert.equal(h.entries().length, 1)
    assert.equal(h.entries()[0].title, '重试目标')

    const searched = await run(scope, 'search_notes', { query: '重试' })
    assert.equal(searched.status, 'ok')
    const deleted = await run(scope, 'delete_entry', { id: target.id })
    assert.equal(deleted.status, 'confirm')
    assert.ok(deleted.confirmAction)
  })
})

describe('删除提议目标绑定', () => {
  it('确认卡片传入的目标与提议不一致时作废，不执行删除', async () => {
    resetDeleteProposals()
    const target = await seed(h, makeBase('note', { title: '删除目标' }))
    const other = await seed(h, makeBase('note', { title: '另一个目标' }))
    const scope = untrustedScope()
    scope.trustedTargets.set(target.id, {
      id: target.id,
      source: 'user_explicit',
      kind: 'note',
      title: '删除目标',
      trustedAt: BASE_TIME,
    })
    const out = await run(scope, 'delete_entry', { id: target.id })
    assert.equal(out.status, 'confirm')
    const proposalId = out.confirmAction?.proposalId
    const moves: string[] = []
    const result = await executeDeleteConfirm({
      proposalId,
      targetId: other.id,
      expectedKind: 'note',
      moves,
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'target_mismatch')
    assert.deepEqual(moves, [])
    assert.equal(h.entries().length, 2)
    assert.equal(getDeleteProposal(proposalId ?? '')?.status, 'invalid')
  })
})

async function executeDeleteConfirm(input: {
  proposalId: string | undefined
  targetId: string
  expectedKind: 'note'
  moves: string[]
}) {
  const { confirmDeleteProposal } = await import('../src/services/deleteExecution')
  return confirmDeleteProposal({
    proposalId: input.proposalId,
    targetId: input.targetId,
    expectedKind: input.expectedKind,
    now: h.now(),
    access: {
      findEntry: (id) => h.entries().find((entry) => entry.id === id),
      moveToTrash: async (id) => {
        input.moves.push(id)
        await h.repo.moveToTrash(id)
        await h.refresh()
      },
      stillExists: (id) => h.entries().some((entry) => entry.id === id),
    },
  })
}
