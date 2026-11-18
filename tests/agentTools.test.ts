import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import dayjs from 'dayjs'
import { executeToolWithEnv } from '../src/services/agentToolExecutor'
import type { AgentToolEnvironment, ToolOutcome } from '../src/services/agentToolExecutor'
import {
  cancelDeleteProposal,
  confirmDeleteProposal,
  type DeleteConfirmationAccess,
} from '../src/services/deleteExecution'
import { getDeleteProposal, resetDeleteProposals } from '../src/services/deleteProposals'
import { createAgentToolScope } from '../src/services/agentToolExecutor'
import {
  BASE_TIME,
  alarm,
  call,
  createHarness,
  makeBase,
  makeReminder,
  nextId,
  seed,
  type TestHarness,
} from './helpers'

const fmt = (ms: number): string => dayjs(ms).format('YYYY-MM-DDTHH:mm')

let h!: TestHarness
beforeEach(async () => {
  h = await createHarness()
})

function run(name: string, args: unknown, id = nextId('call'), scope = h.scope()): Promise<ToolOutcome> {
  return executeToolWithEnv(call(id, name, args), h.env, scope)
}

function confirm(input: Omit<Parameters<typeof confirmDeleteProposal>[0], 'now'>) {
  return confirmDeleteProposal({ ...input, now: h.now() })
}

function deleteAccess(harness: TestHarness, moves: string[] = []): DeleteConfirmationAccess {
  return {
    findEntry: (id: string) => harness.entries().find((entry) => entry.id === id),
    moveToTrash: async (id: string) => {
      moves.push(id)
      await harness.repo.moveToTrash(id)
      await harness.refresh()
    },
    stillExists: (id: string) => harness.entries().some((entry) => entry.id === id),
  }
}

describe('create_entry：直接执行并回读真实结果', () => {
  it('新建备忘直接生效，不生成确认卡片', async () => {
    const out = await run('create_entry', { kind: 'note', title: '会议记录', content: '**要点**' })
    assert.equal(out.status, 'ok')
    assert.equal(out.confirmAction, undefined)
    const entry = h.entries()[0]
    assert.equal(entry.kind, 'note')
    assert.equal(entry.title, '会议记录')
    assert.equal(entry.content, '**要点**')
    assert.ok(out.result.includes(entry.id), '结果里必须带真实 id')
  })

  it('新建待办带子任务', async () => {
    const out = await run('create_entry', { kind: 'todo', title: '购物', items: ['牛奶', '面包'] })
    assert.equal(out.status, 'ok')
    const entry = h.entries()[0]
    assert.equal(entry.kind, 'todo')
    if (entry.kind !== 'todo') return
    assert.deepEqual(
      entry.items.map((item) => [item.text, item.done]),
      [
        ['牛奶', false],
        ['面包', false],
      ],
    )
  })

  it('新建提醒写入未来的单次闹钟', async () => {
    const at = BASE_TIME + 3600_000
    const out = await run('create_entry', { kind: 'reminder', title: '喝水', remindAt: fmt(at) })
    assert.equal(out.status, 'ok')
    const entry = h.entries()[0]
    assert.equal(entry.kind, 'reminder')
    if (entry.kind !== 'reminder') return
    assert.equal(entry.alarms.length, 1)
    assert.equal(entry.alarms[0].mode, 'once')
    assert.equal(entry.alarms[0].notified, false)
    assert.equal(entry.alarms[0].remindAt, at)
    assert.ok(out.result.includes('提醒时间'))
  })

  it('提醒时间无效或已过期时拒绝创建', async () => {
    const missing = await run('create_entry', { kind: 'reminder', title: '旧提醒' })
    assert.equal(missing.status, 'error')
    assert.match(missing.result, /remindAt/)
    const past = await run(
      'create_entry',
      { kind: 'reminder', title: '过去', remindAt: fmt(BASE_TIME - 3600_000) },
      'call-2',
    )
    assert.equal(past.status, 'error')
    assert.match(past.result, /晚于当前时间/)
    assert.equal(h.entries().length, 0)
  })

  it('受保护字段（id）会整条拒绝，不做静默忽略', async () => {
    const out = await run('create_entry', { kind: 'note', title: 'x', id: 'hacked' })
    assert.equal(out.status, 'error')
    assert.match(out.result, /不支持的参数：id/)
    assert.equal(h.entries().length, 0)
  })

  it('标题超长直接报错，不静默截断', async () => {
    const out = await run('create_entry', { kind: 'note', title: 'a'.repeat(121) })
    assert.equal(out.status, 'error')
    assert.match(out.result, /120/)
    assert.equal(h.entries().length, 0)
  })

  it('同一 tool_call_id 不会重复执行', async () => {
    const args = { kind: 'note', title: '唯一' }
    const scope = h.scope()
    const first = await run('create_entry', args, 'dup-id', scope)
    const second = await run('create_entry', args, 'dup-id', scope)
    assert.equal(first.status, 'ok')
    assert.equal(second.status, 'duplicate')
    assert.equal(h.entries().length, 1)
  })

  it('同参数不同 id 的重试也不会重复新增（请求内签名去重）', async () => {
    const args = { kind: 'note', title: '唯一' }
    const scope = h.scope()
    await run('create_entry', args, 'call-a', scope)
    const second = await run('create_entry', args, 'call-b', scope)
    assert.equal(second.status, 'duplicate')
    assert.equal(h.entries().length, 1)
  })

  it('新的用户请求拥有新的去重作用域（去重仅限单次请求）', async () => {
    const args = { kind: 'note', title: '同名' }
    await run('create_entry', args, 'a', h.scope('req-1'))
    const second = await run('create_entry', args, 'b', h.scope('req-2'))
    assert.equal(second.status, 'ok')
    assert.equal(h.entries().length, 2)
  })

  it('仓储没有真正写入时如实报错', async () => {
    const broken: AgentToolEnvironment = {
      ...h.env,
      addEntry: async () => null,
    }
    const out = await executeToolWithEnv(
      call('c', 'create_entry', { kind: 'note', title: 'x' }),
      broken,
      h.scope(),
    )
    assert.equal(out.status, 'error')
    assert.equal(h.entries().length, 0)
  })
})

