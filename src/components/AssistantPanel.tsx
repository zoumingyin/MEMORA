import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import dayjs from 'dayjs'
import { App as AntdApp, Button, Dropdown, Flex, Popconfirm, Select, Tooltip } from 'antd'
import { openExternal } from '../utils/openExternal'
import {
  ArrowUp,
  Bell,
  Brain,
  Check,
  CircleAlert,
  Copy,
  FileText,
  Globe,
  History,
  ListChecks,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  Square,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react'
import { markdownToHtml } from '../utils/markdown'
import { parseAssistantActions, type AssistantAction } from '../utils/assistantActions'
import { saveAiProfile } from '../services/aiClient'
import {
  cancelDeleteProposal,
  confirmDeleteProposal,
} from '../services/deleteExecution'
import {
  recordDeleteCancelled,
  recordDeleteConfirmed,
} from '../services/deleteConfirmationHistory'
import {
  ALARM_METHOD_LABEL,
  ALARM_MODE_LABEL,
} from '../services/reminderAlarms'
import {
  cancelAlarmSelection,
  expireAlarmSelection,
} from '../services/alarmSelections'
import { confirmAlarmSelection } from '../services/alarmSelectionExecution'
import { createAgentToolEnv } from '../services/agentTools'
import {
  buildTaskChecklist,
  countTaskStatuses,
  TASK_STATUS_LABEL,
  taskStatusFromStep,
} from '../services/agentProgress'
import {
  executionSummaryLines,
  summarizeExecution,
} from '../services/agentExecution'
import { FreeBadge } from './FreeBadge'
import { ModalityBadge } from './ModalityBadge'
import { ProviderMark } from './ProviderMark'
import { AgentHistoryPanel } from './AgentHistoryPanel'
import { useAssistantStore } from '../store/useAssistantStore'
import { useAiProfileStore } from '../store/useAiProfileStore'
import { useEntryStore } from '../store/useEntryStore'
import { useUiStore } from '../store/useUiStore'
import {
  isNonTextModality,
  type AssistantAlarmSelection,
  type AssistantMessage,
  type AssistantPhase,
  type AssistantTaskStatus,
  type AiProfileStatus,
  type ReasoningEffort,
} from '../types/ai'
import type { EntryKind } from '../types/entry'

/** 模块级空数组兜底：避免 aiStatus 未就绪时每次渲染都新建 [] 导致 useMemo 失效 */
const EMPTY_PROFILES: AiProfileStatus[] = []

/** 空态引导问题：覆盖检索、统计、日程与整理四类常见诉求 */
const SUGGESTIONS = [
  '总结我最近的笔记',
  '我有哪些未完成的待办？',
  '帮我梳理最近的提醒安排',
  '把最近的想法整理成提纲',
]

/** 推理强度档位：default 表示不上送参数，由服务商决定 */
const REASONING_ITEMS: { key: ReasoningEffort | 'default'; label: string }[] = [
  { key: 'default', label: '默认（服务商决定）' },
  { key: 'none', label: '无 · 关闭思考，最快' },
  { key: 'low', label: '低' },
  { key: 'medium', label: '中' },
  { key: 'high', label: '高' },
]
const REASONING_SHORT: Record<ReasoningEffort | 'default', string> = {
  default: '默认',
  none: '无',
  low: '低',
  medium: '中',
  high: '高',
}

/** 错误码 → 用户可理解的标题；未知错误回落到「生成失败」 */
const ERROR_TITLE: Record<string, string> = {
  not_configured: 'AI 服务尚未配置',
  unauthorized: '密钥无效或无权限',
  endpoint_not_found: '接口地址或模型不存在',
  rate_limited: '请求过于频繁',
  server_error: 'AI 服务暂时不可用',
  network_error: '网络连接失败',
  stream_error: '回答传输中断',
  empty_response: '没有生成有效回答',
  empty_messages: '没有可发送的内容',
  interrupted: '回答已中断',
}

function errorTitle(code: string): string {
  return ERROR_TITLE[code] ?? '生成失败'
}

/** 便签引用提取：消毒前把 <note-ref> 换成占位符，消毒后由前端注入真实 <a>（属性不被 DOMPurify 处理） */
function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapeHtmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 把回答文本中的 note-ref 标记替换为占位符（[[NR0]]），登记引用清单供消毒后回填 */
function extractNoteRefs(text: string): {
  tokenized: string
  refs: { id: string; title: string }[]
} {
  const refs: { id: string; title: string }[] = []
  const tokenized = text.replace(
    /<note-ref\b([^>]*)>([\s\S]*?)<\/note-ref>/gi,
    (_match: string, attrs: string, inner: string) => {
      const idMatch = /(?:data-id|\bid)\s*=\s*["']([^"']+)["']/i.exec(attrs)
      if (!idMatch) return inner
      const title = inner.replace(/<[^>]+>/g, '').trim() || '查看便签'
      refs.push({ id: idMatch[1].trim(), title })
      return `[[NR${refs.length - 1}]]`
    },
  )
  return { tokenized, refs }
}

function TypingDots() {
  return (
    <span className="assistant-typing inline-flex items-center gap-1 py-1" aria-label="正在思考">
      <span />
      <span />
      <span />
    </span>
  )
}

/**
 * 首字前的等待反馈：推理模型（如豆包 Seed）会先思考十几秒，
 * 这里按秒计时，避免用户以为卡住；联网搜索时显示对应文案
 */
function ThinkingIndicator({
  startedAt,
  label = '思考中',
}: {
  startedAt: number
  label?: string
}) {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const tick = () =>
      setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)))
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [startedAt])
  return (
    <Flex align="center" gap={4}>
      <TypingDots />
      <span className="text-[12px] text-[var(--text-muted)]">
        {label}
        {elapsed >= 2 ? ` ${elapsed}s` : ''}
      </span>
    </Flex>
  )
}

function ErrorCard({
  message,
  onRetry,
}: {
  message: AssistantMessage
  onRetry: () => void
}) {
  const openSettings = useUiStore((state) => state.openSettings)
  const error = message.error
  if (!error) return null
  const needsConfig = error.code === 'not_configured'

  return (
    <div className="mt-2 rounded-[var(--memora-radius)] border border-[color-mix(in_srgb,var(--memora-danger)_45%,transparent)] bg-[color-mix(in_srgb,var(--memora-danger)_10%,var(--field))] px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-[var(--memora-danger-text)]">
        <TriangleAlert size={13} />
        {errorTitle(error.code)}
      </div>
      <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
        {error.message}
      </p>
      {needsConfig && (
        <div className="mt-2 flex gap-2">
          <Button
            size="small"
            type="primary"
            icon={<Settings2 size={12} />}
            onClick={() => openSettings('ai-config')}
          >
            去设置
          </Button>
        </div>
      )}
      {!needsConfig && (
        <div className="mt-2 flex gap-2">
          <Button size="small" icon={<RotateCcw size={12} />} onClick={onRetry}>
            重试
          </Button>
        </div>
      )}
    </div>
  )
}

