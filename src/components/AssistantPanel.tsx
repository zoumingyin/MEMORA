import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Dropdown, Flex, Popconfirm, Select, Tooltip, message as antdMessage } from 'antd'
import dayjs from 'dayjs'
import {
  ArrowUp,
  Bell,
  Brain,
  Check,
  Copy,
  FileText,
  Globe,
  ListChecks,
  Pencil,
  Plus,
  RotateCcw,
  Settings2,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  Square,
  TriangleAlert,
  X,
} from 'lucide-react'
import { markdownToHtml } from '../utils/markdown'
import { parseAssistantActions, type AssistantAction } from '../utils/assistantActions'
import { saveAiProfile } from '../services/aiClient'
import { FreeBadge } from './FreeBadge'
import { ModalityBadge } from './ModalityBadge'
import { ProviderMark } from './ProviderMark'
import { useAssistantStore } from '../store/useAssistantStore'
import { useAiProfileStore } from '../store/useAiProfileStore'
import { useEntryStore } from '../store/useEntryStore'
import { useUiStore } from '../store/useUiStore'
import {
  isNonTextModality,
  type AssistantMessage,
  type ReasoningEffort,
} from '../types/ai'
import type { EntryKind } from '../types/entry'

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
    <div className="mt-2 rounded-[10px] border border-[var(--border)] bg-[var(--field)] px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-[var(--danger)]">
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

const ACTION_META: Record<EntryKind, { label: string; icon: ReactNode }> = {
  note: { label: '备忘', icon: <FileText size={12} /> },
  todo: { label: '待办', icon: <ListChecks size={12} /> },
  reminder: { label: '提醒', icon: <Bell size={12} /> },
  draw: { label: '涂鸦', icon: <Pencil size={12} /> },
}

