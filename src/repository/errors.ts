import type { Entry } from '../types/entry'

export type EntryWriteErrorCode = 'conflict' | 'not_found' | 'io' | 'readonly'

/** 写入失败统一错误：界面据此决定提示与冲突处理，不把失败当成功 */
export class EntryWriteError extends Error {
  readonly code: EntryWriteErrorCode
  readonly latest: Entry | null

  constructor(code: EntryWriteErrorCode, message: string, latest: Entry | null = null) {
    super(message)
    this.name = 'EntryWriteError'
    this.code = code
    this.latest = latest
  }
}

export function isEntryWriteError(error: unknown): error is EntryWriteError {
  return error instanceof EntryWriteError
}

/** 把 Tauri 命令错误归一为数据库只读/故障错误 */
export class DatabaseUnavailableError extends Error {
  readonly status: string
  readonly errorType: string
  readonly dbPath: string

  constructor(status: string, errorType: string, message: string, dbPath: string) {
    super(message)
    this.name = 'DatabaseUnavailableError'
    this.status = status
    this.errorType = errorType
    this.dbPath = dbPath
  }
}
