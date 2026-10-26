import { useEffect, useState } from 'react'
import { Button } from 'antd'
import { BellOutlined } from '@ant-design/icons'
import { emit } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { getRepository, isTauriRuntime } from '../repository'
import { useNow } from '../hooks/useNow'
import type { AlarmMethod, AlarmMode } from '../types/entry'

const MODE_LABEL: Record<AlarmMode, string> = {
  once: '',
  loop: '（循环）',
  daily: '（每天）',
  weekly: '（每周）',
  monthly: '（每月）',
  yearly: '（每年阳历）',
  lunar: '（每年农历）',
  workday: '（工作日）',
}

/** 从弹窗窗口 URL 参数读取提醒条目与具体闹钟 */
function readParams(): {
  id: string
  alarm: string
  title: string
  content: string
  time: number
  mode: AlarmMode
  method: AlarmMethod
} {
  const query = new URLSearchParams(location.search)
  const mode = query.get('mode') as AlarmMode | null
  const method = query.get('method') as AlarmMethod | null
  return {
    id: query.get('id') ?? '',
    alarm: query.get('alarm') ?? '',
    title: query.get('t') ?? '',
    content: query.get('c') ?? '',
    time: Number(query.get('time') ?? Date.now()),
    mode: ['loop', 'daily', 'weekly', 'monthly', 'yearly', 'lunar', 'workday'].includes(mode ?? '')
      ? (mode as AlarmMode)
      : 'once',
    method: method === 'notification' || method === 'sound' ? method : 'dialog',
  }
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 模拟表盘：时针 / 分针 / 秒针按当前时间旋转，秒针每秒走动 */
function AnalogClock({ now }: { now: number }) {
  const d = new Date(now)
  const hourAngle = (d.getHours() % 12 + d.getMinutes() / 60) * 30
  const minuteAngle = (d.getMinutes() + d.getSeconds() / 60) * 6
  const secondAngle = d.getSeconds() * 6
  const ticks = Array.from({ length: 12 }, (_, i) => i * 30)
  return (
    <svg viewBox="0 0 100 100" className="analog-clock" aria-hidden="true">
      <circle cx="50" cy="50" r="48" className="clock-face" />
      {ticks.map((angle) => (
        <line
          key={angle}
          x1="50"
          y1="6"
          x2="50"
          y2="11"
          transform={`rotate(${angle} 50 50)`}
          className="clock-tick"
        />
      ))}
      <line
        x1="50"
        y1="50"
        x2="50"
        y2="30"
        transform={`rotate(${hourAngle} 50 50)`}
        className="clock-hand hour"
      />
      <line
        x1="50"
        y1="50"
        x2="50"
        y2="19"
        transform={`rotate(${minuteAngle} 50 50)`}
        className="clock-hand minute"
      />
      <line
        x1="50"
        y1="56"
        x2="50"
        y2="15"
        transform={`rotate(${secondAngle} 50 50)`}
        className="clock-hand second"
      />
      <circle cx="50" cy="50" r="2.6" className="clock-center" />
    </svg>
  )
}

/** 声音提醒方式：弹窗内播放一段短促提示音 */
function playBeep(): void {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return
    const ctx = new Ctor()
    const play = (freq: number, start: number, duration: number): void => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + start)
      gain.gain.exponentialRampToValueAtTime(0.22, ctx.currentTime + start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + duration)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(ctx.currentTime + start)
      osc.stop(ctx.currentTime + start + duration)
    }
    play(880, 0, 0.18)
    play(1175, 0.24, 0.22)
    play(1568, 0.52, 0.3)
  } catch (error) {
    console.error('播放提示音失败', error)
  }
}

/**
 * 到期提醒模态弹窗：屏幕居中、置顶、全屏遮罩；表盘显示当前时间，点击「我知道了」或「进入便签」后标记已通知并关闭窗口。
 * Tauri 环境走独立弹窗窗口；浏览器预览环境不创建窗口，确认后仅隐藏遮罩便于样式回归。
 */
export function ReminderDialog() {
  const params = readParams()
  const [confirmed, setConfirmed] = useState(false)
  const now = useNow(1000)

  // 声音提醒方式：挂载时播放提示音
  useEffect(() => {
    if (params.method === 'sound') playBeep()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleConfirm = async (): Promise<void> => {
    if (confirmed) return
    setConfirmed(true)
    try {
      if (isTauriRuntime() && params.id) {
        await getRepository().markAlarmNotified(params.id, params.alarm)
        await emit('reminder:confirmed', { entryId: params.id, alarmId: params.alarm })
        await getCurrentWindow().close()
      }
    } catch (error) {
      console.error('确认提醒失败', error)
      setConfirmed(false)
    }
  }

  /** 进入便签：与确认一致写库标记已通知，额外通知主窗口跳转到对应条目并聚焦 */
  const handleEnter = async (): Promise<void> => {
    if (confirmed) return
    setConfirmed(true)
    try {
      if (isTauriRuntime() && params.id) {
        await getRepository().markAlarmNotified(params.id, params.alarm)
        await emit('reminder:open-note', { entryId: params.id, alarmId: params.alarm })
        await emit('reminder:confirmed', { entryId: params.id, alarmId: params.alarm })
        await getCurrentWindow().close()
      }
    } catch (error) {
      console.error('进入便签失败', error)
      setConfirmed(false)
    }
  }

  // 浏览器预览确认后直接隐藏遮罩；Tauri 环境关闭窗口后组件不再存活
  if (confirmed && !isTauriRuntime()) return null

  const at = new Date(params.time)
  const cd = new Date(now)

  return (
    <div className="reminder-overlay">
      <section className="reminder-card" role="alertdialog" aria-label="提醒">
        <header className="reminder-card-head">
          <BellOutlined />
          弹窗提醒
        </header>

        <div className="reminder-clock-wrap">
          <AnalogClock now={now} />
          <p className="reminder-current-time">
            当前时间 {pad2(cd.getHours())}:{pad2(cd.getMinutes())}:{pad2(cd.getSeconds())}
          </p>
        </div>

        <p className="reminder-time-line">
          <span className="reminder-time-label">提醒时间：</span>
          <span className="reminder-time-value">
            {at.getMonth() + 1}月{at.getDate()}日 {pad2(at.getHours())}:{pad2(at.getMinutes())}
            {MODE_LABEL[params.mode]}
          </span>
        </p>

        <h2 className="reminder-title">{params.title || '提醒'}</h2>
        {params.content && <p className="reminder-content">{params.content}</p>}

        <button
          type="button"
          className="reminder-enter"
          title="打开便签并查看这条提醒"
          onClick={() => void handleEnter()}
        >
          <span>进入便签</span>
          <span>&gt;&gt;&gt;</span>
        </button>

        <Button
          type="primary"
          size="large"
          block
          className="reminder-confirm"
          onClick={() => void handleConfirm()}
        >
          我知道了
        </Button>
      </section>
    </div>
  )
}