/** AI 提议新建的便签：卡片确认后才写入仓储，避免模型直接改数据 */
function ActionCard({
  action,
  created,
  onCreated,
}: {
  action: AssistantAction
  created: boolean
  onCreated: () => void
}) {
  const [status, setStatus] = useState<'idle' | 'creating' | 'dismissed'>('idle')
  const meta = ACTION_META[action.kind]
  if (status === 'dismissed') return null

  const handleCreate = async () => {
    if (created || status !== 'idle') return
    setStatus('creating')
    const entry = await useEntryStore.getState().addEntry(
      {
        title: action.title,
        content: action.content,
        remindAt: action.remindAt,
        items: action.items,
      },
      action.kind,
    )
    if (!entry) {
      setStatus('idle')
      antdMessage.error(`创建${meta.label}失败，请稍后重试`)
      return
    }
    setStatus('idle')
    // 记到消息里并持久化：重开面板或重启应用后不再重复提供创建按钮
    onCreated()
    antdMessage.success(`已创建${meta.label}`)
  }

  return (
    <div className="rounded-[10px] border border-[var(--border)] bg-[var(--field)] px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[10.5px] text-[var(--text-muted)]">
        <span className="flex-center text-[var(--kind-accent)]">{meta.icon}</span>
        <span>新建{meta.label}</span>
        {action.remindAt !== undefined && (
          <span className="text-[var(--text)]">
            · {dayjs(action.remindAt).format('M月D日 HH:mm')}
          </span>
        )}
        {created && (
          <span className="ml-auto flex items-center gap-0.5 text-[var(--kind-accent)]">
            <Check size={11} />
            已创建
          </span>
        )}
      </div>
      <div className="mt-1 whitespace-pre-wrap break-words text-[12.5px] font-semibold leading-snug text-[var(--text)]">
        {action.title}
      </div>
      {action.content && (
        <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words text-[11.5px] leading-relaxed text-[var(--text-muted)]">
          {action.content}
        </p>
      )}
      {action.items && action.items.length > 0 && (
        <>
          <Flex vertical gap={2} className="mt-1">
            {action.items.slice(0, 4).map((item) => (
              <Flex
                key={item}
                align="flex-start"
                gap={6}
                className="text-[11.5px] leading-relaxed text-[var(--text-muted)]"
              >
                <span className="mt-[7px] h-[3px] w-[3px] shrink-0 rounded-full bg-[var(--text-muted)]" />
                <span className="min-w-0 break-words">{item}</span>
              </Flex>
            ))}
          </Flex>
          {action.items.length > 4 && (
            <div className="pl-[9px] text-[11px] text-[var(--text-muted)]">
              还有 {action.items.length - 4} 项…
            </div>
          )}
        </>
      )}
      {!created && (
        <div className="mt-2 flex items-center gap-2">
          <Button
            size="small"
            type="primary"
            icon={<Plus size={12} />}
            loading={status === 'creating'}
            onClick={() => void handleCreate()}
          >
            创建{meta.label}
          </Button>
          <Button size="small" type="text" onClick={() => setStatus('dismissed')}>
            忽略
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
        : { text: '', actions: [] as AssistantAction[] },
    [message.role, message.content],
  )
  const html = useMemo(
    () => (message.role === 'assistant' ? markdownToHtml(parsed.text) : ''),
    [message.role, parsed.text],
  )
  const markActionCreated = useAssistantStore((state) => state.markActionCreated)
  const createdActions = Array.isArray(message.createdActions)
    ? message.createdActions
    : []

  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[86%] whitespace-pre-wrap break-words rounded-[12px] border border-[var(--card-active-border)] bg-[var(--card-active-bg)] px-3 py-2 text-[13px] leading-relaxed text-[var(--text)]">
          {message.content}
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

  return (
    <div className="group flex items-start gap-2">
      <div className="flex-center h-6 w-6 shrink-0 rounded-full bg-[var(--card-active-bg)] text-[var(--kind-accent)]">
        <Sparkles size={13} />
      </div>
      <div className="min-w-0 flex-1">
        {showBubble && (
          <div className="rounded-[12px] border border-[var(--border)] bg-[var(--field)] px-3 py-2 text-[13px] leading-relaxed text-[var(--text)]">
            {message.status === 'streaming' && !parsed.text && (
              <ThinkingIndicator
                startedAt={message.createdAt}
                label={
                  webSearch?.status === 'searching' ? '正在联网搜索…' : '思考中'
                }
              />
            )}
            {searchHint && searchHint !== '正在联网搜索…' && (
              <div className="mb-1 flex items-center gap-1 text-[10.5px] leading-snug text-[var(--text-muted)]">
                <Globe size={10} />
                <span>{searchHint}</span>
              </div>
            )}
            {parsed.text && (
              <div
                className="note-md assistant-md"
                dangerouslySetInnerHTML={{ __html: html }}
              />
            )}
            {message.status === 'streaming' && parsed.text && (
              <span className="assistant-caret" aria-hidden />
            )}
            {message.stopped && (
              <div className="mt-1 text-[11px] text-[var(--text-muted)]">已停止生成</div>
            )}
          </div>
        )}
        {message.status !== 'streaming' && parsed.actions.length > 0 && (
          <div className="mt-2 flex flex-col gap-2">
            {parsed.actions.map((action, index) => (
              <ActionCard
                key={`${message.id}:${index}`}
                action={action}
                created={createdActions.includes(index)}
                onCreated={() => markActionCreated(message.id, index)}
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
  const aiProfiles = aiStatus?.profiles ?? []
  const activeProfile =
    aiProfiles.find((profile) => profile.id === aiStatus?.activeId) ?? null
  const openSettings = useUiStore((state) => state.openSettings)

  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const modelSelectRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  // 弹层高度：按触发器上下可用空间取大者，避免小窗口下列表被裁掉
  const [modelListHeight, setModelListHeight] = useState(240)

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
      togglePanel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [togglePanel])

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
                  className="rounded-[10px] border border-[var(--border)] bg-[var(--field)] px-3 py-2 text-left text-[12px] text-[var(--text)] transition hover:border-[var(--card-border-hover)] hover:bg-[var(--hover-fill)]"
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
        <div className="flex flex-col overflow-hidden rounded-[16px] border border-[var(--control-border)] bg-[var(--field)] transition-colors focus-within:border-[var(--kind-accent)]">
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
                  className="flex-center h-8 w-8 shrink-0 cursor-pointer rounded-[9px] border-0 bg-[var(--danger)] p-0 text-white transition-opacity hover:opacity-90"
                  onClick={stop}
                  title="停止生成"
                  aria-label="停止生成"
                >
                  <Square size={11} fill="currentColor" />
                </button>
              ) : (
                <button
                  type="button"
                  className="flex-center h-8 w-8 shrink-0 cursor-pointer rounded-[9px] border-0 bg-[var(--kind-accent)] p-0 text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-35"
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
    </section>
  )
}

export function AssistantPanel() {
  const open = useAssistantStore((state) => state.open)
  if (!open) return null
  return <AssistantPanelBody />
}
