import type {
  AgentExecutionPage,
  AgentExecutionQuery,
  AgentExecutionRecord,
  AgentExecutionStatus,
  AgentExecutionStep,
  AgentExecutionStepStatus,
  AgentExecutionTargetReference,
} from '../types/executionHistory'
import type { AssistantPhase, ToolEffect } from '../types/ai'
import type { AgentFailure } from '../services/agentFailure'
import {
  normalizeExecutionQuery,
} from '../services/executionHistory'
import type { AgentExecutionRepository } from './agentExecutionRepository'
import { getDatabase } from './db'

async function getDb() {
  return getDatabase()
}

interface ExecutionRow {
  id: string
  conversation_id: string
  message_id: string
  request_id: string
  title: string
  user_input: string
  status: string
  phase: string
  started_at: number
  finished_at: number | null
  duration_ms: number | null
  tool_count: number
  success_count: number
  failed_count: number
  skipped_count: number
  summary: string | null
  failure_json: string | null
  error_message: string | null
  created_at: number
  updated_at: number
}

interface StepRow {
  id: string
  execution_id: string
  ordinal: number
  tool_call_id: string
  tool_name: string
  proposal_id: string | null
  label: string
  status: string
  started_at: number | null
  finished_at: number | null
  duration_ms: number | null
  effect_json: string | null
  failure_json: string | null
  targets_json: string | null
  input_summary: string | null
  output_summary: string | null
}

