import { useEffect, useState } from 'react'
import { App as AntdApp, Button, Switch } from 'antd'
import { invoke } from '@tauri-apps/api/core'
import { open as dialogOpen } from '@tauri-apps/plugin-dialog'
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
  customDir: string | null
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

  /** 更改镜像目录：系统目录选择器 → 校验并保存 → 立即补一次当日备份镜像 */
  const handlePickMirror = async (): Promise<void> => {
    const picked = await dialogOpen({ directory: true, multiple: false })
    if (typeof picked !== 'string' || !picked.trim()) return
    setBusy(true)
    try {
      const next = await invoke<AutoBackupStatus>('set_backup_dir', {
        dir: picked.trim(),
      })
      setStatus(next)
      if (next.customDir) message.success(`备份将镜像到 ${next.customDir}`)
    } catch (error) {
      console.error('设置镜像目录失败', error)
      message.error(
        error instanceof Error ? `设置失败：${error.message}` : '设置镜像目录失败'
      )
    } finally {
      setBusy(false)
    }
  }

  const handleClearMirror = async (): Promise<void> => {
    setBusy(true)
    try {
      const next = await invoke<AutoBackupStatus>('set_backup_dir', { dir: null })
      setStatus(next)
      message.success('已清除镜像目录，备份仅保存在应用数据目录')
    } catch (error) {
      console.error('清除镜像目录失败', error)
      message.error('清除镜像目录失败')
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
          <span className="settings-item-label">镜像目录</span>
          <span className="settings-item-hint break-all">
            {status?.customDir
              ? status.customDir
              : '未设置。可选填网盘同步文件夹（OneDrive / 坚果云等），每日备份会额外复制一份到这里实现异地备份'}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {status?.customDir && (
            <Button size="small" disabled={busy} onClick={() => void handleClearMirror()}>
              清除
            </Button>
          )}
          <Button size="small" disabled={busy} onClick={() => void handlePickMirror()}>
            更改
          </Button>
        </div>
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
