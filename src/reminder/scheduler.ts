import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { currentMonitor } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import { sendNotification } from '@tauri-apps/plugin-notification'
import { Lunar } from 'lunar-javascript'
import { useEntryStore } from '../store/useEntryStore'
import { isTauriRuntime } from '../repository'
import type {
  AlarmIntervalUnit,
  AlarmItem,
  ReminderEntry,
} from '../types/entry'

/** 循环提醒间隔单位 → 毫秒换算 */
const INTERVAL_UNIT_MS: Record<AlarmIntervalUnit, number> = {
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
}

/**
 * 循环提醒的间隔毫秒数：优先 intervalMs（「X 时 Y 分」复合间隔），
 * 旧数据（interval + intervalUnit 单值）自动换算，缺省按 1 天。
 */
export function alarmLoopIntervalMs(alarm: AlarmItem): number {
  if (typeof alarm.intervalMs === 'number' && alarm.intervalMs > 0) {
    return alarm.intervalMs
  }
  const unit = alarm.intervalUnit ?? 'day'
  return Math.max(1, alarm.interval ?? 1) * INTERVAL_UNIT_MS[unit]
}

/** 到期扫描间隔：30 秒 */
const POLL_INTERVAL_MS = 30_000

/** 已弹出提醒弹窗的闹钟 key（`条目id:闹钟id`），避免同一闹钟在确认关闭前重复开窗 */
const openDialogIds = new Set<string>()

/** 取主显示器工作区尺寸：弹窗全屏遮罩需要铺满屏幕，排除任务栏高度 */
async function getWorkArea(): Promise<{ width: number; height: number }> {
  if (isTauriRuntime()) {
    try {
      const monitor = await currentMonitor()
      if (monitor?.workArea) {
        return { width: monitor.workArea.size.width, height: monitor.workArea.size.height }
      }
    } catch (error) {
      console.error('读取显示器工作区失败', error)
    }
  }
  return { width: 1280, height: 800 }
}

function addDays(date: Date, days: number): number {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next.getTime()
}

/**
 * 重复模式的下一次触发时间（保持同一时刻）：
 * - loop：每隔 interval（默认 1）天
 * - daily：+1 天；weekly：+7 天（保持星期几）
 * - monthly：+1 月，日号超出目标月天数时取当月最后一天（如 10-31 → 11-30）
 * - yearly：+1 年，闰日 2-29 在平年取 2-28
 * - lunar：每年农历同一月日 → 换算为次年对应公历
 * - workday：推到下一个工作日（周一至周五），仅兼容旧数据
 */
function nextAlarmAt(alarm: AlarmItem): number {
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
      // 从当前提醒时间取农历年月日，次年同一农历日换算回公历，保留时分秒
      const lunar = Lunar.fromDate(base)
      const nextLunar = Lunar.fromYmd(lunar.getYear() + 1, lunar.getMonth(), lunar.getDay())
      const solar = nextLunar.getSolar()
      const next = new Date(
        solar.getYear(),
        solar.getMonth() - 1,
        solar.getDay(),
        base.getHours(),
        base.getMinutes(),
        base.getSeconds(),
        base.getMilliseconds(),
      )
      return next.getTime()
    }
    default:
      return base.getTime()
  }
}

/** Tauri 环境：为到期闹钟创建屏幕居中、置顶、无边框的独立弹窗窗口 */
async function openReminderDialog(entry: ReminderEntry, alarm: AlarmItem): Promise<boolean> {
  const label = `reminder-${entry.id}-${alarm.id}`
  try {
    const existing = await WebviewWindow.getByLabel(label)
    if (existing) return true

    const area = await getWorkArea()
    const params = new URLSearchParams({
      reminder: '1',
      id: entry.id,
      alarm: alarm.id,
      t: entry.title,
      c: entry.content,
      time: String(alarm.remindAt),
      mode: alarm.mode,
      method: alarm.method,
    })

    new WebviewWindow(label, {
      url: `index.html?${params.toString()}`,
      width: Math.round(area.width),
      height: Math.round(area.height),
      center: true,
      decorations: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      focus: true,
      visible: true,
      title: '便签提醒',
    })
    openDialogIds.add(`${entry.id}:${alarm.id}`)
    return true
  } catch (error) {
    console.error('创建提醒弹窗失败', error)
    openDialogIds.delete(`${entry.id}:${alarm.id}`)
    return false
  }
}

