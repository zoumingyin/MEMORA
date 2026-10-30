import { create } from 'zustand'
import { buildAssistantContext } from '../services/assistantContext'
import { cancelChat, streamChat } from '../services/aiClient'
import { useAiProfileStore } from './useAiProfileStore'
import { useEntryStore } from './useEntryStore'
import type { AiChatMessage, AiErrorInfo, AssistantMessage } from '../types/ai'

/** 对话持久化：仅保留最近若干条，避免 localStorage 无限增长 */
const STORAGE_KEY = 'bianqian.assistant.v1'
const MAX_STORED_MESSAGES = 40
/** 每次请求携带的历史条数（不含 system），控制 token 消耗 */
const MAX_HISTORY_MESSAGES = 14
const MAX_MESSAGE_CHARS = 4000
/** 流式增量合并刷新间隔：逐 token setState 会导致整个消息列表高频重渲染 */
const FLUSH_INTERVAL_MS = 50

interface PersistedAssistant {
  messages: AssistantMessage[]
  contextEnabled: boolean
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
    if (!raw) return { messages: [], contextEnabled: true }
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
    }
  } catch {
    return { messages: [], contextEnabled: true }
  }
}

function persistSnapshot(
  messages: AssistantMessage[],
  contextEnabled: boolean,
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
      JSON.stringify({ messages: stored, contextEnabled }),
    )
  } catch {
    // 存储不可用（隐私模式 / 配额满）时静默跳过，不影响对话
  }
}

/** 当前进行中的请求：用于停止生成与丢弃取消后的迟到事件 */
let active: { requestId: string; assistantId: string } | null = null

interface AssistantState {
  open: boolean
  messages: AssistantMessage[]
  input: string
  sending: boolean
  /** 是否允许把便签内容作为上下文发送给 AI（隐私开关，默认开启） */
  contextEnabled: boolean
  openPanel: () => void
  closePanel: () => void
  togglePanel: () => void
  setInput: (value: string) => void
  setContextEnabled: (enabled: boolean) => void
  send: (text?: string) => Promise<void>
  stop: () => void
  retry: () => Promise<void>
  clear: () => void
  /** 记录某条回答里的操作已创建，避免重复写入 */
  markActionCreated: (messageId: string, index: number) => void
}

const initial = loadPersisted()

export const useAssistantStore = create<AssistantState>((set, get) => ({
  open: false,
  messages: initial.messages,
  input: '',
  sending: false,
  contextEnabled: initial.contextEnabled,

  openPanel: () => set({ open: true }),
  closePanel: () => set({ open: false }),
  togglePanel: () => set((state) => ({ open: !state.open })),
  setInput: (value) => set({ input: value }),

  setContextEnabled: (enabled) => {
    set({ contextEnabled: enabled })
    persistSnapshot(get().messages, enabled)
  },

  send: async (text) => {
    const state = get()
    if (state.sending) return
    const content = (text ?? state.input).trim()
    if (!content) return

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
    persistSnapshot(get().messages, state.contextEnabled)

    const requestId = crypto.randomUUID()
    active = { requestId, assistantId }

    // 历史消息：排除出错的回答与空内容，截断超长文本
    const history = state.messages
      .filter((message) => message.status !== 'error' && message.content.trim())
      .slice(-MAX_HISTORY_MESSAGES)
      .map<AiChatMessage>((message) => ({
        role: message.role,
        content: message.content.slice(0, MAX_MESSAGE_CHARS),
      }))
    history.push({ role: 'user', content })

    const entriesState = useEntryStore.getState()
    const context = buildAssistantContext(
      entriesState.entries,
      entriesState.selectedId,
      state.contextEnabled,
    )
    const apiMessages: AiChatMessage[] = [
      { role: 'system', content: context.systemPrompt },
      ...history,
    ]

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
      persistSnapshot(get().messages, get().contextEnabled)
    }
    const isStale = () => active?.requestId !== requestId

    try {
      // 使用对话界面当前选中的模型配置；未加载时由后端回落到当前配置
      const profileId = useAiProfileStore.getState().status?.activeId ?? null
      await streamChat(requestId, profileId, apiMessages, {
        onDelta: (delta) => {
          if (isStale()) return
          pending += delta
          scheduleFlush()
        },
        onDone: (finishReason) => {
          if (isStale()) return
          finalize((current) => ({
            sending: false,
            messages: current.messages.map((message) =>
              message.id === assistantId
                ? {
                    ...message,
                    status: 'done',
                    stopped: finishReason === 'cancelled' ? true : message.stopped,
                  }
                : message,
            ),
          }))
        },
        onError: (error: AiErrorInfo) => {
          if (isStale()) return
          finalize((current) => ({
            sending: false,
            messages: current.messages.map((message) =>
              message.id === assistantId
                ? { ...message, status: 'error', error }
                : message,
            ),
          }))
        },
      })
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
        persistSnapshot(get().messages, get().contextEnabled)
      }
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
    persistSnapshot(get().messages, get().contextEnabled)
  },

  retry: async () => {
    if (get().sending) return
    const messages = [...get().messages]
    let index = messages.length - 1
    while (index >= 0 && messages[index].role !== 'user') index -= 1
    if (index < 0) return
    const content = messages[index].content
    set({ messages: messages.slice(0, index) })
    persistSnapshot(get().messages, get().contextEnabled)
    await get().send(content)
  },

  clear: () => {
    if (active) {
      cancelChat(active.requestId)
      active = null
    }
    set({ messages: [], input: '', sending: false })
    persistSnapshot([], get().contextEnabled)
  },

  markActionCreated: (messageId, index) => {
    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === messageId
          ? {
              ...message,
              createdActions: Array.from(
                new Set([...(message.createdActions ?? []), index]),
              ),
            }
          : message,
      ),
    }))
    persistSnapshot(get().messages, get().contextEnabled)
  },
}))
