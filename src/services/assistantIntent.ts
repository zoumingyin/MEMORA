import {
  AGENT_TOOLS,
  AGENT_TOOL_PROMPT,
  NO_TOOL_PROMPT,
  READ_ONLY_TOOL_PROMPT,
} from './agentToolSchema'
import { isReadOnlyTool } from './agentExecution'
import type { AiToolDefinition } from '../types/ai'

/**
 * 轻量意图预判：
 * - 只决定本轮下发哪些工具、使用哪档提示词；
 * - 不产生目标 id、写入参数或执行授权；
 * - 工具范围同时作为执行层权限声明传入 AgentToolScope，由执行器强制校验；
 *   模型无视列表返回写调用时会被拒绝，仍需通过目标来源与歧义守卫。
 */

export type AssistantIntent =
  | 'chat'
  | 'suggest'
  | 'search'
  | 'create'
  | 'update'
  | 'delete'
  | 'multi_step'
  | 'unknown'

export type IntentConfidence = 'high' | 'medium' | 'low'

export type IntentReason =
  | 'explicit_write'
  | 'advice'
  | 'query'
  | 'negated_write'
  | 'hypothetical'
  | 'referent_ambiguous'
  | 'referent_resolved'
  | 'mixed_actions'
  | 'no_signal'

export interface IntentAnalysis {
  intent: AssistantIntent
  confidence: IntentConfidence
  requiresClarification: boolean
  reason: IntentReason
}

export interface IntentContext {
  /** 当前是否有用户选中的条目，仅用于判断“这个/当前”的指代 */
  hasSelectedEntry: boolean
  /** 本轮历史指代是否已由对话记忆唯一解析（解析结果仍由执行层校验） */
  hasResolvedConversationReferent?: boolean
  /** 当前消息是否已唯一命中真实条目（显式 id 或唯一标题） */
  hasExplicitTarget?: boolean
}

export type AssistantToolMode = 'none' | 'read' | 'write'

export interface AssistantToolPlan {
  mode: AssistantToolMode
  tools: AiToolDefinition[] | null
  prompt: string
}

const READ_ONLY_AGENT_TOOLS = AGENT_TOOLS.filter((tool) =>
  isReadOnlyTool(tool.function.name),
)

const CREATE_CUE_SOURCE =
  '创建|新建|新增|添加|加一条|加个|记一下|记一条|记一笔|保存为|建一个|建一条|提醒我|设个提醒|设置提醒|(?:帮我|给我|替我|麻烦你|请你)\\s*安排|安排(?:一下|一次|在|到|明天|后天|今天|下周|周[一二三四五六日天])'
const UPDATE_CUE_SOURCE =
  '修改|更新|改成|改为|改一下|改下|改掉|调整|补充|追加|替换|重命名|勾选|标记|设为|设置为|编辑|完善|改(?!天|变|口|观|善)'
const DELETE_CUE_SOURCE = '删除|删掉|删了|移除|清理|清掉|去掉|删'
const QUERY_CUE_SOURCE =
  '查询|查找|搜索|搜一下|搜下|找一下|找找|查看|看看|看一下|有哪些|有没有|列出|列一下|列(?:出|待办|提醒|便签|备忘|所有|全部)|显示|读取|打开|查一下|查下|查(?!询)|有什么|哪些'
const ADVICE_CUE_SOURCE =
  '帮我想|想几个|想一个|想想|建议|推荐|规划|方案|头脑风暴|怎么|如何|怎样|会怎样|怎么样|能否|可不可以|会不会|举例|说明|区别|是什么|介绍|你能|你会|支持什么|可以做什么|能做什么|有哪些功能|是否|可以(?:创建|新增|添加|修改|删除|改|删|安排|提醒)'
const SEQUENCE_CUE_SOURCE = '然后|接着|之后|再|并|同时|顺便'
const CHAT_CUE_SOURCE =
  '^(?:你好|您好|嗨|hi|hello|在吗|谢谢|多谢|辛苦了|早上好|晚上好|晚安|哈+|嗯+|好的|好吧|ok|收到|没事|随便聊聊|今天(?:有点|天气|心情)|我(?:今天|最近|觉得))'
const VAGUE_ACTION_SOURCE = '弄|搞|处理|整一下|那个|这个|东西'

const HYPOTHETICAL_SOURCE = '假如|假设|要是'
const IF_SOURCE = '如果'
const QUESTION_OR_ADVICE_SOURCE =
  '会怎样|怎么样|如何|怎么|能否|可不可以|会不会|吗|？|\\?|举例|说明'