function CopyReplyButton({ text }: { text: string }) {
  const { message: antdMessage } = AntdApp.useApp()
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<number | undefined>(undefined)

  useEffect(
    () => () => {
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
    },
    [],
  )

  const handleCopy = async () => {
    const write = navigator.clipboard?.writeText?.bind(navigator.clipboard)
    if (!write) {
      antdMessage.error('当前环境不支持复制')
      return
    }
    try {
      await write(text)
      setCopied(true)
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => setCopied(false), 1600)
    } catch {
      antdMessage.error('复制失败，请手动选择文本')
    }
  }

  return (
    <Tooltip title={copied ? '已复制' : '复制回答'}>
      <button
        type="button"
        className="flex h-6 items-center gap-1 rounded-full border-0 bg-transparent px-1.5 text-[10.5px] text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-fill)] hover:text-[var(--text)]"
        onClick={() => void handleCopy()}
        aria-label="复制回答"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
        <span>{copied ? '已复制' : '复制'}</span>
      </button>
    </Tooltip>
  )
}

/** 执行阶段文案：与 agent loop 的真实阶段一一对应，不做假进度 */
const PHASE_META: Record<
  AssistantPhase,
  { label: string; tone: 'active' | 'success' | 'warning' | 'danger' }
> = {
  understanding: { label: '正在理解任务', tone: 'active' },
  searching: { label: '正在搜索资料', tone: 'active' },
  executing: { label: '正在执行操作', tone: 'active' },
  composing: { label: '正在整理结果', tone: 'active' },
  done: { label: '已完成', tone: 'success' },
  partial: { label: '部分完成', tone: 'warning' },
  failed: { label: '执行失败', tone: 'danger' },
  needs_input: { label: '等待用户补充信息', tone: 'warning' },
}

const PHASE_TONE_CLASS: Record<
  (typeof PHASE_META)[AssistantPhase]['tone'],
  string
> = {
  active: 'bg-[var(--hover-fill)] text-[var(--text-muted)]',
  success:
    'bg-[color-mix(in_srgb,var(--memora-success)_10%,transparent)] text-[var(--memora-success-text)]',
  warning:
    'bg-[color-mix(in_srgb,var(--memora-warning)_12%,transparent)] text-[var(--memora-warning-text)]',
  danger:
    'bg-[color-mix(in_srgb,var(--memora-danger)_12%,transparent)] text-[var(--memora-danger-text)]',
}

const PHASE_ICON: Record<
  (typeof PHASE_META)[AssistantPhase]['tone'],
  ReactNode
> = {
  active: <Search size={10} />,
  success: <Check size={11} />,
  warning: <CircleAlert size={11} />,
  danger: <TriangleAlert size={11} />,
}

function PhaseBadge({ phase, live }: { phase: AssistantPhase; live: boolean }) {
  const meta = PHASE_META[phase]
  return (
    <div
      className={`mb-1 inline-flex items-center gap-1 rounded-[var(--memora-radius-sm)] px-1.5 py-0.5 text-[10.5px] leading-snug ${PHASE_TONE_CLASS[meta.tone]}`}
    >
      {live && meta.tone === 'active' ? (
        <TypingDots />
      ) : (
        PHASE_ICON[meta.tone]
      )}
      <span>{meta.label}</span>
    </div>
  )
}

function TaskStatusMark({ status }: { status: AssistantTaskStatus }) {
  if (status === 'running') return <TypingDots />
  if (status === 'success') {
    return <Check size={11} className="shrink-0 text-[var(--memora-success-text)]" />
  }
  if (status === 'failed') {
    return <TriangleAlert size={11} className="shrink-0 text-[var(--memora-danger-text)]" />
  }
  if (status === 'needs_input' || status === 'execution_unknown') {
    return <CircleAlert size={11} className="shrink-0 text-[var(--memora-warning-text)]" />
  }
  if (status === 'interrupted') {
    return <CircleAlert size={11} className="shrink-0 text-[var(--text-muted)]" />
  }
  return <CircleAlert size={11} className="shrink-0 text-[var(--text-muted)]" />
}

function taskTone(status: AssistantTaskStatus): string {
  if (status === 'success') return 'text-[var(--memora-success-text)]'
  if (status === 'failed') return 'text-[var(--memora-danger-text)]'
  if (status === 'needs_input' || status === 'execution_unknown') {
    return 'text-[var(--memora-warning-text)]'
  }
  if (status === 'running') return 'text-[var(--text)]'
  return 'text-[var(--text-muted)]'
}

function taskDetailVisible(status: AssistantTaskStatus): boolean {
  return (
    status === 'failed' ||
    status === 'needs_input' ||
    status === 'execution_unknown'
  )
}

/**
 * 执行进度：已执行项来自 toolSteps，未执行项来自 toolTasks；
 * 计划项在真实执行前只能是待执行 / 执行中，结果详情默认折叠。
 */
