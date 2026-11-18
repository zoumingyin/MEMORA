import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import dayjs from 'dayjs'
import {
  createAgentToolScope,
  executeAuthorizedAlarmUpdate,
  executeToolWithEnv,
} from '../src/services/agentToolExecutor'
import { confirmAlarmSelection } from '../src/services/alarmSelectionExecution'
import {
  ALARM_SELECTION_TTL_MS,
  cancelAlarmSelection,
  cancelPendingAlarmSelections,
  getAlarmSelection,
  resetAlarmSelections,
  type AlarmSelectionPatch,
} from '../src/services/alarmSelections'
import type { Entry, ReminderEntry } from '../src/types/entry'
import {
  BASE_TIME,
  alarm,
  call,
  createHarness,
  makeReminder,
  seed,
  type TestHarness,
} from './helpers'

const fmt = (ms: number): string => dayjs(ms).format('YYYY-MM-DDTHH:mm')
const NEXT = BASE_TIME + 10800_000

let h!: TestHarness
beforeEach(async () => {
  h = await createHarness()
  resetAlarmSelections()
})

async function seedTwoAlarms() {
  return seed(
    h,
    makeReminder({
      title: '喝水提醒',
      alarms: [
        alarm('a1', BASE_TIME + 3600_000, 'daily'),
        alarm('a2', BASE_TIME + 7200_000, 'weekly'),
      ],
    }),
  )
}

async function selectionFor(extra: Record<string, unknown> = {}) {
  const seeded = h.entries()[0]
  if (seeded.kind !== 'reminder') throw new Error('not reminder')
  const scope = createAgentToolScope('req-phase32', () => false, 'msg-1', {
    permission: 'write',
    trustedTargets: [{ id: seeded.id }],
  })
  const outcome = await executeToolWithEnv(
    call('u1', 'update_entry', {
      id: seeded.id,
      remind_at: fmt(NEXT),
      ...extra,
    }),
    h.env,
    scope,
  )
  assert.equal(outcome.needsInput, true)
  assert.ok(outcome.alarmSelection, '应生成候选选择卡片')
  return { seeded, selection: outcome.alarmSelection }
}

async function requestSelection(extra: Record<string, unknown> = {}) {
  await seedTwoAlarms()
  return selectionFor(extra)
}

function alarmsOf(): [string, number, string, string][] {
  const entry = h.entries()[0]
  if (entry.kind !== 'reminder') throw new Error('kind changed')
  return entry.alarms.map((item) => [item.id, item.remindAt, item.mode, item.method])
}

function pick(selection: { proposalId: string; entryId: string }, alarmId: string) {
  return confirmAlarmSelection({
    proposalId: selection.proposalId,
    entryId: selection.entryId,
    alarmId,
    env: h.env,
    now: h.now(),
  })
}

