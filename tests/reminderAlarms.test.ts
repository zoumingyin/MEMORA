import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ALARM_MODE_LABEL,
  applyReminderTime,
  describeAlarm,
} from '../src/services/reminderAlarms'
import type { AlarmMode } from '../src/types/entry'
import { BASE_TIME, alarm } from './helpers'

const NEXT = BASE_TIME + 7200_000

describe('applyReminderTime', () => {
  it('单个待触发闹钟：只改时间，保留模式、方式与循环间隔', () => {
    const alarms = [alarm('a1', BASE_TIME + 3600_000, 'daily', { method: 'sound', intervalMs: 3_600_000 })]
    const result = applyReminderTime(alarms, undefined, NEXT, BASE_TIME)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.alarms.length, 1)
    assert.equal(result.alarms[0].id, 'a1')
    assert.equal(result.alarms[0].mode, 'daily')
    assert.equal(result.alarms[0].method, 'sound')
    assert.equal(result.alarms[0].intervalMs, 3_600_000)
    assert.equal(result.alarms[0].remindAt, NEXT)
    assert.equal(result.target.notified, false)
    assert.equal(result.modeLabel, '每天')
  })

  it('多个待触发闹钟且未指定 alarm_id 时拒绝并列出候选', () => {
    const alarms = [
      alarm('a1', BASE_TIME + 3600_000, 'daily'),
      alarm('a2', BASE_TIME + 7200_000, 'weekly'),
    ]
    const result = applyReminderTime(alarms, undefined, NEXT, BASE_TIME)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.error, /alarm_id=a1/)
    assert.match(result.error, /alarm_id=a2/)
    assert.match(result.error, /询问用户/)
  })

  it('指定 alarm_id 时只修改对应闹钟', () => {
    const alarms = [
      alarm('a1', BASE_TIME + 3600_000, 'daily'),
      alarm('a2', BASE_TIME + 7200_000, 'monthly', { method: 'notification' }),
    ]
    const result = applyReminderTime(alarms, 'a2', NEXT, BASE_TIME)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.alarms[0], alarms[0], '其它闹钟保持原对象不变')
    assert.equal(result.alarms[1].remindAt, NEXT)
    assert.equal(result.alarms[1].mode, 'monthly')
    assert.equal(result.alarms[1].method, 'notification')
  })

  it('全部闹钟都已通知时退化为全部闹钟作为候选', () => {
    const alarms = [alarm('a1', BASE_TIME - 1000, 'once', { notified: true })]
    const result = applyReminderTime(alarms, undefined, NEXT, BASE_TIME)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.target.notified, false)
  })

  it('alarm_id 不存在时拒绝', () => {
    const result = applyReminderTime([alarm('a1', BASE_TIME + 1000)], 'ghost', NEXT, BASE_TIME)
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, /找不到 alarm_id/)
  })

  it('指定已触发闹钟且仍有待触发候选时拒绝，不能绕过候选选择', () => {
    const alarms = [
      alarm('a1', BASE_TIME - 1000, 'daily', { notified: true }),
      alarm('a2', BASE_TIME + 3600_000, 'weekly'),
    ]
    const result = applyReminderTime(alarms, 'a1', NEXT, BASE_TIME)
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.code, 'invalid_alarm')
      assert.match(result.error, /已触发/)
      assert.match(result.error, /重新选择/)
    }
  })

  it('没有闹钟时拒绝', () => {
    const result = applyReminderTime([], undefined, NEXT, BASE_TIME)
    assert.equal(result.ok, false)
  })

  it('时间不在未来时拒绝', () => {
    const result = applyReminderTime([alarm('a1', BASE_TIME + 1000)], undefined, BASE_TIME, BASE_TIME)
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, /晚于当前时间/)
  })
})

describe('闹钟模式文案', () => {
  it('覆盖所有重复模式', () => {
    const modes: AlarmMode[] = [
      'once',
      'loop',
      'daily',
      'weekly',
      'monthly',
      'yearly',
      'lunar',
      'workday',
    ]
    for (const mode of modes) {
      assert.ok(ALARM_MODE_LABEL[mode].length > 0)
      assert.ok(describeAlarm(alarm('a', BASE_TIME, mode)).startsWith(ALARM_MODE_LABEL[mode]))
    }
  })
})