describe('update_entry：直接执行、校验真实生效并保留提醒规则', () => {
  it('修改标题并追加正文', async () => {
    const created = await run('create_entry', { kind: 'note', title: '旧标题', content: '原文' })
    assert.equal(created.status, 'ok')
    const target = h.entries()[0]
    const out = await run(
      'update_entry',
      { id: target.id, title: '新标题', append_content: '补充' },
      'u1',
    )
    assert.equal(out.status, 'ok')
    assert.equal(out.confirmAction, undefined)
    const updated = h.entries()[0]
    assert.equal(updated.title, '新标题')
    assert.equal(updated.content, '原文\n\n补充')
  })

  it('找不到目标时报错且不写入', async () => {
    const out = await run('update_entry', { id: 'nope', title: 'x' })
    assert.equal(out.status, 'error')
    assert.match(out.result, /找不到/)
  })

  it('拒绝受保护字段与未支持字段', async () => {
    const seeded = await seed(h, makeBase('note'))
    const out = await run('update_entry', { id: seeded.id, createdAt: 1, title: 'x' })
    assert.equal(out.status, 'error')
    assert.match(out.result, /不支持的参数：createdAt/)
    assert.equal(h.entries()[0].title, '标题')
  })

  it('content 与 append_content 同时出现时拒绝', async () => {
    const seeded = await seed(h, makeBase('note'))
    const out = await run('update_entry', { id: seeded.id, content: 'a', append_content: 'b' })
    assert.equal(out.status, 'error')
    assert.match(out.result, /不能同时提供/)
  })

  it('空修改（没有任何字段）会被拒绝', async () => {
    const seeded = await seed(h, makeBase('note'))
    const out = await run('update_entry', { id: seeded.id })
    assert.equal(out.status, 'error')
    assert.match(out.result, /没有提供任何有效修改字段/)
  })

  it('待办：勾选与新增子任务，完成态由仓储派生', async () => {
    await run('create_entry', { kind: 'todo', title: '清单', items: ['a', 'b'] })
    const todo = h.entries()[0]
    const out = await run('update_entry', { id: todo.id, complete_items: ['a'], add_items: ['c'] }, 'u2')
    assert.equal(out.status, 'ok')
    const updated = h.entries()[0]
    if (updated.kind !== 'todo') throw new Error('kind changed')
    assert.deepEqual(
      updated.items.map((item) => [item.text, item.done]),
      [
        ['a', true],
        ['b', false],
        ['c', false],
      ],
    )
    assert.equal(updated.done, false)
  })

  it('勾选不存在的子任务会明确报错', async () => {
    await run('create_entry', { kind: 'todo', title: '清单', items: ['a'] })
    const todo = h.entries()[0]
    const out = await run('update_entry', { id: todo.id, complete_items: ['不存在'] }, 'u3')
    assert.equal(out.status, 'error')
    assert.match(out.result, /不存在这些子任务/)
    const unchanged = h.entries()[0]
    if (unchanged.kind !== 'todo') throw new Error('kind changed')
    assert.equal(unchanged.items[0].done, false)
  })

  it('新增重复子任务会明确报错', async () => {
    await run('create_entry', { kind: 'todo', title: '清单', items: ['a'] })
    const todo = h.entries()[0]
    const out = await run('update_entry', { id: todo.id, add_items: ['a'] }, 'u4')
    assert.equal(out.status, 'error')
    assert.match(out.result, /已存在/)
  })

  it('对备忘设置 remind_at 会报错', async () => {
    const seeded = await seed(h, makeBase('note'))
    const out = await run('update_entry', {
      id: seeded.id,
      remind_at: fmt(BASE_TIME + 3600_000),
    })
    assert.equal(out.status, 'error')
    assert.match(out.result, /仅适用于提醒/)
  })

  it('标签可增可减，移除不存在的标签会报错', async () => {
    const seeded = await seed(h, makeBase('note', { tags: ['旧'] }))
    const ok = await run('update_entry', { id: seeded.id, add_tags: ['新'], remove_tags: ['旧'] }, 't1')
    assert.equal(ok.status, 'ok')
    assert.deepEqual(h.entries()[0].tags, ['新'])
    const bad = await run('update_entry', { id: seeded.id, remove_tags: ['不存在'] }, 't2')
    assert.equal(bad.status, 'error')
    assert.match(bad.result, /标签不存在/)
  })

  it('涂鸦条目不允许 AI 修改', async () => {
    const seeded = await seed(h, makeBase('draw'))
    const out = await run('update_entry', { id: seeded.id, title: 'x' })
    assert.equal(out.status, 'error')
    assert.match(out.result, /涂鸦/)
  })

  const modes = ['once', 'loop', 'daily', 'weekly', 'monthly', 'yearly', 'lunar', 'workday'] as const
  for (const mode of modes) {
    it(`修改提醒时间保留 ${mode} 重复规则`, async () => {
      const old = BASE_TIME + 86400_000
      const seeded = await seed(
        h,
        makeReminder({
          alarms: [alarm('a1', old, mode, { method: 'notification', intervalMs: 7_200_000 })],
        }),
      )
      const next = BASE_TIME + 7200_000
      const out = await run('update_entry', { id: seeded.id, remind_at: fmt(next) }, `m-${mode}`)
      assert.equal(out.status, 'ok')
      const updated = h.entries()[0]
      if (updated.kind !== 'reminder') throw new Error('kind changed')
      assert.equal(updated.alarms.length, 1)
      assert.equal(updated.alarms[0].id, 'a1')
      assert.equal(updated.alarms[0].mode, mode)
      assert.equal(updated.alarms[0].method, 'notification')
      assert.equal(updated.alarms[0].intervalMs, 7_200_000)
      assert.equal(updated.alarms[0].remindAt, next)
      assert.ok(out.result.includes('重复规则'), '结果应说明保留了重复规则')
    })
  }

  it('多个待触发闹钟且未指定 alarm_id 时拒绝执行并生成选择卡片', async () => {
    const seeded = await seed(
      h,
      makeReminder({
        alarms: [alarm('a1', BASE_TIME + 3600_000, 'daily'), alarm('a2', BASE_TIME + 7200_000, 'weekly')],
      }),
    )
    const out = await run('update_entry', { id: seeded.id, remind_at: fmt(BASE_TIME + 10800_000) })
    assert.equal(out.status, 'error')
    assert.equal(out.needsInput, true)
    assert.match(out.result, /选择卡片/)
    assert.equal(out.alarmSelection?.candidates.length, 2)
    const unchanged = h.entries()[0]
    if (unchanged.kind !== 'reminder') throw new Error('kind changed')
    assert.equal(unchanged.alarms[0].remindAt, BASE_TIME + 3600_000)
    assert.equal(unchanged.alarms[1].remindAt, BASE_TIME + 7200_000)
  })

  it('模型指定 alarm_id 但没有用户选择授权时仍拒绝写入', async () => {
    const seeded = await seed(
      h,
      makeReminder({
        alarms: [alarm('a1', BASE_TIME + 3600_000, 'daily'), alarm('a2', BASE_TIME + 7200_000, 'weekly')],
      }),
    )
    const out = await run(
      'update_entry',
      { id: seeded.id, remind_at: fmt(BASE_TIME + 10800_000), alarm_id: 'a2' },
      'alarm-target',
    )
    assert.equal(out.status, 'error')
    assert.equal(out.needsInput, true)
    assert.ok(out.alarmSelection)
    const unchanged = h.entries()[0]
    if (unchanged.kind !== 'reminder') throw new Error('kind changed')
    assert.deepEqual(
      unchanged.alarms.map((item) => [item.id, item.mode, item.remindAt]),
      [
        ['a1', 'daily', BASE_TIME + 3600_000],
        ['a2', 'weekly', BASE_TIME + 7200_000],
      ],
    )
  })

  it('alarm_id 不存在时报错', async () => {
    const seeded = await seed(h, makeReminder({ alarms: [alarm('a1', BASE_TIME + 3600_000)] }))
    const out = await run('update_entry', {
      id: seeded.id,
      remind_at: fmt(BASE_TIME + 7200_000),
      alarm_id: 'missing',
    })
    assert.equal(out.status, 'error')
    assert.match(out.result, /找不到 alarm_id/)
  })

  it('alarm_id 不与 remind_at 一起使用时拒绝', async () => {
    const seeded = await seed(h, makeReminder({ alarms: [alarm('a1', BASE_TIME + 3600_000)] }))
    const out = await run('update_entry', { id: seeded.id, alarm_id: 'a1' })
    assert.equal(out.status, 'error')
    assert.match(out.result, /alarm_id 必须与 remind_at/)
  })

  it('修改提醒时间会清除已处理状态', async () => {
    const seeded = await seed(
      h,
      makeReminder({ alarms: [alarm('a1', BASE_TIME + 3600_000)], done: true }),
    )
    const out = await run('update_entry', {
      id: seeded.id,
      remind_at: fmt(BASE_TIME + 7200_000),
    })
    assert.equal(out.status, 'ok')
    const updated = h.entries()[0]
    if (updated.kind !== 'reminder') throw new Error('kind changed')
    assert.equal(updated.done, false)
  })

  it('仓储未按 patch 生效时如实报错（不虚构成功）', async () => {
    const seeded = await seed(h, makeBase('note', { title: '原样' }))
    const ignoring: AgentToolEnvironment = {
      ...h.env,
      updateEntry: async () => {
        /* 模拟仓储吞掉更新 */
      },
    }
    const out = await executeToolWithEnv(
      call('u', 'update_entry', { id: seeded.id, title: '新标题' }),
      ignoring,
      h.scope(),
    )
    assert.equal(out.status, 'error')
    assert.match(out.result, /修改未能确认/)
  })

  it('同一请求内相同 update 参数不会重复写入', async () => {
    const seeded = await seed(h, makeBase('note'))
    const scope = h.scope()
    const args = { id: seeded.id, title: '新' }
    const first = await run('update_entry', args, 'x1', scope)
    const second = await run('update_entry', args, 'x2', scope)
    assert.equal(first.status, 'ok')
    assert.equal(second.status, 'duplicate')
  })
})

