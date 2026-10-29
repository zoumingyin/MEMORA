const pad = (n: number): string => String(n).padStart(2, '0')

/** 格式化为 MM-DD HH:mm（短时间戳，列表内展示） */
export function formatShort(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 格式化为 datetime-local 输入框可用的本地时间字符串 */
export function toInputValue(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 闹钟时间归整：秒数归零只保留小时和分钟，确保整时整分触发、不受秒数偏差影响 */
export function toMinuteStart(ms: number): number {
  const d = new Date(ms)
  d.setSeconds(0, 0)
  return d.getTime()
}

/** 相对时间描述：剩余 / 已过多久 */
export function formatRelative(ms: number): string {
  const diff = ms - Date.now()
  const abs = Math.abs(diff)
  const minutes = Math.floor(abs / 60_000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  let text: string
  if (days >= 1) text = `${days} 天`
  else if (hours >= 1) text = `${hours} 小时`
  else if (minutes >= 1) text = `${minutes} 分钟`
  else text = '片刻'

  return diff > 0 ? `${text}后提醒` : `已过 ${text}`
}