describe('提醒目标选择授权', () => {
  it('单闹钟修改直接执行，不需要选择', async () => {
    const seeded = await seed(
      h,
      makeReminder({ alarms: [alarm('only', BASE_TIME + 3600_000, 'daily')] }),
    )
    const out = await executeToolWithEnv(
      call('u', 'update_entry', { id: seeded.id, remind_at: fmt(NEXT) }),
      h.env,
      h.scope(),
    )
    assert.equal(out.status, 'ok')
    assert.equal(out.alarmSelection, undefined)
    const entry = h.entries()[0]
    if (entry.kind !== 'reminder') throw new Error('kind changed')
    assert.equal(entry.alarms[0].remindAt, NEXT)
    assert.equal(entry.alarms[0].mode, 'daily')
  })

  it('多闹钟未选择：不写库，返回结构化候选并标记等待补充', async () => {
    const { seeded, selection } = await requestSelection()
    const entry = h.entries()[0]
    assert.equal(entry.id, seeded.id)
    assert.equal(entry.kind, 'reminder')
    assert.deepEqual(alarmsOf(), [
      ['a1', BASE_TIME + 3600_000, 'daily', 'dialog'],
      ['a2', BASE_TIME + 7200_000, 'weekly', 'dialog'],
    ])
    assert.deepEqual(
      selection.candidates.map((candidate) => [
        candidate.alarmId,
        candidate.mode,
        candidate.remindAt,
        candidate.method,
      ]),
      [
        ['a1', 'daily', BASE_TIME + 3600_000, 'dialog'],
        ['a2', 'weekly', BASE_TIME + 7200_000, 'dialog'],
      ],
    )
    assert.ok(selection.entryId)
    assert.equal(selection.title, '喝水提醒')
    assert.equal(selection.remindAt, NEXT)
  })

  it('模型提供真实 alarm_id 但无用户授权：仍然拒绝，不写入', async () => {
    const { selection } = await requestSelection({ alarm_id: 'a2' })
    assert.deepEqual(alarmsOf(), [
      ['a1', BASE_TIME + 3600_000, 'daily', 'dialog'],
      ['a2', BASE_TIME + 7200_000, 'weekly', 'dialog'],
    ])
    assert.ok(selection.proposalId)
  })

  it('用户选择 daily：只改 daily，weekly 与重复规则完整保留', async () => {
    const { selection } = await requestSelection()
    const result = await pick(selection, 'a1')
    assert.equal(result.ok, true)
    assert.deepEqual(alarmsOf(), [
      ['a1', NEXT, 'daily', 'dialog'],
      ['a2', BASE_TIME + 7200_000, 'weekly', 'dialog'],
    ])
  })

  it('用户选择 weekly：只改 weekly，daily 保留', async () => {
    const { selection } = await requestSelection()
    const result = await pick(selection, 'a2')
    assert.equal(result.ok, true)
    assert.deepEqual(alarmsOf(), [
      ['a1', BASE_TIME + 3600_000, 'daily', 'dialog'],
      ['a2', NEXT, 'weekly', 'dialog'],
    ])
  })

  it('取消选择：不修改任何数据，之后也不能再执行', async () => {
    const { selection } = await requestSelection()
    cancelAlarmSelection(selection.proposalId)
    const result = await pick(selection, 'a1')
    assert.equal(result.ok, false)
    assert.deepEqual(alarmsOf(), [
      ['a1', BASE_TIME + 3600_000, 'daily', 'dialog'],
      ['a2', BASE_TIME + 7200_000, 'weekly', 'dialog'],
    ])
  })

  it('停止请求后授权失效', async () => {
    const { selection } = await requestSelection()
    cancelPendingAlarmSelections()
    const result = await pick(selection, 'a1')
    assert.equal(result.ok, false)
    assert.equal(getAlarmSelection(selection.proposalId)?.status, 'cancelled')
    assert.deepEqual(alarmsOf(), [
      ['a1', BASE_TIME + 3600_000, 'daily', 'dialog'],
      ['a2', BASE_TIME + 7200_000, 'weekly', 'dialog'],
    ])
  })

  it('开始新任务后旧授权不能复用', async () => {
    const { selection } = await requestSelection()
    cancelPendingAlarmSelections()
    const result = await pick(selection, 'a2')
    assert.equal(result.ok, false)
    assert.equal(getAlarmSelection(selection.proposalId)?.status, 'cancelled')
  })

  it('目标提醒删除后授权失效', async () => {
    const { selection, seeded } = await requestSelection()
    await h.repo.moveToTrash(seeded.id)
    await h.refresh()
    const result = await pick(selection, 'a1')
    assert.equal(result.ok, false)
    assert.equal(h.entries().length, 0)
  })

  it('闹钟被其它操作修改后授权失效', async () => {
    const { selection } = await requestSelection()
    const entry = h.entries()[0]
    if (entry.kind !== 'reminder') throw new Error('kind changed')
    await h.env.updateEntry(entry.id, {
      alarms: entry.alarms.map((item) =>
        item.id === 'a1' ? { ...item, remindAt: item.remindAt + 60_000 } : item,
      ),
    })
    const changedAt = h.entries()[0]
    if (changedAt.kind !== 'reminder') throw new Error('kind changed')
    const before = changedAt.alarms.map((item) => item.remindAt)
    const result = await pick(selection, 'a1')
    assert.equal(result.ok, false)
    assert.deepEqual(
      h.entries()[0].kind === 'reminder'
        ? (h.entries()[0] as { alarms: { remindAt: number }[] }).alarms.map(
            (item) => item.remindAt,
          )
        : [],
      before,
    )
  })

  it('同一授权不能重复执行', async () => {
    const { selection } = await requestSelection()
    const first = await pick(selection, 'a1')
    assert.equal(first.ok, true)
    const second = await pick(selection, 'a1')
    assert.equal(second.ok, false)
    assert.deepEqual(alarmsOf(), [
      ['a1', NEXT, 'daily', 'dialog'],
      ['a2', BASE_TIME + 7200_000, 'weekly', 'dialog'],
    ])
  })

  it('选中闹钟的时间已过期时拒绝写入', async () => {
    const { selection } = await requestSelection()
    h.setNow(NEXT + 60_000)
    const result = await pick(selection, 'a1')
    assert.equal(result.ok, false)
    assert.deepEqual(alarmsOf(), [
      ['a1', BASE_TIME + 3600_000, 'daily', 'dialog'],
      ['a2', BASE_TIME + 7200_000, 'weekly', 'dialog'],
    ])
  })

  it('授权目标与候选不匹配时拒绝', async () => {
    const { selection } = await requestSelection()
    const wrongAlarm = await pick(selection, 'a-not-exist')
    assert.equal(wrongAlarm.ok, false)
    const wrongEntry = await confirmAlarmSelection({
      proposalId: selection.proposalId,
      entryId: 'other-entry',
      alarmId: 'a1',
      env: h.env,
      now: h.now(),
    })
    assert.equal(wrongEntry.ok, false)
    assert.deepEqual(alarmsOf(), [
      ['a1', BASE_TIME + 3600_000, 'daily', 'dialog'],
      ['a2', BASE_TIME + 7200_000, 'weekly', 'dialog'],
    ])
  })
})

