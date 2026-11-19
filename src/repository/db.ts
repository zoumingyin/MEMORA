import Database from '@tauri-apps/plugin-sql'
import { invoke } from '@tauri-apps/api/core'
import { DatabaseUnavailableError } from './errors'

/** 后端数据库闸门状态（与 db_safety::DbGateStatus 同构） */
export interface DbGateStatus {
  status: 'pending' | 'ready' | 'readonly'
  errorType: string | null
  message: string | null
  dbPath: string
  schemaVersion: number
  migrationPending: boolean
  preMigrationBackup: string | null
}

let database: Database | null = null
let opening: Promise<Database> | null = null

export async function readDbGateStatus(): Promise<DbGateStatus> {
  return invoke<DbGateStatus>('db_gate_status')
}

function unavailable(status: DbGateStatus): DatabaseUnavailableError {
  return new DatabaseUnavailableError(
    status.status,
    status.errorType ?? 'database_unavailable',
    status.message ?? '数据库不可用',
    status.dbPath,
  )
}

/**
 * 打开共享数据库连接。
 * Rust 端已在应用 setup 中完成只读检查与迁移前备份；这里只在闸门 ready 后触发
 * SQL 插件迁移，并把迁移结果回报给闸门。迁移失败时回退迁移前备份并进入只读保护。
 */
export async function getDatabase(): Promise<Database> {
  if (database) return database
  if (opening) return opening

  opening = (async () => {
    const gate = await readDbGateStatus()
    if (gate.status !== 'ready') {
      throw unavailable(gate)
    }
    try {
      const db = await Database.load('sqlite:bianqian.db')
      if (gate.migrationPending) {
        await invoke('db_gate_migration_complete')
      }
      database = db
      return db
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const failed = await invoke<DbGateStatus>('db_gate_load_failed', { message }).catch(
        () => null,
      )
      if (failed) throw unavailable(failed)
      throw error
    } finally {
      opening = null
    }
  })()

  return opening
}

/** 关闭共享连接：恢复数据库前必须调用，否则 Windows 下文件仍被占用 */
export async function closeDatabase(): Promise<void> {
  if (!database) return
  const current = database
  database = null
  try {
    await current.close()
  } catch {
    // 已关闭 / 插件内部释放失败：恢复流程由后端文件替换结果兜底
  }
}

/** 测试或恢复后重置连接缓存 */
export function resetDatabaseCache(): void {
  database = null
  opening = null
}
