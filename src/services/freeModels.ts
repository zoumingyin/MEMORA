/**
 * 免费模型目录（浏览器预览环境的镜像实现）。
 *
 * 模型清单不硬编码：运行时向各网关的 OpenAI 兼容 `GET /models` 拉取，
 * 结果按 HTTP 缓存语义存在 localStorage。接口不可用时依次降级：
 * 本地缓存 → 内置兜底模型（每个来源至少一条）→ 该来源不展示。
 * 桌面端由 src-tauri/src/ai.rs 提供同样的能力，两端行为保持一致。
 */

import type { AiModality } from '../types/ai'

export type FreeSourceStatus = 'ok' | 'cached' | 'fallback' | 'unavailable'

export interface FreeProviderSpec {
  source: string
  label: string
  baseUrl: string
  /** 是否需要用户自己的密钥（OpenCode Zen 用个人免费额度） */
  requiresKey: boolean
  /** 来源说明：限速、隐私提示等 */
  note: string
  /** 接口不可用时的兜底模型；为空则该来源直接隐藏 */
  fallback: { id: string; name: string }[]
}

const PROVIDERS: FreeProviderSpec[] = [
  {
    source: 'opencode',
    label: 'OpenCode Zen',
    baseUrl: 'https://opencode.ai/inference/v1',
    requiresKey: true,
    note: '使用应用内置的 OpenCode API Key（仅使用账号下的零费用模型）；免费额度按账号限速，超限返回 429；提示词可能被上游记录。',
    fallback: [
      { id: 'deepseek-v4.1-flash-free', name: 'DeepSeek V4.1 Flash Free' },
    ],
  },
  {
    source: 'kilo',
    label: 'Kilo AI',
    baseUrl: 'https://api.kilo.ai/api/gateway',
    requiresKey: false,
    note: '无需 Key；自动路由免费模型池，约 200 次/小时；提示词可能被上游记录。',
    fallback: [{ id: 'kilo-auto/free', name: 'Auto Free（自动路由）' }],
  },
  {
    source: 'llm7',
    label: 'LLM7.io',
    baseUrl: 'https://api.llm7.io/v1',
    requiresKey: false,
    note: '无需 Key；匿名约 60 次/分钟、250 次/小时。',
    fallback: [{ id: 'gpt-oss:20b', name: 'GPT-OSS 20B' }],
  },
  {
    source: 'pollinations',
    label: 'Pollinations',
    baseUrl: 'https://text.pollinations.ai/openai',
    requiresKey: false,
    note: '无需 Key；匿名层模型随上游调整，以接口返回为准。',
    fallback: [{ id: 'openai-fast', name: 'GPT-OSS 20B（匿名）' }],
  },
]

export interface FreeModel {
  id: string
  name: string
  model: string
  /** 来源标识（分组键） */
  source: string
  /** 来源展示名，同时作为 provider 显示 */
  sourceLabel: string
  baseUrl: string
  /** 该来源是否需要用户自己的密钥 */
  requiresKey: boolean
  /** 来源说明：限速、隐私提示等 */
  note: string
  /** 输出模态：非 text 的模型不能用于本应用的文本对话 */
  modality: AiModality
}

export interface FreeSourceInfo {
  source: string
  label: string
  baseUrl: string
  note: string
  status: FreeSourceStatus
  count: number
  requiresKey: boolean
  keyMasked: string | null
  /** browser：浏览器 localStorage；builtin：编译期内置；null：未设置 */
  keySource: 'browser' | 'builtin' | null
}

interface FreeModelEntry {
  id: string
  name: string | null
  /** 输出模态；旧缓存缺这个字段时按文本处理 */
  modality: AiModality
}

interface FreeSourceCache {
  state: FreeSourceStatus
  fetchedAt: number
  models: FreeModelEntry[]
}

interface FreeCatalogCache {
  version: 3
  fetchedAt: number
  sources: Record<string, FreeSourceCache>
}

/**
 * 缓存键带版本号：免费筛选规则 / 条目结构变化时递增，
 * 旧缓存里的付费、不可用或缺模态信息的条目直接作废
 */
const CACHE_KEY = 'bianqian.assistant.ai.free.v3'
/** 来源密钥（source → key）：浏览器预览只存 localStorage，桌面端存 ai-config.json */
const KEYS_KEY = 'bianqian.assistant.ai.free.keys.v1'
/**
 * 编译期内置的来源密钥：vite.config.ts 与 src-tauri/build.rs 读同一个
 * src-tauri/keys/opencode.key，浏览器预览没有 Rust 后端时由此兜底。
 * 文件缺失时为空字符串，行为与未内置一致。
 */