describe('授权字段范围', () => {
  function reminder(): ReminderEntry {
    const entry = h.entries()[0]
    if (entry.kind !== 'reminder') throw new Error('kind changed')
    return entry
  }

  it('只请求时间：卡片不展示额外字段，执行后标题/正文/标签保持原样', async () => {
    await seedTwoAlarms()
    const seeded = h.entries()[0]
    await h.env.updateEntry(seeded.id, { content: '原有正文', tags: ['健康'] })
    const { selection } = await selectionFor()
    assert.equal(selection.changes, undefined)
    assert.deepEqual(getAlarmSelection(selection.proposalId)?.allowedFields, ['remindAt'])

    const result = await pick(selection, 'a1')
    assert.equal(result.ok, true)
    const stored = reminder()
    assert.equal(stored.title, '喝水提醒')
    assert.equal(stored.content, '原有正文')
    assert.deepEqual(stored.tags, ['健康'])
    assert.equal(stored.alarms[0].remindAt, NEXT)
  })

  it('显式给出标题+时间：卡片逐项展示，点击后两项都生效', async () => {
    const { selection } = await requestSelection({ title: '喝水提醒（新）' })
    assert.deepEqual(
      selection.changes?.map((change) => change.field),
      ['title'],
    )
    assert.match(selection.changes?.[0].label ?? '', /喝水提醒（新）/)
    assert.deepEqual(getAlarmSelection(selection.proposalId)?.allowedFields, [
      'remindAt',
      'title',
    ])

    const result = await pick(selection, 'a2')
    assert.equal(result.ok, true)
    const stored = reminder()
    assert.equal(stored.title, '喝水提醒（新）')
    assert.equal(stored.alarms[1].remindAt, NEXT)
    assert.equal(stored.alarms[0].remindAt, BASE_TIME + 3600_000)
  })

  it('授权执行时不接受白名单之外的字段，直接拒绝且不写入', async () => {
    const seeded = await seedTwoAlarms()
    const out = await executeAuthorizedAlarmUpdate({
      entryId: seeded.id,
      alarmId: 'a1',
      patch: { remindAt: NEXT, title: '偷偷改标题' },
      allowedFields: ['remindAt'],
      env: h.env,
    })
    assert.equal(out.status, 'error')
    assert.match(out.result, /授权范围不包括：标题/)
    assert.equal(reminder().title, '喝水提醒')
    assert.deepEqual(alarmsOf(), [
      ['a1', BASE_TIME + 3600_000, 'daily', 'dialog'],
      ['a2', BASE_TIME + 7200_000, 'weekly', 'dialog'],
    ])
  })

  it('授权执行时缺少提醒时间字段直接拒绝', async () => {
    const seeded = await seedTwoAlarms()
    const out = await executeAuthorizedAlarmUpdate({
      entryId: seeded.id,
      alarmId: 'a1',
      patch: { title: '只改标题' } as unknown as AlarmSelectionPatch,
      allowedFields: ['remindAt'],
      env: h.env,
    })
    assert.equal(out.status, 'error')
    assert.equal(reminder().title, '喝水提醒')
  })
})

