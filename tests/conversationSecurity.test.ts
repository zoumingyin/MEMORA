import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  executeToolWithEnv,
  seedTrustedTargets,
  type AgentToolScope,
  type ToolOutcome,
} from '../src/services/agentToolExecutor'
import { hasReferentWriteClause } from '../src/services/agentTargets'
import { buildConversationMemory } from '../src/services/conversationMemory'
import { resolveConversationReferent } from '../src/services/conversationReferents'
import type { AssistantMessage, AssistantToolStep } from '../src/types/ai'
import { call, createHarness, makeBase, nextId, seed, type TestHarness } from './helpers'

let h!: TestHarness
beforeEach(async () => {
  h = await createHarness()
})

function untrustedScope(): AgentToolScope {
  return h.scope(nextId('req'), { trustedTargets: [] })
}

function run(
  scope: AgentToolScope,
  name: string,
  args: unknown,
  id = nextId('call'),
): Promise<ToolOutcome> {
  return executeToolWithEnv(call(id, name, args), h.env, scope)
}

let messageSeq = 0
function userMessage(content: string): AssistantMessage {
  messageSeq += 1
  return {
    id: `cu-${messageSeq}`,
    role: 'user',
    content,
    createdAt: messageSeq,
    status: 'done',
  }
}

function assistantMessage(
  content: string,
  steps: AssistantToolStep[] = [],
): AssistantMessage {
  messageSeq += 1
  return {
    id: `ca-${messageSeq}`,
    role: 'assistant',
    content,
    createdAt: messageSeq,
    status: 'done',
    ...(steps.length > 0 ? { toolSteps: steps } : {}),
  }
}

function createdStep(reference: { id: string; kind: 'note' | 'todo' | 'reminder'; title: string }) {
  return {
    callId: `cc-${reference.id}`,
    tool: 'create_entry',
    label: `新建「${reference.title}」`,
    status: 'ok' as const,
    message: 'ok',
    effect: {
      op: 'create' as const,
      kind: reference.kind,
      entryId: reference.id,
      title: reference.title,
      references: [reference],
    },
  }
}

/**
 * 复刻 store 的授权入口：只有「当前消息有写意图」且「本轮唯一解析成功」时，
 * 才把对话记忆中的条目交给执行层；历史文本本身永远不进入 trustedTargets。
 */
function seedFromConversation(scope: AgentToolScope, text: string, memory: AssistantMessage[]) {
  const entries = h.entries()
  const built = buildConversationMemory(memory)
  const referent = resolveConversationReferent(text, built, entries)
  const referentWrite =
    referent !== null && hasReferentWriteClause(text, text.indexOf(referent.phrase))
  const resolved = referentWrite && referent.status === 'resolved' ? referent : null
  seedTrustedTargets(scope, {
    userText: text,
    entries,
    conversationTargets:
      resolved && resolved.entry
        ? [{ id: resolved.entry.id, kind: resolved.entry.kind, title: resolved.entry.title }]
        : [],
  })
  return resolved
}