const BUILTIN_SOURCE_KEYS: Record<string, string> = {
  opencode: __BUILTIN_OPENCODE_KEY__,
}
/** 拉取成功后的缓存有效期；失败且已有模型时的重试间隔 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const RETRY_MS = 10 * 60 * 1000
/** 单个网关最多展示的模型数，避免选择器过长 */
const MODEL_LIMIT = 40
const FETCH_TIMEOUT_MS = 10_000

let cache: FreeCatalogCache | null = null
let inflight: Promise<void> | null = null

function emptyCache(): FreeCatalogCache {
  return { version: 3, fetchedAt: 0, sources: {} }
}

function normalizeModality(raw: unknown): AiModality {
  return raw === 'image' || raw === 'audio' || raw === 'video' ? raw : 'text'
}

/** 只做浅校验：缓存文件损坏时丢弃，重新拉取 */
function normalizeCache(raw: unknown): FreeCatalogCache {
  if (typeof raw !== 'object' || raw === null) return emptyCache()
  const item = raw as Record<string, unknown>
  const sources: Record<string, FreeSourceCache> = {}
  const rawSources =
    typeof item.sources === 'object' && item.sources !== null
      ? (item.sources as Record<string, unknown>)
      : {}
  for (const [key, value] of Object.entries(rawSources)) {
    if (typeof value !== 'object' || value === null) continue
    const entry = value as Record<string, unknown>
    if (!Array.isArray(entry.models)) continue
    const models = entry.models.flatMap((model): FreeModelEntry[] => {
      if (typeof model !== 'object' || model === null) return []
      const modelEntry = model as Record<string, unknown>
      if (typeof modelEntry.id !== 'string' || !modelEntry.id.trim()) return []
      return [
        {
          id: modelEntry.id.trim(),
          name:
            typeof modelEntry.name === 'string' && modelEntry.name.trim()
              ? modelEntry.name.trim()
              : null,
          modality: normalizeModality(modelEntry.modality),
        },
      ]
    })
    if (models.length === 0) continue
    const state = entry.state
    sources[key] = {
      state:
        state === 'ok' || state === 'cached' || state === 'fallback'
          ? state
          : 'cached',
      fetchedAt: typeof entry.fetchedAt === 'number' ? entry.fetchedAt : 0,
      models,
    }
  }
  return {
    version: 3,
    fetchedAt: typeof item.fetchedAt === 'number' ? item.fetchedAt : 0,
    sources,
  }
}

function readCache(): FreeCatalogCache {
  if (cache) return cache
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    cache = raw ? normalizeCache(JSON.parse(raw)) : emptyCache()
  } catch {
    cache = emptyCache()
  }
  return cache
}

function persistCache(next: FreeCatalogCache): void {
  cache = next
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(next))
  } catch {
    // 存储不可用（隐私模式 / 配额满）时仅保留内存结果
  }
}

export function findFreeProvider(source: string): FreeProviderSpec | undefined {
  return PROVIDERS.find((provider) => provider.source === source)
}

function readSourceKeys(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEYS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) return {}
    const keys: Record<string, string> = {}
    for (const [source, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim()) keys[source] = value.trim()
    }
    return keys
  } catch {
    return {}
  }
}

/** 某个来源已保存在 localStorage 的密钥；未设置时返回 null */
function savedSourceKey(source: string): string | null {
  return readSourceKeys()[source] ?? null
}

/**
 * 某个来源实际生效的密钥：localStorage 优先，其次编译期内置，
 * 与 Rust 端 env > file > builtin 的优先级保持一致。
 */
export function freeSourceKey(source: string): string | null {
  const saved = savedSourceKey(source)
  if (saved) return saved
  const builtin = (BUILTIN_SOURCE_KEYS[source] ?? '').trim()
  return builtin || null
}

/** 与 Rust 端 mask_key 一致：只保留末 4 位 */
function maskFreeKey(key: string | null): string | null {
  if (!key) return null
  return key.length <= 8 ? '••••' : `••••${key.slice(-4)}`
}

/** 免费模型 id 形如 `free:{source}:{modelId}`；模型 id 自身可能含 `:`，只切前两段 */
export function parseFreeModelId(
  id: string,
): { provider: FreeProviderSpec; model: string } | null {
  if (!id.startsWith('free:')) return null
  const rest = id.slice('free:'.length)
  const index = rest.indexOf(':')
  if (index <= 0) return null
  const source = rest.slice(0, index)
  const model = rest.slice(index + 1)
  if (!model) return null
  const provider = findFreeProvider(source)
  return provider ? { provider, model } : null
}

export function isFreeModelId(id: string): boolean {
  return parseFreeModelId(id) !== null
}

