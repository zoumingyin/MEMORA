/**
 * 统一的失败分类与恢复策略（纯逻辑）：
 * - 所有失败都落到固定分类，界面、续办与重试保护使用同一套判断；
 * - 只有「已证明没有产生任何写入」的失败才允许自动重试；
 * - 写入结果不确定时禁止重放，必须先让用户核对真实数据。
 */

export type AgentFailureCategory =
  | 'model_request_failed'
  | 'model_timeout'
  | 'invalid_tool_arguments'
  | 'permission_denied'
  | 'target_not_found'
  | 'target_ambiguous'
  | 'business_execution_failed'
  | 'execution_unknown'
  | 'readback_failed'
  | 'execution_cancelled'
  | 'dependency_failed'

/** 失败发生时写入可能落到的状态：none 未写入；failed 明确未生效；unknown 可能已生效 */
export type AgentWriteState = 'none' | 'failed' | 'unknown' | 'applied'

export interface AgentFailure {
  category: AgentFailureCategory
  writeState: AgentWriteState
  /** 只有确定没有写入业务数据时才允许自动重试 */
  autoRetryAllowed: boolean
  /** 需要用户先核对便签真实状态，禁止自动重放 */
  requiresVerification: boolean
}

const VERIFY_CATEGORIES: ReadonlySet<AgentFailureCategory> = new Set([
  'execution_unknown',
  'readback_failed',
])

const AUTO_RETRY_CATEGORIES: ReadonlySet<AgentFailureCategory> = new Set([
  'model_request_failed',
  'model_timeout',
  'invalid_tool_arguments',
])

export function failureFor(
  category: AgentFailureCategory,
  writeState: AgentWriteState = 'none',
): AgentFailure {
  const requiresVerification =
    writeState === 'unknown' || VERIFY_CATEGORIES.has(category)
  return {
    category,
    writeState,
    autoRetryAllowed:
      !requiresVerification && writeState === 'none' && AUTO_RETRY_CATEGORIES.has(category),
    requiresVerification,
  }
}

/** 查询失败可以重试；写入失败即使明确未生效也不自动重放，避免判断失误造成重复数据 */
export function readFailure(): AgentFailure {
  return {
    category: 'business_execution_failed',
    writeState: 'none',
    autoRetryAllowed: true,
    requiresVerification: false,
  }
}

/** 模型请求失败分类：只有整个请求没有任何业务工具执行时才允许自动重试 */
export function classifyModelFailure(
  code: string,
  message: string,
  businessExecuted: boolean,
): AgentFailure {
  const timeout =
    code === 'stream_error' && /timeout|timed out|超时/i.test(message)
  const category: AgentFailureCategory = timeout ? 'model_timeout' : 'model_request_failed'
  return {
    category,
    writeState: businessExecuted ? 'unknown' : 'none',
    autoRetryAllowed: !businessExecuted,
    requiresVerification: false,
  }
}

export function failureCategoryLabel(category: AgentFailureCategory): string {
  switch (category) {
    case 'model_request_failed':
      return '模型请求失败'
    case 'model_timeout':
      return '模型请求超时'
    case 'invalid_tool_arguments':
      return '工具参数无效'
    case 'permission_denied':
      return '权限或目标来源不允许'
    case 'target_not_found':
      return '目标不存在'
    case 'target_ambiguous':
      return '目标不明确'
    case 'business_execution_failed':
      return '业务执行失败'
    case 'execution_unknown':
      return '执行状态无法确认'
    case 'readback_failed':
      return '写入后回读失败'
    case 'execution_cancelled':
      return '执行已停止'
    case 'dependency_failed':
      return '依赖步骤未完成'
  }
}
