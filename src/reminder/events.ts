/** 闹钟弹窗 → 主窗口：请求确认 / 稍后提醒，主窗口写库成功后回执 */
export const REMINDER_CONFIRM_EVENT = 'reminder:confirm-request'
export const REMINDER_CONFIRM_RESULT_EVENT = 'reminder:confirm-result'
export const REMINDER_SNOOZE_EVENT = 'reminder:snooze-request'
export const REMINDER_SNOOZE_RESULT_EVENT = 'reminder:snooze-result'

export interface ReminderActionRequest {
  requestId: string
  entryId: string
  alarmId: string
  /** 请求来源窗口 label，用于把结果发回对应弹窗 */
  windowLabel: string
}

export interface ReminderSnoozeRequest extends ReminderActionRequest {
  remindAt: number
}

export interface ReminderActionResult {
  requestId: string
  ok: boolean
  message?: string
}
