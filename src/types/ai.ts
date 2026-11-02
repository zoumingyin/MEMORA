/** AI 助手：前后端共享的类型定义（与 src-tauri/src/ai.rs 对应） */

/** 推理强度：none 关闭思考；low / medium / high 为思考强度分档 */
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high'

/** 模型输出模态：本应用只走文本对话，非 text 的免费模型只展示不可选 */
export type AiModality = 'text' | 'image' | 'audio' | 'video'

/** 非文本模型走不了 chat/completions：选择器与设置列表据此禁用 */
export function isNonTextModality(modality: AiModality | null): boolean {
  // 兼容尚未返回该字段的旧后端：undefined 按文本处理
  return modality != null && modality !== 'text'
}

/** 单条模型配置的展示状态（后端永不返回明文密钥） */
export interface AiProfileStatus {
  id: string
  /** 展示名称；未自定义时为模型名 */
  name: string
  provider: string
  baseUrl: string
  model: string
  keyMasked: string | null
  /** env：环境变量；file：桌面端本机配置；browser：浏览器 localStorage */
  keySource: 'env' | 'file' | 'browser' | null
  /** 接口地址、模型与密钥是否齐全 */
  configured: boolean
  /** 环境变量注入 / 内置免费模型只读，不能编辑或删除 */
  readOnly: boolean
  /** 内置免费模型（不写入用户配置文件） */
  free: boolean
  /** 免费模型来源标识与展示名，用于按来源分组 */
  source: string | null
  sourceLabel: string | null
  /** 来源说明：限速、隐私提示等 */
  note: string | null
  /** 输出模态：仅免费模型有值；普通配置为 null（按文本处理） */
  modality: AiModality | null
  temperature: number
  maxTokens: number
  /** 推理强度；null 表示不干预，由服务商决定 */
  reasoning: ReasoningEffort | null
}

/** 免费模型来源的可用状态：实时拉取 / 本地缓存 / 内置兜底 / 不可用 */
export type AiFreeSourceStatus = 'ok' | 'cached' | 'fallback' | 'unavailable'

/** 免费模型来源概况（模型清单一律运行时获取，不在客户端硬编码） */
export interface AiFreeSource {
  source: string
  label: string
  baseUrl: string
  note: string
  status: AiFreeSourceStatus
  count: number
  /** 需要用户自己的账号密钥（OpenCode Zen） */
  requiresKey: boolean
  /** 已保存密钥的掩码；null 表示未设置 */
  keyMasked: string | null
  /** env：环境变量；file：本机配置；browser：浏览器 localStorage；builtin：编译期内置；null：未设置 */
  keySource: 'env' | 'file' | 'browser' | 'builtin' | null
}

/** 全部配置状态：当前选中的模型 + 已配置列表 + 免费来源概况 */
export interface AiStatus {
  configured: boolean
  activeId: string | null
  profiles: AiProfileStatus[]
  freeSources: AiFreeSource[]
}

/** 保存 / 测试时提交的单个配置；id 为空表示新增，apiKey 留空表示沿用已保存密钥 */
export interface AiProfileInput {
  id?: string
  /** 展示名称；留空时使用模型名 */
  name?: string
  provider?: string
  baseUrl: string
  model: string
  apiKey?: string
  temperature?: number
  maxTokens?: number
  /** 推理强度；传空字符串表示清除设置，恢复服务商默认 */
  reasoning?: ReasoningEffort | ''
}

/** 稳定错误码：前端据此决定兜底文案与操作按钮 */
export type AiErrorCode =
  | 'not_configured'
  | 'unauthorized'
  | 'endpoint_not_found'
  | 'rate_limited'
  | 'server_error'
  | 'http_error'
  | 'network_error'
  | 'stream_error'
  | 'empty_response'
  | 'empty_messages'
  | 'client_init_failed'
  | 'interrupted'
  | 'unknown'

export interface AiErrorInfo {
  code: AiErrorCode | string
  message: string
}

/** 发送给模型的单条消息（OpenAI Chat Completions 规范） */
export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 后端流式事件（serde tag = "type"） */
export type AiStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; finishReason?: string | null }
  | { type: 'error'; code: string; message: string }
  /** 仅开发环境：后端诊断信息，前端只打印到控制台 */
  | { type: 'debug'; message: string }

/** 对话界面中的一条消息 */
export interface AssistantMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  status: 'done' | 'streaming' | 'error'
  /** 失败时的错误信息（仅 assistant 消息） */
  error?: AiErrorInfo
  /** 用户主动停止生成 */
  stopped?: boolean
  /** 已确认创建的操作下标：随消息持久化，避免重开面板或重启后重复创建 */
  createdActions?: number[]
}