const IMPERATIVE_WRITE_SOURCE =
  '^(?:请(?:你)?|帮我|给我|替我|麻烦(?:你)?)?\\s*(?:把|将|创建|新建|新增|添加|删除|删掉|修改|更新|改|移除|清理|提醒我|安排)'
const REQUEST_WRITE_SOURCE =
  '(?:帮我|给我|替我|麻烦(?:你)?|请(?:你)?)[^，。！？!?]{0,14}$'
const BRAINSTORM_TO_ACTION_SOURCE =
  '(?:帮我想|想几个|想一个|想想)[^。！？!?]{0,40}(?:并|然后|再|同时|顺便)[^。！？!?]{0,40}(?:创建|新建|新增|添加|加一条|加个|记一下|记一条|建一个|建一条|安排|提醒我)'

const SELECTED_REFERENT_SOURCE = '这个|当前|选中|这条|这篇|本条|该便签|该条目'
const HISTORICAL_REFERENT_SOURCE =
  '刚才|刚刚|上一个|上一条|前面那个|之前那个|那个|那条|最后一条|最后那个|第[一二三四五六七八九十0-9]+(?:条|个|项)|(?<!其)它|再补充|继续刚才|接着刚才|上面提到的|刚才创建|刚才新建|刚才添加'
const NEGATION_SOURCE = '不要|不用|不需要|不必|先别|别|暂不|暂时不|无需|不想|不用了|不'
const NEGATION_FALSE_POSITIVE_SOURCE =
  '不错|不好意思|不久|不仅|不但|不断|不同|分别'

function matches(text: string, source: string): RegExpExecArray[] {
  return Array.from(text.matchAll(new RegExp(source, 'g')))
}

function hasCue(text: string, source: string): boolean {
  return new RegExp(source).test(text)
}

function clauseStart(text: string, index: number): number {
  let start = 0
  for (const mark of ['，', ',', '。', '；', ';', '！', '!', '？', '?']) {
    start = Math.max(start, text.lastIndexOf(mark, index - 1) + 1)
  }
  return start
}

function isNegatedAt(text: string, index: number): boolean {
  const before = text.slice(clauseStart(text, index), index)
  if (new RegExp(NEGATION_FALSE_POSITIVE_SOURCE).test(before)) return false
  return new RegExp(NEGATION_SOURCE).test(before)
}

interface CueHit {
  index: number
  negated: boolean
}

function cueHits(text: string, source: string): CueHit[] {
  return matches(text, source).map((match) => {
    const index = match.index ?? 0
    return { index, negated: isNegatedAt(text, index) }
  })
}

function hasActiveCue(hits: CueHit[]): boolean {
  return hits.some((hit) => !hit.negated)
}

function hasStrongWriteRequest(text: string, hits: CueHit[]): boolean {
  return hits.some((hit) => {
    if (hit.negated) return false
    const start = clauseStart(text, hit.index)
    const before = text.slice(start, hit.index)
    return new RegExp(REQUEST_WRITE_SOURCE).test(before)
  })
}

function isImperativeWrite(text: string): boolean {
  return new RegExp(IMPERATIVE_WRITE_SOURCE).test(text)
}

function isHypothetical(text: string): boolean {
  if (hasCue(text, HYPOTHETICAL_SOURCE)) return true
  return hasCue(text, IF_SOURCE) && hasCue(text, QUESTION_OR_ADVICE_SOURCE)
}

function isAdvice(text: string): boolean {
  return hasCue(text, ADVICE_CUE_SOURCE)
}

function isBrainstormToAction(text: string): boolean {
  return hasCue(text, BRAINSTORM_TO_ACTION_SOURCE)
}

function isVagueAction(text: string): boolean {
  return hasCue(text, VAGUE_ACTION_SOURCE)
}

function hasSelectedReferent(text: string): boolean {
  return hasCue(text, SELECTED_REFERENT_SOURCE)
}

function hasHistoricalReferent(text: string): boolean {
  return hasCue(text, HISTORICAL_REFERENT_SOURCE)
}

function decision(
  intent: AssistantIntent,
  confidence: IntentConfidence,
  reason: IntentReason,
  requiresClarification = false,
): IntentAnalysis {
  return { intent, confidence, requiresClarification, reason }
}

