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

/** 按年月构造时刻，日超月末 clamp 到最后一天，时刻部分保留 base 的时/分/秒 */
function clampDay(base: Date, year: number, month: number, day: number): Date {
  const lastDay = new Date(year, month + 1, 0).getDate()
  return new Date(
    year,
    month,
    Math.min(day, lastDay),
    base.getHours(),
    base.getMinutes(),
    base.getSeconds(),
    base.getMilliseconds(),
  )
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
      // 锚定用户设定日（anchorDay）：短月临时 clamp 到月末，下月恢复原日不滑落
      // （1 月 31 日 → 2 月 28 日 → 3 月 31 日，而非滑落成 3 月 28 日）
      const day = alarm.anchorDay ?? base.getDate()
      return clampDay(base, base.getFullYear(), base.getMonth() + 1, day).getTime()
    }
    case 'yearly': {
      // 锚定原始日；不能用 setFullYear（2/29 会被 JS 自动 roll 到 3 月 1 日再错设成 3/28）
      const day = alarm.anchorDay ?? base.getDate()
      const month = base.getMonth()
      return clampDay(base, base.getFullYear() + 1, month, day).getTime()
    }
    case 'lunar': {
      const lunar = Lunar.fromDate(base)
      const nextYear = lunar.getYear() + 1
      const month = lunar.getMonth() // 负数 = 闰月
      const day = lunar.getDay()
      // 次年可能没有对应闰月（闰月不逐年固定），或该农历月无三十日：
      // 依次回退尝试 闰月→平月、三十→廿九（如 闰六月初十 → 次年六月初十）
      const months = month < 0 ? [month, -month] : [month]
      const days = day >= 30 ? [day, day - 1] : [day]
      for (const m of months) {
        for (const d of days) {
          try {
            const nextLunar = Lunar.fromYmd(nextYear, m, d)
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
          } catch {
            // 该农历组合次年不存在，尝试下一候选
          }
        }
      }
      // 兜底：次年平月与廿九必存在，理论上不会走到；真走到则按阳历一年后
      return clampDay(base, base.getFullYear() + 1, base.getMonth(), base.getDate()).getTime()
    }
    default:
      return base.getTime()
  }
}

/** 稳定的单次到期标识：同一闹钟同一提醒时间视为同一 occurrence */
export function occurrenceKey(alarm: AlarmItem): string {
  return `${alarm.id}:${alarm.remindAt}`
}