function ExecutionProgress({ message }: { message: AssistantMessage }) {
  const steps = message.toolSteps ?? []
  const tasks = buildTaskChecklist(message)
  const counts = countTaskStatuses(tasks)
  const summary = summarizeExecution(steps)
  const lines = executionSummaryLines(summary)
  const live = message.status === 'streaming'
  const hasAttention =
    counts.failed > 0 ||
    counts.needsInput > 0 ||
    counts.skipped > 0 ||
    counts.unknown > 0
  const pending = counts.pending + counts.running
  if (tasks.length === 0) return null

  return (
    <div className="mt-2 rounded-[var(--memora-radius)] border border-[var(--border)] bg-[var(--hover-fill)] px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px] text-[var(--text-muted)]">
        <span className="inline-flex items-center gap-1">
          <ListChecks size={11} />
          {live ? '执行进度' : '执行结果'} · 完成 {counts.success}/{counts.total}
        </span>
        {pending > 0 && <span>待执行 {pending}</span>}
        {counts.failed > 0 && (
          <span className="text-[var(--memora-danger-text)]">失败 {counts.failed}</span>
        )}
        {counts.needsInput > 0 && (
          <span className="text-[var(--memora-warning-text)]">
            待补充 / 确认 {counts.needsInput}
          </span>
        )}
        {counts.unknown > 0 && (
          <span className="text-[var(--memora-warning-text)]">
            状态待核对 {counts.unknown}
          </span>
        )}
        {counts.interrupted > 0 && <span>已中断 {counts.interrupted}</span>}
        {counts.skipped > 0 && <span>已跳过 {counts.skipped}</span>}
        {counts.cancelled > 0 && <span>已取消 {counts.cancelled}</span>}
      </div>
      <ul className="mt-1 flex flex-col gap-1">
        {tasks.map((task) => (
          <li
            key={task.callId}
            className="rounded-[var(--memora-radius-sm)] bg-[var(--field)] px-2 py-1"
          >
            <div className="flex items-center gap-1 text-[10.5px]">
              <TaskStatusMark status={task.status} />
              <span className="min-w-0 flex-1 truncate text-[var(--text)]">
                {task.label}
              </span>
              <span className={`shrink-0 ${taskTone(task.status)}`}>
                {TASK_STATUS_LABEL[task.status]}
              </span>
            </div>
            {task.detail && taskDetailVisible(task.status) && (
              <div className="mt-0.5 break-words text-[10px] leading-snug text-[var(--text-muted)]">
                {task.detail}
              </div>
            )}
          </li>
        ))}
      </ul>
      {(lines.length > 0 || steps.length > 0) && !live && (
        <details className="mt-1">
          <summary className="cursor-pointer text-[10.5px] text-[var(--text-muted)]">
            查看执行详情
          </summary>
          {lines.length > 0 && (
            <ul className="mt-1 flex flex-col gap-0.5 text-[10.5px] leading-relaxed text-[var(--text)]">
              {lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
          <ul className="mt-1 flex flex-col gap-1">
            {steps.map((step) => (
              <li
                key={step.callId}
                className="rounded-[var(--memora-radius-sm)] bg-[var(--hover-fill)] px-2 py-1"
              >
                <div className="flex items-center gap-1 text-[10px]">
                  <span className="min-w-0 flex-1 truncate text-[var(--text)]">
                    {step.label}
                  </span>
                  <span className={`shrink-0 ${taskTone(taskStatusFromStep(step))}`}>
                    {TASK_STATUS_LABEL[taskStatusFromStep(step)]}
                  </span>
                </div>
                <div className="mt-0.5 break-words text-[10px] leading-snug text-[var(--text-muted)]">
                  {step.message}
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
      {hasAttention && live && (
        <div className="mt-1 text-[10px] leading-snug text-[var(--text-muted)]">
          失败或等待补充的步骤会在结束后保留原因。
        </div>
      )}
    </div>
  )
}

const ACTION_META: Record<EntryKind, { label: string; icon: ReactNode }> = {
  note: { label: '备忘', icon: <FileText size={12} /> },
  todo: { label: '待办', icon: <ListChecks size={12} /> },
  reminder: { label: '提醒', icon: <Bell size={12} /> },
  draw: { label: '涂鸦', icon: <Pencil size={12} /> },
}

/** 删除确认卡片：AI 唯一需要用户确认的操作；新增与修改都已直接执行 */
function ActionCard({
  action,
  done,
  cancelled,
  invalidated,
  onDone,
  onCancelled,
}: {
  action: AssistantAction
  done: boolean
  cancelled: boolean
  invalidated: boolean
  onDone: () => void
  onCancelled: () => void
}) {
  const { message: antdMessage } = AntdApp.useApp()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  // 写入失败但提议已释放时允许原卡片重试；其它失败（过期 / 已执行 / 目标变化）直接作废
  const [retryable, setRetryable] = useState(false)
  const target = useEntryStore((state) =>
    action.targetId
      ? state.entries.find((entry) => entry.id === action.targetId)
      : undefined,
  )
  const meta = ACTION_META[target?.kind ?? action.kind]
  const title = target?.title.trim() || action.title || '无标题'
  const resolved = done || cancelled || invalidated || (failure !== null && !retryable)
  const stateLabel = done
    ? '已移入废纸篓'
    : cancelled
      ? '已取消'
      : invalidated
        ? '已失效'
        : failure
          ? retryable
            ? '删除失败，可重试'
            : '已失效'
          : '待确认'

  const handleConfirm = async (): Promise<void> => {
    if (busy || resolved) return
    setBusy(true)
    const result = await confirmDeleteProposal({
      proposalId: action.proposalId,
      targetId: action.targetId,
      expectedKind: action.kind,
      access: {
        findEntry: (id) => useEntryStore.getState().entries.find((entry) => entry.id === id),
        moveToTrash: (id) => useEntryStore.getState().moveToTrash(id),
        stillExists: (id) =>
          useEntryStore.getState().entries.some((entry) => entry.id === id),
      },
    })
    // 只回写历史表中的真实结果；历史缺失或失败不影响业务删除
    await recordDeleteConfirmed(action, result)
    setBusy(false)
    if (!result.ok) {
      setFailure(result.message)
      setRetryable(result.reason === 'failed' || result.reason === 'busy')
      return
    }
    onDone()
    antdMessage.success('已移入废纸篓')
  }

  const handleCancel = async (): Promise<void> => {
    if (busy || resolved) return
    setBusy(true)
    cancelDeleteProposal(action.proposalId)
    await recordDeleteCancelled(action)
    setBusy(false)
    onCancelled()
    antdMessage.info('已取消删除，便签没有任何改动')
  }

  return (
    <div
      className={`rounded-[var(--memora-radius)] border px-3 py-2.5 ${
        done
          ? 'border-[color-mix(in_srgb,var(--memora-success)_45%,transparent)] bg-[color-mix(in_srgb,var(--memora-success)_8%,var(--field))]'
          : cancelled || failure
            ? 'border-[var(--border)] bg-[var(--field)] opacity-80'
            : 'border-[color-mix(in_srgb,var(--memora-danger)_40%,transparent)] bg-[var(--field)]'
      }`}
    >
      <div className="flex items-center gap-1.5 text-[10.5px] text-[var(--text-muted)]">
        <span className="flex-center text-[var(--memora-danger-text)]">
          <Trash2 size={12} />
        </span>
        <span>删除便签</span>
        <span className="text-[var(--text)]">· {meta.label}</span>
        <span
          className={`ml-auto flex items-center gap-0.5 ${
            done
              ? 'font-semibold text-[var(--memora-success-text)]'
              : cancelled || failure
                ? ''
                : 'text-[var(--memora-warning-text)]'
          }`}
        >
          {done ? (
            <Check size={11} />
          ) : cancelled || failure ? null : (
            <CircleAlert size={11} />
          )}
          {stateLabel}
        </span>
      </div>

      <div className="mt-1 flex items-center gap-1.5 break-words text-[12.5px] font-semibold leading-snug text-[var(--text)]">
        <span className="text-[var(--text-muted)]">{meta.icon}</span>
        <span className="min-w-0">{title}</span>
      </div>
      <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
        {done
          ? '已从列表移入废纸篓，可在废纸篓中恢复。'
          : cancelled
            ? '已取消删除，便签内容和数据都没有改动。'
            : invalidated
              ? '这张确认卡片已失效（应用重启后一次性授权已丢失）。请让助手重新发起删除。'
              : failure
                ? failure
                : '将移入废纸篓（可在废纸篓恢复），不会永久删除。确认前不会修改任何数据。'}
      </p>

      {!resolved && (
        <div className="mt-2 flex items-center gap-2">
          <Button
            size="small"
            type="primary"
            danger
            icon={<Trash2 size={12} />}
            loading={busy}
            onClick={() => void handleConfirm()}
          >
            确认删除
          </Button>
          <Button size="small" type="text" onClick={handleCancel}>
            取消
          </Button>
        </div>
      )}
    </div>
  )
}

/** 多闹钟提醒的目标选择：只有用户点击候选才产生一次性修改授权 */
function AlarmSelectionCard({
  selection,
  done,
  cancelled,
  invalidated,
  onDone,
  onCancelled,
  onInvalidated,
  onRetry,
}: {
  selection: AssistantAlarmSelection
  done: boolean
  cancelled: boolean
  invalidated: boolean
  onDone: () => void
  onCancelled: () => void
  onInvalidated: () => void
  onRetry: () => void
}) {
  const { message: antdMessage } = AntdApp.useApp()
  const [busy, setBusy] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [expired, setExpired] = useState(
    () => selection.expiresAt <= Date.now(),
  )
  const resolved =
    done || cancelled || invalidated || expired || success !== null || failure !== null
  const stateLabel = done || success
    ? '已修改'
    : cancelled
      ? '已取消'
      : invalidated
        ? '已失效'
        : expired
          ? '已过期'
          : failure
            ? '已失效'
            : '等待选择'
  const canRetry = !done && !cancelled && (invalidated || expired || failure !== null)

  useEffect(() => {
    if (expired) return
    const remaining = selection.expiresAt - Date.now()
    if (remaining <= 0) {
      // 初始已过期：只同步注册表状态，渲染期已由 useState 初始值标记为过期
      expireAlarmSelection(selection.proposalId)
      return
    }
    const timer = window.setTimeout(() => {
      setExpired(true)
      expireAlarmSelection(selection.proposalId)
    }, remaining)
    return () => window.clearTimeout(timer)
  }, [expired, selection.expiresAt, selection.proposalId])

  const handlePick = async (alarmId: string): Promise<void> => {
    if (busy || resolved) return
    setBusy(alarmId)
    setFailure(null)
    const result = await confirmAlarmSelection({
      proposalId: selection.proposalId,
      entryId: selection.entryId,
      alarmId,
      env: createAgentToolEnv(),
    })
    setBusy(null)
    if (!result.ok) {
      // busy 表示同一次点击仍在执行，保持等待状态；其余失败均消费授权并显示失效
      if (result.reason !== 'busy') {
        setFailure(result.message)
        onInvalidated()
      }
      return
    }
    setSuccess(result.message)
    onDone()
    antdMessage.success('已修改选中的闹钟')
  }

  const handleCancel = (): void => {
    if (busy || resolved) return
    cancelAlarmSelection(selection.proposalId)
    onCancelled()
    antdMessage.info('已取消，闹钟没有任何改动')
  }

  return (
    <div
      className={`rounded-[var(--memora-radius)] border px-3 py-2.5 ${
        done || success
          ? 'border-[color-mix(in_srgb,var(--memora-success)_45%,transparent)] bg-[color-mix(in_srgb,var(--memora-success)_8%,var(--field))]'
          : cancelled || invalidated || expired || failure
            ? 'border-[var(--border)] bg-[var(--field)] opacity-80'
            : 'border-[color-mix(in_srgb,var(--memora-warning)_40%,transparent)] bg-[var(--field)]'
      }`}
    >
      <div className="flex items-center gap-1.5 text-[10.5px] text-[var(--text-muted)]">
        <span className="flex-center text-[var(--memora-warning-text)]">
          <Bell size={12} />
        </span>
        <span>选择要修改的闹钟</span>
        <span
          className={`ml-auto flex items-center gap-0.5 ${
            done || success
              ? 'font-semibold text-[var(--memora-success-text)]'
              : cancelled || invalidated || expired || failure
                ? ''
                : 'text-[var(--memora-warning-text)]'
          }`}
        >
          {done || success ? (
            <Check size={11} />
          ) : cancelled || invalidated || expired || failure ? null : (
            <CircleAlert size={11} />
          )}
          {stateLabel}
        </span>
      </div>

      <div className="mt-1 break-words text-[12.5px] font-semibold leading-snug text-[var(--text)]">
        {selection.title}
      </div>
      <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
        {success
          ? success
          : done
            ? '已修改选中的闹钟；其它闹钟与重复规则未改动。'
            : cancelled
              ? '已取消选择，闹钟没有任何改动。'
              : invalidated
                ? '已开始新任务或应用已重启，这次选择已失效；闹钟没有任何改动。'
                : expired
                  ? '这次选择已过期；闹钟没有任何改动。'
                  : failure
                    ? failure
                    : `这条提醒有 ${selection.candidates.length} 个闹钟，请选择要把时间改到 ${dayjs(
                        selection.remindAt,
                      ).format('YYYY-MM-DD HH:mm')} 的那一个。只修改选中的闹钟，其它闹钟与重复规则保持不变。`}
      </p>

      {(selection.changes ?? []).length > 0 && (
        <div className="mt-1 rounded-[var(--memora-radius-sm)] bg-[var(--hover-fill)] px-2 py-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
          <span className="font-medium text-[var(--text)]">本次点击将一并授权：</span>
          {(selection.changes ?? []).map((change) => change.label).join('；')}
        </div>
      )}

      {!resolved && (
        <div className="mt-2 flex flex-col gap-1.5">
          {selection.candidates.map((candidate) => (
            <button
              key={candidate.alarmId}
              type="button"
              disabled={busy !== null}
              className="flex w-full items-center gap-2 rounded-[var(--memora-radius-sm)] border border-[var(--border)] bg-[var(--field)] px-2 py-1.5 text-left text-[11.5px] text-[var(--text)] transition-colors hover:border-[color-mix(in_srgb,var(--memora-warning)_45%,var(--border))] hover:bg-[var(--hover-fill)] disabled:cursor-default disabled:opacity-60"
              onClick={() => void handlePick(candidate.alarmId)}
            >
              <span className="inline-flex items-center gap-1 font-medium">
                <Bell size={11} className="text-[var(--memora-warning-text)]" />
                {candidate.name && (
                  <span className="max-w-[100px] truncate">{candidate.name} · </span>
                )}
                {ALARM_MODE_LABEL[candidate.mode] ?? candidate.mode}
              </span>
              <span>{dayjs(candidate.remindAt).format('MM-DD HH:mm')}</span>
              <span className="ml-auto text-[10.5px] text-[var(--text-muted)]">
                {busy === candidate.alarmId
                  ? '修改中…'
                  : ALARM_METHOD_LABEL[candidate.method] ?? candidate.method}
              </span>
            </button>
          ))}
        </div>
      )}

      {canRetry && (
        <div className="mt-2 flex items-center gap-2">
          <Button size="small" icon={<RotateCcw size={12} />} onClick={onRetry}>
            重新发起
          </Button>
        </div>
      )}

      {!resolved && (
        <div className="mt-2">
          <Button size="small" type="text" onClick={handleCancel}>
            取消
          </Button>
        </div>
      )}
    </div>
  )
}

function MessageBubble({
  message,
  onRetry,
}: {
  message: AssistantMessage
  onRetry: () => void
}) {
  const parsed = useMemo(
    () =>
      message.role === 'assistant'
        ? parseAssistantActions(message.content)
        : { text: '', actions: [] as AssistantAction[], invalidCount: 0 },
    [message.role, message.content],
  )
  // 两阶段渲染：消毒前摘出 note-ref → markdown → 消毒 → 回填真实 <a>（点击跳转便签）
  const html = useMemo(() => {
    if (message.role !== 'assistant') return ''
    const { tokenized, refs } = extractNoteRefs(parsed.text)
    let result = markdownToHtml(tokenized)
    refs.forEach((ref, index) => {
      result = result.split(`[[NR${index}]]`).join(
        `<a class="note-ref-link" data-id="${escapeHtmlAttr(ref.id)}">${escapeHtmlText(ref.title)}</a>`,
      )
    })
    return result
  }, [message.role, parsed.text])
  const markToolActionDone = useAssistantStore((state) => state.markToolActionDone)
  const markToolActionCancelled = useAssistantStore(
    (state) => state.markToolActionCancelled,
  )
  const markToolSelectionDone = useAssistantStore(
    (state) => state.markToolSelectionDone,
  )
  const markToolSelectionCancelled = useAssistantStore(
    (state) => state.markToolSelectionCancelled,
  )
  const markToolSelectionInvalidated = useAssistantStore(
    (state) => state.markToolSelectionInvalidated,
  )
  /** 回复里的交互元素：便签引用胶囊（.note-ref-link，消毒后由前端注入）点击跳转选中对应便签；
   * 超链接走系统浏览器打开（阻止默认行为，避免 WebView2 整窗导航/opener 权限报错） */
  const handleLinkClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    const noteRef = (event.target as HTMLElement).closest(
      '.note-ref-link, note-ref'
    )
    if (noteRef) {
      const id =
        noteRef.getAttribute('data-id') ?? noteRef.getAttribute('id') ?? ''
      if (id) {
        event.preventDefault()
        if (import.meta.env.DEV) {
          console.info(`[AI] 便签引用跳转：${id}`)
        }
        useEntryStore.getState().setSelectedId(id)
        // 桌面端详情是贴纸墙 Modal（由 uiStore.detailView 控制），必须一并置位才会弹详情
        useUiStore.getState().setDetailView(true)
        useAssistantStore.getState().closePanel()
      }
      return
    }
    const link = (event.target as HTMLElement).closest('a')
    if (!link) return
    const href = link.getAttribute('href') ?? ''
    if (/^https?:\/\//i.test(href)) {
      event.preventDefault()
      void openExternal(href)
    }
  }

  if (message.role === 'user') {
    return (
      <div className="group flex flex-col items-end gap-0.5">
        <div className="max-w-[86%] whitespace-pre-wrap break-words rounded-[var(--memora-radius-card)] border border-[var(--card-active-border)] bg-[var(--card-active-bg)] px-3 py-2 text-[13px] leading-relaxed text-[var(--text)]">
          {message.content}
        </div>
        <div className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <CopyReplyButton text={message.content} />
        </div>
      </div>
    )
  }

  const showBubble =
    message.status === 'streaming' || message.stopped || Boolean(parsed.text)

  // 联网搜索状态提示：搜索中 / 已注入 N 条结果 / 搜索失败（降级为普通回答）
  const webSearch = message.webSearch
  const searchHint =
    message.status === 'streaming' && !parsed.text && webSearch?.status === 'searching'
      ? '正在联网搜索…'
      : webSearch?.status === 'done' && (webSearch.count ?? 0) > 0
        ? `已联网搜索 ${webSearch.count} 条结果`
        : webSearch?.status === 'failed'
          ? `联网搜索失败：${webSearch.error ?? '未知原因'}`
          : null
  // 旧消息只保存了轮数、没有执行记录时，退回显示轮数提示
  const toolSteps = message.toolSteps ?? []
  const toolTasks = message.toolTasks ?? []
  const hasExecution =
    toolSteps.length > 0 || toolTasks.length > 0 || message.toolLimitReached === true
  const toolHint =
    (message.toolRounds ?? 0) > 0 && toolSteps.length === 0
      ? `已执行 ${message.toolRounds} 轮便签工具`
      : null
  const phase = message.phase
  const livePhase = message.status === 'streaming' ? phase : undefined
  // 终态徽标：只在有实际执行、或结果不是「已完成」时展示，普通问答不额外加徽标
  const terminalPhase =
    message.status !== 'streaming' &&
    phase &&
    (phase !== 'done' || hasExecution)
      ? phase
      : null
  const phaseLabel = phase ? PHASE_META[phase].label : '思考中'

  return (
    <div
      className="group flex items-start gap-2"
      data-message-id={message.id}
    >
      <div className="flex-center h-6 w-6 shrink-0 rounded-full bg-[var(--card-active-bg)] text-[var(--kind-accent)]">
        <Sparkles size={13} />
      </div>
      <div className="min-w-0 flex-1">
        {showBubble && (
          <div className="rounded-[var(--memora-radius-card)] border border-[var(--border)] bg-[var(--field)] px-3 py-2 text-[13px] leading-relaxed text-[var(--text)]">
            {message.status === 'streaming' && !parsed.text && (
              <ThinkingIndicator
                startedAt={message.createdAt}
                label={
                  webSearch?.status === 'searching' ? '正在联网搜索…' : phaseLabel
                }
              />
            )}
            {searchHint && searchHint !== '正在联网搜索…' && (
              <div
                className={`mb-1 inline-flex items-center gap-1 rounded-[var(--memora-radius-sm)] px-1.5 py-0.5 text-[10.5px] leading-snug ${
                  webSearch?.status === 'failed'
                    ? 'bg-[color-mix(in_srgb,var(--memora-danger)_12%,transparent)] text-[var(--text)]'
                    : 'bg-[var(--hover-fill)] text-[var(--text-muted)]'
                }`}
              >
                <Globe
                  size={10}
                  className={
                    webSearch?.status === 'failed'
                      ? 'text-[var(--memora-danger-text)]'
                      : undefined
                  }
                />
                <span>{searchHint}</span>
              </div>
            )}
            {livePhase && parsed.text && <PhaseBadge phase={livePhase} live />}
            {toolHint && (
              <div className="mb-1 inline-flex items-center gap-1 rounded-[var(--memora-radius-sm)] bg-[color-mix(in_srgb,var(--memora-violet)_12%,transparent)] px-1.5 py-0.5 text-[10.5px] leading-snug text-[var(--text-muted)]">
                <Search size={10} className="text-[var(--memora-violet)]" />
                <span>{toolHint}</span>
              </div>
            )}
            {parsed.text && (
              <div
                className="note-md assistant-md"
                onClick={handleLinkClick}
                dangerouslySetInnerHTML={{ __html: html }}
              />
            )}
            {message.status === 'streaming' && parsed.text && (
              <span className="assistant-caret" aria-hidden />
            )}
            {message.stopped && (
              <div className="mt-1 text-[11px] leading-snug text-[var(--text-muted)]">
                已停止生成
                {(message.toolRounds ?? 0) > 0
                  ? '；停止前已开始的工具操作可能已经生效，请检查便签列表。'
                  : ''}
              </div>
            )}
            {message.truncated && message.status !== 'streaming' && (
              <div className="mt-1 text-[11px] leading-snug text-[var(--text-muted)]">
                回答因长度限制被截断，操作卡片可能不完整，可回复「继续」让 AI 重新生成。
              </div>
            )}
          </div>
        )}
        {(terminalPhase || hasExecution) && (
          <div className="mt-2 flex flex-col gap-1">
            {terminalPhase && (
              <div className="self-start">
                <PhaseBadge phase={terminalPhase} live={false} />
              </div>
            )}
            {hasExecution && <ExecutionProgress message={message} />}
          </div>
        )}
        {message.status !== 'streaming' && parsed.invalidCount > 0 && (
          <div className="mt-2 flex items-start gap-1 text-[11px] leading-snug text-[var(--text-muted)]">
            <TriangleAlert size={11} className="mt-[2px] shrink-0" />
            <span>
              有 {parsed.invalidCount} 个操作卡片解析失败（格式异常或被截断），可让
              AI 重新生成。
            </span>
          </div>
        )}
        {message.status !== 'streaming' && (message.toolSelections ?? []).length > 0 && (
          <div className="mt-2 flex flex-col gap-2">
            {(message.toolSelections ?? []).map((selection) => (
              <AlarmSelectionCard
                key={selection.proposalId}
                selection={selection}
                done={(message.toolSelectionsDone ?? []).includes(
                  selection.proposalId,
                )}
                cancelled={(message.toolSelectionsCancelled ?? []).includes(
                  selection.proposalId,
                )}
                invalidated={(message.toolSelectionsInvalidated ?? []).includes(
                  selection.proposalId,
                )}
                onDone={() =>
                  markToolSelectionDone(message.id, selection.proposalId)
                }
                onCancelled={() =>
                  markToolSelectionCancelled(message.id, selection.proposalId)
                }
                onInvalidated={() =>
                  markToolSelectionInvalidated(message.id, selection.proposalId)
                }
                onRetry={() =>
                  void useAssistantStore
                    .getState()
                    .send(
                      `请重新发起「${selection.title}」的提醒时间修改（之前的选择已失效）。`,
                    )
                }
              />
            ))}
          </div>
        )}
        {message.status !== 'streaming' && (message.toolActions ?? []).length > 0 && (
          <div className="mt-2 flex flex-col gap-2">
            {(message.toolActions ?? []).map((action, index) => (
              <ActionCard
                key={`${message.id}:tool:${index}`}
                action={action}
                done={(message.toolActionsDone ?? []).includes(index)}
                cancelled={(message.toolActionsCancelled ?? []).includes(index)}
                invalidated={(message.toolActionsInvalidated ?? []).includes(index)}
                onDone={() => markToolActionDone(message.id, index)}
                onCancelled={() => markToolActionCancelled(message.id, index)}
              />
            ))}
          </div>
        )}
        {parsed.text && message.status !== 'streaming' && (
          <div className="mt-0.5 flex justify-end opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <CopyReplyButton text={parsed.text} />
          </div>
        )}
        {message.status === 'error' && (
          <ErrorCard message={message} onRetry={onRetry} />
        )}
      </div>
    </div>
  )
}

function AssistantPanelBody() {
  const { message: antdMessage } = AntdApp.useApp()
  const messages = useAssistantStore((state) => state.messages)
  const input = useAssistantStore((state) => state.input)
  const sending = useAssistantStore((state) => state.sending)
  const contextEnabled = useAssistantStore((state) => state.contextEnabled)
  const webSearchEnabled = useAssistantStore((state) => state.webSearch)
  const entryCount = useEntryStore((state) => state.entries.length)
  const setInput = useAssistantStore((state) => state.setInput)
  const send = useAssistantStore((state) => state.send)
  const stop = useAssistantStore((state) => state.stop)
  const retry = useAssistantStore((state) => state.retry)
  const clear = useAssistantStore((state) => state.clear)
  const closePanel = useAssistantStore((state) => state.closePanel)
  const togglePanel = useAssistantStore((state) => state.togglePanel)
  const setContextEnabled = useAssistantStore((state) => state.setContextEnabled)
  const setWebSearch = useAssistantStore((state) => state.setWebSearch)
  const aiStatus = useAiProfileStore((state) => state.status)
  const aiLoad = useAiProfileStore((state) => state.load)
  const aiActivate = useAiProfileStore((state) => state.activate)
  const aiSync = useAiProfileStore((state) => state.sync)
  const [reasoningBusy, setReasoningBusy] = useState(false)
  const aiProfiles = aiStatus?.profiles ?? EMPTY_PROFILES
  const activeProfile =
    aiProfiles.find((profile) => profile.id === aiStatus?.activeId) ?? null
  const openSettings = useUiStore((state) => state.openSettings)

  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const modelSelectRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  // 弹层高度：按触发器上下可用空间取大者，避免小窗口下列表被裁掉
  const [modelListHeight, setModelListHeight] = useState(240)
  const [historyOpen, setHistoryOpen] = useState(false)

  const fitModelDropdown = () => {
    const rect = modelSelectRef.current?.getBoundingClientRect()
    if (!rect) return
    const spaceAbove = rect.top - 48
    const spaceBelow = window.innerHeight - rect.bottom - 8
    const space = Math.max(spaceAbove, spaceBelow)
    setModelListHeight(Math.max(96, Math.min(280, Math.round(space - 16))))
  }

  // 下拉分组：自己新增的模型在前，内置免费模型在后，用组标题作分隔
  const modelOptionGroups = useMemo(() => {
    const toOption = (profile: (typeof aiProfiles)[number]) => ({
      value: profile.id,
      label: (
        <span className="flex min-w-0 items-center gap-1">
          <span className="truncate">{profile.name}</span>
          {profile.free && <FreeBadge />}
          {profile.free && <ModalityBadge modality={profile.modality} />}
        </span>
      ),
      // 语音 / 视频 / 图片模型走不了 chat/completions，只展示不可选
      disabled: !profile.configured || isNonTextModality(profile.modality),
    })
    const custom = aiProfiles.filter((profile) => !profile.free)
    const free = aiProfiles.filter((profile) => profile.free)
    return [
      ...(custom.length
        ? [{ label: '我的模型', options: custom.map(toOption) }]
        : []),
      ...(free.length
        ? [{ label: '内置免费模型', options: free.map(toOption) }]
        : []),
    ]
  }, [aiProfiles])

  // 打开面板时同步模型配置列表（设置页保存后共享同一 store）
  useEffect(() => {
    void aiLoad().catch(() => undefined)
  }, [aiLoad])

  // 自动滚动：仅当用户停留在底部附近时跟随新内容，避免打断向上翻阅
  useEffect(() => {
    const element = scrollRef.current
    if (element && atBottomRef.current) {
      element.scrollTop = element.scrollHeight
    }
  }, [messages])

  // 输入框随内容增高（上限 120px），保持紧凑
  useEffect(() => {
    const element = inputRef.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 120)}px`
  }, [input])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // 设置弹窗打开时由弹窗处理 Esc，避免同时关闭面板
      if (useUiStore.getState().settingsOpen) return
      if (historyOpen) {
        setHistoryOpen(false)
        return
      }
      togglePanel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [historyOpen, togglePanel])

  const handleScroll = () => {
    const element = scrollRef.current
    if (!element) return
    atBottomRef.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < 60
  }

  const handleSend = (text?: string) => {
    atBottomRef.current = true
    void send(text)
  }

  /** 从执行历史回到原对话：消息可能因清空或保留条数上限而不存在，需明确提示 */
  const handleJumpToMessage = (messageId: string) => {
    setHistoryOpen(false)
    window.setTimeout(() => {
      const target = Array.from(
        scrollRef.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [],
      ).find((element) => element.dataset.messageId === messageId)
      if (!target) {
        antdMessage.warning('原对话已不在当前会话中（可能已被清空或超出保留条数）')
        return
      }
      target.scrollIntoView({ block: 'center' })
      target.style.outline = '2px solid var(--kind-accent)'
      target.style.outlineOffset = '4px'
      window.setTimeout(() => {
        target.style.outline = ''
        target.style.outlineOffset = ''
      }, 1600)
    }, 60)
  }

  /** 推理强度保存在模型配置里：切换后同一条配置的后续提问都生效 */
  const handleReasoningChange = async (key: string) => {
    if (!activeProfile || reasoningBusy || sending) return
    const next: ReasoningEffort | '' =
      key === 'default' ? '' : (key as ReasoningEffort)
    if ((activeProfile.reasoning ?? '') === next) return
    setReasoningBusy(true)
    try {
      const status = await saveAiProfile({
        id: activeProfile.id,
        name: activeProfile.name,
        provider: activeProfile.provider,
        baseUrl: activeProfile.baseUrl,
        model: activeProfile.model,
        reasoning: next,
      })
      aiSync(status)
      antdMessage.success(
        next ? `推理强度：${REASONING_SHORT[next]}` : '推理强度：默认',
      )
    } catch (error) {
      antdMessage.error(
        `设置失败：${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      setReasoningBusy(false)
    }
  }

  return (
    <section className="assistant-panel" aria-label="AI 助手" data-tauri-drag-region="false">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[rgba(var(--panel-soft-rgb),var(--chrome-alpha))] px-3">
        <Sparkles size={16} className="text-[var(--kind-accent)]" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-[var(--text)]">AI 助手</div>
          <div className="truncate text-[10.5px] text-[var(--text-muted)]">
            {sending ? '正在回答…' : '基于你的便签回答'}
          </div>
        </div>
        <Tooltip title="执行历史">
          <button
            type="button"
            className={`titlebar-btn ${historyOpen ? 'text-[var(--kind-accent)]' : ''}`}
            aria-label="查看执行历史"
            aria-pressed={historyOpen}
            onClick={() => setHistoryOpen((open) => !open)}
          >
            <History size={14} />
          </button>
        </Tooltip>
        <Tooltip title="管理模型配置">
          <button
            type="button"
            className="titlebar-btn"
            aria-label="管理模型配置"
            onClick={() => openSettings('ai-config')}
          >
            <Settings2 size={14} />
          </button>
        </Tooltip>
        <button
          type="button"
          className="titlebar-btn"
          aria-label="关闭 AI 助手"
          title="关闭"
          onClick={closePanel}
        >
          <X size={15} />
        </button>
      </header>

      {historyOpen ? (
        <AgentHistoryPanel
          onClose={() => setHistoryOpen(false)}
          onJumpToMessage={handleJumpToMessage}
        />
      ) : (
        <>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="assistant-scroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3"
      >
        {messages.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center px-2 text-center">
            <div className="flex-center mb-2 h-10 w-10 rounded-full bg-[var(--card-active-bg)] text-[var(--kind-accent)]">
              <Sparkles size={20} />
            </div>
            <div className="text-[13.5px] font-semibold text-[var(--text)]">
              有什么可以帮你？
            </div>
            <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
              {contextEnabled
                ? `我会结合你的 ${entryCount} 条便签回答；找不到依据时会直接说明。`
                : '便签上下文已关闭，我只能回答通用问题。'}
            </p>
            <div className="mt-4 flex w-full flex-col gap-1.5">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="rounded-[var(--memora-radius)] border border-[var(--border)] bg-[var(--field)] px-3 py-2 text-left text-[12px] text-[var(--text)] transition hover:border-[var(--card-border-hover)] hover:bg-[var(--hover-fill)]"
                  onClick={() => handleSend(suggestion)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              onRetry={() => void retry()}
            />
          ))
        )}
      </div>

      <footer className="shrink-0 px-2.5 pb-2.5 pt-1.5">
        {/* 输入卡片：正文区 + 虚线分隔 + 底部工具条（对齐参考布局） */}
        <div className="flex flex-col overflow-hidden rounded-[var(--memora-radius-lg)] border border-[var(--control-border)] bg-[var(--field)] transition-colors focus-within:border-[var(--kind-accent)]">
          <textarea
            ref={inputRef}
            rows={1}
            className="assistant-input max-h-[120px] min-h-[56px] w-full resize-none border-0 bg-transparent px-3 pt-2.5 pb-1.5 text-[13px] leading-relaxed text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]"
            placeholder="向 AI 提问，基于你的便签回答…"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                if (!sending && input.trim()) handleSend()
              }
            }}
          />
          <div className="flex items-center gap-1 border-t  border-[var(--border)] px-1.5 py-1.5">
            <Popconfirm
              title="清空当前对话？"
              description="仅删除本机保存的聊天记录，不影响便签内容。"
              okText="清空"
              cancelText="取消"
              onConfirm={clear}
              disabled={messages.length === 0}
            >
              <button
                type="button"
                className="flex-center h-7 w-7 shrink-0 cursor-pointer rounded-full border-0 bg-transparent p-0 text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-fill)] hover:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                aria-label="新建对话"
                title="新建对话"
                disabled={messages.length === 0}
              >
                <Plus size={16} />
              </button>
            </Popconfirm>
            <button
              type="button"
              className={`flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border-0 bg-transparent px-1 text-[10.5px] transition-colors hover:bg-[var(--hover-fill)] ${
                contextEnabled
                  ? "text-[var(--kind-accent)]"
                  : "text-[var(--text-muted)]"
              }`}
              aria-label={contextEnabled ? "关闭便签上下文" : "启用便签上下文"}
              title={
                contextEnabled
                  ? "已启用：提问会附带便签摘要，点击关闭上下文"
                  : "已关闭：只回答通用问题，点击启用上下文"
              }
              onClick={() => setContextEnabled(!contextEnabled)}
            >
              {contextEnabled ? <ShieldCheck size={13} /> : <ShieldOff size={13} />}
            </button>

            <button
              type="button"
              className={`flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border-0 bg-transparent px-1 text-[10.5px] transition-colors hover:bg-[var(--hover-fill)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${
                webSearchEnabled
                  ? "text-[var(--kind-accent)]"
                  : "text-[var(--text-muted)]"
              }`}
              aria-label={webSearchEnabled ? "关闭联网搜索" : "开启联网搜索"}
              title={
                webSearchEnabled
                  ? "已开启：提问会先搜索必应并把结果注入上下文，点击关闭"
                  : "已关闭：点击开启联网搜索（提问会先把问题发送到必应）"
              }
              disabled={sending}
              onClick={() => setWebSearch(!webSearchEnabled)}
            >
              <Globe size={13} />
            </button>

            {activeProfile && (
              <Dropdown
                trigger={['click']}
                placement="top"
                disabled={sending || reasoningBusy || activeProfile.readOnly}
                menu={{
                  selectable: true,
                  selectedKeys: [activeProfile.reasoning ?? 'default'],
                  items: REASONING_ITEMS.map((item) => ({
                    key: item.key,
                    label: item.label,
                  })),
                  onClick: ({ key }) => void handleReasoningChange(key),
                }}
              >
                <button
                  type="button"
                  className={`flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-full border-0 bg-transparent px-2 text-[10.5px] transition-colors hover:bg-[var(--hover-fill)] disabled:cursor-not-allowed disabled:opacity-40 ${
                    activeProfile.reasoning
                      ? 'text-[var(--text)]'
                      : 'text-[var(--text-muted)]'
                  }`}
                  aria-label="切换推理强度"
                  title={
                    activeProfile.readOnly
                      ? '内置免费模型不支持调整推理强度'
                      : `推理强度：${REASONING_SHORT[activeProfile.reasoning ?? 'default']}，点击切换（关闭思考可显著加快首字）`
                  }
                  disabled={sending || reasoningBusy || activeProfile.readOnly}
                >
                  <Brain size={12} />
                  <span>推理·{REASONING_SHORT[activeProfile.reasoning ?? 'default']}</span>
                </button>
              </Dropdown>
            )}

            <div ref={modelSelectRef} className="ml-auto flex min-w-0 items-center gap-1">
              {aiProfiles.length > 0 ? (
                <Select
                  size="small"
                  variant="borderless"
                  className="assistant-model-select"
                  value={activeProfile?.id}
                  prefix={
                    <ProviderMark
                      provider={activeProfile?.provider ?? ''}
                      baseUrl={activeProfile?.baseUrl ?? ''}
                      size={14}
                    />
                  }
                  popupMatchSelectWidth={false}
                  listHeight={modelListHeight}
                  onOpenChange={(open) => {
                    if (open) fitModelDropdown()
                  }}
                  classNames={{ popup: { root: 'assistant-model-dropdown' } }}
                  disabled={sending}
                  placeholder="选择模型"
                  title={
                    activeProfile
                      ? `${activeProfile.provider} · ${activeProfile.model} · ${activeProfile.baseUrl}`
                      : undefined
                  }
                  options={modelOptionGroups}
                  optionRender={(option) => {
                    const profile = aiProfiles.find(
                      (item) => item.id === option.value
                    )
                    if (!profile) return option.label
                    return (
                      <div className="flex min-w-0 flex-col">
                        <span className="flex items-center gap-1">
                          <span className="truncate text-[12px] text-[var(--text)]">
                            {profile.name}
                          </span>
                          {profile.free && <FreeBadge />}
                          {profile.free && (
                            <ModalityBadge modality={profile.modality} />
                          )}
                          {!profile.configured && (
                            <span className="shrink-0 rounded-full border border-[var(--danger)] px-1.5 text-[9px] leading-[14px] text-[var(--danger)]">
                              缺少密钥
                            </span>
                          )}
                        </span>
                        <span className="truncate text-[10px] text-[var(--text-muted)]">
                          {profile.free && profile.sourceLabel
                            ? `${profile.sourceLabel} · ${profile.model}`
                            : `${profile.provider} · ${profile.model}`}
                        </span>
                      </div>
                    )
                  }}
                  onChange={(id) => {
                    void aiActivate(id).catch(() => undefined)
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="h-7 min-w-0 cursor-pointer truncate rounded-full border-0 bg-transparent px-2 text-[10.5px] text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-fill)] hover:text-[var(--text)]"
                  onClick={() => openSettings('ai-config')}
                >
                  添加模型
                </button>
              )}
              {sending ? (
                <button
                  type="button"
                  className="flex-center h-8 w-8 shrink-0 cursor-pointer rounded-[var(--memora-radius)] border-0 bg-[var(--danger)] p-0 text-[var(--memora-on-primary)] transition-opacity hover:opacity-90"
                  onClick={stop}
                  title="停止生成"
                  aria-label="停止生成"
                >
                  <Square size={11} fill="currentColor" />
                </button>
              ) : (
                <button
                  type="button"
                  className="flex-center h-8 w-8 shrink-0 cursor-pointer rounded-[var(--memora-radius)] border-0 bg-[var(--kind-accent)] p-0 text-[var(--memora-on-primary)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-35"
                  disabled={!input.trim()}
                  onClick={() => handleSend()}
                  title="发送（Enter）"
                  aria-label="发送"
                >
                  <ArrowUp size={16} strokeWidth={2.5} />
                </button>
              )}
            </div>
          </div>
        </div>
      </footer>
        </>
      )}
    </section>
  )
}

export function AssistantPanel() {
  const open = useAssistantStore((state) => state.open)
  if (!open) return null
  return <AssistantPanelBody />
}
