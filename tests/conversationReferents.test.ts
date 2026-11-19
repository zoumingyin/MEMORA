import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { hasWriteActionClause } from '../src/services/agentTargets'
import { buildConversationMemory } from '../src/services/conversationMemory'
import {
  detectConversationReferent,
  resolveConversationReferent,
} from '../src/services/conversationReferents'
import type { AssistantMessage, AssistantToolStep } from '../src/types/ai'
import type { Entry } from '../src/types/entry'

let seq = 0
function userMessage(content: string): AssistantMessage {
  seq += 1
  return { id: `u-${seq}`, role: 'user', content, createdAt: seq, status: 'done' }
}

function assistantMessage(
  content: string,
  steps: AssistantToolStep[] = [],
): AssistantMessage {
  seq += 1
  return {
    id: `a-${seq}`,
    role: 'assistant',
    content,
    createdAt: seq,
    status: 'done',
    ...(steps.length > 0 ? { toolSteps: steps } : {}),
  }
}

function step(extra: Partial<AssistantToolStep>): AssistantToolStep {
  return {
    callId: `c-${seq}-${Math.random().toString(36).slice(2)}`,
    tool: 'search_notes',
    label: '动作',
    status: 'ok',
    message: 'ok',
    ...extra,
  }
}

function searchStep(references: { id: string; kind: Entry['kind']; title: string }[]) {
  return step({
    tool: 'search_notes',
    label: '查询笔记',
    effect: { op: 'search', count: references.length, references },
  })
}

function createStep(reference: { id: string; kind: Entry['kind']; title: string }) {
  return step({
    tool: 'create_entry',
    label: `新建「${reference.title}」`,
    effect: {
      op: 'create',
      kind: reference.kind,
      entryId: reference.id,
      title: reference.title,
      references: [reference],
    },
  })
}

function entryOf(reference: { id: string; kind: Entry['kind']; title: string }): Entry {
  return {
    id: reference.id,
    kind: reference.kind,
    title: reference.title,
    content: '',
    createdAt: 1,
    updatedAt: 1,
    syncStatus: 'pending',
    tags: [],
    version: 1,
  } as Entry
}

describe('指代识别', () => {
  it('识别最近、最后、序号、补充与指示代词', () => {
    assert.equal(detectConversationReferent('把刚才那条改成买水果')?.kind, 'latest')
    assert.equal(detectConversationReferent('把最后一条改成已完成')?.kind, 'last')
    const ordinal = detectConversationReferent('把第二条待办改成已完成')
    assert.equal(ordinal?.kind, 'ordinal')
    assert.equal(ordinal?.ordinal, 2)
    assert.equal(ordinal?.kindFilter, 'todo')
    assert.equal(detectConversationReferent('再补充一点：周末去买菜')?.kind, 'supplement')
    assert.equal(detectConversationReferent('修改它')?.kind, 'demonstrative')
  })

  it('没有历史指代词时返回 null；纯查询句不算写意图', () => {
    assert.equal(detectConversationReferent('新建一条会议笔记'), null)
    assert.equal(hasWriteActionClause('把刚才那条改成买水果'), true)
    assert.equal(hasWriteActionClause('刚才那条写了什么'), false)
    assert.equal(hasWriteActionClause('刚才那条里有哪些修改'), false)
  })
})

describe('指代解析：唯一解析', () => {
  it('最近创建的一条可以用「刚才那条」继续修改', () => {
    const target = { id: 'n-1', kind: 'note' as const, title: '买菜' }
    const memory = buildConversationMemory([
      userMessage('新建一条叫买菜的笔记'),
      assistantMessage('已创建', [createStep(target)]),
    ])
    const referent = resolveConversationReferent(
      '把刚才那条的标题改成买水果',
      memory,
      [entryOf(target)],
    )
    assert.equal(referent?.status, 'resolved')
    assert.equal(referent?.kind, 'latest')
    assert.equal(referent?.entry?.id, 'n-1')
    assert.equal(referent?.question, null)
  })

  it('「再补充一点」唯一解析到最后创建/修改的一条', () => {
    const target = { id: 'n-2', kind: 'note' as const, title: '项目复盘' }
    const memory = buildConversationMemory([
      userMessage('新建项目复盘'),
      assistantMessage('已创建', [createStep(target)]),
    ])
    const referent = resolveConversationReferent('再补充一点：下周一同步', memory, [
      entryOf(target),
    ])
    assert.equal(referent?.status, 'resolved')
    assert.equal(referent?.entry?.id, 'n-2')
  })

  it('「第二条」按最近一次查询结果的展示顺序解析', () => {
    const refs = [
      { id: 'n-a', kind: 'note' as const, title: '工作笔记A' },
      { id: 'n-b', kind: 'note' as const, title: '工作笔记B' },
      { id: 'n-c', kind: 'note' as const, title: '工作笔记C' },
    ]
    const memory = buildConversationMemory([
      userMessage('找一下工作笔记'),
      assistantMessage('找到三条', [searchStep(refs)]),
    ])
    const referent = resolveConversationReferent('把第二条改成已完成', memory, refs.map(entryOf))
    assert.equal(referent?.status, 'resolved')
    assert.equal(referent?.entry?.id, 'n-b')
  })

  it('「最后一条」取查询结果的最后一条，而不是最早一条', () => {
    const refs = [
      { id: 'n-a', kind: 'note' as const, title: '工作笔记A' },
      { id: 'n-b', kind: 'note' as const, title: '工作笔记B' },
    ]
    const memory = buildConversationMemory([
      userMessage('找一下工作笔记'),
      assistantMessage('找到两条', [searchStep(refs)]),
    ])
    const referent = resolveConversationReferent('把最后一条改成已完成', memory, refs.map(entryOf))
    assert.equal(referent?.status, 'resolved')
    assert.equal(referent?.entry?.id, 'n-b')
  })

  it('类型过滤只限定在对应分类里', () => {
    const note = { id: 'n-1', kind: 'note' as const, title: '会议纪要' }
    const reminder = { id: 'r-1', kind: 'reminder' as const, title: '喝水' }
    const memory = buildConversationMemory([
      userMessage('创建一个笔记和一个提醒'),
      assistantMessage('已创建', [createStep(note), createStep(reminder)]),
    ])
    const referent = resolveConversationReferent(
      '把刚才那条提醒改成每天喝水',
      memory,
      [note, reminder].map(entryOf),
    )
    assert.equal(referent?.status, 'resolved')
    assert.equal(referent?.entry?.id, 'r-1')
  })

  it('解析结果显示条目的当前标题，而不是记忆里的旧标题', () => {
    const target = { id: 'n-1', kind: 'note' as const, title: '旧标题' }
    const memory = buildConversationMemory([
      userMessage('新建旧标题'),
      assistantMessage('已创建', [createStep(target)]),
    ])
    const referent = resolveConversationReferent('把刚才那条改成新标题', memory, [
      { ...entryOf(target), title: '用户改过的新标题' },
    ])
    assert.equal(referent?.status, 'resolved')
    assert.equal(referent?.entry?.title, '用户改过的新标题')
  })
})

