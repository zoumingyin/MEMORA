/**
 * 废纸篓自动清理设置：deletedAt 超过保留期的条目在应用启动时彻底删除。
 * 默认开启，保留 30 天；开关与保留期随版本固定，只持久化开/关。
 */

const STORAGE_KEY = "bianqian.trashAutoClean.v1";

/** 废纸篓保留期（天）：超过该天数的软删除条目启动时自动彻底删除 */
export const TRASH_RETENTION_DAYS = 30;

export function readTrashAutoCleanEnabled(): boolean {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return true;
    const parsed = JSON.parse(raw) as { enabled?: boolean };
    return parsed?.enabled !== false;
  } catch {
    return true;
  }
}

export function writeTrashAutoCleanEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled }));
  } catch {
    // localStorage 不可用时静默忽略：下次启动按默认开启处理
  }
}
