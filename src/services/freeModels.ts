/**
 * 免费模型目录（浏览器预览环境的镜像实现）。
 *
 * 模型清单不硬编码：运行时向各网关的 OpenAI 兼容 `GET /models` 拉取，
 * 结果按 HTTP 缓存语义存在 localStorage。接口不可用时依次降级：
 * 本地缓存 → 内置兜底模型（每个来源至少一条）→ 该来源不展示。
 * 桌面端由 src-tauri/src/ai.rs 提供同样的能力，两端行为保持一致。
 */

export type FreeSourceStatus = 'ok' | 'cached' | 'fallback' | 'unavailable'

export interface FreeProviderSpec {
  source: string
  label: string
  baseUrl: string
  /** 网关要求的固定公开令牌（OpenCode Zen 为 `public`） */
  bearer: string | null
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
    bearer: 'public',
    note: '无需注册；固定 Bearer public；IP 限速，高峰可能 429；提示词可能被上游记录。',
    fallback: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }],
  },
  {
    source: 'kilo',
    label: 'Kilo AI',
    baseUrl: 'https://api.kilo.ai/api/gateway',
    bearer: null,
    note: '无需 Key；自动路由免费模型池，约 200 次/小时；提示词可能被上游记录。',
    fallback: [{ id: 'kilo-auto/free', name: 'Auto Free（自动路由）' }],
  },
  {
    source: 'llm7',
    label: 'LLM7.io',
    baseUrl: 'https://api.llm7.io/v1',
    bearer: null,
    note: '无需 Key；匿名约 60 次/分钟、250 次/小时。',
    fallback: [{ id: 'gpt-oss-20b', name: 'GPT-OSS 20B' }],
  },
  {
    source: 'pollinations',
    label: 'Pollinations',
    baseUrl: 'https://text.pollinations.ai/openai',
    bearer: null,
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
  bearer: string | null
  /** 来源说明：限速、隐私提示等 */
  note: string
}

export interface FreeSourceInfo {
  source: string
  label: string
  baseUrl: string
  note: string
  status: FreeSourceStatus
  count: number
}

interface FreeModelEntry {
  id: string
  name: string | null
}

interface FreeSourceCache {
  state: FreeSourceStatus
  fetchedAt: number
  models: FreeModelEntry[]
}

interface FreeCatalogCache {
  version: 1
  fetchedAt: number
  sources: Record<string, FreeSourceCache>
}

const CACHE_KEY = 'bianqian.assistant.ai.free.v1'
/** 拉取成功后的缓存有效期；失败且已有模型时的重试间隔 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const RETRY_MS = 10 * 60 * 1000
/** 单个网关最多展示的模型数，避免选择器过长 */
const MODEL_LIMIT = 40
const FETCH_TIMEOUT_MS = 10_000

const EMPTY_CACHE: FreeCatalogCache = { version: 1, fetchedAt: 0, sources: {} }

let cache: FreeCatalogCache | null = null
let inflight: Promise<void> | null = null

function emptyCache(): FreeCatalogCache {
  return { version: 1, fetchedAt: 0, sources: {} }
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
    version: 1,
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
    bearer: provider.bearer,
    note: provider.note,
  }
}

/** 当前来源可用的模型：优先缓存/最新结果，没有时回退到内置兜底 */
function sourceSnapshot(provider: FreeProviderSpec): {
  models: FreeModelEntry[]
  status: FreeSourceStatus
} {
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
    models: provider.fallback.map((item) => ({ id: item.id, name: item.name })),
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
    return {
      source: provider.source,
      label: provider.label,
      baseUrl: provider.baseUrl,
      note: provider.note,
      status: snapshot.status,
      count: snapshot.models.length,
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
  return toFreeModel(parsed.provider, { id: parsed.model, name: null })
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
  cost?: { text?: { output?: { price?: unknown } } }
}

interface ModelsResponse {
  data?: unknown
}

/** 运行时拉取单个网关的模型列表：只保留 chat 且免费（若接口给出价格）的条目 */
async function fetchProviderModels(
  provider: FreeProviderSpec,
): Promise<FreeModelEntry[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(modelsUrl(provider.baseUrl), {
      headers: {
        Accept: 'application/json',
        ...(provider.bearer ? { Authorization: `Bearer ${provider.bearer}` } : {}),
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
    if (typeof item.type === 'string' && item.type !== 'chat') continue
    const price = item.cost?.text?.output?.price
    if (typeof price === 'number' && price > 0) continue
    const name =
      typeof item.name === 'string' && item.name.trim() ? item.name.trim() : null
    models.push({ id, name })
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
  persistCache({ version: 1, fetchedAt, sources })
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
