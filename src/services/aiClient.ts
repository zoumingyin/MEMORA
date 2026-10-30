import { Channel, invoke } from '@tauri-apps/api/core'
import { isTauriRuntime } from '../repository'
import type {
  AiChatMessage,
  AiErrorInfo,
  AiProfileInput,
  AiProfileStatus,
  AiStatus,
  AiStreamEvent,
} from '../types/ai'

/**
 * 浏览器预览环境没有 Rust 后端，改为前端直连 OpenAI 兼容接口：
 * 配置与密钥保存在浏览器 localStorage，仅供本地预览/调试；
 * 桌面端仍走 Rust 代理，密钥不会进入 WebView。
 */
const BROWSER_CONFIG_KEY = 'bianqian.assistant.ai.v2'
/** 旧版单配置：读取时迁移为一条 v2 配置 */
const LEGACY_CONFIG_KEY = 'bianqian.assistant.ai.v1'
const DEFAULT_TEMPERATURE = 0.7
const DEFAULT_MAX_TOKENS = 1200

interface BrowserProfile {
  id: string
  name: string
  provider: string
  baseUrl: string
  model: string
  apiKey: string
  temperature: number
  maxTokens: number
}

interface BrowserStore {
  version: 2
  activeId: string | null
  profiles: BrowserProfile[]
}

const EMPTY_STORE: BrowserStore = { version: 2, activeId: null, profiles: [] }

/** 浏览器端进行中的请求：取消时中断 fetch */
const browserRequests = new Map<string, AbortController>()

function normalizeProfile(raw: unknown): BrowserProfile | null {
  if (typeof raw !== 'object' || raw === null) return null
  const item = raw as Record<string, unknown>
  if (typeof item.id !== 'string' || !item.id) return null
  if (typeof item.baseUrl !== 'string' || typeof item.model !== 'string') return null
  return {
    id: item.id,
    name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : item.model,
    provider: typeof item.provider === 'string' ? item.provider : '',
    baseUrl: item.baseUrl,
    model: item.model,
    apiKey: typeof item.apiKey === 'string' ? item.apiKey : '',
    temperature:
      typeof item.temperature === 'number'
        ? item.temperature
        : DEFAULT_TEMPERATURE,
    maxTokens:
      typeof item.maxTokens === 'number' ? item.maxTokens : DEFAULT_MAX_TOKENS,
  }
}

/** 旧版（v1）单配置 → 一条 v2 配置；下次写入时正式落盘 */
function migrateLegacyConfig(): BrowserStore {
  try {
    const raw = localStorage.getItem(LEGACY_CONFIG_KEY)
    if (!raw) return EMPTY_STORE
    const parsed = JSON.parse(raw) as Partial<BrowserProfile>
    if (
      typeof parsed.baseUrl !== 'string' ||
      !parsed.baseUrl.trim() ||
      typeof parsed.model !== 'string' ||
      !parsed.model.trim()
    ) {
      return EMPTY_STORE
    }
    const profile: BrowserProfile = {
      // 固定 id：迁移结果即使还没落盘，重复读取也必须返回同一个 id，
      // 否则前端拿上一次读取的 id 保存会「找不到配置」
      id: 'legacy',
      name: parsed.model.trim(),
      provider: '',
      baseUrl: parsed.baseUrl.trim(),
      model: parsed.model.trim(),
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
      temperature:
        typeof parsed.temperature === 'number'
          ? parsed.temperature
          : DEFAULT_TEMPERATURE,
      maxTokens:
        typeof parsed.maxTokens === 'number'
          ? parsed.maxTokens
          : DEFAULT_MAX_TOKENS,
    }
    return { version: 2, activeId: profile.id, profiles: [profile] }
  } catch {
    return EMPTY_STORE
  }
}

function readBrowserStore(): BrowserStore {
  try {
    const raw = localStorage.getItem(BROWSER_CONFIG_KEY)
    if (!raw) {
      const migrated = migrateLegacyConfig()
      // 迁移结果立即落盘，避免每次读取重新迁移
      if (migrated.profiles.length > 0) {
        try {
          persistBrowserStore(migrated)
        } catch {
          // 无法写入时仍返回迁移结果，id 已固定为 legacy，保存时仍能命中
        }
      }
      return migrated
    }
    const parsed = JSON.parse(raw) as Partial<BrowserStore>
    return {
      version: 2,
      activeId: typeof parsed.activeId === 'string' ? parsed.activeId : null,
      profiles: Array.isArray(parsed.profiles)
        ? parsed.profiles
            .map(normalizeProfile)
            .filter((profile): profile is BrowserProfile => profile !== null)
        : [],
    }
  } catch {
    return EMPTY_STORE
  }
}

