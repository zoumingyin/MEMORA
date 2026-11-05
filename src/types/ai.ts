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

/** 发送给模型的单条消息（OpenAI Chat Completions 规范）
 *
 * 字段名与 Rust 端 ChatMessage 对应（snake_case 原样透传）：
 * - assistant 消息可携带 tool_calls（agent loop 把调用回传给上游）
 * - tool 消息携带 tool_call_id 与执行结果（字符串 JSON）
 */
export interface AiChatToolCallPayload {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** assistant 消息发起的工具调用（OpenAI 格式原样透传） */
  tool_calls?: AiChatToolCallPayload[]
  /** tool 角色消息对应的调用 id */
  tool_call_id?: string
}

/** OpenAI tools 参数中的单个工具定义（function calling） */
export interface AiToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    }
  }
}

/** 模型发起的单个工具调用（后端已把流式增量聚合为完整参数） */
export interface AiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** 后端流式事件（serde tag = "type"） */
export type AiStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'toolCalls'; calls: AiToolCall[] }
  | { type: 'done'; finishReason?: string | null }
  | { type: 'error'; code: string; message: string }
  /** 仅开发环境：后端诊断信息，前端只打印到控制台 */
  | { type: 'debug'; message: string }

/** 联网搜索返回的单条结果（与 src-tauri/src/web_search.rs 对应） */
export interface WebSearchResult {
  title: string
  url: string
  snippet: string
  /** 结果页正文摘录（仅前几条结果有值；SPA 空壳或反爬页为空） */
  content?: string | null
}

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
  /** 回答因 max_tokens 用尽被截断（finish_reason=length），操作卡片可能不完整 */
  truncated?: boolean
  /** 已确认创建的操作下标：随消息持久化，避免重开面板或重启后重复创建 */
  createdActions?: number[]
  /**
   * 联网搜索状态（仅 assistant 消息）：开启联网后随消息持久化，
   * 展示「正在搜索 / 已搜索 N 条 / 搜索失败」提示
   */
  webSearch?: {
    status: 'searching' | 'done' | 'failed'
    count?: number
    error?: string
  }
  /** agent 自动执行的只读工具调用轮数（function calling），随消息持久化用于展示提示 */
  toolRounds?: number
  /** agent 工具产生的待确认操作（目前只有 delete_entry），随消息持久化渲染确认卡片 */
  toolActions?: import('../utils/assistantActions').AssistantAction[]
  /** 已确认执行的 toolActions 下标（随消息持久化，避免重复执行） */
  toolActionsDone?: number[]
}
