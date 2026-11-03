import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
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
/** 轮询间隔：Worker 心跳为 500ms；Worker 创建失败时退化为页面 setInterval（1s） */
const POLL_INTERVAL_MS = 1_000

/**
 * 创建调度心跳：优先用 Web Worker 定时器驱动——主窗口隐藏 / 被遮挡（如收纳到屏幕边缘）时
 * 页面定时器会被 WebView 节流到分钟级，Worker 定时器不受页面可见性节流，保证准时触发。
 * 返回停止函数。Worker 不可用（如极端环境）时退化为页面 setInterval。
 */
function createTicker(onTick: () => void): () => void {
  // 页面兜底定时器：常驻 1s 扫描一次。窗口隐藏时它会被 WebView 节流到分钟级，
  // 准时触发由 Worker 心跳（500ms、不受页面可见性节流）承担，此处仅作失效兜底
  const fallback = window.setInterval(onTick, POLL_INTERVAL_MS)
  let worker: Worker | null = null
  try {
    worker = new Worker(new URL("./tickWorker.ts", import.meta.url), {
      type: "module",
    })
    worker.onmessage = onTick
    worker.onerror = (error) => {
      console.error("调度心跳 Worker 异常", error)
    }
  } catch (error) {
    console.error("创建调度心跳 Worker 失败，仅使用页面定时器兜底", error)
  }
  return () => {
    window.clearInterval(fallback)
    worker?.terminate()
  }
}

/** 已弹出提醒弹窗的闹钟 key（`条目id:闹钟id`），避免同一闹钟在确认关闭前重复开窗 */
const openDialogIds = new Set<string>()

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

/** Tauri 环境：为到期闹钟创建居中、置顶、无边框的独立窗口（交互参考图片预览弹窗：自定义标题栏 + 暗亮主题） */
async function openReminderDialog(entry: ReminderEntry, alarm: AlarmItem): Promise<boolean> {
  const label = `reminder-${entry.id}-${alarm.id}`
  try {
    const existing = await WebviewWindow.getByLabel(label)
    if (existing) return true

    const isDark = document.documentElement.classList.contains('dark-glass')
    const params = new URLSearchParams({
      alarm: '1',
      id: entry.id,
      alarmId: alarm.id,
      t: entry.title,
      c: entry.content,
      time: String(alarm.remindAt),
      mode: alarm.mode,
      method: alarm.method,
      dark: isDark ? '1' : '0',
    })

    new WebviewWindow(label, {
      // 独立轻量入口（alarm.html）：只打包闹钟卡片所需代码；
      // visible:false 隐藏创建，首帧渲染完成后再 show，消除加载延迟
      url: `alarm.html?${params.toString()}`,
      width: 400,
      height: 480,
      minWidth: 340,
      minHeight: 400,
      center: true,
      decorations: false,
      transparent: true,
      // 透明窗口不要再叠加系统投影：会在卡片周围透出一圈灰色轮廓
      shadow: false,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      focus: true,
      visible: false,
      title: '闹钟提醒',
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
  // 防重入：1s 高频轮询下避免上一次扫描（含 await 开窗）未完成时重入导致重复处理
  let scanning = false
  const scan = async (): Promise<void> => {
    if (scanning) return
    scanning = true
    try {
      const state = useEntryStore.getState()
      const now = Date.now()
      for (const entry of state.entries) {
        if (entry.kind !== 'reminder' || entry.done) continue
        for (const alarm of entry.alarms) {
          const key = `${entry.id}:${alarm.id}`
          // 稍后提醒会把闹钟推到未来：旧弹窗登记必须解除，否则到点后会被误判为「弹窗仍开着」
          if (alarm.remindAt > now && openDialogIds.has(key)) openDialogIds.delete(key)
          if (alarm.notified || alarm.remindAt > now) continue
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
    } finally {
      scanning = false
    }
  }

  void scan()
  const stopTicker = createTicker(() => void scan())

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

  // 稍后提醒：解除弹窗登记并把闹钟改到新时间（仓储已由弹窗写入，这里同步内存状态与派生字段）
  let detachSnoozed: () => void = () => undefined
  if (isTauriRuntime()) {
    const promise = listen<{ entryId: string; alarmId: string; remindAt: number }>(
      'reminder:snoozed',
      async (event) => {
        const { entryId, alarmId, remindAt } = event.payload
        openDialogIds.delete(`${entryId}:${alarmId}`)
        const state = useEntryStore.getState()
        const entry = state.entries.find((item) => item.id === entryId)
        if (entry?.kind !== 'reminder') return
        const alarms = entry.alarms.map((item) =>
          item.id === alarmId ? { ...item, remindAt, notified: false } : item,
        )
        await state.updateEntry(entryId, { kind: 'reminder', alarms })
      },
    )
    detachSnoozed = () => {
      void promise.then((detach) => detach())
    }
  }

  return () => {
    stopTicker()
    detachConfirmed()
    detachSnoozed()
  }
}
