import { create } from 'zustand'
import { buildAssistantContext } from '../services/assistantContext'
import {
  AGENT_TOOLS,
  AGENT_TOOL_PROMPT,
  NO_TOOL_PROMPT,
  createAgentToolScope,
  executeAgentTool,
  type AgentToolScope,
} from '../services/agentTools'
import { resetDeleteProposals } from '../services/deleteProposals'
import { cancelChat, streamChat } from '../services/aiClient'
import { formatWebResults, searchWeb } from '../services/webSearch'
import {
  parseAssistantActions,
  type AssistantAction,
} from '../utils/assistantActions'
import { useAiProfileStore } from './useAiProfileStore'
import { useEntryStore } from './useEntryStore'
import type {
  AiChatMessage,
  AiErrorInfo,
  AiToolCall,
  AiToolDefinition,
  AssistantMessage,
} from '../types/ai'

/** 对话持久化：仅保留最近若干条，避免 localStorage 无限增长 */
const STORAGE_KEY = 'bianqian.assistant.v1'
const MAX_STORED_MESSAGES = 40
/** 每次请求携带的历史条数与总字数上限（不含 system）：输入越小首字越快 */
const MAX_HISTORY_MESSAGES = 12
const MAX_MESSAGE_CHARS = 2000
const MAX_HISTORY_CHARS = 8000
/** 流式增量合并刷新间隔：逐 token setState 会导致整个消息列表高频重渲染 */
const FLUSH_INTERVAL_MS = 50
/** agent loop 工具轮数上限：防止模型连环调用不收敛（超限后按普通回答收尾）；
 * 批量编排（检索 1 轮 + 每轮可并行多个写入）8 轮足够覆盖常见整理任务 */
const MAX_TOOL_ROUNDS = 8
/** 这些错误码出现在「带 tools 的首次请求且无任何输出」时，按不支持工具降级重试 */
const TOOL_UNSUPPORTED_CODES = new Set(['http_error', 'endpoint_not_found', 'server_error'])

interface PersistedAssistant {
  messages: AssistantMessage[]
  contextEnabled: boolean
  webSearch: boolean
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
    if (!raw) return { messages: [], contextEnabled: true, webSearch: false }
    const parsed = JSON.parse(raw) as Partial<PersistedAssistant>
    const messages = Array.isArray(parsed.messages)
      ? parsed.messages
          .filter(isMessage)
          .slice(-MAX_STORED_MESSAGES)
          .map((message): AssistantMessage =>
            message.status === 'streaming'
              ? {
                  ...message,
                  // 上次异常退出时残留的「生成中」消息：有内容则视为完成，空消息直接丢弃
                  status: message.content ? 'done' : 'error',
                  error: message.content
                    ? message.error
                    : { code: 'interrupted', message: '上次回答因应用退出中断，可点击重试。' },
                }
              : message,
          )
          .filter((message) => message.status !== 'error' || message.content.length > 0)
      : []
    return {
      messages,
      contextEnabled:
        typeof parsed.contextEnabled === 'boolean' ? parsed.contextEnabled : true,
      webSearch: parsed.webSearch === true,
    }
  } catch {
    return { messages: [], contextEnabled: true, webSearch: false }
  }
}

/** 持久化当前快照：消息 + 两个会话开关 */
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
      JSON.stringify({ messages: stored, contextEnabled, webSearch }),
    )
  } catch {
    // 存储不可用（隐私模式 / 配额满）时静默跳过，不影响对话
  }
}

/** 当前进行中的请求：用于停止生成与丢弃取消后的迟到事件 */
let active: { requestId: string; assistantId: string } | null = null

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
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
}

