import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, ConfigProvider, theme as antdTheme } from 'antd'
import { BellOutlined } from '@ant-design/icons'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { emit } from '@tauri-apps/api/event'
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

/** 从弹窗窗口 URL 参数读取提醒条目与具体闹钟（含主题标记） */
function readParams(): {
  id: string
  alarm: string
  title: string
  content: string
  time: number
  mode: AlarmMode
  method: AlarmMethod
  isDark: boolean
} {
  const query = new URLSearchParams(location.search)
  const mode = query.get('mode') as AlarmMode | null
  const method = query.get('method') as AlarmMethod | null
  return {
    id: query.get('id') ?? '',
    alarm: query.get('alarmId') ?? '',
    title: query.get('t') ?? '',
    content: query.get('c') ?? '',
    time: Number(query.get('time') ?? Date.now()),
    mode: ['loop', 'daily', 'weekly', 'monthly', 'yearly', 'lunar', 'workday'].includes(mode ?? '')
      ? (mode as AlarmMode)
      : 'once',
    method: method === 'notification' || method === 'sound' ? method : 'dialog',
    isDark: query.get('dark') === '1',
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

/** 暗色模式下的 CSS 变量（和 App.tsx / ImagePreviewDialog 保持一致） */
const DARK_TOKENS = {
  '--panel-rgb': '32, 34, 40',
  '--panel-soft-rgb': '42, 45, 52',
  '--field-rgb': '46, 49, 56',
  '--text': '#ffffff',
  '--text-muted': '#e0dcd3',
  '--border': 'rgba(236, 230, 220, 0.2)',
  '--control-border': 'rgba(236, 230, 220, 0.35)',
  '--hover-fill': 'rgba(255, 255, 255, 0.1)',
  '--text-halo': 'none',
  '--glass-edge': 'rgba(236, 230, 220, 0.12)',
  '--glass-highlight': 'rgba(236, 230, 220, 0.06)',
}

/** 亮色模式下需要恢复的变量 */
const LIGHT_TOKENS = {
  '--hover-fill': 'rgba(0, 0, 0, 0.06)',
}

/**
 * 闹钟弹窗：独立置顶透明窗口，仅浮出提醒卡片本身（无标题栏 / 无背景遮罩 / 无窗口边框）。
 * 交互参考图片预览弹窗：从 URL 读参、跟随暗亮主题、确认即关窗口。
 * 卡片显示模拟表盘与当前时间，确认后标记闹钟已通知并关闭；声音方式挂载时播放提示音。
 */
export function AlarmDialog() {
  const params = readParams()
  const [confirmed, setConfirmed] = useState(false)
  const confirmedRef = useRef(false)
  const now = useNow(1000)

  // 应用主题：读取到 isDark 后设置 CSS 变量与 dark-glass 类
  useEffect(() => {
    const rootStyle = document.documentElement.style
    if (params.isDark) {
      document.documentElement.classList.add('dark-glass')
      for (const [key, value] of Object.entries(DARK_TOKENS)) {
        rootStyle.setProperty(key, value)
      }
    } else {
      document.documentElement.classList.remove('dark-glass')
      for (const key of Object.keys(DARK_TOKENS)) {
        rootStyle.removeProperty(key)
      }
      for (const [key, value] of Object.entries(LIGHT_TOKENS)) {
        rootStyle.setProperty(key, value)
      }
    }
  }, [params.isDark])

  // 声音提醒方式：挂载时播放提示音
  useEffect(() => {
    if (params.method === 'sound') playBeep()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 标记已通知 + 关闭窗口（确认 / 进入便签 / 关闭按钮 / Esc 共用）
  const finishAndClose = useCallback(
    async (openNote: boolean): Promise<void> => {
      if (confirmedRef.current) return
      confirmedRef.current = true
      setConfirmed(true)
      try {
        if (isTauriRuntime() && params.id) {
          await getRepository().markAlarmNotified(params.id, params.alarm)
          if (openNote) {
            await emit('reminder:open-note', { entryId: params.id, alarmId: params.alarm })
          }
          await emit('reminder:confirmed', { entryId: params.id, alarmId: params.alarm })
          await getCurrentWindow().close()
        }
      } catch (error) {
        console.error('确认提醒失败', error)
        confirmedRef.current = false
        setConfirmed(false)
      }
    },
    [params.id, params.alarm],
  )

  const handleConfirm = useCallback(() => void finishAndClose(false), [finishAndClose])
  const handleEnter = useCallback(() => void finishAndClose(true), [finishAndClose])

  // Esc 等同于「我知道了」关闭弹窗
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') void handleConfirm()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleConfirm])

  // 浏览器预览确认后直接隐藏；Tauri 环境关闭窗口后组件不再存活
  if (confirmed && !isTauriRuntime()) return null

  const at = new Date(params.time)
  const cd = new Date(now)

  return (
    <ConfigProvider theme={params.isDark ? { algorithm: antdTheme.darkAlgorithm } : undefined}>
      <div className="alarm-dialog">
        <div className="alarm-body">
          <section className="reminder-card" role="alertdialog" aria-label="闹钟提醒">
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
      </div>
    </ConfigProvider>
  )
}
