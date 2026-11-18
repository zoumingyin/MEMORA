import { create } from 'zustand'
import { buildAssistantContext } from '../services/assistantContext'
import { createAgentToolScope, executeAgentTool } from '../services/agentTools'
import {
  commitStagedCandidates,
  seedTrustedTargets,
  type AgentToolScope,
  type ToolPermission,
  type WriteAttempt,
} from '../services/agentToolExecutor'
import {
  buildConversationMemory,
  buildMemoryPromptBlock,
  createConversationMemoryCache,
} from '../services/conversationMemory'
import { resolveConversationReferent } from '../services/conversationReferents'
import {
  buildExecutionOutcomeNotice,
  buildPlannedTasks,
  buildRoundLimitTasks,
  cancelUnfinishedTasks,
  taskStatusFromOutcome,
} from '../services/agentProgress'
import {
  buildContinuationContext,
  isContinuationRequest,
} from '../services/agentContinuation'
import {
  hasReferentWriteClause,
  hasSelectedReferentWriteIntent,
  resolveExplicitIdTargets,
  resolveExplicitTitleTargets,
} from '../services/agentTargets'
import {
  buildRetryLedger,
  mergeRetryLedger,
  retryBlockedWriteTools,
  retrySystemNote,
  retryWriteSignatures,
  type RetryLedger,
} from '../services/agentRetryLedger'
import {
  MAX_TOOL_ROUNDS,
  appendNotice,
  buildRoundLimitNotice,
  callsAreReadOnly,
  deriveFinalPhase,
  executeToolBatch,
  shouldDegradeTools,
} from '../services/agentExecution'
import { classifyModelFailure } from '../services/agentFailure'
import type { AgentFailure } from '../services/agentFailure'
import { getExecutionRecorder } from '../services/executionRecorder'
import {
  buildExecutionTitle,
  deriveExecutionStatus,
  summarizeUserInput,
} from '../services/executionHistory'
import {
  analyzeAssistantIntent,
  degradeToolPrompt,
  planAssistantTools,
} from '../services/assistantIntent'
import { resetDeleteProposals } from '../services/deleteProposals'
import { invalidatePendingSelections, invalidatePendingToolActions } from '../utils/assistantSelectionLifecycle'
import {
  cancelPendingAlarmSelections,
  resetAlarmSelections,
} from '../services/alarmSelections'
import { cancelChat, streamChat } from '../services/aiClient'
import { formatWebResults, searchWeb } from '../services/webSearch'
import { type AssistantAction } from '../utils/assistantActions'
import { useAiProfileStore } from './useAiProfileStore'
import { useEntryStore } from './useEntryStore'
import type {
  AiChatMessage,
  AiErrorInfo,
  AiToolCall,
  AiToolDefinition,
  AssistantMessage,
  AssistantPhase,
  AssistantToolStep,
  AssistantToolTask,
  AssistantWriteAttempt,
} from '../types/ai'

/** 对话持久化：仅保留最近若干条，避免 localStorage 无限增长 */
const STORAGE_KEY = 'bianqian.assistant.v1'
const MAX_STORED_MESSAGES = 40
/** 流式增量合并刷新间隔：逐 token setState 会导致整个消息列表高频重渲染 */
const FLUSH_INTERVAL_MS = 50

/** 摘要缓存只服务当前会话；清空会话时一并丢弃，避免跨会话复用 */
const conversationMemoryCache = createConversationMemoryCache()

interface PersistedAssistant {
  messages: AssistantMessage[]
  contextEnabled: boolean
  webSearch: boolean
  /** 当前对话标识：执行历史据此关联原始对话（清空对话后重新生成） */
  conversationId: string
}

function isMessage(value: unknown): value is AssistantMessage {
  if (typeof value !== 'object' || value === null) return false
  const message = value as Record<string, unknown>
  return (
    typeof message.id === 'string' &&
    (message.role === 'user' || message.role === 'assistant') &&
    typeof message.content === 'string' &&
    typeof message.createdAt === 'number' &&
    (message.status === 'done' ||
      message.status === 'streaming' ||
      message.status === 'error')
  )
}


function loadPersisted(): PersistedAssistant {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return {
        messages: [],
        contextEnabled: true,
        webSearch: false,
        conversationId: crypto.randomUUID(),
      }
    }
    const parsed = JSON.parse(raw) as Partial<PersistedAssistant>
    const messages = Array.isArray(parsed.messages)
      ? parsed.messages
          .filter(isMessage)
          .slice(-MAX_STORED_MESSAGES)
          .map((message): AssistantMessage =>
            message.status === 'streaming'
              ? {
                  ...message,
                  // 上次异常退出时残留的「生成中」消息：有内容则视为完成，空消息直接丢弃；
                  // 清理未结束的阶段标记，避免重启后仍显示「正在执行」
                  status: message.content ? 'done' : 'error',
                  phase: undefined,
                  needsInput: undefined,
                  error: message.content
                    ? message.error
                    : { code: 'interrupted', message: '上次回答因应用退出中断，可点击重试。' },
                }
              : message,
          )
          .filter((message) => message.status !== 'error' || message.content.length > 0)
          // 重启后没有执行器可继续推进：未开始的计划项按取消展示，不能显示为执行中
          .map((message) =>
            message.toolTasks?.length
              ? { ...message, toolTasks: cancelUnfinishedTasks(message.toolTasks) }
              : message,
          )
      : []
    return {
      // 应用重启后内存授权表为空：所有未完成的候选卡片都必须显示为已失效
      // 删除提议同样只存在内存中，重启后旧卡片不能再次获得授权
      messages: invalidatePendingToolActions(invalidatePendingSelections(messages)),
      contextEnabled:
        typeof parsed.contextEnabled === 'boolean' ? parsed.contextEnabled : true,
      webSearch: parsed.webSearch === true,
      conversationId:
        typeof parsed.conversationId === 'string' && parsed.conversationId
          ? parsed.conversationId
          : crypto.randomUUID(),
    }
  } catch {
    return {
      messages: [],
      contextEnabled: true,
      webSearch: false,
      conversationId: crypto.randomUUID(),
    }
  }
}

