import { useEffect, useMemo, useRef } from 'react'
import { Button, Popconfirm, Select, Tooltip } from 'antd'
import {
  ArrowUp,
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
import { ProviderMark } from './ProviderMark'
import { useAssistantStore } from '../store/useAssistantStore'
import { useAiProfileStore } from '../store/useAiProfileStore'
import { useEntryStore } from '../store/useEntryStore'
import { useUiStore } from '../store/useUiStore'
import type { AssistantMessage } from '../types/ai'

/** 空态引导问题：覆盖检索、统计、日程与整理四类常见诉求 */
const SUGGESTIONS = [
  '总结我最近的笔记',
  '我有哪些未完成的待办？',
  '帮我梳理最近的提醒安排',
  '把最近的想法整理成提纲',
]

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

function MessageBubble({
  message,
  onRetry,
}: {
  message: AssistantMessage
  onRetry: () => void
}) {
  const html = useMemo(
    () => (message.role === 'assistant' ? markdownToHtml(message.content) : ''),
    [message.role, message.content],
  )

  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[86%] whitespace-pre-wrap break-words rounded-[12px] border border-[var(--card-active-border)] bg-[var(--card-active-bg)] px-3 py-2 text-[13px] leading-relaxed text-[var(--text)]">
          {message.content}
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-start gap-2">
      <div className="flex-center h-6 w-6 shrink-0 rounded-full bg-[var(--card-active-bg)] text-[var(--kind-accent)]">
        <Sparkles size={13} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="rounded-[12px] border border-[var(--border)] bg-[var(--field)] px-3 py-2 text-[13px] leading-relaxed text-[var(--text)]">
          {message.status === 'streaming' && !message.content && <TypingDots />}
          {message.content && (
            <div
              className="note-md assistant-md"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}
          {message.status === 'streaming' && message.content && (
            <span className="assistant-caret" aria-hidden />
          )}
          {message.stopped && (
            <div className="mt-1 text-[11px] text-[var(--text-muted)]">已停止生成</div>
          )}
        </div>
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
  const entryCount = useEntryStore((state) => state.entries.length)
  const setInput = useAssistantStore((state) => state.setInput)
  const send = useAssistantStore((state) => state.send)
  const stop = useAssistantStore((state) => state.stop)
  const retry = useAssistantStore((state) => state.retry)
  const clear = useAssistantStore((state) => state.clear)
  const closePanel = useAssistantStore((state) => state.closePanel)
  const togglePanel = useAssistantStore((state) => state.togglePanel)
  const setContextEnabled = useAssistantStore((state) => state.setContextEnabled)
  const aiStatus = useAiProfileStore((state) => state.status)
  const aiLoad = useAiProfileStore((state) => state.load)
  const aiActivate = useAiProfileStore((state) => state.activate)
  const aiProfiles = aiStatus?.profiles ?? []
  const activeProfile =
    aiProfiles.find((profile) => profile.id === aiStatus?.activeId) ??
    aiProfiles[0] ??
    null
  const openSettings = useUiStore((state) => state.openSettings)

  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const atBottomRef = useRef(true)

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

  return (
    <section className="assistant-panel" aria-label="AI 助手">
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
              className={`flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border-0 bg-transparent px-2 text-[10.5px] transition-colors hover:bg-[var(--hover-fill)] ${
                contextEnabled
                  ? "text-[var(--kind-accent)]"
                  : "text-[var(--text-muted)]"
              }`}
              aria-label={contextEnabled ? "关闭便签上下文" : "启用便签上下文"}
              title={
                contextEnabled
                  ? "已启用：提问会附带便签摘要，点击关闭"
                  : "已关闭：只回答通用问题，点击启用"
              }
              onClick={() => setContextEnabled(!contextEnabled)}
            >
              {contextEnabled ? <ShieldCheck size={13} /> : <ShieldOff size={13} />}
              <span>上下文</span>
            </button>

            <div className="ml-auto flex min-w-0 items-center gap-1">
              {aiProfiles.length > 0 ? (
                <Select
                  size="small"
                  variant="borderless"
                  className="min-w-0 max-w-[150px]"
                  value={activeProfile?.id}
                  prefix={
                    <ProviderMark
                      provider={activeProfile?.provider ?? ''}
                      baseUrl={activeProfile?.baseUrl ?? ''}
                      size={14}
                    />
                  }
                  popupMatchSelectWidth={false}
                  disabled={sending}
                  title={
                    activeProfile
                      ? `${activeProfile.provider} · ${activeProfile.model} · ${activeProfile.baseUrl}`
                      : undefined
                  }
                  options={aiProfiles.map((profile) => ({
                    value: profile.id,
                    label: profile.name,
                    disabled: !profile.configured,
                  }))}
                  optionRender={(option) => {
                    const profile = aiProfiles.find(
                      (item) => item.id === option.value
                    )
                    if (!profile) return option.label
                    return (
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate text-[12px] text-[var(--text)]">
                          {profile.name}
                        </span>
                        <span className="truncate text-[10px] text-[var(--text-muted)]">
                          {profile.provider} · {profile.model}
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
