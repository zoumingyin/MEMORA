/** AI 助手：前后端共享的类型定义（与 src-tauri/src/ai.rs 对应） */

import type { AlarmMethod, AlarmMode, EntryKind } from './entry'

/** 操作类型：create 新建便签；complete-todo 勾选已有待办的子任务；append-note 向已有备忘追加内容；delete 删除便签（进废纸篓，可恢复） */
export type AssistantActionOp = 'create' | 'complete-todo' | 'append-note' | 'delete'

/** AI 提议的一条操作（用户确认前不会写入仓储）；界面只渲染工具产生的删除卡片 */
export interface AssistantAction {
  /** 缺省视为 create（兼容旧回答里的动作块） */
  op?: AssistantActionOp
  kind: EntryKind
  title: string
  content: string
  /** 提醒专用：毫秒时间戳（已校验为未来时间） */
  remindAt?: number
  /** 待办专用：子任务文本（create 为新建项；complete-todo 为要勾选的现有项） */
  items?: string[]
  /** 操作已有便签时的目标 id（来自上下文） */
  targetId?: string
  /** 删除提议 id：确认时凭它做一次性执行与过期校验 */
  proposalId?: string
  /** 生成该删除步骤的执行历史 id：只用于回写结果，不构成授权 */
  executionId?: string
  /** 生成该删除步骤的历史步骤 id：只用于精确回写，不构成授权 */
  stepId?: string
  /** 删除提议过期时间（毫秒时间戳），过期后不可执行 */
  expiresAt?: number
}

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

/**
 * 执行阶段：面向前端的过程反馈。
 * 只表示真实发生的阶段切换，结束后落到 done / partial / failed / needs_input。
 */
export type AssistantPhase =
  | 'understanding'
  | 'searching'
  | 'executing'
  | 'composing'
  | 'done'
  | 'partial'
  | 'failed'
  | 'needs_input'

/** 工具真实返回的条目引用：仅用于对话指代理解，不构成写入授权 */
export interface EntryReference {
  id: string
  kind: EntryKind
  title: string
}

/** 一次工具调用对数据产生的影响：只记录工具真实返回的事实，用于执行记录与结果小结 */
export interface ToolEffect {
  op: 'search' | 'list' | 'read' | 'create' | 'update' | 'delete'
  kind?: EntryKind
  entryId?: string
  title?: string
  count?: number
  /** 查询 / 读取 / 写入真实返回的条目（按展示顺序，最多 8 条） */
  references?: EntryReference[]
}

/** 候选闹钟：只暴露用户做选择所需的字段 */
export interface AlarmSelectionCandidate {
  alarmId: string
  mode: AlarmMode
  remindAt: number
  /** 提醒方式（弹窗 / 通知 / 声音） */
  method: AlarmMethod
}

/** 候选闹钟授权可覆盖的修改字段：时间必选，其余字段必须由卡片明确展示 */
export type AlarmSelectionPatchField =
  | 'remindAt'
  | 'title'
  | 'content'
  | 'appendContent'
  | 'completeItems'
  | 'addItems'
  | 'addTags'
  | 'removeTags'

/** 时间之外、随候选点击一并授权的字段摘要（只用于展示，不携带完整正文） */
export interface AlarmSelectionChange {
  field: Exclude<AlarmSelectionPatchField, 'remindAt'>
  label: string
}

/**
 * 提醒歧义选择卡片：修改目标不明确时由执行器生成。
 * 模型提供的 alarm_id 不构成授权，只有用户点击候选才产生一次性授权。
 */
export interface AssistantAlarmSelection {
  proposalId: string
  entryId: string
  title: string
  /** 用户要求修改到的时间 */
  remindAt: number
  candidates: AlarmSelectionCandidate[]
  expiresAt: number
  /** 点击候选时一并生效的其它字段；缺省表示只授权提醒时间 */
  changes?: AlarmSelectionChange[]
}

