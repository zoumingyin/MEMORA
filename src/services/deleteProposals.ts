import type { EntryKind } from '../types/entry'

/**
 * 删除提议注册表（仅内存）：
 * - 模型发起 delete_entry 时生成提议，ActionCard 凭 proposalId 执行；
 * - 每个提议只会被 claim 一次（pending → executing → done），重复点击 / 并发点击都拿不到第二次；
 * - 取消、过期、已执行、目标已不存在时都不能再执行；
 * - 作用范围：单个应用会话内的内存表，应用重启后提议丢失，
 *   历史消息里的删除卡片会按「已失效」处理，需要让 AI 重新发起删除。
 */

export type DeleteProposalStatus =
  | 'pending'
  | 'executing'
  | 'done'
  | 'cancelled'
  | 'expired'
  | 'invalid'

export interface DeleteProposal {
  id: string
  entryId: string
  kind: EntryKind
  title: string
  /** 发起来源请求 id，仅用于排查 */
  requestId: string
  createdAt: number
  expiresAt: number
  status: DeleteProposalStatus
}

export const DELETE_PROPOSAL_TTL_MS = 10 * 60_000

const proposals = new Map<string, DeleteProposal>()

function prune(now: number): void {
  if (proposals.size < 64) return
  for (const [id, proposal] of proposals) {
    if (proposal.expiresAt + 60 * 60_000 < now) proposals.delete(id)
  }
}

export function createDeleteProposal(input: {
  entryId: string
  kind: EntryKind
  title: string
  requestId: string
  now?: number
  ttlMs?: number
}): DeleteProposal {
  const now = input.now ?? Date.now()
  prune(now)
  const proposal: DeleteProposal = {
    id: crypto.randomUUID(),
    entryId: input.entryId,
    kind: input.kind,
    title: input.title,
    requestId: input.requestId,
    createdAt: now,
    expiresAt: now + (input.ttlMs ?? DELETE_PROPOSAL_TTL_MS),
    status: 'pending',
  }
  proposals.set(proposal.id, proposal)
  return proposal
}

export function getDeleteProposal(id: string): DeleteProposal | undefined {
  return proposals.get(id)
}

export type ClaimDeleteProposalResult =
  | { ok: true; proposal: DeleteProposal }
  | { ok: false; reason: 'not_found' | 'expired' | 'cancelled' | 'done' | 'busy' | 'invalid' }

/** 原子占用：只有 pending 且未过期的提议能成功，成功即置为 executing */
export function claimDeleteProposal(id: string, now: number = Date.now()): ClaimDeleteProposalResult {
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
  proposal.status = 'executing'
  return { ok: true, proposal }
}

/** 写入失败时释放占用，允许用户重试（已过期则不释放） */
export function releaseDeleteProposal(id: string, now: number = Date.now()): void {
  const proposal = proposals.get(id)
  if (!proposal || proposal.status !== 'executing') return
  proposal.status = proposal.expiresAt <= now ? 'expired' : 'pending'
}

export function finishDeleteProposal(
  id: string,
  status: 'done' | 'cancelled' | 'invalid',
): void {
  const proposal = proposals.get(id)
  if (!proposal) return
  proposal.status = status
}

/** 清空会话时一并清理，避免内存表无限增长 */
export function resetDeleteProposals(): void {
  proposals.clear()
}
