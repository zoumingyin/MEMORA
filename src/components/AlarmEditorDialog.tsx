import { useState } from 'react'
import dayjs from 'dayjs'
import { Button, DatePicker, Input, InputNumber, Modal, Select } from 'antd'
import type { AlarmItem, AlarmMethod, AlarmMode } from '../types/entry'
import { alarmLoopIntervalMs } from '../reminder/nextAlarm'
import { toMinuteStart } from '../utils/format'
import { lunarMonthDay, lunarText } from '../utils/lunar'

/** 闹钟提醒模式选项（存储值 → 界面文案）：单次/循环/每天/工作日（含调休）/每周/每月/每年阳历/每年农历 */
const MODE_OPTIONS: Array<{ value: AlarmMode; label: string }> = [
  { value: 'once', label: '单次提醒' },
  { value: 'loop', label: '循环提醒' },
  { value: 'daily', label: '每天提醒' },
  { value: 'workday', label: '工作日提醒' },
  { value: 'weekly', label: '每周提醒' },
  { value: 'monthly', label: '每月提醒' },
  { value: 'yearly', label: '每年阳历' },
  { value: 'lunar', label: '每年农历' },
]

/** 闹钟提醒方式选项（存储值 → 界面文案） */
const METHOD_OPTIONS: Array<{ value: AlarmMethod; label: string }> = [
  { value: 'dialog', label: '弹窗提醒' },
  { value: 'notification', label: '系统通知' },
  { value: 'sound', label: '弹窗+声音' },
]

/** 每周提醒的星期选项（value 为 JS getDay 值：0=周日） */
const WEEKDAY_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 0, label: '周日' },
]

interface AlarmEditorDialogProps {
  /** 正在编辑的闹钟（新建时由调用方先创建默认闹钟再打开） */
  alarm: AlarmItem
  /** 保存（返回编辑后的闹钟） */
  onSave: (alarm: AlarmItem) => void
  /** 关闭；新建且未保存时由调用方决定是否保留 */
  onClose: () => void
}

/**
 * 「设置闹钟」编辑弹窗（antd Modal）：双击闹钟列表行（或点添加）后弹出，
 * 提醒模式（单次/循环/每天/工作日/每周/每月/每年阳历/每年农历）/ 提醒方式下拉 +
 * 日期时间选择器 + 设为当前时间 + 确定。
 * 选择「循环提醒」时追加显示「X 时 Y 分」复合间隔输入（两栏全 0 会立即 clamp 为 1 分）。
 */