describe('指代解析：不确定一律询问', () => {
  it('多个候选时「修改它」必须询问，不能默认第一条', () => {
    const refs = [
      { id: 'n-a', kind: 'note' as const, title: '工作笔记A' },
      { id: 'n-b', kind: 'note' as const, title: '工作笔记B' },
    ]
    const memory = buildConversationMemory([
      userMessage('找一下工作笔记'),
      assistantMessage('找到两条', [searchStep(refs)]),
    ])
    const referent = resolveConversationReferent('修改它', memory, refs.map(entryOf))
    assert.equal(referent?.status, 'ambiguous')
    assert.equal(referent?.entry, null)
    assert.equal(referent?.candidates.length, 2)
    assert.match(referent?.question ?? '', /你指的是哪一条/)
    assert.match(referent?.question ?? '', /工作笔记A/)
    assert.match(referent?.question ?? '', /工作笔记B/)
  })

  it('同批创建多条时「再补充一点」也必须询问', () => {
    const first = { id: 'n-1', kind: 'note' as const, title: '会议记录' }
    const second = { id: 'n-2', kind: 'note' as const, title: '待办清单' }
    const memory = buildConversationMemory([
      userMessage('创建会议记录和待办清单'),
      assistantMessage('已创建', [createStep(first), createStep(second)]),
    ])
    const referent = resolveConversationReferent('再补充一点：周五前完成', memory, [
      first,
      second,
    ].map(entryOf))
    assert.equal(referent?.status, 'ambiguous')
    assert.equal(referent?.entry, null)
  })

  it('序号超出范围时给出可回答的问题，而不是回落到第一条', () => {
    const refs = [{ id: 'n-a', kind: 'note' as const, title: '唯一笔记' }]
    const memory = buildConversationMemory([
      userMessage('找一下笔记'),
      assistantMessage('找到一条', [searchStep(refs)]),
    ])
    const referent = resolveConversationReferent('把第五条改成已完成', memory, refs.map(entryOf))
    assert.equal(referent?.status, 'missing')
    assert.equal(referent?.entry, null)
    assert.match(referent?.question ?? '', /没有第 5 条/)
  })

  it('条目被删除后指代失效，不能凭记忆里的标题继续操作', () => {
    const target = { id: 'n-1', kind: 'note' as const, title: '已删除的笔记' }
    const memory = buildConversationMemory([
      userMessage('新建一条笔记'),
      assistantMessage('已创建', [createStep(target)]),
    ])
    const referent = resolveConversationReferent('把刚才那条改成新标题', memory, [])
    assert.equal(referent?.status, 'stale')
    assert.equal(referent?.entry, null)
    assert.match(referent?.question ?? '', /已不存在或已被删除/)
  })

  it('完全没有历史时指代无法解析，要求用户说明标题', () => {
    const memory = buildConversationMemory([])
    const referent = resolveConversationReferent('再补充一点：周末去买菜', memory, [])
    assert.equal(referent?.status, 'missing')
    assert.match(referent?.question ?? '', /没有找到/)
  })

  it('只有历史查询结果、没有写意图时不产生解析结果', () => {
    const refs = [{ id: 'n-a', kind: 'note' as const, title: '工作笔记A' }]
    const memory = buildConversationMemory([
      userMessage('找一下工作笔记'),
      assistantMessage('找到一条', [searchStep(refs)]),
    ])
    assert.equal(hasWriteActionClause('刚才那条写了什么'), false)
    // 指代本身可以识别，但是否进入写授权由调用方的写意图门禁决定
    const referent = resolveConversationReferent('刚才那条写了什么', memory, refs.map(entryOf))
    assert.equal(referent?.status, 'resolved')
    assert.equal(referent?.entry?.id, 'n-a')
  })
})
