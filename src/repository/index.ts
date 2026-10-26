import { SqliteEntryRepository } from './sqliteRepository'
import { MemoryEntryRepository } from './memoryRepository'
import type { EntryRepository } from './repository'

/** 识别当前是否运行在 Tauri 桌面运行时内 */
export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

let repository: EntryRepository | null = null

/**
 * 仓储单例：Tauri 环境用 SQLite；浏览器直开预览用 localStorage 兜底。
 * 后续多设备同步在此工厂内叠加远程实现，store 不直接感知。
 */
export function getRepository(): EntryRepository {
  if (!repository) {
    repository = isTauriRuntime()
      ? new SqliteEntryRepository()
      : new MemoryEntryRepository()
  }
  return repository
}