const initial = loadPersisted()

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
    }

    set({
      messages: [...state.messages, userMessage, assistantMessage],
      input: '',
      sending: true,
      open: true,
    })
    persistSnapshot(get().messages, state.contextEnabled, state.webSearch)

    const requestId = crypto.randomUUID()
    active = { requestId, assistantId }
    // 幂等集合与过期判断都绑定本次请求：旧请求不会执行未开始的工具
    const isStale = () => active?.requestId !== requestId
    const toolScope: AgentToolScope = createAgentToolScope(requestId, isStale)

    // 历史消息：排除出错的回答，剥掉 <action> 操作块，从新到旧累加并受总字数约束；
    // 输入越小，首字越快（免费网关排队时长也随输入体积增长）
    const history: AiChatMessage[] = []
    let historyChars = content.length
    for (let index = state.messages.length - 1; index >= 0; index -= 1) {
      if (history.length >= MAX_HISTORY_MESSAGES) break
      const message = state.messages[index]
      if (message.status === 'error') continue
      const text = (
        message.role === 'assistant'
          ? parseAssistantActions(message.content).text
          : message.content
      ).slice(0, MAX_MESSAGE_CHARS)
      if (!text) continue
      if (historyChars + text.length > MAX_HISTORY_CHARS) break
      history.unshift({ role: message.role, content: text })
      historyChars += text.length
    }
    history.push({ role: 'user', content })

    const entriesState = useEntryStore.getState()
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

    try {
      // 联网搜索：开启时先搜必应，结果并入 system 提示词；失败降级为普通回答
      let webBlock: string | null = null
      if (state.webSearch) {
        updateWebSearch({ status: 'searching' })
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
      }

      // agent 工具：仅在用户允许读取便签时提供（隐私不变量：
      // contextEnabled 关闭时不下发任何工具，模型无法触达便签数据）
      const toolsAvailable = state.contextEnabled ? AGENT_TOOLS : null

      const systemContent = [
        context.systemPrompt,
        // 工具可用时附上使用说明；不可用时明确告知只能回答、不能写数据
        toolsAvailable ? AGENT_TOOL_PROMPT : NO_TOOL_PROMPT,
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

      for (;;) {
        const attempt = await runAttempt(apiMessages, toolsEnabled ? AGENT_TOOLS : null)

        // 降级重试：模型/网关不支持 function calling（首次带 tools 且无任何输出就报错）
        // 时，去掉工具原样重问一次，行为与旧版完全一致
        if (attempt.outcome === 'error') {
          if (
            toolsEnabled &&
            !toolsDegraded &&
            !attempt.received &&
            TOOL_UNSUPPORTED_CODES.has(attempt.error.code)
          ) {
            toolsDegraded = true
            toolsEnabled = false
            // 工具不可用时把工具说明换成降级说明，避免模型仍声称能写数据
            apiMessages = apiMessages.map((message, index) =>
              index === 0 && message.role === 'system'
                ? {
                    ...message,
                    content: `${message.content.replace(AGENT_TOOL_PROMPT, '').trim()}\n\n${NO_TOOL_PROMPT}`,
                  }
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
          finalize((current) => ({
            sending: false,
            messages: current.messages.map((message) =>
              message.id === assistantId
                ? { ...message, status: 'error', error: attempt.error }
                : message,
            ),
          }))
          return
        }

        if (isStale()) return

        // 工具轮：执行工具并把结果回传，继续下一轮。
        // 查询 / 新增 / 修改直接执行；删除只生成确认卡片，由用户点击执行
        if (attempt.outcome === 'toolCalls' && toolRounds < MAX_TOOL_ROUNDS) {
          if (isStale()) return
          toolRounds += 1
          set((current) => ({
            messages: current.messages.map((message) =>
              message.id === assistantId ? { ...message, toolRounds } : message,
            ),
          }))
          const toolMessages: AiChatMessage[] = []
          const confirmCards: AssistantAction[] = []
          let aborted = false
          for (const call of attempt.calls) {
            // 用户点停止后：尚未开始的工具一律不再执行
            if (isStale()) {
              aborted = true
              break
            }
            const outcome = await executeAgentTool(call, toolScope)
            // 执行期间用户可能已停止：不再回传结果、不展示卡片；
            // 已提交的写入不回滚，也不向用户声称已撤销
            if (isStale()) {
              aborted = true
              break
            }
            if (outcome.confirmAction) confirmCards.push(outcome.confirmAction)
            toolMessages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: outcome.result,
            })
          }
          if (aborted) return
          if (confirmCards.length > 0) {
            set((current) => ({
              messages: current.messages.map((message) =>
                message.id === assistantId
                  ? {
                      ...message,
                      toolActions: [...(message.toolActions ?? []), ...confirmCards],
                    }
                  : message,
              ),
            }))
          }
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
            ...toolMessages,
          ]
          continue
        }

        // 最终回答（或轮数用尽 / 用户停止）
        const finishReason = attempt.outcome === 'done' ? attempt.finishReason : null
        reportTiming(finishReason === 'cancelled' ? '已停止' : '完成')
        finalize((current) => ({
          sending: false,
          messages: current.messages.map((message) =>
            message.id === assistantId
              ? {
                  ...message,
                  status: 'done',
                  stopped: finishReason === 'cancelled' ? true : message.stopped,
                  // 长度截断：操作卡片 JSON 很可能没写完，界面给出「继续」提示
                  truncated:
                    finishReason === 'length' ? true : message.truncated,
                  toolRounds: toolRounds > 0 ? toolRounds : message.toolRounds,
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
        set((current) => ({
          sending: false,
          messages: current.messages.map((message) =>
            message.id === assistantId && message.status === 'streaming'
              ? { ...message, status: 'done' }
              : message,
          ),
        }))
        active = null
        persistSnapshot(get().messages, get().contextEnabled, get().webSearch)
      }
      // 用户停止或异常退出时收尾，确保每个请求都有且仅有一条计时日志
      reportTiming('中断')
    }
  },

  stop: () => {
    if (!active) return
    const { requestId, assistantId } = active
    cancelChat(requestId)
    active = null
    set((state) => ({
      sending: false,
      messages: state.messages.map((message) =>
        message.id === assistantId
          ? { ...message, status: 'done', stopped: true }
          : message,
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
    set({ messages: messages.slice(0, index) })
    persistSnapshot(get().messages, get().contextEnabled, get().webSearch)
    await get().send(content)
  },

  clear: () => {
    if (active) {
      cancelChat(active.requestId)
      active = null
    }
    resetDeleteProposals()
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
}))