/** 接口未返回 name 时，用模型 id 生成可读名称（去掉 `:free` 后缀、连字符转空格） */
function displayName(id: string, name: string | null): string {
  const trimmed = name?.trim()
  if (trimmed) return trimmed
  const base = id.split(':')[0] || id
  const spaced = base.replace(/[-_]/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

function toFreeModel(provider: FreeProviderSpec, entry: FreeModelEntry): FreeModel {
  return {
    id: `free:${provider.source}:${entry.id}`,
    name: displayName(entry.id, entry.name),
    model: entry.id,
    source: provider.source,
    sourceLabel: provider.label,
    baseUrl: provider.baseUrl,
    requiresKey: provider.requiresKey,
    note: provider.note,
    modality: entry.modality,
  }
}

/** 当前来源可用的模型：优先缓存/最新结果，没有时回退到内置兜底 */
function sourceSnapshot(provider: FreeProviderSpec): {
  models: FreeModelEntry[]
  status: FreeSourceStatus
} {
  // 需要密钥但尚未填写时不展示兜底模型：选中后请求必然失败
  if (provider.requiresKey && !freeSourceKey(provider.source)) {
    return { models: [], status: 'unavailable' }
  }
  const entry = readCache().sources[provider.source]
  if (entry && entry.models.length > 0) {
    const status: FreeSourceStatus =
      entry.state === 'ok' || entry.state === 'cached' ? entry.state : 'cached'
    return { models: entry.models, status }
  }
  if (provider.fallback.length === 0) {
    return { models: [], status: 'unavailable' }
  }
  return {
    models: provider.fallback.map((item) => ({
      id: item.id,
      name: item.name,
      modality: 'text' as const,
    })),
    status: 'fallback',
  }
}

/** 全部免费模型：按来源顺序拼接，与桌面端顺序一致 */
export function allFreeModels(): FreeModel[] {
  const models: FreeModel[] = []
  for (const provider of PROVIDERS) {
    for (const entry of sourceSnapshot(provider).models) {
      models.push(toFreeModel(provider, entry))
    }
  }
  return models
}

/** 各来源的可用状态，供设置页展示「实时 / 缓存 / 兜底 / 不可用」 */
export function freeSourceInfos(): FreeSourceInfo[] {
  return PROVIDERS.map((provider) => {
    const snapshot = sourceSnapshot(provider)
    const key = freeSourceKey(provider.source)
    return {
      source: provider.source,
      label: provider.label,
      baseUrl: provider.baseUrl,
      note: provider.note,
      status: snapshot.status,
      count: snapshot.models.length,
      requiresKey: provider.requiresKey,
      keyMasked: maskFreeKey(key),
      keySource: savedSourceKey(provider.source)
        ? 'browser'
        : key
          ? 'builtin'
          : null,
    }
  })
}

/**
 * 按 id 找免费模型。列表里没有时仍按 id 还原请求目标——
 * 模型可能因上游下线而从最新列表中消失，但用户先前选中过，不应变成「配置不存在」。
 */
export function findFreeModel(id: string): FreeModel | undefined {
  const cached = allFreeModels().find((model) => model.id === id)
  if (cached) return cached
  const parsed = parseFreeModelId(id)
  if (!parsed) return undefined
  // 需要密钥的来源在密钥被清除后不再按 id 还原，与桌面端一致
  if (parsed.provider.requiresKey && !freeSourceKey(parsed.provider.source)) {
    return undefined
  }
  return toFreeModel(parsed.provider, {
    id: parsed.model,
    name: null,
    modality: 'text',
  })
}

function isCatalogFresh(): boolean {
  const current = readCache()
  if (current.fetchedAt === 0) return false
  const hasModels = Object.values(current.sources).some(
    (source) => source.models.length > 0,
  )
  return Date.now() - current.fetchedAt < (hasModels ? CACHE_TTL_MS : RETRY_MS)
}

function modelsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  return /\/models$/.test(base) ? base : `${base}/models`
}

interface ModelsResponseItem {
  id?: unknown
  name?: unknown
  type?: unknown
  model_type?: unknown
  isFree?: unknown
  usage_based_only?: unknown
  pricing?: { prompt?: unknown; completion?: unknown }
  cost?: { text?: { output?: { price?: unknown } } }
  /** Kilo / OpenRouter 风格：声明输入与输出模态 */
  architecture?: { output_modalities?: unknown }
  /** LLM7 风格 */
  modalities?: { output?: unknown }
}

interface ModelsResponse {
  data?: unknown
}

/** 价格字段可能是数字或字符串（"0" / "-1"），>0 视为付费；字段缺失按免费处理 */
function pricePositive(value: unknown): boolean {
  const price =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseFloat(value)
        : Number.NaN
  return Number.isFinite(price) && price > 0
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

/**
 * 从网关条目推断输出模态，与 Rust 端 item_modality 保持一致：
 * 优先看 `architecture.output_modalities` / `modalities.output`，再看 `model_type`。
 * 混合输出（如 ["text","audio"]）取非文本的那一种——chat/completions 用不了它。
 */
function itemModality(item: ModelsResponseItem): AiModality {
  const outputs = [
    ...stringList(item.architecture?.output_modalities),
    ...stringList(item.modalities?.output),
  ]
  const kind = typeof item.model_type === 'string' ? item.model_type : ''
  const has = (needle: string) =>
    outputs.includes(needle) || kind.includes(needle)
  if (has('video')) return 'video'
  if (has('audio') || kind.includes('speech')) return 'audio'
  if (has('image')) return 'image'
  return 'text'
}

/**
 * 运行时拉取单个网关的模型列表：只保留「可用于对话且确实免费」的条目。
 * 各网关免费标记不一致，逐项判断：
 * - `type` / `model_type` 不是 chat（语音转写、图像生成等）不能对话；
 * - Kilo 用 `isFree`、LLM7 用 `usage_based_only` 标记付费模型（后者匿名请求会 401）；
 * - 价格字段（OpenRouter 风格 `cost.text.output.price` 与 `pricing.prompt/completion`）>0。
 */
async function fetchProviderModels(
  provider: FreeProviderSpec,
): Promise<FreeModelEntry[]> {
  const key = freeSourceKey(provider.source)
  if (provider.requiresKey && !key) {
    throw new Error(`${provider.label} 缺少可用密钥（构建时未内置，请在设置中配置）`)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(modelsUrl(provider.baseUrl), {
      headers: {
        Accept: 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      signal: controller.signal,
    })
  } catch {
    throw new Error('网络不可达或响应超时')
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  const parsed = (await response.json().catch(() => null)) as ModelsResponse | null
  if (!parsed || !Array.isArray(parsed.data)) {
    throw new Error('模型列表格式不符合预期')
  }
  const models: FreeModelEntry[] = []
  for (const item of parsed.data as ModelsResponseItem[]) {
    const id = typeof item?.id === 'string' ? item.id.trim() : ''
    if (!id) continue
    const kind =
      typeof item.type === 'string'
        ? item.type
        : typeof item.model_type === 'string'
          ? item.model_type
          : null
    if (kind && kind !== 'chat') continue
    if (item.isFree === false) continue
    if (item.usage_based_only === true) continue
    if (
      pricePositive(item.cost?.text?.output?.price) ||
      pricePositive(item.pricing?.prompt) ||
      pricePositive(item.pricing?.completion)
    ) {
      continue
    }
    const name =
      typeof item.name === 'string' && item.name.trim() ? item.name.trim() : null
    models.push({ id, name, modality: itemModality(item) })
  }
  models.sort((a, b) => a.id.localeCompare(b.id))
  const unique = models.filter(
    (model, index) => index === 0 || models[index - 1].id !== model.id,
  )
  const limited = unique.slice(0, MODEL_LIMIT)
  if (limited.length === 0) throw new Error('服务返回了空的模型列表')
  return limited
}

async function refreshCatalog(): Promise<void> {
  const results = await Promise.allSettled(
    PROVIDERS.map((provider) => fetchProviderModels(provider)),
  )
  const fetchedAt = Date.now()
  const current = readCache()
  const sources: Record<string, FreeSourceCache> = { ...current.sources }
  results.forEach((result, index) => {
    const provider = PROVIDERS[index]
    if (result.status === 'fulfilled') {
      sources[provider.source] = {
        state: 'ok',
        fetchedAt,
        models: result.value,
      }
      return
    }
    const previous = current.sources[provider.source]
    if (!previous || previous.models.length === 0) {
      // 不写入空条目，读取时会自动回退到内置兜底模型
      delete sources[provider.source]
      return
    }
    sources[provider.source] = {
      state: 'cached',
      fetchedAt: previous.fetchedAt,
      models: previous.models,
    }
  })
  persistCache({ version: 3, fetchedAt, sources })
}

/**
 * 确保目录可用：缓存新鲜时直接返回，否则并发拉取一次。
 * 任何异常都被吞掉——调用方总能拿到「缓存或兜底」的可用列表。
 */
export async function ensureFreeCatalog(force = false): Promise<void> {
  if (!force && isCatalogFresh()) return
  if (inflight) return inflight
  inflight = refreshCatalog()
    .catch(() => undefined)
    .finally(() => {
      inflight = null
    })
  return inflight
}