describe('授权有效期与一次性', () => {
  it('超过 TTL 后不能执行，状态标记为 expired', async () => {
    const { selection } = await requestSelection()
    h.setNow(BASE_TIME + ALARM_SELECTION_TTL_MS + 1)
    const result = await pick(selection, 'a1')
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'expired')
    assert.equal(getAlarmSelection(selection.proposalId)?.status, 'expired')
    assert.deepEqual(alarmsOf(), [
      ['a1', BASE_TIME + 3600_000, 'daily', 'dialog'],
      ['a2', BASE_TIME + 7200_000, 'weekly', 'dialog'],
    ])
  })

  it('并发重复点击只有一次成功，另一次返回 busy', async () => {
    const { selection } = await requestSelection()
    const [first, second] = await Promise.all([
      pick(selection, 'a1'),
      pick(selection, 'a1'),
    ])
    const results = [first, second]
    assert.equal(results.filter((item) => item.ok).length, 1)
    const rejected = results.find((item) => !item.ok)
    assert.equal(rejected && 'reason' in rejected ? rejected.reason : '', 'busy')
    assert.deepEqual(alarmsOf(), [
      ['a1', NEXT, 'daily', 'dialog'],
      ['a2', BASE_TIME + 7200_000, 'weekly', 'dialog'],
    ])
  })

  it('执行异常后授权立即消费，不能再次点击重试', async () => {
    const { selection } = await requestSelection()
    const failingEnv = {
      ...h.env,
      updateEntry: async () => {
        throw new Error('write failed')
      },
    }
    const first = await confirmAlarmSelection({
      proposalId: selection.proposalId,
      entryId: selection.entryId,
      alarmId: 'a1',
      env: failingEnv,
      now: h.now(),
    })
    assert.equal(first.ok, false)
    assert.equal(getAlarmSelection(selection.proposalId)?.status, 'invalid')

    const second = await pick(selection, 'a1')
    assert.equal(second.ok, false)
    assert.notEqual(second.ok, true)
    assert.deepEqual(alarmsOf(), [
      ['a1', BASE_TIME + 3600_000, 'daily', 'dialog'],
      ['a2', BASE_TIME + 7200_000, 'weekly', 'dialog'],
    ])
  })

  it('写入后回读不一致时标记失效，不允许再次点击', async () => {
    const { selection } = await requestSelection()
    const tamperingEnv = {
      ...h.env,
      updateEntry: async (id: string, patch: Partial<Entry>) => {
        const alarms =
          patch && 'alarms' in patch && Array.isArray(patch.alarms)
            ? patch.alarms.map((item) => ({ ...item, remindAt: item.remindAt + 1 }))
            : []
        await h.repo.update(id, { ...patch, alarms } as never)
        await h.refresh()
      },
    }
    const first = await confirmAlarmSelection({
      proposalId: selection.proposalId,
      entryId: selection.entryId,
      alarmId: 'a1',
      env: tamperingEnv,
      now: h.now(),
    })
    assert.equal(first.ok, false)
    assert.equal(first.ok ? '' : first.reason, 'failed')
    assert.equal(getAlarmSelection(selection.proposalId)?.status, 'invalid')

    const second = await pick(selection, 'a1')
    assert.equal(second.ok, false)
    assert.equal(getAlarmSelection(selection.proposalId)?.status, 'invalid')
  })
})

describe('授权快照失效', () => {
  async function expectChanged(mutate: (entry: ReminderEntry) => Promise<void>) {
    const { selection } = await requestSelection()
    const before = reminderAlarmsSnapshot()
    await mutate(h.entries()[0] as ReminderEntry)
    const result = await pick(selection, 'a1')
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.reason, 'changed')
    assert.deepEqual(reminderAlarmsSnapshot(), before)
  }

  function reminderAlarmsSnapshot() {
    return alarmsOf()
  }

  it('正文变化使授权失效', async () => {
    await expectChanged(async (entry) => {
      await h.env.updateEntry(entry.id, { content: '被其它操作填写了正文' })
    })
  })

  it('标签变化使授权失效', async () => {
    await expectChanged(async (entry) => {
      await h.env.updateEntry(entry.id, { tags: ['新标签'] })
    })
  })

  it('标题变化使授权失效', async () => {
    await expectChanged(async (entry) => {
      await h.env.updateEntry(entry.id, { title: '别的标题' })
    })
  })

  it('已处理状态变化使授权失效', async () => {
    await expectChanged(async (entry) => {
      await h.env.updateEntry(entry.id, { done: true })
    })
  })

  it('闹钟触发状态变化使授权失效', async () => {
    await expectChanged(async (entry) => {
      await h.env.updateEntry(entry.id, {
        alarms: entry.alarms.map((item) => ({ ...item, notified: true })),
      })
    })
  })
})