function parseJson<T>(raw: string | null): T | undefined {
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

function rowToRecord(row: ExecutionRow): AgentExecutionRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    requestId: row.request_id,
    title: row.title,
    userInput: row.user_input,
    status: row.status as AgentExecutionStatus,
    phase: row.phase as AssistantPhase,
    startedAt: row.started_at,
    ...(row.finished_at != null ? { finishedAt: row.finished_at } : {}),
    ...(row.duration_ms != null ? { durationMs: row.duration_ms } : {}),
    toolCount: row.tool_count,
    successCount: row.success_count,
    failedCount: row.failed_count,
    skippedCount: row.skipped_count,
    ...(row.summary ? { summary: row.summary } : {}),
    ...(parseJson<AgentFailure>(row.failure_json)
      ? { failure: parseJson<AgentFailure>(row.failure_json) }
      : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToStep(row: StepRow): AgentExecutionStep {
  return {
    id: row.id,
    executionId: row.execution_id,
    ordinal: row.ordinal,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    ...(row.proposal_id ? { proposalId: row.proposal_id } : {}),
    label: row.label,
    status: row.status as AgentExecutionStepStatus,
    ...(row.started_at != null ? { startedAt: row.started_at } : {}),
    ...(row.finished_at != null ? { finishedAt: row.finished_at } : {}),
    ...(row.duration_ms != null ? { durationMs: row.duration_ms } : {}),
    ...(parseJson<ToolEffect>(row.effect_json)
      ? { effect: parseJson<ToolEffect>(row.effect_json) }
      : {}),
    ...(parseJson<AgentFailure>(row.failure_json)
      ? { failure: parseJson<AgentFailure>(row.failure_json) }
      : {}),
    ...(parseJson<AgentExecutionTargetReference[]>(row.targets_json)
      ? {
          targetReferences: parseJson<AgentExecutionTargetReference[]>(
            row.targets_json,
          ),
        }
      : {}),
    ...(row.input_summary ? { safeInputSummary: row.input_summary } : {}),
    ...(row.output_summary ? { safeOutputSummary: row.output_summary } : {}),
  }
}

const RECORD_COLUMNS: Array<{
  key: keyof AgentExecutionRecord
  column: string
  encode?: (value: AgentExecutionRecord[keyof AgentExecutionRecord]) => string | number | null
}> = [
  { key: 'conversationId', column: 'conversation_id' },
  { key: 'messageId', column: 'message_id' },
  { key: 'requestId', column: 'request_id' },
  { key: 'title', column: 'title' },
  { key: 'userInput', column: 'user_input' },
  { key: 'status', column: 'status' },
  { key: 'phase', column: 'phase' },
  { key: 'startedAt', column: 'started_at' },
  { key: 'finishedAt', column: 'finished_at' },
  { key: 'durationMs', column: 'duration_ms' },
  { key: 'toolCount', column: 'tool_count' },
  { key: 'successCount', column: 'success_count' },
  { key: 'failedCount', column: 'failed_count' },
  { key: 'skippedCount', column: 'skipped_count' },
  { key: 'summary', column: 'summary' },
  {
    key: 'failure',
    column: 'failure_json',
    encode: (value) => (value ? JSON.stringify(value) : null),
  },
  { key: 'errorMessage', column: 'error_message' },
  { key: 'createdAt', column: 'created_at' },
]

/** SQLite 执行历史仓储：独立表，迁移见 src-tauri/src/lib.rs version 8 */
export class SqliteAgentExecutionRepository implements AgentExecutionRepository {
  async create(record: AgentExecutionRecord): Promise<void> {
    const database = await getDb()
    await database.execute(
      `INSERT OR IGNORE INTO agent_executions
        (id, conversation_id, message_id, request_id, title, user_input, status, phase,
         started_at, finished_at, duration_ms, tool_count, success_count, failed_count,
         skipped_count, summary, failure_json, error_message, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
      [
        record.id,
        record.conversationId,
        record.messageId,
        record.requestId,
        record.title,
        record.userInput,
        record.status,
        record.phase,
        record.startedAt,
        record.finishedAt ?? null,
        record.durationMs ?? null,
        record.toolCount,
        record.successCount,
        record.failedCount,
        record.skippedCount,
        record.summary ?? null,
        record.failure ? JSON.stringify(record.failure) : null,
        record.errorMessage ?? null,
        record.createdAt,
        record.updatedAt,
      ],
    )
  }

  async update(
    id: string,
    patch: Partial<AgentExecutionRecord>,
  ): Promise<void> {
    const database = await getDb()
    const sets: string[] = []
    const params: (string | number | null)[] = []
    for (const entry of RECORD_COLUMNS) {
      if (patch[entry.key] === undefined) continue
      sets.push(`${entry.column} = $${params.length + 1}`)
      params.push(
        entry.encode
          ? entry.encode(patch[entry.key])
          : (patch[entry.key] as string | number | null),
      )
    }
    sets.push(`updated_at = $${params.length + 1}`)
    params.push(patch.updatedAt ?? Date.now())
    params.push(id)
    await database.execute(
      `UPDATE agent_executions SET ${sets.join(', ')} WHERE id = $${params.length}`,
      params,
    )
  }

  async getById(id: string): Promise<AgentExecutionRecord | null> {
    const database = await getDb()
    const rows = await database.select<ExecutionRow[]>(
      'SELECT * FROM agent_executions WHERE id = $1',
      [id],
    )
    return rows.length > 0 ? rowToRecord(rows[0]) : null
  }

  async list(query: AgentExecutionQuery): Promise<AgentExecutionPage> {
    const database = await getDb()
    const { page, pageSize } = normalizeExecutionQuery(query)
    const where: string[] = []
    const params: (string | number)[] = []
    if (query.unfinishedOnly === true) where.push('finished_at IS NULL')
    if (query.statuses && query.statuses.length > 0) {
      const placeholders = query.statuses.map((status) => {
        params.push(status)
        return `$${params.length}`
      })
      where.push(`status IN (${placeholders.join(', ')})`)
    }
    if (query.from !== undefined) {
      params.push(query.from)
      where.push(`started_at >= $${params.length}`)
    }
    if (query.to !== undefined) {
      params.push(query.to)
      where.push(`started_at <= $${params.length}`)
    }
    const keyword = query.keyword?.trim()
    if (keyword) {
      params.push(`%${keyword}%`)
      const placeholder = `$${params.length}`
      where.push(
        `(title LIKE ${placeholder} OR user_input LIKE ${placeholder} OR COALESCE(summary, '') LIKE ${placeholder})`,
      )
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const countRows = await database.select<Array<{ total: number }>>(
      `SELECT COUNT(*) AS total FROM agent_executions ${whereSql}`,
      params,
    )
    const total = countRows[0]?.total ?? 0
    if (total === 0) {
      return { items: [], total: 0, page, pageSize, hasMore: false }
    }
    const pageParams = [...params, pageSize, (page - 1) * pageSize]
    const rows = await database.select<ExecutionRow[]>(
      `SELECT * FROM agent_executions ${whereSql}
       ORDER BY started_at DESC, created_at DESC
       LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
      pageParams,
    )
    return {
      items: rows.map(rowToRecord),
      total,
      page,
      pageSize,
      hasMore: page * pageSize < total,
    }
  }

  async listUnfinished(): Promise<AgentExecutionRecord[]> {
    const database = await getDb()
    const rows = await database.select<ExecutionRow[]>(
      'SELECT * FROM agent_executions WHERE finished_at IS NULL ORDER BY started_at ASC',
    )
    return rows.map(rowToRecord)
  }

  async getSteps(executionId: string): Promise<AgentExecutionStep[]> {
    const database = await getDb()
    const rows = await database.select<StepRow[]>(
      'SELECT * FROM agent_execution_steps WHERE execution_id = $1 ORDER BY ordinal ASC, started_at ASC',
      [executionId],
    )
    return rows.map(rowToStep)
  }

  async upsertStep(step: AgentExecutionStep): Promise<void> {
    const database = await getDb()
    await database.execute(
      `INSERT INTO agent_execution_steps
        (id, execution_id, ordinal, tool_call_id, tool_name, proposal_id, label, status,
         started_at, finished_at, duration_ms, effect_json, failure_json, targets_json,
         input_summary, output_summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT(id) DO UPDATE SET
         ordinal = excluded.ordinal,
         tool_call_id = excluded.tool_call_id,
         tool_name = excluded.tool_name,
         proposal_id = excluded.proposal_id,
         label = excluded.label,
         status = excluded.status,
         started_at = COALESCE(agent_execution_steps.started_at, excluded.started_at),
         finished_at = excluded.finished_at,
         duration_ms = excluded.duration_ms,
         effect_json = excluded.effect_json,
         failure_json = excluded.failure_json,
         targets_json = excluded.targets_json,
         input_summary = excluded.input_summary,
         output_summary = excluded.output_summary`,
      [
        step.id,
        step.executionId,
        step.ordinal,
        step.toolCallId,
        step.toolName,
        step.proposalId ?? null,
        step.label,
        step.status,
        step.startedAt ?? null,
        step.finishedAt ?? null,
        step.durationMs ?? null,
        step.effect ? JSON.stringify(step.effect) : null,
        step.failure ? JSON.stringify(step.failure) : null,
        step.targetReferences ? JSON.stringify(step.targetReferences) : null,
        step.safeInputSummary ?? null,
        step.safeOutputSummary ?? null,
      ],
    )
  }

  async deleteById(id: string): Promise<void> {
    const database = await getDb()
    await database.execute(
      'DELETE FROM agent_execution_steps WHERE execution_id = $1',
      [id],
    )
    await database.execute('DELETE FROM agent_executions WHERE id = $1', [id])
  }

  async clear(): Promise<void> {
    const database = await getDb()
    await database.execute('DELETE FROM agent_execution_steps')
    await database.execute('DELETE FROM agent_executions')
  }
}
