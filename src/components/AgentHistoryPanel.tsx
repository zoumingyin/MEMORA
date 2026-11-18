import { useEffect, useRef, useState } from 'react'
import dayjs from 'dayjs'
import {
  App as AntdApp,
  Empty,
  Input,
  Pagination,
  Popconfirm,
  Select,
  Spin,
  Tooltip,
} from 'antd'
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Lightbulb,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react'
import { getAgentExecutionRepository } from '../repository/executionRepository'
import {
  EXECUTION_STATUS_LABEL,
  EXECUTION_STEP_STATUS_LABEL,
  failureGuidance,
  formatDuration,
} from '../services/executionHistory'
import type { AgentFailure } from '../services/agentFailure'
import type {
  AgentExecutionPage,
  AgentExecutionRecord,
  AgentExecutionStatus,
  AgentExecutionStep,
} from '../types/executionHistory'
import { useAssistantStore } from '../store/useAssistantStore'
import { useEntryStore } from '../store/useEntryStore'
import { useUiStore } from '../store/useUiStore'

interface AgentHistoryPanelProps {
  onClose: () => void
  onJumpToMessage: (messageId: string) => void
}

type RangeKey = 'all' | 'today' | '7d' | '30d'

const EMPTY_PAGE: AgentExecutionPage = {
  items: [],
  total: 0,
  page: 1,
  pageSize: 10,
  hasMore: false,
}

const PAGE_SIZE = 10