describe('delete_entry：只生成确认卡片，确认后才软删除', () => {
  it('调用删除只产生提议，便签保持不动', async () => {
    const seeded = await seed(h, makeBase('note', { title: '待删' }))
    const scope = h.scope('exec-delete-link', {
      trustedTargets: [{ id: seeded.id, kind: 'note', title: '待删' }],
    })
    const out = await run('delete_entry', { id: seeded.id }, 'call-delete-link', scope)
    assert.equal(out.status, 'confirm')
    assert.ok(out.confirmAction)
    assert.equal(out.confirmAction?.op, 'delete')
    assert.equal(out.confirmAction?.targetId, seeded.id)
    assert.equal(out.confirmAction?.kind, 'note')
    assert.ok(out.confirmAction?.proposalId)
    assert.equal(out.confirmAction?.executionId, 'exec-delete-link')
    assert.equal(out.confirmAction?.stepId, 'exec-delete-link:call-delete-link')
    assert.ok((out.confirmAction?.expiresAt ?? 0) > h.now())
    assert.equal(h.entries().length, 1, '确认前不得删除')
    const proposal = getDeleteProposal(out.confirmAction?.proposalId ?? '')
    assert.equal(proposal?.status, 'pending')
  })

  it('同参数重复删除请求不会生成第二张卡片', async () => {
    const seeded = await seed(h, makeBase('note'))
    const scope = h.scope()
    const first = await run('delete_entry', { id: seeded.id }, 'd1', scope)
    const second = await run('delete_entry', { id: seeded.id }, 'd2', scope)
    assert.equal(first.status, 'confirm')
    assert.equal(second.status, 'duplicate')
    assert.equal(second.confirmAction, undefined)
  })

  it('删除不存在的 id 不会生成提议', async () => {
    const out = await run('delete_entry', { id: 'ghost' })
    assert.equal(out.status, 'error')
    assert.equal(out.confirmAction, undefined)
  })

  it('取消后不删除，且提议不能再执行', async () => {
    const seeded = await seed(h, makeBase('note'))
    const out = await run('delete_entry', { id: seeded.id })
    const proposalId = out.confirmAction?.proposalId
    cancelDeleteProposal(proposalId)
    const result = await confirm({
      proposalId,
      targetId: seeded.id,
      expectedKind: 'note',
      access: deleteAccess(h),
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'cancelled')
    assert.equal(h.entries().length, 1)
  })

  it('确认后移入废纸篓，重复确认不会重复删除', async () => {
    const seeded = await seed(h, makeBase('todo'))
    const out = await run('delete_entry', { id: seeded.id })
    const proposalId = out.confirmAction?.proposalId
    const moves: string[] = []
    const first = await confirm({
      proposalId,
      targetId: seeded.id,
      expectedKind: 'todo',
      access: deleteAccess(h, moves),
    })
    assert.equal(first.ok, true)
    assert.equal(h.entries().length, 0, '列表中不再出现')
    const trash = await h.repo.listTrash()
    assert.ok(trash.some((entry) => entry.id === seeded.id), '应可在废纸篓恢复')
    const second = await confirm({
      proposalId,
      targetId: seeded.id,
      expectedKind: 'todo',
      access: deleteAccess(h, moves),
    })
    assert.equal(second.ok, false)
    if (!second.ok) assert.equal(second.reason, 'done')
    assert.deepEqual(moves, [seeded.id], '只允许一次 moveToTrash')
  })

  it('并发点击只有一次能拿到执行权', async () => {
    const seeded = await seed(h, makeBase('note'))
    const out = await run('delete_entry', { id: seeded.id })
    const proposalId = out.confirmAction?.proposalId
    const moves: string[] = []
    const access = deleteAccess(h, moves)
    const [a, b] = await Promise.all([
      confirm({ proposalId, targetId: seeded.id, expectedKind: 'note', access }),
      confirm({ proposalId, targetId: seeded.id, expectedKind: 'note', access }),
    ])
    const okCount = [a, b].filter((item) => item.ok).length
    assert.equal(okCount, 1)
    assert.equal(moves.length, 1)
  })

  it('确认时目标已不存在则作废提议', async () => {
    const seeded = await seed(h, makeBase('note'))
    const out = await run('delete_entry', { id: seeded.id })
    const proposalId = out.confirmAction?.proposalId
    const access = deleteAccess(h)
    access.findEntry = () => undefined
    const result = await confirm({
      proposalId,
      targetId: seeded.id,
      expectedKind: 'note',
      access,
    })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.reason, 'missing')
      assert.match(result.message, /已不存在/)
    }
    assert.equal(h.entries().length, 1, '未调用 moveToTrash')
  })

  it('确认时类型变化则拒绝删除', async () => {
    const seeded = await seed(h, makeBase('note'))
    const out = await run('delete_entry', { id: seeded.id })
    const proposalId = out.confirmAction?.proposalId
    const moves: string[] = []
    const access = deleteAccess(h, moves)
    access.findEntry = () => ({ kind: 'todo' })
    const result = await confirm({
      proposalId,
      targetId: seeded.id,
      expectedKind: 'note',
      access,
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'kind_changed')
    assert.equal(moves.length, 0)
    assert.equal(h.entries().length, 1)
  })

  it('用户停止时不展示删除卡片，提议作废', async () => {
    const seeded = await seed(h, makeBase('note'))
    let stale = false
    let listCalls = 0
    h.onList = () => {
      listCalls += 1
      // 执行器读取目标快照后模拟用户停止；deleteEntry 会复查并作废提议
      if (listCalls >= 1) stale = true
    }
    const scope = createAgentToolScope('req-stop', () => stale, undefined, {
      permission: 'write',
      trustedTargets: [{ id: seeded.id }],
    })
    const out = await executeToolWithEnv(call('d', 'delete_entry', { id: seeded.id }), h.env, scope)
    assert.equal(out.status, 'cancelled')
    assert.equal(out.confirmAction, undefined)
  })

  it('请求已停止时不执行任何写入', async () => {
    const scope = createAgentToolScope('req-stopped', () => true, undefined, {
      permission: 'write',
    })
    const out = await executeToolWithEnv(
      call('c', 'create_entry', { kind: 'note', title: '不该出现' }),
      h.env,
      scope,
    )
    assert.equal(out.status, 'cancelled')
    assert.equal(h.entries().length, 0)
  })

  it('已提交的写入不会被谎报为取消，后续工具才停止', async () => {
    let stale = false
    h.onAdd = () => {
      stale = true
    }
    const scope = createAgentToolScope('req-mid-stop', () => stale, undefined, {
      permission: 'write',
    })
    const out = await executeToolWithEnv(
      call('c', 'create_entry', { kind: 'note', title: '已写入' }),
      h.env,
      scope,
    )
    assert.equal(out.status, 'ok')
    assert.equal(h.entries().length, 1)
    const next = await executeToolWithEnv(
      call('c2', 'create_entry', { kind: 'note', title: '未执行' }),
      h.env,
      scope,
    )
    assert.equal(next.status, 'cancelled')
    assert.equal(h.entries().length, 1)
  })
})

