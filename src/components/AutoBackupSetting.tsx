import { useEffect, useState } from 'react'
import { App as AntdApp, Button, Switch } from 'antd'
import { invoke } from '@tauri-apps/api/core'
import dayjs from 'dayjs'
import { isTauriRuntime } from '../repository'

interface BackupMetadata {
  kind: string
  schemaVersion: number
  backupAt: number
  sizeBytes: number
  sha256: string
  valid: boolean
  requiredTables: boolean
}

interface AutoBackupStatus {
  enabled: boolean
  dir: string
  lastBackupAt: number | null
  count: number
  lastError: string | null
  lastBackup: BackupMetadata | null
}

/**
 * 每日自动备份设置：启动时一致性快照到备份目录，按日期命名并保留最近 7 份。
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
      // 失败时重新读取状态，避免开关显示与实际配置不一致
      void invoke<AutoBackupStatus>('auto_backup_status')
        .then(setStatus)
        .catch(() => undefined)
    } finally {
      setBusy(false)
    }
  }

  const handleRunNow = async (): Promise<void> => {
    setBusy(true)
    try {
      const next = await invoke<AutoBackupStatus>('run_auto_backup_now')
      setStatus(next)
      if (next.lastError) message.error(`备份失败：${next.lastError}`)
      else message.success('已生成今天的备份')
    } catch (error) {
      console.error('立即备份失败', error)
      message.error(
        error instanceof Error ? `备份失败：${error.message}` : '备份失败'
      )
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
            启动时生成一致性快照并校验，保留最近 7 份
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
        <Button
          size="small"
          disabled={busy || !status?.enabled}
          onClick={() => void handleRunNow()}
        >
          立即备份
        </Button>
      </div>
      {status?.lastBackup && (
        <div className="settings-item">
          <div className="settings-item-main">
            <span className="settings-item-label">最近备份校验</span>
            <span className="settings-item-hint break-all">
              schema v{status.lastBackup.schemaVersion} ·{' '}
              {Math.max(1, Math.round(status.lastBackup.sizeBytes / 1024))} KB ·
              SHA256 {status.lastBackup.sha256.slice(0, 12)}… ·{' '}
              {status.lastBackup.valid && status.lastBackup.requiredTables
                ? '校验通过'
                : '校验未通过'}
            </span>
          </div>
        </div>
      )}
      {status?.lastError && (
        <div className="settings-item">
          <div className="settings-item-main">
            <span className="settings-item-label">最近一次失败</span>
            <span className="settings-item-hint break-all text-[var(--danger)]">
              {status.lastError}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