const RANGE_OPTIONS: { value: RangeKey; label: string }[] = [
  { value: 'all', label: '全部时间' },
  { value: 'today', label: '今天' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
]

const STATUS_OPTIONS = (
  Object.keys(EXECUTION_STATUS_LABEL) as AgentExecutionStatus[]
).map((status) => ({ value: status, label: EXECUTION_STATUS_LABEL[status] }))

const STATUS_TONE: Record<AgentExecutionStatus, string> = {
  success:
    'bg-[color-mix(in_srgb,var(--memora-success)_10%,transparent)] text-[var(--memora-success-text)]',
  partial:
    'bg-[color-mix(in_srgb,var(--memora-warning)_12%,transparent)] text-[var(--memora-warning-text)]',
  needs_input:
    'bg-[color-mix(in_srgb,var(--memora-warning)_12%,transparent)] text-[var(--memora-warning-text)]',
  running:
    'bg-[color-mix(in_srgb,var(--memora-primary)_10%,transparent)] text-[var(--memora-primary)]',
  failed:
    'bg-[color-mix(in_srgb,var(--memora-danger)_12%,transparent)] text-[var(--memora-danger-text)]',
  execution_unknown:
    'bg-[color-mix(in_srgb,var(--memora-danger)_12%,transparent)] text-[var(--memora-danger-text)]',
  cancelled: 'bg-[var(--hover-fill)] text-[var(--text-muted)]',
  interrupted: 'bg-[var(--hover-fill)] text-[var(--text-muted)]',
}

const STEP_STATUS_TONE: Record<string, string> = {
  success:
    'bg-[color-mix(in_srgb,var(--memora-success)_10%,transparent)] text-[var(--memora-success-text)]',
  failed:
    'bg-[color-mix(in_srgb,var(--memora-danger)_12%,transparent)] text-[var(--memora-danger-text)]',
  execution_unknown:
    'bg-[color-mix(in_srgb,var(--memora-danger)_12%,transparent)] text-[var(--memora-danger-text)]',
  needs_input:
    'bg-[color-mix(in_srgb,var(--memora-warning)_12%,transparent)] text-[var(--memora-warning-text)]',
  running:
    'bg-[color-mix(in_srgb,var(--memora-primary)_10%,transparent)] text-[var(--memora-primary)]',
}

const FAILURE_LABEL: Record<AgentFailure['category'], string> = {
  model_request_failed: '模型请求失败',
  model_timeout: '模型响应超时',
  invalid_tool_arguments: '工具参数无效',
  permission_denied: '缺少操作目标授权',
  target_not_found: '目标不存在',
  target_ambiguous: '目标不唯一',
  business_execution_failed: '业务执行失败',
  execution_unknown: '写入结果不确定',
  readback_failed: '写入后回读失败',
  execution_cancelled: '执行已取消',
  dependency_failed: '前置步骤未确认',
}

const PHASE_LABEL: Record<string, string> = {
  understanding: '理解任务',
  searching: '检索资料',
  executing: '执行操作',
  composing: '整理结果',
  done: '已完成',
  partial: '部分完成',
  failed: '失败',
  needs_input: '等待补充',
}

const EFFECT_LABEL: Record<string, string> = {
  search: '检索',
  list: '列表',
  read: '读取',
  create: '创建',
  update: '修改',
  delete: '删除',
}

const KIND_LABEL: Record<string, string> = {
  note: '备忘',
  reminder: '提醒',
  todo: '待办',
  draw: '涂鸦',
}

function StatusChip({ status }: { status: AgentExecutionStatus }) {
  return (
    <span
      className={`shrink-0 rounded-[var(--memora-radius-sm)] px-1.5 py-0.5 text-[10px] leading-snug ${STATUS_TONE[status]}`}
    >
      {EXECUTION_STATUS_LABEL[status]}
    </span>
  )
}

function StepStatusChip({ status }: { status: AgentExecutionStep['status'] }) {
  return (
    <span
      className={`shrink-0 rounded-[var(--memora-radius-sm)] px-1.5 py-0.5 text-[10px] leading-snug ${
        STEP_STATUS_TONE[status] ?? 'bg-[var(--hover-fill)] text-[var(--text-muted)]'
      }`}
    >
      {EXECUTION_STEP_STATUS_LABEL[status]}
    </span>
  )
}

function formatTime(value: number | undefined): string {
  return value ? dayjs(value).format('YYYY-MM-DD HH:mm:ss') : '—'
}

function timeRangeToBounds(range: RangeKey): { from?: number; to?: number } {
  if (range === 'all') return {}
  const now = dayjs()
  const to = now.endOf('day').valueOf()
  if (range === 'today') return { from: now.startOf('day').valueOf(), to }
  const days = range === '7d' ? 6 : 29
  return { from: now.startOf('day').subtract(days, 'day').valueOf(), to }
}

/** 执行历史视图：只读展示真实执行记录，不提供重放，也不构成任何写入授权 */
export function AgentHistoryPanel({ onClose, onJumpToMessage }: AgentHistoryPanelProps) {
  const { message } = AntdApp.useApp()
  const [page, setPage] = useState(1)
  const [keywordInput, setKeywordInput] = useState('')
  const [keyword, setKeyword] = useState('')
  const [statuses, setStatuses] = useState<AgentExecutionStatus[]>([])
  const [range, setRange] = useState<RangeKey>('all')
  const [data, setData] = useState<AgentExecutionPage>(EMPTY_PAGE)
  const [loading, setLoading] = useState(true)
  const [refreshTick, setRefreshTick] = useState(0)
  const [detail, setDetail] = useState<{
    record: AgentExecutionRecord
    steps: AgentExecutionStep[]
  } | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const loadSeq = useRef(0)

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setKeyword(keywordInput.trim())
      setPage(1)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [keywordInput])

  useEffect(() => {
    const seq = ++loadSeq.current
    const bounds = timeRangeToBounds(range)
    const run = async () => {
      setLoading(true)
      try {
        const result = await getAgentExecutionRepository().list({
          ...(keyword ? { keyword } : {}),
          ...(statuses.length > 0 ? { statuses } : {}),
          ...bounds,
          page,
          pageSize: PAGE_SIZE,
        })
        if (seq !== loadSeq.current) return
        // 删除末页唯一记录后回退一页，避免停在空页
        if (result.items.length === 0 && result.total > 0 && page > 1) {
          setPage((current) => Math.max(1, current - 1))
          return
        }
        setData(result)
      } catch (error) {
        if (seq !== loadSeq.current) return
        console.error('[AI] 加载执行历史失败', error)
      } finally {
        if (seq === loadSeq.current) setLoading(false)
      }
    }
    void run()
  }, [keyword, statuses, range, page, refreshTick])

  const openDetail = (record: AgentExecutionRecord) => {
    setDetail({ record, steps: [] })
    setDetailLoading(true)
    void Promise.all([
      getAgentExecutionRepository().getById(record.id),
      getAgentExecutionRepository().getSteps(record.id),
    ])
      .then(([latest, steps]) => {
        if (!latest) {
          setDetail(null)
          message.warning('这条执行记录已被删除')
          return
        }
        setDetail({ record: latest, steps })
      })
      .catch((error: unknown) => {
        console.error('[AI] 加载执行步骤失败', error)
        message.error('加载执行详情失败')
        setDetail(null)
      })
      .finally(() => setDetailLoading(false))
  }

  const removeRecord = async (id: string) => {
    try {
      await getAgentExecutionRepository().deleteById(id)
      if (detail?.record.id === id) setDetail(null)
      setRefreshTick((tick) => tick + 1)
      message.success('已删除该执行记录')
    } catch (error) {
      console.error('[AI] 删除执行记录失败', error)
      message.error('删除执行记录失败')
    }
  }

  const clearAll = async () => {
    try {
      await getAgentExecutionRepository().clear()
      setDetail(null)
      setPage(1)
      setRefreshTick((tick) => tick + 1)
      message.success('执行历史已清空')
    } catch (error) {
      console.error('[AI] 清空执行历史失败', error)
      message.error('清空执行历史失败')
    }
  }

  const jumpToEntry = (entryId: string) => {
    const exists = useEntryStore.getState().entries.some((entry) => entry.id === entryId)
    if (!exists) {
      message.warning('目标便签已不存在，可能已被删除')
      return
    }
    useEntryStore.getState().setSelectedId(entryId)
    useUiStore.getState().setDetailView(true)
    useAssistantStore.getState().closePanel()
  }

  if (detail) {
    const { record, steps } = detail
    const guidance = failureGuidance(record.failure, record.status)
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-tauri-drag-region="false">
        <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-[var(--border)] px-3">
          <button
            type="button"
            className="titlebar-btn"
            aria-label="返回执行历史列表"
            title="返回列表"
            onClick={() => setDetail(null)}
          >
            <ChevronLeft size={15} />
          </button>
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--text)]">
            执行详情
          </span>
          <Popconfirm
            title="删除这条执行记录？"
            description="只删除历史记录，不影响便签内容。"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => void removeRecord(record.id)}
          >
            <button
              type="button"
              className="titlebar-btn"
              aria-label="删除这条执行记录"
              title="删除记录"
            >
              <Trash2 size={13} />
            </button>
          </Popconfirm>
        </div>

        <div className="assistant-scroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
          <div>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 break-words text-[13px] font-semibold leading-snug text-[var(--text)]">
                {record.title}
              </div>
              <StatusChip status={record.status} />
            </div>
            <div className="mt-1 whitespace-pre-wrap break-words text-[11.5px] leading-relaxed text-[var(--text-muted)]">
              {record.userInput}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-[var(--memora-radius)] border border-[var(--border)] bg-[var(--field)] px-2.5 py-2 text-[11px]">
            <div className="text-[var(--text-muted)]">
              开始：<span className="text-[var(--text)]">{formatTime(record.startedAt)}</span>
            </div>
            <div className="text-[var(--text-muted)]">
              耗时：<span className="text-[var(--text)]">{formatDuration(record.durationMs)}</span>
            </div>
            <div className="text-[var(--text-muted)]">
              阶段：<span className="text-[var(--text)]">{PHASE_LABEL[record.phase] ?? record.phase}</span>
            </div>
            <div className="text-[var(--text-muted)]">
              工具：<span className="text-[var(--text)]">{record.toolCount}</span>
              <span className="ml-1 text-[var(--memora-success-text)]">成功 {record.successCount}</span>
              <span className="ml-1 text-[var(--memora-danger-text)]">失败 {record.failedCount}</span>
              <span className="ml-1">跳过 {record.skippedCount}</span>
            </div>
          </div>

          {record.summary && (
            <div className="whitespace-pre-wrap break-words rounded-[var(--memora-radius)] border border-[var(--border)] bg-[var(--field)] px-2.5 py-2 text-[11.5px] leading-relaxed text-[var(--text)]">
              {record.summary}
            </div>
          )}

          {record.failure && (
            <div className="rounded-[var(--memora-radius)] border border-[var(--border)] bg-[var(--hover-fill)] px-2.5 py-2 text-[11px]">
              <div className="text-[var(--memora-danger-text)]">
                失败分类：{FAILURE_LABEL[record.failure.category]}
                {record.failure.writeState === 'unknown' &&
                  record.failure.category !== 'execution_unknown' &&
                  ' · 写入结果不确定'}
                {record.failure.requiresVerification && ' · 需先核对'}
              </div>
              {record.errorMessage && (
                <div className="mt-1 break-words text-[var(--text-muted)]">
                  {record.errorMessage}
                </div>
              )}
            </div>
          )}

          {guidance && record.status !== 'success' && (
            <div className="flex items-start gap-1.5 rounded-[var(--memora-radius)] border border-[color-mix(in_srgb,var(--memora-warning)_35%,var(--border))] bg-[color-mix(in_srgb,var(--memora-warning)_8%,transparent)] px-2.5 py-2 text-[11px] leading-relaxed text-[var(--memora-warning-text)]">
              <Lightbulb size={12} className="mt-0.5 shrink-0" />
              <span>{guidance}</span>
            </div>
          )}

          <div>
            <div className="mb-1.5 text-[11px] font-medium text-[var(--text-muted)]">
              执行步骤（{steps.length}）
            </div>
            {detailLoading ? (
              <div className="flex justify-center py-4">
                <Spin size="small" />
              </div>
            ) : steps.length === 0 ? (
              <div className="rounded-[var(--memora-radius)] border border-dashed border-[var(--border)] px-2.5 py-3 text-center text-[11px] text-[var(--text-muted)]">
                本次任务没有真实进入执行链路的工具步骤
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {steps.map((step) => (
                  <div
                    key={step.id}
                    className="rounded-[var(--memora-radius)] border border-[var(--border)] bg-[var(--field)] px-2.5 py-2"
                  >
                    <div className="flex items-start gap-1.5">
                      <span className="mt-px shrink-0 rounded bg-[var(--hover-fill)] px-1 text-[10px] leading-4 text-[var(--text-muted)]">
                        {step.ordinal + 1}
                      </span>
                      <span className="min-w-0 flex-1 break-words text-[11.5px] text-[var(--text)]">
                        {step.label}
                      </span>
                      <StepStatusChip status={step.status} />
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-[var(--text-muted)]">
                      <span className="font-mono">{step.toolName}</span>
                      <span>{formatDuration(step.durationMs)}</span>
                      {step.effect && (
                        <span>
                          {EFFECT_LABEL[step.effect.op] ?? step.effect.op}
                          {step.effect.kind ? `·${KIND_LABEL[step.effect.kind] ?? step.effect.kind}` : ''}
                          {typeof step.effect.count === 'number' ? ` ${step.effect.count} 项` : ''}
                        </span>
                      )}
                    </div>
                    {step.failure && (
                      <div className="mt-1 text-[10.5px] text-[var(--memora-danger-text)]">
                        {FAILURE_LABEL[step.failure.category]}
                        {step.failure.writeState === 'unknown' &&
                          step.failure.category !== 'execution_unknown' &&
                          ' · 写入结果不确定'}
                        {step.failure.requiresVerification && ' · 需先核对，禁止自动重试'}
                      </div>
                    )}
                    {(step.safeInputSummary || step.safeOutputSummary) && (
                      <div className="mt-1 space-y-0.5 text-[10.5px] leading-relaxed text-[var(--text-muted)]">
                        {step.safeInputSummary && (
                          <div className="break-words">输入：{step.safeInputSummary}</div>
                        )}
                        {step.safeOutputSummary && (
                          <div className="break-words">结果：{step.safeOutputSummary}</div>
                        )}
                      </div>
                    )}
                    {step.targetReferences && step.targetReferences.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {step.targetReferences.map((ref) => (
                          <button
                            key={`${ref.entryId}:${ref.effect}`}
                            type="button"
                            className="max-w-full truncate rounded-full border border-[var(--border)] bg-[var(--card-active-bg)] px-1.5 py-0.5 text-[10.5px] text-[var(--kind-accent)] transition hover:border-[var(--card-border-hover)]"
                            title={`打开便签：${ref.title ?? ref.entryId}`}
                            onClick={() => jumpToEntry(ref.entryId)}
                          >
                            {ref.title ?? ref.entryId}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <button
            type="button"
            className="self-start rounded-[var(--memora-radius-sm)] border border-[var(--border)] bg-[var(--field)] px-2 py-1 text-[11px] text-[var(--text)] transition hover:bg-[var(--hover-fill)]"
            onClick={() => onJumpToMessage(record.messageId)}
          >
            定位原对话
          </button>
          <div className="text-[10px] leading-relaxed text-[var(--text-muted)]">
            历史记录只用于回看真实执行过程，不会重放操作，也不构成新的写入授权。
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-tauri-drag-region="false">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-[var(--border)] px-3">
        <button
          type="button"
          className="titlebar-btn"
          aria-label="返回对话"
          title="返回对话"
          onClick={onClose}
        >
          <ArrowLeft size={14} />
        </button>
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--text)]">
          执行历史
        </span>
        <Tooltip title="刷新">
          <button
            type="button"
            className="titlebar-btn"
            aria-label="刷新执行历史"
            onClick={() => setRefreshTick((tick) => tick + 1)}
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : undefined} />
          </button>
        </Tooltip>
        <Popconfirm
          title="清空执行历史？"
          description="只删除历史记录，不影响便签内容，也不会撤销已执行的修改。"
          okText="清空"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          onConfirm={() => void clearAll()}
        >
          <button
            type="button"
            className="titlebar-btn"
            aria-label="清空执行历史"
            title="清空全部历史"
          >
            <Trash2 size={13} />
          </button>
        </Popconfirm>
      </div>

      <div className="flex shrink-0 flex-col gap-1.5 px-3 py-2">
        <Input
          size="small"
          allowClear
          prefix={<Search size={12} className="text-[var(--text-muted)]" />}
          placeholder="搜索任务标题、输入或摘要"
          value={keywordInput}
          onChange={(event) => setKeywordInput(event.target.value)}
        />
        <div className="flex items-center gap-1.5">
          <Select
            size="small"
            mode="multiple"
            allowClear
            maxTagCount="responsive"
            className="min-w-0 flex-1"
            placeholder="全部状态"
            options={STATUS_OPTIONS}
            value={statuses}
            onChange={(next) => {
              setStatuses(next)
              setPage(1)
            }}
          />
          <Select
            size="small"
            className="w-[100px] shrink-0"
            options={RANGE_OPTIONS}
            value={range}
            onChange={(next) => {
              setRange(next)
              setPage(1)
            }}
          />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-3 pb-2">
        {loading && data.items.length === 0 ? (
          <div className="flex flex-1 items-center justify-center py-8">
            <Spin size="small" />
          </div>
        ) : data.items.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-1 py-8">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的执行记录" />
            <span className="text-[10.5px] text-[var(--text-muted)]">
              真实执行过的工具任务会记录在这里
            </span>
          </div>
        ) : (
          data.items.map((record) => (
            <div
              key={record.id}
              className="group flex items-start gap-1 rounded-[var(--memora-radius)] border border-[var(--border)] bg-[var(--field)] transition hover:border-[var(--card-border-hover)]"
            >
              <button
                type="button"
                className="min-w-0 flex-1 border-0 bg-transparent px-2.5 py-2 text-left"
                onClick={() => openDetail(record)}
              >
                <div className="flex items-start gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--text)]">
                    {record.title}
                  </span>
                  <StatusChip status={record.status} />
                  <ChevronRight
                    size={12}
                    className="mt-0.5 shrink-0 text-[var(--text-muted)]"
                  />
                </div>
                <div className="mt-0.5 truncate text-[10.5px] text-[var(--text-muted)]">
                  {record.userInput}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-[var(--text-muted)]">
                  <span>{dayjs(record.startedAt).format('MM-DD HH:mm')}</span>
                  <span>{formatDuration(record.durationMs)}</span>
                  <span>工具 {record.toolCount}</span>
                  <span className="text-[var(--memora-success-text)]">成功 {record.successCount}</span>
                  <span className="text-[var(--memora-danger-text)]">失败 {record.failedCount}</span>
                  <span>跳过 {record.skippedCount}</span>
                </div>
              </button>
              <Popconfirm
                title="删除这条执行记录？"
                description="只删除历史记录，不影响便签内容。"
                okText="删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={() => void removeRecord(record.id)}
              >
                <button
                  type="button"
                  className="mr-1 mt-1.5 flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded border-0 bg-transparent p-0 text-[var(--text-muted)] opacity-0 transition hover:bg-[var(--hover-fill)] hover:text-[var(--danger)] focus:opacity-100 group-hover:opacity-100"
                  aria-label="删除这条执行记录"
                  title="删除"
                >
                  <Trash2 size={12} />
                </button>
              </Popconfirm>
            </div>
          ))
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-[var(--border)] px-3 py-1.5 text-[10.5px] text-[var(--text-muted)]">
        <span>共 {data.total} 条</span>
        <Pagination
          size="small"
          current={data.page}
          pageSize={PAGE_SIZE}
          total={data.total}
          showSizeChanger={false}
          onChange={setPage}
          hideOnSinglePage
        />
      </div>
    </div>
  )
}