describe('查询类工具直接执行', () => {
  it('search_notes 返回真实便签 id', async () => {
    const seeded = await seed(h, makeBase('note', { title: '菜谱：番茄炒蛋', content: '鸡蛋两个' }))
    const out = await run('search_notes', { query: '番茄' })
    assert.equal(out.status, 'ok')
    assert.ok(out.result.includes(seeded.id))
    assert.match(out.result, /找到 1 条/)
  })

  it('list_todos 只列未完成待办', async () => {
    await run('create_entry', { kind: 'todo', title: '未完成', items: ['a'] })
    const out = await run('list_todos', {})
    assert.equal(out.status, 'ok')
    assert.match(out.result, /未完成待办 1 条/)
  })

  it('get_note 返回闹钟 alarm_id，供修改时间指定目标', async () => {
    const seeded = await seed(
      h,
      makeReminder({ alarms: [alarm('alarm-x', BASE_TIME + 3600_000, 'daily')] }),
    )
    const out = await run('get_note', { id: seeded.id })
    assert.equal(out.status, 'ok')
    assert.match(out.result, /alarm_id: alarm-x/)
    assert.match(out.result, /每天/)
  })

  it('查询工具拒绝未支持参数', async () => {
    const out = await run('list_todos', { limit: 5 })
    assert.equal(out.status, 'error')
    assert.match(out.result, /不支持的参数/)
  })
})

describe('提议注册表清理', () => {
  it('清空会话后历史删除卡片失效', async () => {
    const seeded = await seed(h, makeBase('note'))
    const out = await run('delete_entry', { id: seeded.id })
    const proposalId = out.confirmAction?.proposalId
    resetDeleteProposals()
    const result = await confirm({
      proposalId,
      targetId: seeded.id,
      expectedKind: 'note',
      access: deleteAccess(h),
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'not_found')
    assert.equal(h.entries().length, 1)
  })
})
