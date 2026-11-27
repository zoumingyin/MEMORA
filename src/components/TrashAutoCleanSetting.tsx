import { useState } from 'react'
import { Switch } from 'antd'
import {
  readTrashAutoCleanEnabled,
  writeTrashAutoCleanEnabled,
  TRASH_RETENTION_DAYS,
} from '../utils/trashAutoClean'

/**
 * 废纸篓自动清理开关：启动时把 deletedAt 超过保留期的软删除条目彻底删除。
 * 默认开启；仅持久化开/关，保留期随版本固定。
 */
export function TrashAutoCleanSetting() {
  const [enabled, setEnabled] = useState(() => readTrashAutoCleanEnabled())

  const handleToggle = (value: boolean): void => {
    setEnabled(value)
    writeTrashAutoCleanEnabled(value)
  }

  return (
    <div className="flex flex-col">
      <div className="settings-item">
        <div className="settings-item-main">
          <span className="settings-item-label">废纸篓自动清理</span>
          <span className="settings-item-hint">
            每次启动时彻底删除已删除超过 {TRASH_RETENTION_DAYS} 天的条目，不可恢复
          </span>
        </div>
        <Switch
          size="small"
          checked={enabled}
          onChange={handleToggle}
        />
      </div>
      <div className="settings-item">
        <div className="settings-item-main">
          <span className="settings-item-hint">
            关闭后废纸篓条目将一直保留，可在废纸篓里手动「彻底删除」
          </span>
        </div>
      </div>
    </div>
  )
}