export function AlarmEditorDialog({ alarm, onSave, onClose }: AlarmEditorDialogProps) {
  const [name, setName] = useState<string>(alarm.name ?? '')
  const [mode, setMode] = useState<AlarmMode>(alarm.mode)
  const [method, setMethod] = useState<AlarmMethod>(alarm.method)
  const [remindAt, setRemindAt] = useState(alarm.remindAt)

  // 循环间隔拆成「时 / 分」两栏：从 intervalMs 换算（旧数据由 interval+intervalUnit 兜底）
  const [intervalHours, setIntervalHours] = useState<number>(() => {
    const totalMin = Math.max(1, Math.round(alarmLoopIntervalMs(alarm) / 60_000))
    return Math.floor(totalMin / 60)
  })
  const [intervalMinutes, setIntervalMinutes] = useState<number>(() => {
    const totalMin = Math.max(1, Math.round(alarmLoopIntervalMs(alarm) / 60_000))
    return totalMin % 60
  })

  // 循环间隔变更：两栏都为 0 时立即 clamp 到 1 分，输入框直接反映实际生效的间隔
  const applyInterval = (h: number, m: number): void => {
    if (h <= 0 && m <= 0) m = 1
    setIntervalHours(h)
    setIntervalMinutes(m)
  }

  // 每月提醒锚定「几号」：短月临时落月末，下月恢复（与 scheduler 的 anchorDay 配套）
  const [monthDay, setMonthDay] = useState<number>(() => dayjs(alarm.remindAt).date())

  // 每周几变更：把提醒时间平移到最近的上一个/当天该星期几，时刻保持不变
  const rebaseWeekday = (dow: number): void => {
    const d = dayjs(remindAt)
    const diff = (dow - d.day() + 7) % 7
    setRemindAt(toMinuteStart(d.add(diff, 'day').valueOf()))
  }

  // 每月几号变更：当日改日（超出本月月末 clamp 到月末），时刻保持不变
  const rebaseMonthDay = (day: number): void => {
    const clamped = Math.min(Math.max(1, Math.round(day)), 31)
    setMonthDay(clamped)
    const d = dayjs(remindAt)
    setRemindAt(toMinuteStart(d.date(Math.min(clamped, d.daysInMonth())).valueOf()))
  }

  // 模式动态说明：用一句话讲清当前模式按什么重复（随提醒时间实时联动）
  const modeHint = ((): string => {
    const t = dayjs(remindAt).format('HH:mm')
    switch (mode) {
      case 'loop': {
        const totalMin = Math.max(1, (intervalHours || 0) * 60 + (intervalMinutes || 0))
        const h = Math.floor(totalMin / 60)
        const m = totalMin % 60
        const span = h > 0 && m > 0 ? `${h} 时 ${m} 分` : h > 0 ? `${h} 时` : `${m} 分`
        return `自首次提醒时间起，每 ${span}重复一次`
      }
      case 'workday':
        return `每个法定工作日 ${t} 重复（自动跳过周末与节假日，调休补班的周末照常提醒）`
      case 'daily':
        return `每天 ${t} 重复（日期部分忽略）`
      case 'weekly': {
        const wd = WEEKDAY_OPTIONS.find((option) => option.value === dayjs(remindAt).day())
        return `每周${wd ? wd.label.slice(1) : ''} ${t} 重复`
      }
      case 'monthly':
        return `每月 ${dayjs(remindAt).date()} 日 ${t} 重复；短月自动落月末，下月恢复`
      case 'yearly':
        return `每年阳历 ${dayjs(remindAt).format('M月D日')} ${t} 重复`
      case 'lunar':
        return `每年农历 ${lunarMonthDay(remindAt)} ${t} 重复`
      default:
        return ''
    }
  })()

  return (
    <Modal
      open
      title="设置闹钟"
      okText="确定"
      cancelText="取消"
      width={300}
      centered
      // 小窗口（如 320x380 独立便签小窗）下弹窗高于视口：body 限高滚动，保证「确定」可达
      styles={{ body: { maxHeight: 'calc(100vh - 140px)', overflowY: 'auto' } }}
      onOk={() => {
        const totalMin = Math.max(
          1,
          (intervalHours || 0) * 60 + (intervalMinutes || 0),
        )
        onSave({
          id: alarm.id,
          ...(name.trim() ? { name: name.trim() } : { name: undefined }),
          // 秒数归零：闹钟整时整分触发，不受设定时携带的秒数偏差影响
          remindAt: toMinuteStart(remindAt),
          mode,
          method,
          notified: alarm.notified,
          interval: mode === 'loop' ? totalMin : undefined,
          intervalUnit: mode === 'loop' ? 'minute' : undefined,
          intervalMs: mode === 'loop' ? totalMin * 60_000 : undefined,
          // 每月 / 每年模式锚定用户设定的「几号」：短月 / 平年 clamp 不滑落。
          // monthly 用输入框的 monthDay（如选 31 号，2 月落 28 但 3 月仍恢复 31）
          ...(mode === 'monthly'
            ? { anchorDay: monthDay }
            : mode === 'yearly'
              ? { anchorDay: new Date(remindAt).getDate() }
              : {}),
        })
      }}
      onCancel={onClose}
    >
      <div className="alarm-editor-fields">
        <div className="alarm-editor-field">
          <label>闹钟名称</label>
          <Input
            size="small"
            value={name}
            maxLength={40}
            placeholder="可选，用于区分多个闹钟"
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="alarm-editor-field">
          <label>提醒模式</label>
          <Select
            size="small"
            value={mode}
            options={MODE_OPTIONS}
            onChange={(value) => setMode(value as AlarmMode)}
          />
        </div>
        {mode === 'loop' && (
          <div className="alarm-editor-field">
            <label>循环间隔</label>
            <div className="alarm-dt">
              <InputNumber
                size="small"
                min={0}
                max={999}
                value={intervalHours}
                onChange={(value) => applyInterval(value ?? 0, intervalMinutes)}
              />
              <span className="alarm-interval-unit">时</span>
              <InputNumber
                size="small"
                min={0}
                max={59}
                value={intervalMinutes}
                onChange={(value) => applyInterval(intervalHours, value ?? 0)}
              />
              <span className="alarm-interval-unit">分</span>
            </div>
          </div>
        )}
        {mode === 'weekly' && (
          <div className="alarm-editor-field">
            <label>每周几</label>
            <div className="alarm-dt">
              <Select
                size="small"
                style={{ flex: 1 }}
                value={dayjs(remindAt).day()}
                options={WEEKDAY_OPTIONS}
                onChange={(value) => rebaseWeekday(value as number)}
              />
            </div>
          </div>
        )}
        {mode === 'monthly' && (
          <div className="alarm-editor-field">
            <label>每月几号</label>
            <div className="alarm-dt">
              <InputNumber
                size="small"
                min={1}
                max={31}
                value={monthDay}
                onChange={(value) => rebaseMonthDay(value ?? 1)}
              />
              <span className="alarm-interval-unit">
                当月实际 {dayjs(remindAt).date()} 日
              </span>
            </div>
          </div>
        )}
        <div className="alarm-editor-field">
          <label>提醒方式</label>
          <Select
            size="small"
            value={method}
            options={METHOD_OPTIONS}
            onChange={(value) => setMethod(value as AlarmMethod)}
          />
        </div>
        <div className="alarm-editor-field">
          <label>提醒时间</label>
          <div className="alarm-dt">
            <DatePicker
              size="small"
              classNames={{ popup: { root: 'alarm-picker-dropdown' } }}
              // changeOnScroll:false：时间列滚轮只浏览不改值。
              // 默认开启时滚轮会把「列中央的分钟」写成选中值——选完分钟再滚一下，
              // 值就被弹回当前分钟附近（用户反馈「选择分钟后自动滚动当前的分钟」）
              showTime={{ format: 'HH:mm', changeOnScroll: false }}
              format="YYYY-MM-DD HH:mm"
              value={dayjs(remindAt)}
              // 日期格显示农历 / 节气 / 节日小字，与日历视图网格观感一致
              cellRender={(current, info) => {
                if (info.type !== 'date') return info.originNode
                const d = dayjs(current)
                return (
                  <div className="ant-picker-cell-inner alarm-cell-lunar">
                    <span className="alarm-cell-day">{d.date()}</span>
                    <span className="alarm-cell-lunar-sub">{lunarText(d)}</span>
                  </div>
                )
              }}
              onChange={(value) => {
                if (value) {
                  setRemindAt(toMinuteStart(value.valueOf()))
                  // 手动改日期时同步「每月几号」，保持锚定日与所选日期一致
                  setMonthDay(value.date())
                }
              }}
            />
            <Button
              type="link"
              size="small"
              className="alarm-now"
              onClick={() => setRemindAt(toMinuteStart(Date.now()))}
            >
              设为当前时间
            </Button>
          </div>
        </div>
        {modeHint && (
          <p className="alarm-mode-hint">{modeHint}</p>
        )}
      </div>
    </Modal>
  )
}
