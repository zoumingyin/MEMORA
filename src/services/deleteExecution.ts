import {
  claimDeleteProposal,
  finishDeleteProposal,
  releaseDeleteProposal,
} from './deleteProposals'
import type { EntryKind } from '../types/entry'

/**
 * 删除确认执行：ActionCard 只负责界面，真正的校验与一次性执行放在这里，便于测试。
 * - 提议必须存在、未过期、未取消、未执行过；
 * - 确认时再次校验目标条目存在且类型一致；
 * - 移入废纸篓后回读确认，失败时释放提议允许重试；
 * - 已取消 / 已过期 / 已执行的提议不会再写数据库。
 */

export type DeleteFailureReason =
  | 'not_found'
  | 'expired'
  | 'cancelled'
  | 'done'
  | 'busy'
  | 'invalid'
  | 'missing'
  | 'kind_changed'
  | 'target_mismatch'
  | 'failed'

export function deleteFailureMessage(reason: DeleteFailureReason): string {
  switch (reason) {
    case 'expired':
      return '该删除提议已过期，请让助手重新发起删除'
    case 'cancelled':
      return '该删除提议已取消，不能再执行'
    case 'done':
      return '该删除提议已经执行过，不会重复删除'
    case 'busy':
      return '删除正在执行，请稍候'
    case 'missing':
      return '目标便签已不存在，可能已被删除'
    case 'kind_changed':
      return '目标便签类型已变化，请让助手重新确认'
    case 'target_mismatch':
      return '删除卡片与提议的目标不一致，已作废，请让助手重新发起删除'
    case 'failed':
      return '删除未生效，请稍后重试'
    case 'invalid':
      return '该删除提议已失效，请让助手重新发起删除'
    default:
      return '找不到删除提议（可能应用已重启），请让助手重新发起删除'
  }
}

export interface DeleteConfirmationAccess {
  findEntry: (id: string) => { kind: EntryKind } | undefined
  moveToTrash: (id: string) => Promise<void>
  stillExists: (id: string) => boolean
}

export type DeleteConfirmationResult =
  | { ok: true }
  | { ok: false; reason: DeleteFailureReason; message: string }

export async function confirmDeleteProposal(input: {
  proposalId: string | undefined
  targetId: string | undefined
  expectedKind: EntryKind
  access: DeleteConfirmationAccess
  now?: number
}): Promise<DeleteConfirmationResult> {
  const { proposalId, targetId, expectedKind, access } = input
  if (!proposalId || !targetId) {
    return { ok: false, reason: 'invalid', message: deleteFailureMessage('invalid') }
  }

  const claim = claimDeleteProposal(proposalId, input.now)
  if (!claim.ok) {
    return {
      ok: false,
      reason: claim.reason,
      message: deleteFailureMessage(claim.reason),
    }
  }

  // 卡片传入的目标必须与提议创建时绑定的目标完全一致，防止篡改 targetId/kind
  if (claim.proposal.entryId !== targetId || claim.proposal.kind !== expectedKind) {
    finishDeleteProposal(proposalId, 'invalid')
    return {
      ok: false,
      reason: 'target_mismatch',
      message: deleteFailureMessage('target_mismatch'),
    }
  }

  const current = access.findEntry(targetId)
  if (!current) {
    finishDeleteProposal(proposalId, 'invalid')
    return { ok: false, reason: 'missing', message: deleteFailureMessage('missing') }
  }
  if (current.kind !== expectedKind) {
    finishDeleteProposal(proposalId, 'invalid')
    return {
      ok: false,
      reason: 'kind_changed',
      message: deleteFailureMessage('kind_changed'),
    }
  }

  try {
    await access.moveToTrash(targetId)
  } catch {
    releaseDeleteProposal(proposalId, input.now)
    return { ok: false, reason: 'failed', message: deleteFailureMessage('failed') }
  }
  if (access.stillExists(targetId)) {
    releaseDeleteProposal(proposalId, input.now)
    return { ok: false, reason: 'failed', message: deleteFailureMessage('failed') }
  }

  finishDeleteProposal(proposalId, 'done')
  return { ok: true }
}

/** 用户取消：提议作废，之后不能再执行 */
export function cancelDeleteProposal(proposalId: string | undefined): void {
  if (!proposalId) return
  finishDeleteProposal(proposalId, 'cancelled')
}