/** 浏览器预览兜底：环境内无法创建独立窗口，退化为 Web Notification */
function fallbackNotify(title: string, body: string): void {
  if (
    typeof window !== 'undefined' &&
    'Notification' in window &&
    Notification.permission === 'granted'
  ) {
    new Notification(title, { body: body || title })
  }
}

/**
 * 启动到期提醒调度。返回清理函数用于停止轮询与事件订阅。
 * 每个提醒条目下可含多个闹钟；闹钟按 提醒方式 区分触达：
 *   dialog → 屏幕居中模态弹窗，确认后写库回传；
 *   notification → 系统通知 toast，直接标记已通知；
 *   sound → 弹窗内附带提示音（弹窗侧播放）。
 * 一次性闹钟确认后不再提醒；每天 / 每周 / 工作日闹钟确认后自动推进到下一次触发时间。
 */
export function startReminderScheduler(): () => void {
  const scan = async (): Promise<void> => {
    const state = useEntryStore.getState()
    const now = Date.now()
    for (const entry of state.entries) {
      if (entry.kind !== 'reminder' || entry.done) continue
      for (const alarm of entry.alarms) {
        if (alarm.notified || alarm.remindAt > now) continue
        const key = `${entry.id}:${alarm.id}`
        if (openDialogIds.has(key)) continue

        if (alarm.method === 'notification') {
          if (isTauriRuntime()) {
            try {
              sendNotification({ title: entry.title, body: entry.content || entry.title })
            } catch (error) {
              console.error('发送系统通知失败', error)
            }
          } else {
            fallbackNotify(entry.title, entry.content)
          }
          await state.markAlarmNotified(entry.id, alarm.id)
          continue
        }

        if (isTauriRuntime()) {
          const opened = await openReminderDialog(entry, alarm)
          // 开窗失败回退通知并标记已通知，避免轮询反复尝试同一个闹钟
          if (!opened) {
            fallbackNotify(entry.title, entry.content)
            await state.markAlarmNotified(entry.id, alarm.id)
          }
        } else {
          fallbackNotify(entry.title, entry.content)
          await state.markAlarmNotified(entry.id, alarm.id)
        }
      }
    }
  }

  void scan()
  const timer = setInterval(() => void scan(), POLL_INTERVAL_MS)

  // 弹窗确认后回传 { entryId, alarmId }；主窗口解除弹窗登记、标记已通知，重复模式推进到下一次
  let detachConfirmed: () => void = () => undefined
  if (isTauriRuntime()) {
    const promise = listen<{ entryId: string; alarmId: string }>('reminder:confirmed', async (event) => {
      const { entryId, alarmId } = event.payload
      openDialogIds.delete(`${entryId}:${alarmId}`)
      const state = useEntryStore.getState()
      await state.markAlarmNotified(entryId, alarmId)
      const entry = state.entries.find((item) => item.id === entryId)
      const alarm = entry?.kind === 'reminder' ? entry.alarms.find((item) => item.id === alarmId) : undefined
      if (entry?.kind === 'reminder' && alarm && alarm.mode !== 'once') {
        const alarms = entry.alarms.map((item) =>
          item.id === alarmId ? { ...item, remindAt: nextAlarmAt(item), notified: false } : item,
        )
        await state.updateEntry(entry.id, { kind: 'reminder', alarms })
      }
    })
    detachConfirmed = () => {
      void promise.then((detach) => detach())
    }
  }

  return () => {
    clearInterval(timer)
    detachConfirmed()
  }
}
