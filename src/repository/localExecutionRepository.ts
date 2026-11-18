import type {
  AgentExecutionPage,
  AgentExecutionQuery,
  AgentExecutionRecord,
  AgentExecutionStep,
} from '../types/executionHistory'
import {
  emptyExecutionPage,
  matchesExecutionQuery,
  normalizeExecutionQuery,
} from '../services/executionHistory'
import type { AgentExecutionRepository } from './agentExecutionRepository'

const STORAGE_KEY = 'bianqian.agent.executions.v1'
/** 浏览器预览 / 测试环境的容量上限，避免 localStorage 配额被打满 */
const MAX_RECORDS = 300

interface ExecutionStoreData {
  version: 1
  records: AgentExecutionRecord[]
  steps: AgentExecutionStep[]
}

function emptyStore(): ExecutionStoreData {
  return { version: 1, records: [], steps: [] }
}

function isRecord(value: unknown): value is AgentExecutionRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    typeof record.title === 'string' &&
    typeof record.startedAt === 'number' &&
    typeof record.status === 'string'
  )
}

function isStep(value: unknown): value is AgentExecutionStep {
  if (typeof value !== 'object' || value === null) return false
  const step = value as Record<string, unknown>
  return (
    typeof step.id === 'string' &&
    typeof step.executionId === 'string' &&
    typeof step.toolName === 'string'
  )
}

/**
 * 非 Tauri 运行环境的执行历史仓储：localStorage 持久化。
 * 浏览器预览与 Mock SSE / 真实模型验收都走这里，与用户真实 SQLite 完全隔离。
 */
export class LocalAgentExecutionRepository implements AgentExecutionRepository {
  private readonly storage: Storage | null
  private memory: ExecutionStoreData = emptyStore()

  constructor(storage?: Storage | null) {
    this.storage =
      storage === undefined
        ? typeof localStorage === 'undefined'
          ? null
          : localStorage
        : storage
  }

  private load(): ExecutionStoreData {
    if (!this.storage) return this.memory
    try {
      const raw = this.storage.getItem(STORAGE_KEY)
      if (!raw) return emptyStore()
      const parsed = JSON.parse(raw) as Partial<ExecutionStoreData>
      return {
        version: 1,
        records: Array.isArray(parsed.records)
          ? parsed.records.filter(isRecord)
          : [],
        steps: Array.isArray(parsed.steps) ? parsed.steps.filter(isStep) : [],
      }
    } catch {
      return emptyStore()
    }
  }

  private save(data: ExecutionStoreData): void {
    if (!this.storage) {
      this.memory = data
      return
    }
    this.storage.setItem(STORAGE_KEY, JSON.stringify(data))
  }

  private prune(data: ExecutionStoreData): ExecutionStoreData {
    if (data.records.length <= MAX_RECORDS) return data
    const keep = new Set(
      [...data.records]
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, MAX_RECORDS)
        .map((record) => record.id),
    )
    return {
      version: 1,
      records: data.records.filter((record) => keep.has(record.id)),
      steps: data.steps.filter((step) => keep.has(step.executionId)),
    }
  }

  async create(record: AgentExecutionRecord): Promise<void> {
    const data = this.load()
    if (data.records.some((item) => item.id === record.id)) return
    data.records.push({ ...record })
    this.save(this.prune(data))
  }

  async update(
    id: string,
    patch: Partial<AgentExecutionRecord>,
  ): Promise<void> {
    const data = this.load()
    const index = data.records.findIndex((record) => record.id === id)
    if (index === -1) return
    data.records[index] = {
      ...data.records[index],
      ...patch,
      id,
      updatedAt: patch.updatedAt ?? Date.now(),
    }
    this.save(data)
  }

  async getById(id: string): Promise<AgentExecutionRecord | null> {
    const record = this.load().records.find((item) => item.id === id)
    return record ? { ...record } : null
  }

  async list(query: AgentExecutionQuery): Promise<AgentExecutionPage> {
    const { page, pageSize } = normalizeExecutionQuery(query)
    const matched = this.load()
      .records.filter((record) => matchesExecutionQuery(record, query))
      .sort((a, b) => b.startedAt - a.startedAt)
    if (matched.length === 0) return emptyExecutionPage(query)
    const start = (page - 1) * pageSize
    const items = matched.slice(start, start + pageSize).map((record) => ({ ...record }))
    return {
      items,
      total: matched.length,
      page,
      pageSize,
      hasMore: start + items.length < matched.length,
    }
  }

  async listUnfinished(): Promise<AgentExecutionRecord[]> {
    return this.load()
      .records.filter((record) => record.finishedAt === undefined)
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((record) => ({ ...record }))
  }

  async getSteps(executionId: string): Promise<AgentExecutionStep[]> {
    return this.load()
      .steps.filter((step) => step.executionId === executionId)
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((step) => ({ ...step }))
  }

  async upsertStep(step: AgentExecutionStep): Promise<void> {
    const data = this.load()
    const index = data.steps.findIndex((item) => item.id === step.id)
    if (index === -1) data.steps.push({ ...step })
    else data.steps[index] = { ...data.steps[index], ...step }
    this.save(data)
  }

  async deleteById(id: string): Promise<void> {
    const data = this.load()
    data.records = data.records.filter((record) => record.id !== id)
    data.steps = data.steps.filter((step) => step.executionId !== id)
    this.save(data)
  }

  async clear(): Promise<void> {
    this.save(emptyStore())
  }
}
