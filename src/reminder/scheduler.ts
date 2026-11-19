import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { emitTo, listen } from '@tauri-apps/api/event'
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'
import { useEntryStore } from '../store/useEntryStore'
import { isTauriRuntime } from '../repository'
import {
  REMINDER_CONFIRM_EVENT,
  REMINDER_CONFIRM_RESULT_EVENT,
  REMINDER_SNOOZE_EVENT,
  REMINDER_SNOOZE_RESULT_EVENT,
  type ReminderActionResult,
  type ReminderActionRequest,
  type ReminderSnoozeRequest,
} from './events'
import type { AlarmItem, ReminderEntry } from '../types/entry'

/** 轮询间隔：Worker 心跳为 500ms；Worker 创建失败时退化为页面 setInterval（1s） */
const POLL_INTERVAL_MS = 1_000
/** 触达失败后的重试冷却：避免每秒重试同一闹钟，也不把失败当已处理 */
const FAILURE_COOLDOWN_MS = 60_000

/**
 * 创建调度心跳：优先用 Web Worker 定时器驱动——主窗口隐藏 / 被遮挡（如收纳到屏幕边缘）时
 * 页面定时器会被 WebView 节流到分钟级，Worker 定时器不受页面可见性节流，保证准时触发。
 * 返回停止函数。Worker 不可用（如极端环境）时退化为页面 setInterval。
 */