/** 持久化当前快照：消息 + 两个会话开关 + 对话标识 */
function persistSnapshot(
  messages: AssistantMessage[],
  contextEnabled: boolean,
  webSearch: boolean,
): void {
  try {
    const stored = messages
      .filter((message) => message.status !== 'streaming' || message.content.length > 0)
      .slice(-MAX_STORED_MESSAGES)
      .map((message) =>
        message.status === 'streaming'
          ? { ...message, status: 'done' as const }
          : message,
      )
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ messages: stored, contextEnabled, webSearch, conversationId }),
    )
  } catch {
    // 存储不可用（隐私模式 / 配额满）时静默跳过，不影响对话
  }
}

/** 当前进行中的请求：用于停止生成、丢弃取消后的迟到事件，以及停止时保留已执行记录 */
let active: {
  requestId: string
  assistantId: string
  steps: AssistantToolStep[]
  /** 与执行作用域共享同一数组：停止时也能知道哪些写入已经成功 */
  writeAttempts: WriteAttempt[]
  /** 续办来源消息已携带的成功签名：收尾时并入新消息，避免多轮续办丢失幂等保护 */
  carriedWriteAttempts: AssistantWriteAttempt[]
} | null = null

/** 最近一次请求级失败的重试账本：只服务于同一次 retry，新用户消息不继承 */
let retryLedger: RetryLedger | null = null
/** retry() 与 send() 之间的短生命周期交接，避免公开 send 签名变化 */
let pendingRetryLedger: RetryLedger | null = null

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 续办幂等携带的创建 / 修改签名：
 * - 成功写入必须携带，避免续办重复执行；
 * - 写入状态不确定（回读失败 / 执行异常）也必须携带，宁可少写不可重复写；
 * - 明确失败（未生效）不携带，允许重新校验后重试。
 */
function carryWriteAttempts(
  attempts: WriteAttempt[],
  steps: AssistantToolStep[],
): AssistantWriteAttempt[] {
  const stepByCall = new Map(steps.map((step) => [step.callId, step]))
  return attempts
    .filter((attempt) => {
      if (attempt.tool !== 'create_entry' && attempt.tool !== 'update_entry') {
        return false
      }
      const step = stepByCall.get(attempt.callId)
      // 进入执行器但没有记录的写入同样视为不确定
      if (!step) return true
      return step.status === 'ok' || step.failure?.writeState === 'unknown'
    })
    .map((attempt) => ({
      callId: attempt.callId,
      tool: attempt.tool as AssistantWriteAttempt['tool'],
      signature: attempt.signature,
    }))
}

/** 续办链上累计成功签名：同签名只保留最新一条 */
function mergeWriteAttempts(
  carried: AssistantWriteAttempt[],
  current: AssistantWriteAttempt[],
): AssistantWriteAttempt[] {
  const bySignature = new Map<string, AssistantWriteAttempt>()
  for (const attempt of [...carried, ...current]) {
    bySignature.set(attempt.signature, attempt)
  }
  return Array.from(bySignature.values())
}

interface AssistantState {
  open: boolean
  messages: AssistantMessage[]
  input: string
  sending: boolean
  /** 是否允许把便签内容作为上下文发送给 AI（隐私开关，默认开启） */
  contextEnabled: boolean
  /** 是否开启联网搜索：提问前先搜必应并把结果注入上下文（默认关闭） */
  webSearch: boolean
  openPanel: () => void
  closePanel: () => void
  togglePanel: () => void
  setInput: (value: string) => void
  setContextEnabled: (enabled: boolean) => void
  setWebSearch: (enabled: boolean) => void
  send: (text?: string) => Promise<void>
  stop: () => void
  retry: () => Promise<void>
  clear: () => void
  /** 记录某条回答里工具产生的删除提议已执行，避免重复执行 */
  markToolActionDone: (messageId: string, index: number) => void
  /** 记录删除提议已被用户取消：取消后不能再执行 */
  markToolActionCancelled: (messageId: string, index: number) => void
  /** 记录候选闹钟选择已由用户执行，避免刷新后重复展示为待选择 */
  markToolSelectionDone: (messageId: string, proposalId: string) => void
  /** 记录候选闹钟选择已被用户取消 */
  markToolSelectionCancelled: (messageId: string, proposalId: string) => void
  /** 记录候选闹钟选择执行失败后已失效（重开面板也不能再次显示为等待选择） */
  markToolSelectionInvalidated: (messageId: string, proposalId: string) => void
}

const initial = loadPersisted()
/** 当前对话标识：随消息快照持久化，清空对话时重新生成；不构成任何授权 */
let conversationId = initial.conversationId

