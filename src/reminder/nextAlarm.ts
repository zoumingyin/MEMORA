import { Lunar } from 'lunar-javascript'
import type { AlarmIntervalUnit, AlarmItem } from '../types/entry'

const INTERVAL_UNIT_MS: Record<AlarmIntervalUnit, number> = {
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
}

/** 循环提醒的间隔毫秒数：优先 intervalMs，旧数据按 interval + unit 换算 */
export function alarmLoopIntervalMs(alarm: AlarmItem): number {
  if (typeof alarm.intervalMs === 'number' && alarm.intervalMs > 0) {
    return alarm.intervalMs
  }
  const unit = alarm.intervalUnit ?? 'day'
  return Math.max(1, alarm.interval ?? 1) * INTERVAL_UNIT_MS[unit]
}

function addDays(date: Date, days: number): number {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next.getTime()
}

/** 重复模式的下一次触发时间（保持同一时刻）；once 返回原时间 */
export function nextAlarmAt(alarm: AlarmItem): number {
  const base = new Date(alarm.remindAt)
  switch (alarm.mode) {
    case 'workday': {
      const next = new Date(base)
      do {
        next.setDate(next.getDate() + 1)
      } while (next.getDay() === 0 || next.getDay() === 6)
      return next.getTime()
    }
    case 'daily':
      return addDays(base, 1)
    case 'weekly':
      return addDays(base, 7)
    case 'loop':
      return base.getTime() + alarmLoopIntervalMs(alarm)
    case 'monthly': {
      const day = base.getDate()
      const next = new Date(base)
      next.setDate(1)
      next.setMonth(next.getMonth() + 1)
      const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()
      next.setDate(Math.min(day, lastDay))
      return next.getTime()
    }
    case 'yearly': {
      const month = base.getMonth()
      const day = base.getDate()
      const next = new Date(base)
      next.setFullYear(next.getFullYear() + 1)
      const lastDay = new Date(next.getFullYear(), month + 1, 0).getDate()
      next.setDate(Math.min(day, lastDay))
      return next.getTime()
    }
    case 'lunar': {
      const lunar = Lunar.fromDate(base)
      const nextLunar = Lunar.fromYmd(lunar.getYear() + 1, lunar.getMonth(), lunar.getDay())
      const solar = nextLunar.getSolar()
      return new Date(
        solar.getYear(),
        solar.getMonth() - 1,
        solar.getDay(),
        base.getHours(),
        base.getMinutes(),
        base.getSeconds(),
        base.getMilliseconds(),
      ).getTime()
    }
    default:
      return base.getTime()
  }
}

/** 稳定的单次到期标识：同一闹钟同一提醒时间视为同一 occurrence */
export function occurrenceKey(alarm: AlarmItem): string {
  return `${alarm.id}:${alarm.remindAt}`
}