/** 单次工具调用的执行记录（随回答持久化，内容全部来自真实工具结果） */
export interface AssistantToolStep {
  callId: string
  tool: string
  /** 用户可读的动作标签，如「新建待办「购物」」 */
  label: string
  status:
    | 'ok'
    | 'error'
    | 'cancelled'
    | 'duplicate'
    | 'confirm'
    /** 应用中断时该步骤正在执行，且无法确认是否生效 */
    | 'execution_unknown'
    /** 重启时仍在执行、但没有写入风险的只读步骤 */
    | 'interrupted'
  /** 工具真实返回结果的摘要 */
  message: string
  /** 需要用户补充信息才能继续（如多个闹钟未指定目标） */
  needsInput?: boolean
  /** 删除确认步骤关联的一次性提议 id：只用于历史对账 */
  proposalId?: string
  /** 执行层拦截原因（权限 / 目标来源 / 歧义 / 重试保护） */
  blockedCode?: string
  /** 统一失败分类：写入状态不确定时禁止自动重放 */
  failure?: {
    category: string
    writeState: 'none' | 'failed' | 'unknown' | 'applied'
    autoRetryAllowed: boolean
    requiresVerification: boolean
  }
  effect?: ToolEffect
}

/** 任务清单状态：pending/running 表示模型已请求但尚无真实执行结果 */
export type AssistantTaskStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'skipped'
  | 'cancelled'
  | 'needs_input'
  /** 重启时仍在执行，无法确认结果 */
  | 'execution_unknown'
  /** 中断时未完成的只读步骤，可重新发起 */
  | 'interrupted'

/** 模型真实请求、但尚未产生执行记录的调用；执行完成后由 toolSteps 承载结果 */
export interface AssistantToolTask {
  callId: string
  tool: string
  label: string
  status: AssistantTaskStatus
}

/** 本请求中真实进入执行器的写入签名：仅用于续办时阻止重复写入 */
export interface AssistantWriteAttempt {
  callId: string
  tool: 'create_entry' | 'update_entry'
  signature: string
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
  /** 当前执行阶段：仅随真实阶段切换更新，结束后落到终态 */
  phase?: AssistantPhase
  /** 本次回答的工具执行记录（来自真实工具结果，用于进度反馈与结果小结） */
  toolSteps?: AssistantToolStep[]
  /** 未产生真实执行结果的任务项（待执行 / 已跳过 / 已取消）；执行完成项由 toolSteps 承载 */
  toolTasks?: AssistantToolTask[]
  /** 本请求中已成功的创建 / 修改签名：续办时由执行层拒绝重复写入 */
  writeAttempts?: AssistantWriteAttempt[]
  /** 达到最大工具轮次：仍有工具调用未执行 */
  toolLimitReached?: boolean
  /** 有工具因信息不足需要用户补充（如多个闹钟未指定目标） */
  needsInput?: boolean
  /** 提醒目标不明确时的候选闹钟选择卡片（由用户点击产生一次性授权） */
  toolSelections?: AssistantAlarmSelection[]
  /** 已由用户完成选择并执行的候选选择（存 proposalId，避免重复执行） */
  toolSelectionsDone?: string[]
  /** 已被用户取消的候选选择（存 proposalId） */
  toolSelectionsCancelled?: string[]
  /** 因重启、新任务、停止等原因失效的候选选择（存 proposalId） */
  toolSelectionsInvalidated?: string[]
  /** agent 工具产生的待确认操作（目前只有 delete_entry），随消息持久化渲染确认卡片 */
  toolActions?: AssistantAction[]
  /** 已确认执行的 toolActions 下标（随消息持久化，避免重复执行） */
  toolActionsDone?: number[]
  /** 已被用户取消的 toolActions 下标：取消后不允许再次执行 */
  toolActionsCancelled?: number[]
  /** 因应用重启失效的 toolActions 下标：内存提议已丢失，不能重新获得授权 */
  toolActionsInvalidated?: number[]
}