function persistBrowserStore(store: BrowserStore): void {
  try {
    localStorage.setItem(BROWSER_CONFIG_KEY, JSON.stringify(store))
  } catch {
    throw new Error('浏览器本地存储不可用，无法保存配置（可能处于隐私模式）')
  }
}

function activeBrowserProfile(store: BrowserStore): BrowserProfile | null {
  const active = store.activeId
    ? store.profiles.find((profile) => profile.id === store.activeId)
    : undefined
  return active ?? store.profiles[0] ?? null
}

/** 与 Rust 端 mask_key 保持一致：只保留末 4 位 */
function maskKey(key: string): string | null {
  if (!key) return null
  if (key.length <= 8) return '••••'
  return `••••${key.slice(-4)}`
}

/** 本机服务（Ollama / LM Studio 等）通常不需要密钥 */
export function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname
    return (
      host === '127.0.0.1' ||
      host === 'localhost' ||
      host === '::1' ||
      host === '[::1]'
    )
  } catch {
    return false
  }
}

function browserProfileStatus(profile: BrowserProfile): AiProfileStatus {
  const complete = Boolean(
    profile.baseUrl &&
      profile.model &&
      (profile.apiKey || isLocalBaseUrl(profile.baseUrl)),
  )
  return {
    id: profile.id,
    name: profile.name.trim() || profile.model,
    provider: profile.provider.trim() || '自定义服务',
    baseUrl: profile.baseUrl,
    model: profile.model,
    keyMasked: maskKey(profile.apiKey),
    keySource: profile.apiKey ? 'browser' : null,
    configured: complete,
    readOnly: false,
    temperature: profile.temperature,
    maxTokens: profile.maxTokens,
  }
}

