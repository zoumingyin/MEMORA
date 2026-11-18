import type { AlarmItem, ReminderEntry } from '../types/entry'
import type {
  AlarmSelectionCandidate,
  AlarmSelectionChange,
  AlarmSelectionPatchField,
  AssistantAlarmSelection,
} from '../types/ai'
import type { UpdateEntryArgs } from './agentToolArgs'

/**
 * 提醒目标选择授权（仅内存，不新增数据库表）：
 * - 模型只能「请求」修改某个闹钟，不能直接决定多闹钟提醒改哪一个；
 * - 多候选时执行器不写库，生成待选择提议，由用户点击候选产生一次性授权；
 * - 授权只对创建它的提醒 + 候选闹钟有效，且绑定当时的提醒快照；
 * - 用户取消 / 开始新任务 / 停止请求 / 清空会话 / 目标删除 / 闹钟或标题变化后失效；
 * - 每次授权只能 claim 一次，执行成功即作废，禁止跨请求复用。
 */

export type AlarmSelectionStatus =
  | 'pending'
  | 'executing'
  | 'done'
  | 'cancelled'
  | 'expired'
  | 'invalid'

/** 授权可以执行的修改集合：remindAt 必选，其余字段必须由卡片明确展示 */
export interface AlarmSelectionPatch {
  remindAt: number
  title?: string
  content?: string
  appendContent?: string
  completeItems?: string[]
  addItems?: string[]
  addTags?: string[]
  removeTags?: string[]
}

export interface AlarmSelectionProposal extends AssistantAlarmSelection {
  /** 发起来源请求与消息，用于失效与排查 */
  requestId: string
  messageId?: string
  toolCallId: string
  /** 冻结后的授权 patch：点击时只执行这里，不接受新的参数 */
  patch: AlarmSelectionPatch
  /** 执行时代理 update_entry 允许触碰的字段白名单 */
  allowedFields: AlarmSelectionPatchField[]
  changes: AlarmSelectionChange[]
  /** 生成时的提醒快照（标题、正文、标签、状态 + 全部闹钟），目标被改动后授权失效 */
  fingerprint: string
  createdAt: number
  status: AlarmSelectionStatus
}

export const ALARM_SELECTION_TTL_MS = 10 * 60_000

const proposals = new Map<string, AlarmSelectionProposal>()

/** 可修改的闹钟：优先未触发；全部已触发时退化为全部 */
export function pendingAlarmCandidates(alarms: AlarmItem[]): AlarmItem[] {
  const pending = alarms.filter((alarm) => !alarm.notified)
  return pending.length > 0 ? pending : alarms
}

export function toSelectionCandidate(alarm: AlarmItem): AlarmSelectionCandidate {
  return {
    alarmId: alarm.id,
    mode: alarm.mode,
    remindAt: alarm.remindAt,
    method: alarm.method,
  }
}

function clip(text: string, limit = 40): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

/**
 * 从模型参数里提取授权 patch：
 * - remindAt 是候选授权的必选字段；
 * - 其它字段只在卡片上逐项展示后才允许执行，避免「只点时间却改了标题」；
 * - id / alarmId 不属于 patch，执行时由用户选择结果覆盖。
 */
export function buildAlarmSelectionPatch(args: UpdateEntryArgs): {
  patch: AlarmSelectionPatch
  allowedFields: AlarmSelectionPatchField[]
  changes: AlarmSelectionChange[]
} {
  if (args.remindAt === undefined) {
    throw new Error('候选闹钟授权必须包含提醒时间')
  }
  const patch: AlarmSelectionPatch = { remindAt: args.remindAt }
  const changes: AlarmSelectionChange[] = []

  if (args.title !== undefined) {
    patch.title = args.title
    changes.push({ field: 'title', label: `标题改为「${clip(args.title)}」` })
  }
  if (args.content !== undefined) {
    patch.content = args.content
    changes.push({ field: 'content', label: '正文整体替换' })
  }
  if (args.appendContent !== undefined) {
    patch.appendContent = args.appendContent
    changes.push({ field: 'appendContent', label: '追加正文' })
  }
  if (args.completeItems !== undefined) {
    patch.completeItems = [...args.completeItems]
    changes.push({
      field: 'completeItems',
      label: `勾选子任务：${clip(args.completeItems.join('、'))}`,
    })
  }
  if (args.addItems !== undefined) {
    patch.addItems = [...args.addItems]
    changes.push({
      field: 'addItems',
      label: `新增子任务：${clip(args.addItems.join('、'))}`,
    })
  }
  if (args.addTags !== undefined) {
    patch.addTags = [...args.addTags]
    changes.push({ field: 'addTags', label: `添加标签：${clip(args.addTags.join('、'))}` })
  }
  if (args.removeTags !== undefined) {
    patch.removeTags = [...args.removeTags]
    changes.push({
      field: 'removeTags',
      label: `移除标签：${clip(args.removeTags.join('、'))}`,
    })
  }

  return {
    patch,
    allowedFields: ['remindAt', ...changes.map((change) => change.field)],
    changes,
  }
}