export const useAssistantStore = create<AssistantState>((set, get) => ({
  open: false,
  messages: initial.messages,
  input: '',
  sending: false,
  contextEnabled: initial.contextEnabled,
  webSearch: initial.webSearch,

  openPanel: () => set({ open: true }),
  closePanel: () => set({ open: false }),
  togglePanel: () => set((state) => ({ open: !state.open })),
  setInput: (value) => set({ input: value }),

  setContextEnabled: (enabled) => {
    set({ contextEnabled: enabled })
    persistSnapshot(get().messages, enabled, get().webSearch)
  },

  setWebSearch: (enabled) => {
    set({ webSearch: enabled })
    persistSnapshot(get().messages, get().contextEnabled, enabled)
  },

  send: async (text) => {
    const state = get()
    if (state.sending) return
    const content = (text ?? state.input).trim()
    if (!content) return

    const retryContext = pendingRetryLedger
    pendingRetryLedger = null
    // 普通新消息不继承失败重试账本；retry() 会在调用前显式交接
    if (!retryContext) retryLedger = null

    // 新任务开始：上一轮遗留的候选闹钟授权全部作废，禁止跨请求复用
    cancelPendingAlarmSelections()
    const baseMessages = invalidatePendingSelections(state.messages)

    const entriesState = useEntryStore.getState()
    // 「删除「周报」这条」里的「这条」是同位语：当前消息已唯一命中真实条目时，
    // 不再走历史指代解析，避免被解析不到的历史候选强制降为只读。
    const explicitTargetIds = new Set(
      [
        ...resolveExplicitIdTargets(content, entriesState.entries),
        ...resolveExplicitTitleTargets(content, entriesState.entries),
      ].map((entry) => entry.id),
    )
    const hasExplicitTarget = explicitTargetIds.size === 1
    // 对话记忆：最近原始消息 + 较早消息摘要 + 当前任务 + 指代候选项。
    // 记忆只用于理解指代，不产生写入授权；真实授权仍由执行层按本轮消息校验。
    const memory = buildConversationMemory(state.messages, {
      cache: conversationMemoryCache,
    })
    // 用户明确说「这条 / 当前选中」时，列表选中项优先于历史指代；
    // 避免把「把这条笔记改成……」误判成需要历史解析。
    const selectedReferentWrite =
      Boolean(entriesState.selectedId) && hasSelectedReferentWriteIntent(content)
    const referent =
      selectedReferentWrite || hasExplicitTarget
        ? null
        : resolveConversationReferent(content, memory, entriesState.entries)
    const referentWrite =
      referent !== null && hasReferentWriteClause(content, content.indexOf(referent.phrase))
    const resolvedReferent = referentWrite && referent.status === 'resolved' ? referent : null
    const referentQuestion =
      referentWrite && referent && referent.status !== 'resolved'
        ? referent.question
        : null

    // 续办：只读取历史真实执行记录，生成限制说明；不恢复旧请求的权限与目标
    const continuation = isContinuationRequest(content)
      ? buildContinuationContext(state.messages, {
          cancelled: memory.activeContext?.cancelled === true,
        })
      : null
    const continuationQuestion =
      continuation && !continuation.hasActionableWork ? continuation.question : null

    // 仅开发环境：记录首字/总耗时与实际接收量，便于区分「上游慢」与「本地处理慢」
    const devTiming = import.meta.env.DEV
      ? {
          startedAt: performance.now(),
          firstDeltaAt: null as number | null,
          chunks: 0,
          chars: 0,
        }
      : null
    let timingReported = false
    const reportTiming = (outcome: string) => {
      if (!devTiming || timingReported) return
      timingReported = true
      const elapsed = Math.round(performance.now() - devTiming.startedAt)
      const first =
        devTiming.firstDeltaAt === null
          ? '无'
          : `${Math.round(devTiming.firstDeltaAt - devTiming.startedAt)}ms`
      console.info(
        `[AI] ${outcome}：首字 ${first} · 总耗时 ${elapsed}ms · 接收 ${devTiming.chunks} 段 / ${devTiming.chars} 字`,
      )
    }

    const now = Date.now()
    const userMessage: AssistantMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      createdAt: now,
      status: 'done',
    }
    const assistantId = crypto.randomUUID()
    const assistantMessage: AssistantMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      createdAt: now,
      status: 'streaming',
      phase: 'understanding',
    }

    set({
      messages: [...baseMessages, userMessage, assistantMessage],
      input: '',
      sending: true,
      open: true,
    })
    persistSnapshot(get().messages, state.contextEnabled, state.webSearch)

    const requestId = crypto.randomUUID()
    // 执行记录与 active 共享同一数组：用户点停止时也能看到停止前已完成的步骤
    const steps: AssistantToolStep[] = []
    active = {
      requestId,
      assistantId,
      steps,
      writeAttempts: [],
      carriedWriteAttempts: continuation?.writeAttempts ?? [],
    }
    // 幂等集合与过期判断都绑定本次请求：旧请求不会执行未开始的工具
    const isStale = () => active?.requestId !== requestId
    let toolScope: AgentToolScope | null = null

    // 执行历史独立于聊天消息：请求开始即建记录，工具事件与收尾异步落盘。
    // 历史写入失败不会中断 Agent，也不参与任何权限 / 幂等判断。
    const historyRecorder = getExecutionRecorder()
    historyRecorder.start({
      id: requestId,
      conversationId,
      messageId: assistantId,
      requestId,
      title: buildExecutionTitle(content),
      userInput: summarizeUserInput(content),
      startedAt: now,
    })
    const finishHistory = (input: {
      phase: AssistantPhase
      tasks?: AssistantToolTask[]
      stopped?: boolean
      requestFailed?: boolean
      needsInput?: boolean
      limitReached?: boolean
      failure?: AgentFailure
      errorMessage?: string
    }) => {
      historyRecorder.finish({
        executionId: requestId,
        status: deriveExecutionStatus({
          steps,
          ...(input.tasks ? { tasks: input.tasks } : {}),
          ...(input.stopped ? { stopped: true } : {}),
          ...(input.requestFailed ? { requestFailed: true } : {}),
          ...(input.needsInput ? { needsInput: true } : {}),
          ...(input.limitReached ? { limitReached: true } : {}),
        }),
        phase: input.phase,
        finishedAt: Date.now(),
        steps,
        ...(input.tasks ? { tasks: input.tasks } : {}),
        ...(input.failure ? { failure: input.failure } : {}),
        ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
      })
    }

    // 历史消息：最近原始对话由对话记忆提供（已剥离 <action> 块并受条数 / 字数约束），
    // 更早内容压缩进 system 的记忆块；当前用户消息始终保留。
    const history: AiChatMessage[] = [...memory.recent, { role: 'user', content }]
    const historyChars = history.reduce((total, message) => total + message.content.length, 0)

    const contextStartedAt = performance.now()
    const context = buildAssistantContext(
      entriesState.entries,
      entriesState.selectedId,
      state.contextEnabled,
    )
    const contextMs = performance.now() - contextStartedAt

    // 使用对话界面当前选中的模型配置；未加载时由后端回落到当前配置
    const profileId = useAiProfileStore.getState().status?.activeId ?? null
    if (devTiming) {
      console.info(
        `[AI] 请求：上下文构建 ${contextMs.toFixed(1)}ms · system ${context.systemPrompt.length} 字 · 历史 ${history.length} 条 / ${historyChars} 字 · 模型 ${profileId ?? '默认'}`,
      )
    }

    let pending = ''
    let flushTimer: number | undefined
    const flush = () => {
      if (!pending) return
      const chunk = pending
      pending = ''
      set((current) => ({
        messages: current.messages.map((message) =>
          message.id === assistantId
            ? { ...message, content: message.content + chunk }
            : message,
        ),
      }))
    }
    const scheduleFlush = () => {
      if (flushTimer !== undefined) return
      flushTimer = window.setTimeout(() => {
        flushTimer = undefined
        flush()
      }, FLUSH_INTERVAL_MS)
    }
    const finalize = (
      mutator: (current: AssistantState) => Partial<AssistantState>,
    ) => {
      if (flushTimer !== undefined) {
        window.clearTimeout(flushTimer)
        flushTimer = undefined
      }
      flush()
      set(mutator)
      active = null
      persistSnapshot(get().messages, get().contextEnabled, get().webSearch)
    }

    /** 更新当前回答消息上的联网搜索状态（随消息持久化） */
    const updateWebSearch = (
      info: NonNullable<AssistantMessage['webSearch']>,
    ) => {
      set((current) => ({
        messages: current.messages.map((message) =>
          message.id === assistantId ? { ...message, webSearch: info } : message,
        ),
      }))
    }

    /** 过程反馈：只在真实阶段切换时更新，避免长时间无意义的加载文案 */
    const setPhase = (phase: AssistantPhase) => {
      set((current) => ({
        messages: current.messages.map((message) =>
          message.id === assistantId ? { ...message, phase } : message,
        ),
      }))
    }

    try {
      // 联网搜索：开启时先搜必应，结果并入 system 提示词；失败降级为普通回答
      let webBlock: string | null = null
      if (state.webSearch) {
        updateWebSearch({ status: 'searching' })
        setPhase('searching')
        try {
          const results = await searchWeb(content)
          webBlock = formatWebResults(results, content)
          updateWebSearch({ status: 'done', count: results.length })
        } catch (error) {
          updateWebSearch({
            status: 'failed',
            error: errorText(error),
          })
        }
        // 搜索期间用户可能已点停止：丢弃结果，不再发起对话
        if (isStale()) return
        setPhase('understanding')
      }

      // agent 工具：仅在用户允许读取便签时提供（隐私不变量：
      // contextEnabled 关闭时不下发任何工具，模型无法触达便签数据）。
      // 意图只用于选择本轮的 none / read / write 工具范围与提示词，不产生授权。
      const intent = analyzeAssistantIntent(content, {
        hasSelectedEntry: Boolean(entriesState.selectedId),
        hasResolvedConversationReferent: resolvedReferent !== null,
        hasExplicitTarget,
      })
      // 指代无法唯一解析时强制只读，并只向用户提出一个关键问题；
      // 续办没有可安全重试的记录时同样只读，避免把旧任务当成新授权
      const toolPlan = planAssistantTools(intent, state.contextEnabled, {
        forceReadOnly: referentQuestion !== null || continuationQuestion !== null,
        forceWrite: continuation?.hasActionableWork === true,
      })
      const toolsAvailable = toolPlan.tools

      // 执行层权限来自同一份计划，但由执行器强制校验；下发给模型的 tools 不是授权
      const permission: ToolPermission = toolPlan.mode
      toolScope = createAgentToolScope(requestId, isStale, assistantId, {
        permission,
        blockedWriteTools: retryBlockedWriteTools(retryContext),
        writeSignatures: [
          ...retryWriteSignatures(retryContext),
          ...(continuation?.writeSignatures ?? []),
        ],
        onBlocked: (event) => {
          console.warn(`[AI] 工具调用被拦截：${event.tool} / ${event.code}`)
        },
      })
      // 共享同一数组：用户停止时也能拿到真实写入尝试，供后续续办幂等使用
      if (active) active.writeAttempts = toolScope.writeAttempts
      seedTrustedTargets(toolScope, {
        userText: content,
        entries: entriesState.entries,
        selectedId: entriesState.selectedId,
        allowSelectedReferent:
          intent.reason === 'referent_resolved' &&
          hasSelectedReferentWriteIntent(content),
        // 只登记本轮唯一解析、且真实存在的对话指代目标；模糊 / 失效目标不进入授权
        conversationTargets:
          resolvedReferent && resolvedReferent.entry
            ? [
                {
                  id: resolvedReferent.entry.id,
                  kind: resolvedReferent.entry.kind,
                  title: resolvedReferent.entry.title,
                },
              ]
            : [],
      })

      const memoryBlock = buildMemoryPromptBlock({
        memory,
        entries: entriesState.entries,
        referent:
          referentWrite && referent
            ? {
                status: referent.status,
                phrase: referent.phrase,
                ...(referent.entry
                  ? { entryId: referent.entry.id, title: referent.entry.title }
                  : {}),
                question: referent.question,
              }
            : null,
      })

      const systemContent = [
        context.systemPrompt,
        memoryBlock,
        continuation?.guard,
        toolPlan.prompt,
        retrySystemNote(retryContext),
        webBlock,
      ]
        .filter((part): part is string => Boolean(part))
        .join('\n\n')

      /**
       * 单轮流式请求：把回调 Promise 化供 agent loop 驱动；
       * delta 实时进入气泡缓冲（跨轮共用同一缓冲），toolCalls 先于 done 返回
       */
      let turnText = ''
      const runAttempt = (
        msgs: AiChatMessage[],
        useTools: AiToolDefinition[] | null,
      ): Promise<
        | { outcome: 'done'; finishReason: string | null }
        | { outcome: 'toolCalls'; calls: AiToolCall[] }
        | { outcome: 'error'; error: AiErrorInfo; received: boolean }
      > =>
        new Promise((resolve) => {
          let collectedCalls: AiToolCall[] | null = null
          let receivedAnyDelta = false
          turnText = ''
          void streamChat(
            requestId,
            profileId,
            msgs,
            {
              onDelta: (delta) => {
                if (isStale()) return
                receivedAnyDelta = true
                turnText += delta
                if (devTiming) {
                  devTiming.chunks += 1
                  devTiming.chars += delta.length
                  if (devTiming.firstDeltaAt === null) {
                    devTiming.firstDeltaAt = performance.now()
                    console.info(
                      `[AI] 首字：${Math.round(devTiming.firstDeltaAt - devTiming.startedAt)}ms`,
                    )
                  }
                }
                pending += delta
                scheduleFlush()
              },
              onToolCalls: (calls) => {
                if (isStale()) return
                collectedCalls = calls
              },
              onDone: (finishReason) => {
                if (collectedCalls && collectedCalls.length > 0) {
                  resolve({ outcome: 'toolCalls', calls: collectedCalls })
                  return
                }
                resolve({ outcome: 'done', finishReason })
              },
              onError: (error: AiErrorInfo) => {
                resolve({ outcome: 'error', error, received: receivedAnyDelta })
              },
            },
            useTools ?? undefined,
          )
        })

      // agent loop：带工具发起请求 → 模型请求调用 → 执行工具 → 结果回传续问，
      // 直到模型给出最终回答 / 轮数用尽 / 出错。
      // 查询与写入直接执行，删除只生成确认卡片，由用户在界面上确认。
      let apiMessages: AiChatMessage[] = [
        { role: 'system', content: systemContent },
        ...history,
      ]
      let toolsEnabled = toolsAvailable != null
      let toolsDegraded = false
      let toolRounds = 0
      // 需要用户补充：指代未唯一解析 / 续办没有可安全重试的记录
      const requiredQuestions = [referentQuestion, continuationQuestion].filter(
        (question): question is string => Boolean(question),
      )
      let needsInput = requiredQuestions.length > 0
      /** 模型没有主动追问时，把确定性的关键问题补到回答末尾（同一问题只补一次） */
      const withRequiredQuestions = (text: string): string =>
        requiredQuestions.reduce(
          (result, question) =>
            result.includes(question) ? result : appendNotice(result, question),
          text,
        )

      for (;;) {
        // 每次请求模型前都是真实阶段：首轮在理解任务，之后在整理工具结果
        setPhase(toolRounds === 0 ? 'understanding' : 'composing')
        const attempt = await runAttempt(apiMessages, toolsEnabled ? toolsAvailable : null)

        // 降级重试：模型/网关不支持 function calling（首次带 tools 且无任何输出就报错）
        // 时，去掉工具原样重问一次，行为与旧版完全一致
        if (attempt.outcome === 'error') {
          if (
            shouldDegradeTools({
              toolsEnabled,
              alreadyDegraded: toolsDegraded,
              received: attempt.received,
              code: attempt.error.code,
            })
          ) {
            toolsDegraded = true
            toolsEnabled = false
            // 降级后执行层权限一并收回：即使网关仍返回 tool_calls 也不能写入
            if (toolScope) toolScope.permission = 'none'
            // 工具不可用时把工具说明换成降级说明，避免模型仍声称能写数据
            apiMessages = apiMessages.map((message, index) =>
              index === 0 && message.role === 'system'
                ? { ...message, content: degradeToolPrompt(message.content, toolPlan) }
                : message,
            )
            if (import.meta.env.DEV) {
              console.info(
                `[AI] 当前模型可能不支持工具调用，已降级为普通对话重试：${attempt.error.message}`,
              )
            }
            continue
          }
          reportTiming(`失败 ${attempt.error.code}`)
          if (toolScope) {
            const currentLedger = buildRetryLedger({
              requestId,
              assistantMessageId: assistantId,
              userContent: content,
              steps,
              attempts: toolScope.writeAttempts,
            })
            retryLedger = mergeRetryLedger(retryContext, currentLedger)
          }
          const errorPhase = deriveFinalPhase({
            steps,
            needsInput,
            limitReached: false,
            stopped: false,
            requestFailed: true,
          })
          const errorNotice = buildExecutionOutcomeNotice({
            steps,
            phase: errorPhase,
            stopped: false,
          })
          const modelFailure = classifyModelFailure(
            attempt.error.code,
            attempt.error.message,
            steps.length > 0,
          )
          const failureNotice = modelFailure.autoRetryAllowed
            ? ''
            : '模型请求在执行工具后失败：已完成的写入不会回滚，重试时执行层会阻止重复写入。请先核对执行结果，再决定是否继续。'
          const combinedNotice = [errorNotice, failureNotice]
            .filter(Boolean)
            .join('\n')
          const errorWriteAttempts = mergeWriteAttempts(
            continuation?.writeAttempts ?? [],
            carryWriteAttempts(toolScope?.writeAttempts ?? [], steps),
          )
          finishHistory({
            phase: errorPhase,
            requestFailed: true,
            needsInput,
            failure: modelFailure,
            errorMessage: attempt.error.message,
          })
          finalize((current) => ({
            sending: false,
            messages: current.messages.map((message) =>
              message.id === assistantId
                ? {
                    ...message,
                    status: 'error',
                    error: attempt.error,
                    phase: errorPhase,
                    content: combinedNotice
                      ? withRequiredQuestions(appendNotice(message.content, combinedNotice))
                      : withRequiredQuestions(message.content),
                    toolSteps: steps.length > 0 ? [...steps] : message.toolSteps,
                    ...(errorWriteAttempts.length > 0
                      ? { writeAttempts: errorWriteAttempts }
                      : {}),
                  }
                : message,
            ),
          }))
          return
        }

        if (isStale()) return

        // 工具轮：执行工具并把结果回传，继续下一轮。
        // 查询 / 新增 / 修改直接执行；删除只生成确认卡片，由用户点击执行
        if (attempt.outcome === 'toolCalls') {
          // 轮数已用尽：不再执行本轮的调用，但必须明确告知已完成与未执行的步骤
          if (toolRounds >= MAX_TOOL_ROUNDS) {
            const notice = buildRoundLimitNotice(steps, attempt.calls)
            const limitTasks = buildRoundLimitTasks(attempt.calls)
            const limitPhase = deriveFinalPhase({
              steps,
              needsInput,
              limitReached: true,
              stopped: false,
              requestFailed: false,
            })
            const limitWriteAttempts = mergeWriteAttempts(
              continuation?.writeAttempts ?? [],
              carryWriteAttempts(toolScope?.writeAttempts ?? [], steps),
            )
            reportTiming('轮次上限')
            retryLedger = null
            finishHistory({
              phase: limitPhase,
              tasks: limitTasks,
              needsInput,
              limitReached: true,
            })
            finalize((current) => ({
              sending: false,
              messages: current.messages.map((message) =>
                message.id === assistantId
                  ? {
                      ...message,
                      content: withRequiredQuestions(
                        appendNotice(message.content, notice),
                      ),
                      status: 'done',
                      phase: limitPhase,
                      toolLimitReached: true,
                      toolSteps: [...steps],
                      toolTasks: limitTasks,
                      toolRounds,
                      needsInput: needsInput ? true : message.needsInput,
                      ...(limitWriteAttempts.length > 0
                        ? { writeAttempts: limitWriteAttempts }
                        : {}),
                    }
                  : message,
              ),
            }))
            return
          }

          toolRounds += 1
          // 同一轮可能同时包含查询与写入：只有全为只读时才显示「搜索资料」
          setPhase(callsAreReadOnly(attempt.calls) ? 'searching' : 'executing')
          // 模型本轮真实请求的调用先进入任务清单：执行前只能是待执行 / 执行中
          const plannedTasks = buildPlannedTasks(attempt.calls)
          set((current) => ({
            messages: current.messages.map((message) =>
              message.id === assistantId
                ? { ...message, toolRounds, toolTasks: plannedTasks }
                : message,
            ),
          }))

          const batch = await executeToolBatch(
            attempt.calls,
            (call) => executeAgentTool(call, toolScope as AgentToolScope),
            isStale,
            () => {
              if (toolScope) commitStagedCandidates(toolScope)
            },
            (event) => {
              const eventAt = Date.now()
              // 历史记录先于 UI 过期检查：用户停止时，正在执行的工具真实结果仍要落盘
              if (event.type === 'start') {
                historyRecorder.stepStarted(requestId, {
                  call: event.call,
                  startedAt: eventAt,
                })
              } else {
                historyRecorder.stepFinished(requestId, {
                  call: event.call,
                  outcome: event.outcome,
                  finishedAt: eventAt,
                })
              }
              if (isStale()) return
              const status =
                event.type === 'start'
                  ? 'running'
                  : taskStatusFromOutcome(event.outcome)
              set((current) => ({
                messages: current.messages.map((message) =>
                  message.id === assistantId
                    ? {
                        ...message,
                        toolTasks: (message.toolTasks ?? []).map((task) =>
                          task.callId === event.call.id ? { ...task, status } : task,
                        ),
                      }
                    : message,
                ),
              }))
            },
          )

          // 用户停止：已完成的步骤仍要展示（写入不回滚，也不声称撤销）
          if (batch.aborted) {
            steps.push(...batch.steps)
            const stoppedNeedsInput = needsInput || batch.needsInput
            const cancelledTasks = buildPlannedTasks(batch.unexecutedCalls).map(
              (task) => ({ ...task, status: 'cancelled' as const }),
            )
            const stoppedWriteAttempts = mergeWriteAttempts(
              continuation?.writeAttempts ?? [],
              carryWriteAttempts(toolScope?.writeAttempts ?? [], steps),
            )
            const stoppedPhase = deriveFinalPhase({
              steps,
              needsInput: stoppedNeedsInput,
              limitReached: false,
              stopped: true,
              requestFailed: false,
            })
            finishHistory({
              phase: stoppedPhase,
              tasks: cancelledTasks,
              stopped: true,
              needsInput: stoppedNeedsInput,
            })
            set((current) => ({
              messages: current.messages.map((message) =>
                message.id === assistantId
                  ? {
                      ...message,
                      toolSteps: [...steps],
                      toolTasks: cancelledTasks,
                      needsInput: stoppedNeedsInput ? true : message.needsInput,
                      ...(stoppedWriteAttempts.length > 0
                        ? { writeAttempts: stoppedWriteAttempts }
                        : {}),
                      phase: stoppedPhase,
                    }
                  : message,
              ),
            }))
            persistSnapshot(get().messages, get().contextEnabled, get().webSearch)
            return
          }

          steps.push(...batch.steps)
          if (batch.needsInput) needsInput = true
          const confirmCards: AssistantAction[] = batch.confirmCards
          const alarmSelections = batch.alarmSelections
          set((current) => ({
            messages: current.messages.map((message) =>
              message.id === assistantId
                ? {
                    ...message,
                    toolRounds,
                    toolSteps: [...steps],
                    // 已执行项由 toolSteps 承载，避免任务清单与执行记录重复
                    toolTasks: [],
                    phase: 'composing',
                    needsInput: needsInput ? true : message.needsInput,
                    ...(confirmCards.length > 0
                      ? {
                          toolActions: [
                            ...(message.toolActions ?? []),
                            ...confirmCards,
                          ],
                        }
                      : {}),
                    ...(alarmSelections.length > 0
                      ? {
                          toolSelections: [
                            ...(message.toolSelections ?? []),
                            ...alarmSelections,
                          ],
                        }
                      : {}),
                  }
                : message,
            ),
          }))

          apiMessages = [
            ...apiMessages,
            {
              role: 'assistant',
              content: turnText,
              tool_calls: attempt.calls.map((call) => ({
                id: call.id,
                type: 'function' as const,
                function: {
                  name: call.function.name,
                  arguments: call.function.arguments,
                },
              })),
            },
            ...batch.toolMessages,
          ]
          continue
        }

        // 最终回答（工具轮结束后由模型汇总，或用户停止）
        const finishReason = attempt.finishReason
        const stopped = finishReason === 'cancelled' || isStale()
        const finalPhase = deriveFinalPhase({
          steps,
          needsInput,
          limitReached: false,
          stopped,
          requestFailed: false,
        })
        // 终态结果由真实执行记录确定；部分成功 / 失败 / 停止时追加，纠正模型的过度声明
        const outcomeNotice = buildExecutionOutcomeNotice({
          steps,
          phase: finalPhase,
          stopped,
        })
        const finalWriteAttempts = mergeWriteAttempts(
          continuation?.writeAttempts ?? [],
          carryWriteAttempts(toolScope?.writeAttempts ?? [], steps),
        )
        reportTiming(stopped ? '已停止' : '完成')
        retryLedger = null
        finishHistory({ phase: finalPhase, stopped, needsInput })
        finalize((current) => ({
          sending: false,
          messages: current.messages.map((message) =>
            message.id === assistantId
              ? {
                  ...message,
                  status: 'done',
                  stopped: stopped ? true : message.stopped,
                  content: withRequiredQuestions(
                    outcomeNotice
                      ? appendNotice(message.content, outcomeNotice)
                      : message.content,
                  ),
                  // 长度截断：操作卡片 JSON 很可能没写完，界面给出「继续」提示
                  truncated:
                    finishReason === 'length' ? true : message.truncated,
                  toolRounds: toolRounds > 0 ? toolRounds : message.toolRounds,
                  toolSteps: steps.length > 0 ? [...steps] : message.toolSteps,
                  needsInput: needsInput ? true : message.needsInput,
                  phase: finalPhase,
                  ...(finalWriteAttempts.length > 0
                    ? { writeAttempts: finalWriteAttempts }
                    : {}),
                }
              : message,
          ),
        }))
        return
      }
    } finally {
      // 兜底：正常路径已在 onDone/onError 收尾；此处防止异常导致永久「生成中」
      if (active?.requestId === requestId) {
        if (flushTimer !== undefined) {
          window.clearTimeout(flushTimer)
          flushTimer = undefined
        }
        flush()
        const fallbackPhase: AssistantPhase = steps.some(
          (step) => step.status === 'ok' || step.status === 'confirm',
        )
          ? 'partial'
          : 'failed'
        const fallbackWriteAttempts = mergeWriteAttempts(
          active.carriedWriteAttempts,
          carryWriteAttempts(active.writeAttempts, steps),
        )
        finishHistory({ phase: fallbackPhase, requestFailed: true })
        set((current) => ({
          sending: false,
          messages: current.messages.map((message) =>
            message.id === assistantId && message.status === 'streaming'
              ? {
                  ...message,
                  status: 'done',
                  phase: fallbackPhase,
                  toolSteps: steps.length > 0 ? [...steps] : message.toolSteps,
                  toolTasks: cancelUnfinishedTasks(message.toolTasks),
                  ...(fallbackWriteAttempts.length > 0
                    ? { writeAttempts: fallbackWriteAttempts }
                    : {}),
                }
              : message,
          ),
        }))
        active = null
        retryLedger = null
        persistSnapshot(get().messages, get().contextEnabled, get().webSearch)
      }
      // 用户停止或异常退出时收尾，确保每个请求都有且仅有一条计时日志
      reportTiming('中断')
    }
  },

  stop: () => {
    if (!active) return
    const { requestId, assistantId, steps, writeAttempts, carriedWriteAttempts } =
      active
    cancelChat(requestId)
    retryLedger = null
    pendingRetryLedger = null
    // 请求已停止：未执行的候选闹钟授权立即作废，之后点击也不会写入
    cancelPendingAlarmSelections()
    active = null
    const stoppedWriteAttempts = mergeWriteAttempts(
      carriedWriteAttempts,
      carryWriteAttempts(writeAttempts, steps),
    )
    const stoppedMessage = get().messages.find(
      (message) => message.id === assistantId,
    )
    const stoppedTasks = cancelUnfinishedTasks(stoppedMessage?.toolTasks)
    const stoppedNeedsInput = stoppedMessage?.needsInput === true
    const stoppedPhase = deriveFinalPhase({
      steps,
      needsInput: stoppedNeedsInput,
      limitReached: false,
      stopped: true,
      requestFailed: false,
    })
    getExecutionRecorder().finish({
      executionId: requestId,
      status: deriveExecutionStatus({
        steps,
        ...(stoppedTasks ? { tasks: stoppedTasks } : {}),
        stopped: true,
        ...(stoppedNeedsInput ? { needsInput: true } : {}),
      }),
      phase: stoppedPhase,
      finishedAt: Date.now(),
      steps,
      ...(stoppedTasks ? { tasks: stoppedTasks } : {}),
    })
    set((state) => ({
      sending: false,
      messages: invalidatePendingSelections(
        state.messages.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                status: 'done',
                stopped: true,
                ...(steps.length > 0 ? { toolSteps: [...steps] } : {}),
                toolTasks: cancelUnfinishedTasks(message.toolTasks),
                ...(stoppedWriteAttempts.length > 0
                  ? { writeAttempts: stoppedWriteAttempts }
                  : {}),
                phase: stoppedPhase,
              }
            : message,
        ),
      ),
    }))
    persistSnapshot(get().messages, get().contextEnabled, get().webSearch)
  },

  retry: async () => {
    if (get().sending) return
    const messages = [...get().messages]
    let index = messages.length - 1
    while (index >= 0 && messages[index].role !== 'user') index -= 1
    if (index < 0) return
    const content = messages[index].content
    pendingRetryLedger =
      retryLedger && retryLedger.userContent === content ? retryLedger : null
    set({ messages: messages.slice(0, index) })
    persistSnapshot(get().messages, get().contextEnabled, get().webSearch)
    await get().send(content)
  },

  clear: () => {
    if (active) {
      const { requestId, assistantId, steps } = active
      const current = get().messages.find((message) => message.id === assistantId)
      const tasks = cancelUnfinishedTasks(current?.toolTasks)
      getExecutionRecorder().finish({
        executionId: requestId,
        status: deriveExecutionStatus({ steps, stopped: true }),
        phase: deriveFinalPhase({
          steps,
          needsInput: false,
          limitReached: false,
          stopped: true,
          requestFailed: false,
        }),
        finishedAt: Date.now(),
        steps,
        ...(tasks ? { tasks } : {}),
      })
      cancelChat(requestId)
      active = null
    }
    resetDeleteProposals()
    resetAlarmSelections()
    conversationMemoryCache.clear()
    retryLedger = null
    pendingRetryLedger = null
    // 新对话：历史记录仍保留，只更换对话标识；旧删除 / 闹钟授权不会随历史恢复
    conversationId = crypto.randomUUID()
    set({ messages: [], input: '', sending: false })
    persistSnapshot([], get().contextEnabled, get().webSearch)
  },

  markToolActionDone: (messageId, index) => {
    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === messageId
          ? {
              ...message,
              toolActionsDone: Array.from(
                new Set([...(message.toolActionsDone ?? []), index]),
              ),
            }
          : message,
      ),
    }))
    persistSnapshot(get().messages, get().contextEnabled, get().webSearch)
  },

  markToolActionCancelled: (messageId, index) => {
    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === messageId
          ? {
              ...message,
              toolActionsCancelled: Array.from(
                new Set([...(message.toolActionsCancelled ?? []), index]),
              ),
            }
          : message,
      ),
    }))
    persistSnapshot(get().messages, get().contextEnabled, get().webSearch)
  },

  markToolSelectionDone: (messageId, proposalId) => {
    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === messageId
          ? {
              ...message,
              toolSelectionsDone: Array.from(
                new Set([...(message.toolSelectionsDone ?? []), proposalId]),
              ),
            }
          : message,
      ),
    }))
    persistSnapshot(get().messages, get().contextEnabled, get().webSearch)
  },

  markToolSelectionCancelled: (messageId, proposalId) => {
    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === messageId
          ? {
              ...message,
              toolSelectionsCancelled: Array.from(
                new Set([...(message.toolSelectionsCancelled ?? []), proposalId]),
              ),
            }
          : message,
      ),
    }))
    persistSnapshot(get().messages, get().contextEnabled, get().webSearch)
  },

  markToolSelectionInvalidated: (messageId, proposalId) => {
    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === messageId
          ? {
              ...message,
              toolSelectionsInvalidated: Array.from(
                new Set([...(message.toolSelectionsInvalidated ?? []), proposalId]),
              ),
            }
          : message,
      ),
    }))
    persistSnapshot(get().messages, get().contextEnabled, get().webSearch)
  },
}))
