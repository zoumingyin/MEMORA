import { ALARM_MODE_LABEL, applyReminderTime } from './reminderAlarms'
import {
  claimAlarmSelection,
  finishAlarmSelection,
  reminderSelectionFingerprint,
} from './alarmSelections'
import {
  executeAuthorizedAlarmUpdate,
  type AgentToolEnvironment,
  type ToolOutcome,
} from './agentToolExecutor'

/**
 * 用户点击候选闹钟后的执行：
 * - 先 claim 一次性授权，再复查目标、快照、闹钟与时间；
 * - 通过后复用 update_entry 的写入路径，只改用户选中的闹钟；
 * - 写入后回读，确认目标时间生效、重复规则保留、其它闹钟未被改动；
 * - 任一步失败都不改选其它闹钟，也不会静默写入。
 */

export type AlarmSelectionFailureReason =
  | 'not_found'
  | 'expired'
  | 'cancelled'
  | 'done'
  | 'busy'
  | 'invalid'
  | 'target_changed'
  | 'missing'
  | 'kind_changed'
  | 'alarm_missing'
  | 'changed'
  | 'past_time'
  | 'failed'

export function alarmSelectionFailureMessage(
  reason: AlarmSelectionFailureReason,
): string {
  switch (reason) {
    case 'not_found':
      return '找不到这次选择（应用可能已重启），请让助手重新发起修改'
    case 'expired':
      return '这次选择已过期，请让助手重新发起修改'
    case 'cancelled':
      return '这次选择已取消，不会再修改任何闹钟'
    case 'done':
      return '这次选择已经执行过，不会重复修改'
    case 'busy':
      return '正在执行这次选择，请稍候'
    case 'target_changed':
      return '目标提醒或候选闹钟已变化，请让助手重新发起修改'
    case 'missing':
      return '目标提醒已不存在，可能已被删除'
    case 'kind_changed':
      return '目标便签已不是提醒，无法修改闹钟'
    case 'alarm_missing':
      return '选中的闹钟已不存在，请重新选择'
    case 'changed':
      return '提醒的闹钟或标题已变化，这次选择已失效，请重新发起修改'
    case 'past_time':
      return '提醒时间已过去，请重新选择新的时间'
    case 'failed':
      return '修改未生效，这次选择已失效，请让助手重新发起修改'
    default:
      return '这次选择已失效，请让助手重新发起修改'
  }
}

export type AlarmSelectionSuccess = {
  ok: true
  title: string
  alarmId: string
  remindAt: number
  modeLabel: string
  /** 成功后的提示文案（含保留重复规则与其它闹钟未改动） */
  message: string
}

export type AlarmSelectionResult =
  | AlarmSelectionSuccess
  | { ok: false; reason: AlarmSelectionFailureReason; message: string }

function failure(reason: AlarmSelectionFailureReason): AlarmSelectionResult {
  return { ok: false, reason, message: alarmSelectionFailureMessage(reason) }
}

export async function confirmAlarmSelection(input: {
  proposalId: string
  entryId: string
  alarmId: string
  env: AgentToolEnvironment
  now?: number
}): Promise<AlarmSelectionResult> {
  const now = input.now ?? input.env.now()
  const claim = claimAlarmSelection(
    input.proposalId,
    input.entryId,
    input.alarmId,
    now,
  )
  if (!claim.ok) return failure(claim.reason)
  const proposal = claim.proposal

  const entry = input.env.listEntries().find((item) => item.id === input.entryId)
  if (!entry) {
    finishAlarmSelection(proposal.proposalId, 'invalid')
    return failure('missing')
  }
  if (entry.kind !== 'reminder') {
    finishAlarmSelection(proposal.proposalId, 'invalid')
    return failure('kind_changed')
  }
  if (reminderSelectionFingerprint(entry) !== proposal.fingerprint) {
    finishAlarmSelection(proposal.proposalId, 'invalid')
    return failure('changed')
  }
  if (!entry.alarms.some((alarm) => alarm.id === input.alarmId)) {
    finishAlarmSelection(proposal.proposalId, 'invalid')
    return failure('alarm_missing')
  }
  if (proposal.remindAt <= now) {
    finishAlarmSelection(proposal.proposalId, 'invalid')
    return failure('past_time')
  }

  const expected = applyReminderTime(
    entry.alarms,
    input.alarmId,
    proposal.remindAt,
    now,
  )
  if (!expected.ok) {
    // 正常不会走到这里（前一步已确认目标存在且时间合法），失败时不改选其它闹钟
    finishAlarmSelection(proposal.proposalId, 'invalid')
    return failure('alarm_missing')
  }

  let outcome: ToolOutcome
  try {
    outcome = await executeAuthorizedAlarmUpdate({
      entryId: input.entryId,
      alarmId: input.alarmId,
      patch: proposal.patch,
      allowedFields: proposal.allowedFields,
      env: input.env,
    })
  } catch {
    // 执行异常同样消费授权，禁止用同一次点击自动重试
    finishAlarmSelection(proposal.proposalId, 'invalid')
    return failure('failed')
  }
  if (outcome.status !== 'ok') {
    // 已 claim 的授权只消费一次：失败后不释放，用户需重新发起新的修改请求
    finishAlarmSelection(proposal.proposalId, 'invalid')
    return { ok: false, reason: 'failed', message: outcome.result }
  }

  // 写入后回读：目标时间必须生效，重复规则与其它闹钟必须保持原样
  const stored = input.env.listEntries().find((item) => item.id === input.entryId)
  const alarmsMatch =
    stored?.kind === 'reminder' &&
    JSON.stringify(stored.alarms) === JSON.stringify(expected.alarms)
  if (!alarmsMatch) {
    finishAlarmSelection(proposal.proposalId, 'invalid')
    return {
      ok: false,
      reason: 'failed',
      message: '写入后的闹钟与预期不一致，请检查便签；其它闹钟没有被改选。',
    }
  }

  finishAlarmSelection(proposal.proposalId, 'done')
  const modeLabel = ALARM_MODE_LABEL[expected.target.mode] ?? expected.target.mode
  const title = stored?.title.trim() || entry.title.trim() || '无标题'
  return {
    ok: true,
    title,
    alarmId: input.alarmId,
    remindAt: expected.target.remindAt,
    modeLabel,
    message: `已将「${title}」的${modeLabel}闹钟改为 ${new Date(
      expected.target.remindAt,
    ).toLocaleString('zh-CN', { hour12: false })}，其它闹钟与重复规则未改动。`,
  }
}