export function analyzeAssistantIntent(
  text: string,
  context: IntentContext,
): IntentAnalysis {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return decision('unknown', 'low', 'no_signal', true)
  }

  const createHits = cueHits(normalized, CREATE_CUE_SOURCE)
  const updateHits = cueHits(normalized, UPDATE_CUE_SOURCE)
  const deleteHits = cueHits(normalized, DELETE_CUE_SOURCE)
  const hasCreate = hasActiveCue(createHits)
  const hasUpdate = hasActiveCue(updateHits)
  const hasDelete = hasActiveCue(deleteHits)
  const hasWrite = hasCreate || hasUpdate || hasDelete
  const hasQuery = hasCue(normalized, QUERY_CUE_SOURCE)
  const hasAdvice = isAdvice(normalized)
  const hasHypothetical = isHypothetical(normalized)
  const hasSequence = hasCue(normalized, SEQUENCE_CUE_SOURCE)
  const actionRequest =
    isImperativeWrite(normalized) ||
    hasStrongWriteRequest(normalized, [...createHits, ...updateHits, ...deleteHits]) ||
    isBrainstormToAction(normalized)

  if (!hasWrite) {
    if (hasHypothetical) {
      return decision('suggest', 'high', 'hypothetical')
    }
    if (hasAdvice) {
      return decision('suggest', 'high', 'advice')
    }
    if (hasQuery) {
      return decision('search', 'high', 'query')
    }
    if (createHits.length + updateHits.length + deleteHits.length > 0) {
      return decision('chat', 'high', 'negated_write')
    }
    if (isVagueAction(normalized)) {
      return decision('unknown', 'low', 'no_signal', true)
    }
    return decision('chat', hasCue(normalized, CHAT_CUE_SOURCE) ? 'high' : 'medium', 'no_signal')
  }

  if (!actionRequest && hasHypothetical) {
    return decision('suggest', 'high', 'hypothetical')
  }
  if (!actionRequest && hasAdvice) {
    return decision('suggest', 'high', 'advice')
  }

  const writeKinds = [hasCreate, hasUpdate, hasDelete].filter(Boolean).length
  const hasMixedSteps = hasQuery || writeKinds > 1 || (hasSequence && writeKinds > 0 && hasQuery)
  const intent: AssistantIntent = hasMixedSteps
    ? 'multi_step'
    : hasCreate
      ? 'create'
      : hasUpdate
        ? 'update'
        : 'delete'

  const selectedReferent =
    hasSelectedReferent(normalized) &&
    context.hasSelectedEntry &&
    context.hasExplicitTarget !== true
  // 「删除「标题」这条便签」里的「这条」是同位语，不是依赖选中项的指代
  const selectedReferentMissing =
    hasSelectedReferent(normalized) &&
    !context.hasSelectedEntry &&
    context.hasExplicitTarget !== true
  const historicalReferent =
    hasHistoricalReferent(normalized) && context.hasExplicitTarget !== true
  const memoryResolved =
    historicalReferent && context.hasResolvedConversationReferent === true
  const referentAmbiguous =
    (historicalReferent && !memoryResolved) || selectedReferentMissing
  const referentResolved =
    (selectedReferent && !historicalReferent) || memoryResolved

  if (referentAmbiguous) {
    return decision(intent, 'medium', 'referent_ambiguous', true)
  }
  if (referentResolved) {
    return decision(intent, 'high', 'referent_resolved')
  }
  if (intent === 'multi_step') {
    return decision(intent, 'high', 'mixed_actions')
  }
  return decision(intent, 'high', 'explicit_write')
}

/** 工具调用降级时，按本轮实际使用的提示词档位替换为无工具说明 */
export function degradeToolPrompt(
  systemContent: string,
  plan: AssistantToolPlan,
): string {
  return `${systemContent.replace(plan.prompt, '').trim()}\n\n${NO_TOOL_PROMPT}`
}

export function planAssistantTools(
  analysis: IntentAnalysis,
  contextEnabled: boolean,
  options?: { forceReadOnly?: boolean; forceWrite?: boolean },
): AssistantToolPlan {
  if (!contextEnabled) {
    return { mode: 'none', tools: null, prompt: NO_TOOL_PROMPT }
  }

  if (
    options?.forceReadOnly ||
    analysis.reason === 'referent_ambiguous' ||
    analysis.reason === 'negated_write'
  ) {
    return { mode: 'read', tools: READ_ONLY_AGENT_TOOLS, prompt: READ_ONLY_TOOL_PROMPT }
  }

  // 续办请求可能不含「创建 / 修改」等词，但执行层仍会按目标来源、签名与歧义独立校验
  if (options?.forceWrite) {
    return { mode: 'write', tools: AGENT_TOOLS, prompt: AGENT_TOOL_PROMPT }
  }

  if (analysis.intent === 'chat') {
    return { mode: 'none', tools: null, prompt: NO_TOOL_PROMPT }
  }

  if (analysis.intent === 'suggest' || analysis.intent === 'search') {
    return { mode: 'read', tools: READ_ONLY_AGENT_TOOLS, prompt: READ_ONLY_TOOL_PROMPT }
  }

  return { mode: 'write', tools: AGENT_TOOLS, prompt: AGENT_TOOL_PROMPT }
}