import { useState } from 'react'
import dayjs from 'dayjs'
import { Button, DatePicker, InputNumber, Modal, Select } from 'antd'
import type { AlarmItem, AlarmMethod, AlarmMode } from '../types/entry'
import { alarmLoopIntervalMs } from '../reminder/scheduler'

/** 闹钟提醒模式选项（存储值 → 界面文案），对齐参考图：单次/循环/每天/每周/每月/每年阳历/每年农历 */
const MODE_OPTIONS: Array<{ value: AlarmMode; label: string }> = [
  { value: 'once', label: '单次提醒' },
  { value: 'loop', label: '循环提醒' },
  { value: 'daily', label: '每天提醒' },
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
 * 提醒模式（7 种）/ 提醒方式下拉 + 日期时间选择器 + 设为当前时间 + 确定。
 * 选择「循环提醒」时追加显示「X 时 Y 分」复合间隔输入。
 */
export function AlarmEditorDialog({ alarm, onSave, onClose }: AlarmEditorDialogProps) {
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

  return (
    <Modal
      open
      title="设置闹钟"
      okText="确定"
      cancelText="取消"
      width={400}
      centered
      onOk={() => {
        const totalMin = Math.max(
          1,
          (intervalHours || 0) * 60 + (intervalMinutes || 0),
        )
        onSave({
          id: alarm.id,
          remindAt,
          mode,
          method,
          notified: alarm.notified,
          interval: mode === 'loop' ? totalMin : undefined,
          intervalUnit: mode === 'loop' ? 'minute' : undefined,
          intervalMs: mode === 'loop' ? totalMin * 60_000 : undefined,
        })
      }}
      onCancel={onClose}
    >
      <div className="alarm-editor-fields">
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
                onChange={(value) => setIntervalHours(value ?? 0)}
              />
              <span className="alarm-interval-unit">时</span>
              <InputNumber
                size="small"
                min={0}
                max={59}
                value={intervalMinutes}
                onChange={(value) => setIntervalMinutes(value ?? 0)}
              />
              <span className="alarm-interval-unit">分</span>
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
              showTime={{ format: 'HH:mm' }}
              format="YYYY-MM-DD HH:mm"
              value={dayjs(remindAt)}
              onChange={(value) => {
                if (value) setRemindAt(value.valueOf())
              }}
            />
            <Button type="link" size="small" className="alarm-now" onClick={() => setRemindAt(Date.now())}>
              设为当前时间
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
