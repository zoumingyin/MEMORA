import dayjs from 'dayjs'
import type { AlarmItem, AlarmMethod, AlarmMode } from '../types/entry'

/**
 * 提醒闹钟时间修改规则：
 * - 只改被选中的那个闹钟的 remindAt，保留它的 mode / method / 循环间隔；
 * - 其它闹钟原样保留，不整体覆盖 alarms；
 * - 存在多个候选闹钟且模型没有指定 alarm_id 时拒绝执行，要求先询问用户；
 * - 修改后重置该闹钟的已通知状态（未来时间需要重新触发）。
 */

export const ALARM_MODE_LABEL: Record<AlarmMode, string> = {
  once: '单次',
  loop: '循环',
  daily: '每天',
  weekly: '每周',
  monthly: '每月',
  yearly: '每年',
  lunar: '每年农历',
  workday: '工作日',
}

export const ALARM_METHOD_LABEL: Record<AlarmMethod, string> = {
  dialog: '弹窗提醒',
  notification: '系统通知',
  sound: '弹窗+提示音',
}

export function describeAlarm(alarm: AlarmItem): string {
  return `${ALARM_MODE_LABEL[alarm.mode] ?? alarm.mode} · ${dayjs(alarm.remindAt).format('YYYY-MM-DD HH:mm')}`
}

export type ApplyReminderTimeResult =
  | {
      ok: true
      alarms: AlarmItem[]
      target: AlarmItem
      /** 修改后的模式描述，供回传给模型的真实结果使用 */
      modeLabel: string
    }
  | {
      ok: false
      /** ambiguous_alarm：多个候选且未指定目标，需要用户补充信息 */
      code: 'ambiguous_alarm' | 'invalid_alarm' | 'no_alarm' | 'past_time'
      error: string
    }

/**
 * 修改提醒条目下指定闹钟的时间。
 * 候选规则：优先未通知的闹钟；全部已通知时退化为全部闹钟。
 */
export function applyReminderTime(
  alarms: AlarmItem[],
  alarmId: string | undefined,
  remindAt: number,
  now: number,
): ApplyReminderTimeResult {
  if (alarms.length === 0) {
    return { ok: false, code: 'no_alarm', error: '该提醒没有任何闹钟，无法修改提醒时间' }
  }

  const pending = alarms.filter((alarm) => !alarm.notified)
  const candidates = pending.length > 0 ? pending : alarms

  let target: AlarmItem | undefined
  if (alarmId) {
    target = alarms.find((alarm) => alarm.id === alarmId)
    if (!target) {
      return {
        ok: false,
        code: 'invalid_alarm',
        error: `找不到 alarm_id 为 ${alarmId} 的闹钟，请先读取该提醒的闹钟列表`,
      }
    }
    // 模型传入的 alarm_id 只能指向当前候选；不能用它改已触发闹钟来绕过候选选择
    if (!candidates.some((alarm) => alarm.id === alarmId)) {
      return {
        ok: false,
        code: 'invalid_alarm',
        error: `alarm_id 为 ${alarmId} 的闹钟已触发，不是当前可修改候选，请让用户重新选择`,
      }
    }
  } else if (candidates.length === 1) {
    target = candidates[0]
  } else {
    const list = candidates
      .map((alarm) => `alarm_id=${alarm.id}（${describeAlarm(alarm)}）`)
      .join('；')
    return {
      ok: false,
      code: 'ambiguous_alarm',
      error: `该提醒有 ${candidates.length} 个闹钟：${list}。请先询问用户要修改哪一个，再用 alarm_id 指定，不要自行选择`,
    }
  }

  if (remindAt <= now) {
    return { ok: false, code: 'past_time', error: '提醒时间必须晚于当前时间' }
  }

  const nextTarget: AlarmItem = { ...target, remindAt, notified: false }
  return {
    ok: true,
    alarms: alarms.map((alarm) => (alarm.id === target.id ? nextTarget : alarm)),
    target: nextTarget,
    modeLabel: ALARM_MODE_LABEL[target.mode] ?? target.mode,
  }
}
