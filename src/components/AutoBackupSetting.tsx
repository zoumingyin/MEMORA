import { useEffect, useState } from 'react'
import { App as AntdApp, Switch } from 'antd'
import { invoke } from '@tauri-apps/api/core'
import dayjs from 'dayjs'
import { isTauriRuntime } from '../repository'

interface AutoBackupStatus {
  enabled: boolean
  dir: string
  lastBackupAt: number | null
  count: number
}

/**
 * 每日自动备份设置：启动时复制 SQLite 到备份目录，按日期命名并保留最近 7 份。
 * 仅桌面版可用，预览环境展示说明。
 */
export function AutoBackupSetting() {
  const { message } = AntdApp.useApp()
  const [status, setStatus] = useState<AutoBackupStatus | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!isTauriRuntime()) return
    void invoke<AutoBackupStatus>('auto_backup_status')
      .then(setStatus)
      .catch((error) => {
        console.error('读取自动备份状态失败', error)
      })
  }, [])

  if (!isTauriRuntime()) {
    return (
      <div className="settings-item">
        <div className="settings-item-main">
          <span className="settings-item-label">每日自动备份</span>
          <span className="settings-item-hint">仅桌面版可用</span>
        </div>
      </div>
    )
  }

  const handleToggle = async (enabled: boolean): Promise<void> => {
    setBusy(true)
    try {
      const next = await invoke<AutoBackupStatus>('set_auto_backup', { enabled })
      setStatus(next)
      message.success(enabled ? '已开启每日自动备份' : '已关闭每日自动备份')
    } catch (error) {
      console.error('保存自动备份设置失败', error)
      message.error('保存自动备份设置失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col">
      <div className="settings-item">
        <div className="settings-item-main">
          <span className="settings-item-label">每日自动备份</span>
          <span className="settings-item-hint">
            启动时复制数据库到备份目录，保留最近 7 份
          </span>
        </div>
        <Switch
          size="small"
          checked={status?.enabled ?? false}
          loading={busy || !status}
          onChange={(value) => void handleToggle(value)}
        />
      </div>
      <div className="settings-item">
        <div className="settings-item-main">
          <span className="settings-item-label">备份位置</span>
          <span className="settings-item-hint break-all">
            {status?.dir ?? '读取中…'}
          </span>
        </div>
        <span className="settings-item-hint shrink-0">
          {status ? `${status.count} 份` : ''}
        </span>
      </div>
      <div className="settings-item">
        <div className="settings-item-main">
          <span className="settings-item-label">最近备份时间</span>
          <span className="settings-item-hint">
            {status?.lastBackupAt
              ? dayjs(status.lastBackupAt).format('YYYY-MM-DD HH:mm')
              : '尚未备份'}
          </span>
        </div>
      </div>
    </div>
  )
}