/** 只把用户选择需要的字段带到界面 */
export function toSelectionCard(proposal: AlarmSelectionProposal): AssistantAlarmSelection {
  return {
    proposalId: proposal.proposalId,
    entryId: proposal.entryId,
    title: proposal.title,
    remindAt: proposal.remindAt,
    candidates: proposal.candidates.map((candidate) => ({ ...candidate })),
    expiresAt: proposal.expiresAt,
    ...(proposal.changes.length > 0
      ? { changes: proposal.changes.map((change) => ({ ...change })) }
      : {}),
  }
}

/** 提醒目标相关快照：标题、正文、标签、状态或任一闹钟变化都会导致授权失效 */
export function reminderSelectionFingerprint(entry: ReminderEntry): string {
  return JSON.stringify({
    title: entry.title.trim(),
    content: entry.content,
    tags: entry.tags,
    done: entry.done,
    notified: entry.notified,
    alarms: entry.alarms.map((alarm) => [
      alarm.id,
      alarm.remindAt,
      alarm.mode,
      alarm.method,
      alarm.notified,
    ]),
  })
}

export function createAlarmSelection(input: {
  entry: ReminderEntry
  args: UpdateEntryArgs
  requestId: string
  messageId?: string
  toolCallId: string
  now?: number
  ttlMs?: number
}): AlarmSelectionProposal {
  const now = input.now ?? Date.now()
  const { patch, allowedFields, changes } = buildAlarmSelectionPatch(input.args)
  const proposal: AlarmSelectionProposal = {
    proposalId: crypto.randomUUID(),
    entryId: input.entry.id,
    title: input.entry.title.trim() || '无标题',
    remindAt: patch.remindAt,
    candidates: pendingAlarmCandidates(input.entry.alarms).map(toSelectionCandidate),
    expiresAt: now + (input.ttlMs ?? ALARM_SELECTION_TTL_MS),
    requestId: input.requestId,
    messageId: input.messageId,
    toolCallId: input.toolCallId,
    patch,
    allowedFields,
    changes,
    fingerprint: reminderSelectionFingerprint(input.entry),
    createdAt: now,
    status: 'pending',
  }
  proposals.set(proposal.proposalId, proposal)
  return proposal
}

export function getAlarmSelection(id: string): AlarmSelectionProposal | undefined {
  return proposals.get(id)
}

export type ClaimAlarmSelectionResult =
  | { ok: true; proposal: AlarmSelectionProposal }
  | {
      ok: false
      reason:
        | 'not_found'
        | 'expired'
        | 'cancelled'
        | 'done'
        | 'busy'
        | 'invalid'
        | 'target_changed'
    }

/** 原子占用：只有 pending、未过期、目标与候选都匹配的提议能成功 */
export function claimAlarmSelection(
  id: string,
  entryId: string,
  alarmId: string,
  now: number = Date.now(),
): ClaimAlarmSelectionResult {
  const proposal = proposals.get(id)
  if (!proposal) return { ok: false, reason: 'not_found' }
  if (proposal.status === 'executing') return { ok: false, reason: 'busy' }
  if (proposal.status === 'done') return { ok: false, reason: 'done' }
  if (proposal.status === 'cancelled') return { ok: false, reason: 'cancelled' }
  if (proposal.status === 'invalid') return { ok: false, reason: 'invalid' }
  if (proposal.status === 'expired' || proposal.expiresAt <= now) {
    proposal.status = 'expired'
    return { ok: false, reason: 'expired' }
  }
  if (proposal.entryId !== entryId) return { ok: false, reason: 'target_changed' }
  if (!proposal.candidates.some((candidate) => candidate.alarmId === alarmId)) {
    return { ok: false, reason: 'target_changed' }
  }
  proposal.status = 'executing'
  return { ok: true, proposal }
}

/** 卡片到期时同步注册表状态，避免界面显示已过期但后台仍可 claim */
export function expireAlarmSelection(id: string, now: number = Date.now()): void {
  const proposal = proposals.get(id)
  if (!proposal || proposal.status !== 'pending') return
  if (proposal.expiresAt <= now) proposal.status = 'expired'
}

export function finishAlarmSelection(
  id: string,
  status: 'done' | 'cancelled' | 'invalid',
): void {
  const proposal = proposals.get(id)
  if (!proposal) return
  proposal.status = status
}

/** 用户取消：作废，之后不能再执行 */
export function cancelAlarmSelection(id: string | undefined): void {
  if (!id) return
  finishAlarmSelection(id, 'cancelled')
}

/** 新任务 / 停止 / 清空：所有尚未执行的授权立即失效（禁止跨请求复用） */
export function cancelPendingAlarmSelections(): number {
  let cancelled = 0
  for (const proposal of proposals.values()) {
    if (proposal.status === 'pending') {
      proposal.status = 'cancelled'
      cancelled += 1
    }
  }
  return cancelled
}

/** 清空会话时释放内存表 */
export function resetAlarmSelections(): void {
  proposals.clear()
}