describe('对话记忆不产生写入授权', () => {
  it('历史消息里出现过的 id 不能凭当前指代直接授权', async () => {
    const target = await seed(h, makeBase('note', { title: '历史里的目标' }))
    const history = [
      userMessage('之前那条笔记是什么 id？'),
      assistantMessage(
        `那条笔记的 id: ${target.id}，标题是「历史里的目标」。`,
        // 没有真实工具返回：只是模型文本
      ),
    ]
    const scope = untrustedScope()
    const resolved = seedFromConversation(scope, '把刚才那条改成完成', history)
    assert.equal(resolved, null)
    assert.equal(scope.trustedTargets.size, 0)

    const out = await run(scope, 'update_entry', { id: target.id, title: '完成' })
    assert.equal(out.status, 'error')
    assert.equal(out.blockedCode, 'target_untrusted')
    assert.equal(h.entries()[0].title, '历史里的目标')
  })

  it('历史查询结果只作为候选，不会升级为 trustedTargets', async () => {
    const target = await seed(h, makeBase('note', { title: '查询目标' }))
    const history = [
      userMessage('找一下查询目标'),
      assistantMessage('找到一条', [
        {
          callId: 'search-1',
          tool: 'search_notes',
          label: '查询笔记',
          status: 'ok',
          message: '找到 1 条',
          effect: {
            op: 'search',
            count: 1,
            references: [{ id: target.id, kind: 'note', title: '查询目标' }],
          },
        },
      ]),
    ]
    // 纯查询句：有指代但没有写意图 → 不进入授权
    const scope = untrustedScope()
    const resolved = seedFromConversation(scope, '刚才那条写了什么', history)
    assert.equal(resolved, null)
    assert.equal(scope.trustedTargets.size, 0)
    const blocked = await run(scope, 'delete_entry', { id: target.id })
    assert.equal(blocked.status, 'error')

    // 唯一解析 + 明确写意图：只授权这一条，且删除仍只生成确认卡片
    const granted = untrustedScope()
    const unique = seedFromConversation(granted, '把刚才那条改成已完成', history)
    assert.equal(unique?.entry?.id, target.id)
    assert.equal(granted.trustedTargets.get(target.id)?.source, 'conversation_referent')
    const confirm = await run(granted, 'delete_entry', { id: target.id })
    assert.equal(confirm.status, 'confirm')
    assert.ok(confirm.confirmAction)
    assert.equal(h.entries().length, 1)
  })

  it('记忆中的条目已被删除、又出现同名新条目时，不能用记忆标题改到新条目', async () => {
    const original = await seed(h, makeBase('note', { title: '周报' }))
    const history = [
      userMessage('新建周报'),
      assistantMessage('已创建', [createdStep({ id: original.id, kind: 'note', title: '周报' })]),
    ]
    await h.repo.moveToTrash(original.id)
    await h.refresh()
    const replacement = await seed(h, makeBase('note', { title: '周报' }))

    const scope = untrustedScope()
    const resolved = seedFromConversation(scope, '把刚才那条改成新版', history)
    assert.equal(resolved, null)
    assert.equal(scope.trustedTargets.size, 0)

    const out = await run(scope, 'update_entry', { id: replacement.id, title: '误改同名' })
    assert.equal(out.status, 'error')
    assert.equal(out.needsInput, true)
    assert.equal(h.entries().find((entry) => entry.id === replacement.id)?.title, '周报')
  })

  it('指代只出现在查询从句时，不把旧目标带进写入授权', async () => {
    const target = await seed(h, makeBase('note', { title: '周报' }))
    const history = [
      userMessage('新建周报'),
      assistantMessage('已创建', [createdStep({ id: target.id, kind: 'note', title: '周报' })]),
    ]
    const scope = untrustedScope()
    const resolved = seedFromConversation(
      scope,
      '刚才那条是什么？请把标题改成已完成',
      history,
    )
    assert.equal(resolved, null)
    assert.equal(scope.trustedTargets.size, 0)

    const out = await run(scope, 'update_entry', { id: target.id, title: '完成' })
    assert.equal(out.status, 'error')
    assert.equal(h.entries()[0].title, '周报')
  })

  it('多个候选时解析失败，模型自选一条也会被拦截', async () => {
    const first = await seed(h, makeBase('note', { title: '工作笔记A' }))
    const second = await seed(h, makeBase('note', { title: '工作笔记B' }))
    const history = [
      userMessage('找一下工作笔记'),
      assistantMessage('找到两条', [
        {
          callId: 'search-2',
          tool: 'search_notes',
          label: '查询笔记',
          status: 'ok',
          message: '找到 2 条',
          effect: {
            op: 'search',
            count: 2,
            references: [
              { id: first.id, kind: 'note', title: '工作笔记A' },
              { id: second.id, kind: 'note', title: '工作笔记B' },
            ],
          },
        },
      ]),
    ]
    const scope = untrustedScope()
    const resolved = seedFromConversation(scope, '修改它', history)
    assert.equal(resolved, null)
    assert.equal(scope.trustedTargets.size, 0)

    const out = await run(scope, 'update_entry', { id: first.id, append_content: '模型自选' })
    assert.equal(out.status, 'error')
    assert.equal(out.needsInput, true)
    assert.equal(h.entries().find((entry) => entry.id === first.id)?.content, '')
  })

  it('唯一解析的对话目标不能绕过同名歧义拦截', async () => {
    const first = await seed(h, makeBase('note', { title: '周报', content: '第一份' }))
    await seed(h, makeBase('note', { title: '周报', content: '第二份' }))
    const history = [
      userMessage('新建周报'),
      assistantMessage('已创建', [createdStep({ id: first.id, kind: 'note', title: '周报' })]),
    ]
    const scope = untrustedScope()
    const resolved = seedFromConversation(scope, '把刚才那条改成新版', history)
    assert.equal(resolved?.entry?.id, first.id)
    assert.equal(scope.trustedTargets.size, 1)

    const out = await run(scope, 'update_entry', { id: first.id, title: '新版' })
    assert.equal(out.status, 'error')
    assert.equal(out.blockedCode, 'target_ambiguous')
    assert.equal(out.needsInput, true)
    assert.equal(h.entries().find((entry) => entry.id === first.id)?.title, '周报')
  })

  it('记忆目标只授权被解析的那一条，其它条仍不可写', async () => {
    const target = await seed(h, makeBase('note', { title: '买菜' }))
    const other = await seed(h, makeBase('note', { title: '购物清单' }))
    const history = [
      userMessage('新建买菜'),
      assistantMessage('已创建', [createdStep({ id: target.id, kind: 'note', title: '买菜' })]),
    ]
    const scope = untrustedScope()
    const resolved = seedFromConversation(scope, '再补充一点：周末去买菜', history)
    assert.equal(resolved?.entry?.id, target.id)
    assert.equal(scope.trustedTargets.has(other.id), false)

    const wrong = await run(scope, 'update_entry', { id: other.id, title: '误改' })
    assert.equal(wrong.status, 'error')
    assert.equal(wrong.blockedCode, 'target_untrusted')
    const right = await run(scope, 'update_entry', { id: target.id, append_content: '周末去买菜' })
    assert.equal(right.status, 'ok')
    assert.match(h.entries().find((entry) => entry.id === target.id)?.content ?? '', /周末去买菜/)
  })
})
