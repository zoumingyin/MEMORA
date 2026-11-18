import { MemoryEntryRepository } from '../src/repository/memoryRepository'
import type {
  AgentToolEnvironment,
  AgentToolScope,
  AgentToolScopeOptions,
} from '../src/services/agentToolExecutor'
import { createAgentToolScope } from '../src/services/agentToolExecutor'
import type { TargetTrustSource } from '../src/services/agentTargets'
import { resetDeleteProposals } from '../src/services/deleteProposals'
import type { AiToolCall } from '../src/types/ai'
import type { AlarmItem, Entry, EntryKind, ReminderEntry } from '../src/types/entry'

/**
 * 测试基础设施：
 * - 用真实的 MemoryEntryRepository（与 SQLite 仓储语义一致）承载数据；
 * - localStorage 用内存 Map 顶替，仅在本进程内有效；
 * - env 的同步 listEntries 维护一份落库后的快照，写入后立即刷新。
 */

export class FakeStorage implements Storage {
  private readonly map = new Map<string, string>()

  get length(): number {
    return this.map.size
  }

  clear(): void {
    this.map.clear()
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }

  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.map.delete(key)
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
}

function installStorage(): void {
  ;(globalThis as { localStorage?: Storage }).localStorage = new FakeStorage()
}

export interface TestHarness {
  repo: MemoryEntryRepository
  env: AgentToolEnvironment
  /** 落库后的最新快照（不含废纸篓条目） */
  entries: () => Entry[]
  refresh: () => Promise<void>
  setNow: (ms: number) => void
  now: () => number
  /** 默认作用域：写权限，并信任当前仓储快照（测试夹具的「用户已授权」） */
  scope: (requestId?: string, options?: AgentToolScopeOptions) => AgentToolScope
  /** 把测试中刚种入的条目登记到默认作用域，模拟用户已明确授权 */
  trust: (entry: Entry, source?: TargetTrustSource) => void
  /** listEntries 被调用时触发，用于模拟「执行中途用户点了停止」 */
  onList?: () => void
  /** addEntry 成功写入后触发 */
  onAdd?: () => void
  /** updateEntry 成功写入后触发 */
  onUpdate?: () => void
}

export const BASE_TIME = new Date(2026, 10, 13, 9, 0, 0).getTime()

export async function createHarness(options?: { now?: number }): Promise<TestHarness> {
  installStorage()
  resetDeleteProposals()
  const repo = new MemoryEntryRepository()
  let nowMs = options?.now ?? BASE_TIME
  let snapshot: Entry[] = await repo.listAll()
  const makeDefaultScope = () =>
    createAgentToolScope('req-test', () => false, undefined, { permission: 'write' })
  const defaultScope = makeDefaultScope()

  const trust = (entry: Entry, source: TargetTrustSource = 'user_explicit') => {
    defaultScope.trustedTargets.set(entry.id, {
      id: entry.id,
      source,
      kind: entry.kind,
      title: entry.title,
      trustedAt: nowMs,
    })
  }

  const harness: TestHarness = {
    repo,
    entries: () => snapshot,
    refresh: async () => {
      snapshot = await repo.listAll()
    },
    setNow: (ms) => {
      nowMs = ms
    },
    now: () => nowMs,
    scope: (requestId = 'req-test', scopeOptions) => {
      if (requestId === 'req-test' && !scopeOptions) return defaultScope
      return createAgentToolScope(requestId, () => false, undefined, {
        permission: 'write',
        ...(scopeOptions ?? {}),
      })
    },
    trust,
    env: {
      now: () => nowMs,
      listEntries: () => {
        harness.onList?.()
        return snapshot
      },
      addEntry: async (input, kind) => {
        const created = await repo.create(kind, input)
        snapshot = await repo.listAll()
        if (created) trust(created, 'created')
        harness.onAdd?.()
        return created
      },
      updateEntry: async (id, patch) => {
        await repo.update(id, patch)
        snapshot = await repo.listAll()
        harness.onUpdate?.()
      },
    },
  }
  return harness
}

export function call(
  id: string,
  name: string,
  args: unknown = {},
): AiToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
  }
}

let idSeq = 0
export function nextId(prefix: string): string {
  idSeq += 1
  return `${prefix}-${idSeq}`
}

export async function seed<T extends Entry>(harness: TestHarness, entry: T): Promise<T> {
  await harness.repo.importAll([entry])
  await harness.refresh()
  harness.trust(entry)
  return entry
}

export function makeBase(kind: EntryKind, overrides?: Partial<Entry>): Entry {
  return {
    id: nextId(kind),
    kind,
    title: '标题',
    content: '',
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    syncStatus: 'pending',
    tags: [],
    deletedAt: null,
    ...overrides,
  } as Entry
}

export function makeReminder(input: {
  id?: string
  title?: string
  alarms: AlarmItem[]
  tags?: string[]
  done?: boolean
}): ReminderEntry {
  const alarms = input.alarms
  return {
    id: input.id ?? nextId('reminder'),
    kind: 'reminder',
    title: input.title ?? '提醒',
    content: '',
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    syncStatus: 'pending',
    tags: input.tags ?? [],
    deletedAt: null,
    remindAt: Math.min(...alarms.map((alarm) => alarm.remindAt)),
    notified: false,
    done: input.done ?? false,
    alarms,
  }
}

export function alarm(
  id: string,
  remindAt: number,
  mode: AlarmItem['mode'] = 'once',
  extra?: Partial<AlarmItem>,
): AlarmItem {
  return {
    id,
    remindAt,
    mode,
    method: 'dialog',
    notified: false,
    ...extra,
  }
}
