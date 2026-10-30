/** AI 助手：前后端共享的类型定义（与 src-tauri/src/ai.rs 对应） */

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
  /** 环境变量注入的配置只读，不能编辑或删除 */
  readOnly: boolean
  temperature: number
  maxTokens: number
}

/** 全部配置状态：当前选中的模型 + 已配置列表 */
export interface AiStatus {
  configured: boolean
  activeId: string | null
  profiles: AiProfileStatus[]
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
}