function createTicker(onTick: () => void): () => void {
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
/** 触达失败后的下次重试时间（会话内），失败不写已处理 */
const retryAfter = new Map<string, number>()
/** 系统通知权限只主动申请一次，被拒绝后记录失败并冷却重试 */
let notificationPermissionAsked = false

function dialogKey(entryId: string, alarmId: string): string {
  return `${entryId}:${alarmId}`
}

/** Tauri 环境：为到期闹钟创建居中、置顶、无边框的独立窗口 */
async function openReminderDialog(entry: ReminderEntry, alarm: AlarmItem): Promise<boolean> {
  const label = `reminder-${entry.id}-${alarm.id}`
  const key = dialogKey(entry.id, alarm.id)
  if (openDialogIds.has(key)) return true
  try {
    const existing = await WebviewWindow.getByLabel(label)
    if (existing) {
      openDialogIds.add(key)
      return true
    }

    const params = new URLSearchParams({
      alarm: '1',
      id: entry.id,
      alarmId: alarm.id,
      t: entry.title,
      c: entry.content,
      time: String(alarm.remindAt),
      mode: alarm.mode,
      method: alarm.method,
    })

    const win = new WebviewWindow(label, {
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
    // 用户直接关闭弹窗而没确认时解除登记：下一次扫描重新呈现，提醒不丢
    win.once('tauri://destroyed', () => {
      openDialogIds.delete(key)
    })
    openDialogIds.add(key)
    return true
  } catch (error) {
    console.error('创建提醒弹窗失败', error)
    openDialogIds.delete(key)
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

/** 发送系统通知：先检查权限；失败抛错，由调用方记录失败而不是标记已处理 */
async function notifySystem(title: string, body: string): Promise<void> {
  if (!(await isPermissionGranted())) {
    if (notificationPermissionAsked) throw new Error('系统通知权限未授予')
    notificationPermissionAsked = true
    const permission = await requestPermission()
    if (permission !== 'granted') throw new Error('系统通知权限未授予')
  }
  sendNotification({ title, body: body || title })
}

/**
 * 启动到期提醒调度。返回清理函数用于停止轮询与事件订阅。
 *
 * 可靠性语义：
 * - 系统通知 / 弹窗呈现成功后才写「已处理」（重复模式在同一事务内推进到下一次）；
 * - 触达失败记录 lastDeliveryStatus= failed 并保留待提醒状态，冷却后重试；
 * - 同一时刻最多只有一个置顶提醒弹窗，避免多个弹窗叠在屏幕中央；
 * - 主窗口隐藏 / 最小化不停止调度；休眠恢复后按当前时间补触发；
 * - 不承诺 exactly-once，只保证不静默丢弃、失败可追踪、状态可恢复。
 */
export function startReminderScheduler(): () => void {
  let scanning = false
  const scan = async (): Promise<void> => {
    if (scanning) return
    scanning = true
    try {
      let dialogOpen = openDialogIds.size > 0
      const state = useEntryStore.getState()
      const now = Date.now()
      for (const entry of state.entries) {
        if (entry.kind !== 'reminder' || entry.done) continue
        for (const alarm of entry.alarms) {
          const key = dialogKey(entry.id, alarm.id)
          // 稍后提醒会把闹钟推到未来：旧弹窗登记必须解除，否则到点后会被误判为「弹窗仍开着」
          if (alarm.remindAt > now && openDialogIds.has(key)) {
            openDialogIds.delete(key)
          }
          if (alarm.notified || alarm.remindAt > now) continue
          if (openDialogIds.has(key)) continue
          const retryAt = retryAfter.get(key) ?? 0
          if (retryAt > now) continue

          if (alarm.method === 'notification') {
            try {
              if (isTauriRuntime()) {
                await notifySystem(entry.title, entry.content)
              } else {
                fallbackNotify(entry.title, entry.content)
              }
              // 通知已发出：原子确认本次到期（重复模式推进到下一次）
              await state.confirmAlarm(entry.id, alarm.id)
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error)
              retryAfter.set(key, now + FAILURE_COOLDOWN_MS)
              await state.recordAlarmFailure(entry.id, alarm.id, message)
            }
            continue
          }

          // 弹窗方式：同一时刻最多一个置顶弹窗，其余到期项由汇总入口统一查看
          if (dialogOpen) continue
          if (isTauriRuntime()) {
            await state.presentAlarm(entry.id, alarm.id)
            const opened = await openReminderDialog(entry, alarm)
            if (!opened) {
              retryAfter.set(key, now + FAILURE_COOLDOWN_MS)
              await state.recordAlarmFailure(
                entry.id,
                alarm.id,
                '无法创建提醒弹窗',
              )
              fallbackNotify(entry.title, entry.content)
            } else {
              dialogOpen = true
            }
          } else {
            fallbackNotify(entry.title, entry.content)
            try {
              await state.confirmAlarm(entry.id, alarm.id)
            } catch (error) {
              retryAfter.set(key, now + FAILURE_COOLDOWN_MS)
              await state.recordAlarmFailure(
                entry.id,
                alarm.id,
                error instanceof Error ? error.message : String(error),
              )
            }
          }
        }
      }
    } finally {
      scanning = false
    }
  }

  void scan()
  const stopTicker = createTicker(() => void scan())

  const detachFns: Array<() => void> = []

  if (isTauriRuntime()) {
    // 弹窗确认：主窗口写库成功后才回执，弹窗据此关闭；失败保留弹窗并提示
    const confirmPromise = listen<ReminderActionRequest>(
      REMINDER_CONFIRM_EVENT,
      async (event) => {
        const { requestId, entryId, alarmId, windowLabel } = event.payload
        const key = dialogKey(entryId, alarmId)
        try {
          await useEntryStore.getState().confirmAlarm(entryId, alarmId)
          openDialogIds.delete(key)
          const result: ReminderActionResult = { requestId, ok: true }
          await emitTo(windowLabel, REMINDER_CONFIRM_RESULT_EVENT, result).catch(
            () => undefined,
          )
        } catch (error) {
          const result: ReminderActionResult = {
            requestId,
            ok: false,
            message: error instanceof Error ? error.message : '确认提醒失败',
          }
          await emitTo(windowLabel, REMINDER_CONFIRM_RESULT_EVENT, result).catch(
            () => undefined,
          )
        }
      },
    )
    detachFns.push(() => void confirmPromise.then((detach) => detach()))

    const snoozePromise = listen<ReminderSnoozeRequest>(
      REMINDER_SNOOZE_EVENT,
      async (event) => {
        const { requestId, entryId, alarmId, remindAt, windowLabel } =
          event.payload
        const key = dialogKey(entryId, alarmId)
        try {
          await useEntryStore.getState().snoozeAlarm(entryId, alarmId, remindAt)
          openDialogIds.delete(key)
          const result: ReminderActionResult = { requestId, ok: true }
          await emitTo(windowLabel, REMINDER_SNOOZE_RESULT_EVENT, result).catch(
            () => undefined,
          )
        } catch (error) {
          const result: ReminderActionResult = {
            requestId,
            ok: false,
            message: error instanceof Error ? error.message : '稍后提醒失败',
          }
          await emitTo(windowLabel, REMINDER_SNOOZE_RESULT_EVENT, result).catch(
            () => undefined,
          )
        }
      },
    )
    detachFns.push(() => void snoozePromise.then((detach) => detach()))
  }

  return () => {
    stopTicker()
    for (const detach of detachFns) detach()
  }
}