function browserStatus(store: BrowserStore): AiStatus {
  const active = activeBrowserProfile(store)
  return {
    configured: active
      ? Boolean(
          active.baseUrl &&
            active.model &&
            (active.apiKey || isLocalBaseUrl(active.baseUrl)),
        )
      : false,
    activeId: active?.id ?? null,
    profiles: store.profiles.map(browserProfileStatus),
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return '未知错误'
}

/** 兼容 baseUrl 填到 /v1 或完整 endpoint 两种写法 */
function chatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`
}

/** OpenAI 兼容的模型列表接口 */
function modelsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  return /\/models$/.test(base) ? base : `${base}/models`
}

function extractErrorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: unknown }
      message?: unknown
    }
    const message =
      (parsed.error && typeof parsed.error.message === 'string'
        ? parsed.error.message
        : undefined) ??
      (typeof parsed.message === 'string' ? parsed.message : undefined)
    if (message) return message.slice(0, 200)
  } catch {
    // 非 JSON 响应：退回纯文本
  }
  return body.split(/\s+/).join(' ').slice(0, 200)
}

/** 与 Rust 端 classify_http_error 对齐的错误码与文案 */
function classifyHttpError(status: number, body: string): AiErrorInfo {
  const detail = extractErrorDetail(body)
  const suffix = detail ? `（${detail}）` : ''
  if (status === 401 || status === 403) {
    return {
      code: 'unauthorized',
      message: `API 密钥无效或没有访问权限，请在设置中检查密钥${suffix}`,
    }
  }
  if (status === 404) {
    return {
      code: 'endpoint_not_found',
      message: `接口地址或模型不存在，请检查 Base URL 与模型名${suffix}`,
    }
  }
  if (status === 429) {
    return {
      code: 'rate_limited',
      message: `请求过于频繁或额度不足，请稍后重试${suffix}`,
    }
  }
  if (status >= 500) {
    return {
      code: 'server_error',
      message: `AI 服务暂时不可用（HTTP ${status}），请稍后重试${suffix}`,
    }
  }
  return { code: 'http_error', message: `AI 服务返回错误（HTTP ${status}）${suffix}` }
}

function browserNetworkMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return '请求已取消'
  }
  if (error instanceof TypeError) {
    return '无法连接到 AI 服务，请检查网络与接口地址；若接口未允许跨域访问（CORS），浏览器预览将无法直连，请改用桌面版。'
  }
  return `网络请求失败：${errorText(error)}`
}

interface BrowserStreamChoice {
  delta?: { content?: string | null }
  finish_reason?: string | null
}

interface BrowserStreamChunk {
  choices?: BrowserStreamChoice[]
}

interface BrowserChatResponse {
  choices?: { message?: { content?: string | null } }[]
}

interface BrowserModelsResponse {
  data?: { id?: string | null }[]
}

export interface ChatStreamHandlers {
  onDelta: (text: string) => void
  onDone: (finishReason: string | null) => void
  onError: (error: AiErrorInfo) => void
}

/** 表单值 + 已保存配置合并成实际请求参数（密钥 / 地址留空时沿用保存值） */
function resolveBrowserInput(input: AiProfileInput): {
  profile: BrowserProfile | null
  baseUrl: string
  model: string
  apiKey: string
} {
  const store = readBrowserStore()
  const profile = input.id
    ? store.profiles.find((item) => item.id === input.id) ?? null
    : activeBrowserProfile(store)
  return {
    profile,
    baseUrl: (input.baseUrl.trim() || profile?.baseUrl || '').replace(/\/+$/, ''),
    model: input.model.trim() || profile?.model || '',
    apiKey: input.apiKey?.trim() || profile?.apiKey || '',
  }
}

/**
 * 浏览器直连：fetch + SSE 逐帧解析，任何路径都恰好触发一次
 * onDone / onError，与桌面端 Channel 行为保持一致。
 */
async function browserStreamChat(
  requestId: string,
  profileId: string | null,
  messages: AiChatMessage[],
  handlers: ChatStreamHandlers,
): Promise<void> {
  const store = readBrowserStore()
  if (store.profiles.length === 0) {
    handlers.onError({
      code: 'not_configured',
      message:
        'AI 助手尚未配置。请打开设置 → AI 助手 → 接入配置，添加一个模型。',
    })
    return
  }
  const profile =
    (profileId ? store.profiles.find((item) => item.id === profileId) : null) ??
    activeBrowserProfile(store)
  if (!profile) {
    handlers.onError({
      code: 'not_configured',
      message: '所选模型配置不存在，请在对话界面重新选择模型。',
    })
    return
  }
  if (!profile.baseUrl || !profile.model) {
    handlers.onError({
      code: 'not_configured',
      message: '当前模型配置不完整：请在设置中补全接口地址与模型名称。',
    })
    return
  }
  if (!profile.apiKey && !isLocalBaseUrl(profile.baseUrl)) {
    handlers.onError({
      code: 'not_configured',
      message: '当前模型配置缺少 API 密钥，请在设置 → AI 助手中补充，或切换到其他模型。',
    })
    return
  }
  if (messages.length === 0) {
    handlers.onError({ code: 'empty_messages', message: '没有可发送的对话内容。' })
    return
  }

  const controller = new AbortController()
  browserRequests.set(requestId, controller)

  let settled = false
  const settle = (fn: () => void) => {
    if (settled) return
    settled = true
    fn()
  }

  try {
    let response: Response
    try {
      response = await fetch(chatCompletionsUrl(profile.baseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...(profile.apiKey
            ? { Authorization: `Bearer ${profile.apiKey}` }
            : {}),
        },
        body: JSON.stringify({
          model: profile.model,
          messages,
          temperature: profile.temperature,
          max_tokens: profile.maxTokens,
          stream: true,
        }),
        signal: controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted) {
        settle(() => handlers.onDone('cancelled'))
      } else {
        settle(() =>
          handlers.onError({
            code: 'network_error',
            message: browserNetworkMessage(error),
          }),
        )
      }
      return
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      settle(() => handlers.onError(classifyHttpError(response.status, body)))
      return
    }

    const reader = response.body?.getReader()
    if (!reader) {
      settle(() =>
        handlers.onError({
          code: 'stream_error',
          message: '当前浏览器不支持流式响应，请改用桌面版。',
        }),
      )
      return
    }

    const decoder = new TextDecoder()
    let buffer = ''
    let emitted = false
    let finishReason: string | null = null

    const handleFrame = (frame: string): boolean => {
      for (const line of frame.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (!data) continue
        if (data === '[DONE]') return true
        let parsed: BrowserStreamChunk
        try {
          parsed = JSON.parse(data) as BrowserStreamChunk
        } catch {
          continue
        }
        for (const choice of parsed.choices ?? []) {
          if (choice.finish_reason) finishReason = choice.finish_reason
          const text = choice.delta?.content
          if (text) {
            emitted = true
            handlers.onDelta(text)
          }
        }
      }
      return false
    }

    let done = false
    while (!done) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      if (buffer.includes('\r')) buffer = buffer.replace(/\r\n/g, '\n')
      let index = buffer.indexOf('\n\n')
      while (index >= 0) {
        const frame = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        if (handleFrame(frame)) {
          done = true
          break
        }
        index = buffer.indexOf('\n\n')
      }
    }
    if (!done && buffer.trim()) handleFrame(buffer)

    if (!emitted && !finishReason) {
      settle(() =>
        handlers.onError({
          code: 'empty_response',
          message: '模型没有返回有效内容，请重试或更换模型。',
        }),
      )
      return
    }
    settle(() => handlers.onDone(finishReason))
  } catch (error) {
    if (controller.signal.aborted) {
      settle(() => handlers.onDone('cancelled'))
    } else {
      settle(() =>
        handlers.onError({ code: 'stream_error', message: errorText(error) }),
      )
    }
  } finally {
    browserRequests.delete(requestId)
  }
}

/**
 * 发起流式对话：桌面端由 Rust 后端通过 Channel 逐段推送，
 * 浏览器预览则直连上游；两种路径都保证恰好一次 onDone / onError。
 */
export async function streamChat(
  requestId: string,
  profileId: string | null,
  messages: AiChatMessage[],
  handlers: ChatStreamHandlers,
): Promise<void> {
  if (!isTauriRuntime()) {
    await browserStreamChat(requestId, profileId, messages, handlers)
    return
  }

  const channel = new Channel<AiStreamEvent>()
  let settled = false
  channel.onmessage = (event) => {
    if (event.type === 'delta') {
      if (!settled) handlers.onDelta(event.text)
      return
    }
    if (settled) return
    settled = true
    if (event.type === 'done') {
      handlers.onDone(event.finishReason ?? null)
    } else {
      handlers.onError({ code: event.code, message: event.message })
    }
  }

  try {
    await invoke('ai_chat', {
      request: { requestId, profileId, messages },
      onEvent: channel,
    })
    // 兜底：命令正常返回但未收到终止事件（例如上游直接关闭连接）
    if (!settled) {
      settled = true
      handlers.onDone(null)
    }
  } catch (error) {
    if (!settled) {
      settled = true
      handlers.onError({ code: 'unknown', message: errorText(error) })
    }
  }
}

/** 取消进行中的请求：桌面端由后端收尾，浏览器端直接中断 fetch */
export function cancelChat(requestId: string): void {
  if (!isTauriRuntime()) {
    browserRequests.get(requestId)?.abort()
    browserRequests.delete(requestId)
    return
  }
  void invoke('ai_cancel', { requestId }).catch(() => undefined)
}

const EMPTY_STATUS: AiStatus = { configured: false, activeId: null, profiles: [] }

export async function getAiStatus(): Promise<AiStatus> {
  if (!isTauriRuntime()) return browserStatus(readBrowserStore())
  try {
    return await invoke<AiStatus>('ai_get_status')
  } catch {
    return EMPTY_STATUS
  }
}

function validateBrowserInput(
  baseUrl: string,
  model: string,
): void {
  if (!baseUrl) throw new Error('请填写接口地址（Base URL）')
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error('接口地址必须以 http:// 或 https:// 开头')
  }
  if (!model) throw new Error('请填写模型名称')
}

/** 新增或更新一条模型配置；apiKey 留空时沿用该配置已保存的密钥 */
export async function saveAiProfile(input: AiProfileInput): Promise<AiStatus> {
  if (isTauriRuntime()) return invoke<AiStatus>('ai_save_profile', { profile: input })

  const baseUrl = input.baseUrl.trim().replace(/\/+$/, '')
  const model = input.model.trim()
  validateBrowserInput(baseUrl, model)
  // 未自定义名称时默认用模型名，与桌面端保持一致
  const name = input.name?.trim() || model
  const provider = input.provider?.trim() || '自定义服务'

  const store = readBrowserStore()
  const index = input.id
    ? store.profiles.findIndex((profile) => profile.id === input.id)
    : -1
  if (input.id && index < 0) {
    throw new Error('未找到要修改的配置，它可能已被删除')
  }
  const apiKey = input.apiKey?.trim()
  if (index >= 0) {
    const current = store.profiles[index]
    store.profiles[index] = {
      ...current,
      name,
      provider,
      baseUrl,
      model,
      apiKey: apiKey || current.apiKey,
      temperature:
        typeof input.temperature === 'number'
          ? input.temperature
          : current.temperature,
      maxTokens:
        typeof input.maxTokens === 'number'
          ? input.maxTokens
          : current.maxTokens,
    }
  } else {
    const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    store.profiles.push({
      id,
      name,
      provider,
      baseUrl,
      model,
      apiKey: apiKey ?? '',
      temperature:
        typeof input.temperature === 'number'
          ? input.temperature
          : DEFAULT_TEMPERATURE,
      maxTokens:
        typeof input.maxTokens === 'number'
          ? input.maxTokens
          : DEFAULT_MAX_TOKENS,
    })
    store.activeId = id
  }
  persistBrowserStore(store)
  return browserStatus(store)
}

/** 切换当前使用的模型配置 */
export async function activateAiProfile(id: string): Promise<AiStatus> {
  if (isTauriRuntime()) return invoke<AiStatus>('ai_activate_profile', { id })

  const store = readBrowserStore()
  if (!store.profiles.some((profile) => profile.id === id)) {
    throw new Error('未找到该模型配置')
  }
  store.activeId = id
  persistBrowserStore(store)
  return browserStatus(store)
}

/** 删除一条模型配置；删除当前项时自动切换到剩余的第一条 */
export async function deleteAiProfile(id: string): Promise<AiStatus> {
  if (isTauriRuntime()) return invoke<AiStatus>('ai_delete_profile', { id })

  const store = readBrowserStore()
  const remaining = store.profiles.filter((profile) => profile.id !== id)
  if (remaining.length === store.profiles.length) {
    throw new Error('未找到该模型配置')
  }
  store.profiles = remaining
  if (store.activeId === id) store.activeId = remaining[0]?.id ?? null
  persistBrowserStore(store)
  return browserStatus(store)
}

/** 清除某条配置保存在本机的密钥（省略 id 时清除当前项） */
export async function clearAiKey(profileId?: string): Promise<AiStatus> {
  if (isTauriRuntime()) return invoke<AiStatus>('ai_clear_key', { profileId })

  const store = readBrowserStore()
  const target = profileId ?? store.activeId ?? store.profiles[0]?.id
  const profile = target
    ? store.profiles.find((item) => item.id === target)
    : undefined
  if (!profile) throw new Error('尚未配置任何模型')
  profile.apiKey = ''
  persistBrowserStore(store)
  return browserStatus(store)
}

/** 连通性测试：提交当前表单值（不落盘），密钥留空时沿用已保存值 */
export async function testAiConnection(
  config: AiProfileInput,
): Promise<string> {
  if (isTauriRuntime()) return invoke<string>('ai_test', { config })

  const { baseUrl, model, apiKey } = resolveBrowserInput(config)
  validateBrowserInput(baseUrl, model)
  if (!apiKey && !isLocalBaseUrl(baseUrl)) {
    throw new Error('尚未填写 API 密钥')
  }

  let response: Response
  try {
    response = await fetch(chatCompletionsUrl(baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: '你好' }],
        temperature: 0,
        max_tokens: 16,
        stream: false,
      }),
    })
  } catch (error) {
    throw new Error(browserNetworkMessage(error))
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(classifyHttpError(response.status, body).message)
  }

  const parsed = (await response.json().catch(() => null)) as
    | BrowserChatResponse
    | null
  const reply = parsed?.choices?.[0]?.message?.content?.trim() ?? ''
  const summary = reply ? `连接成功：${reply.slice(0, 40)}` : '连接成功'
  return `${summary}（模型 ${model}）`
}

/** 从服务端 GET /models 获取可用模型（桌面经 Rust 代理，浏览器直连） */
export async function listModels(config: AiProfileInput): Promise<string[]> {
  if (isTauriRuntime()) return invoke<string[]>('ai_list_models', { config })

  const { baseUrl, apiKey } = resolveBrowserInput(config)
  if (!baseUrl) throw new Error('请填写接口地址（Base URL）')
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error('接口地址必须以 http:// 或 https:// 开头')
  }
  if (!apiKey && !isLocalBaseUrl(baseUrl)) throw new Error('请填写 API 密钥')

  let response: Response
  try {
    response = await fetch(modelsUrl(baseUrl), {
      headers: {
        Accept: 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
    })
  } catch (error) {
    throw new Error(browserNetworkMessage(error))
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(classifyHttpError(response.status, body).message)
  }

  const parsed = (await response.json().catch(() => null)) as
    | BrowserModelsResponse
    | null
  const models = (parsed?.data ?? [])
    .map((item) => (typeof item?.id === 'string' ? item.id.trim() : ''))
    .filter((id) => id.length > 0)
  const unique = [...new Set(models)].sort((a, b) => a.localeCompare(b))
  if (unique.length === 0) {
    throw new Error('服务返回了空的模型列表，可手动输入模型名')
  }
  return unique
}
