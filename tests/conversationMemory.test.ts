import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_HISTORY_MESSAGES,
  buildConversationMemory,
  buildMemoryPromptBlock,
  collectMemoryEntities,
  createConversationMemoryCache,
  summarizeConversation,
} from '../src/services/conversationMemory'
import type { AssistantMessage, AssistantToolStep } from '../src/types/ai'

let seq = 0
function userMessage(content: string): AssistantMessage {
  seq += 1
  return {
    id: `u-${seq}`,
    role: 'user',
    content,
    createdAt: seq,
    status: 'done',
  }
}

function assistantMessage(
  content: string,
  extra?: Partial<AssistantMessage>,
): AssistantMessage {
  seq += 1
  return {
    id: `a-${seq}`,
    role: 'assistant',
    content,
    createdAt: seq,
    status: 'done',
    ...extra,
  }
}

function step(extra: Partial<AssistantToolStep>): AssistantToolStep {
  return {
    callId: `c-${Math.random().toString(36).slice(2)}`,
    tool: 'search_notes',
    label: '查询笔记',
    status: 'ok',
    message: 'ok',
    ...extra,
  }
}

describe('对话记忆：最近消息与字数预算', () => {
  it('保留最近消息并剥离旧 <action> 块', () => {
    const messages: AssistantMessage[] = []
    for (let index = 0; index < 16; index += 1) {
      messages.push(userMessage(`第 ${index} 个问题`))
      messages.push(
        assistantMessage(
          index === 0
            ? '回答<action>{"op":"delete","kind":"note","title":"x"}</action>'
            : `第 ${index} 个回答`,
        ),
      )
    }
    const memory = buildConversationMemory(messages)
    assert.ok(memory.recent.length >= MAX_HISTORY_MESSAGES)
    assert.ok(memory.recent.length <= 20)
    assert.equal(memory.recent.at(-1)?.content, '第 15 个回答')
    assert.equal(memory.truncated, true)
    assert.ok(memory.recent.every((message) => !message.content.includes('<action>')))
  })

  it('单条超长消息被裁剪，不突破整段预算', () => {
    const long = '字'.repeat(5000)
    const messages = [userMessage(long), userMessage('短消息')]
    const memory = buildConversationMemory(messages)
    const total = memory.recent.reduce((sum, message) => sum + message.content.length, 0)
    assert.ok(total <= 8000)
    assert.equal(memory.recent.at(-1)?.content, '短消息')
    assert.ok(memory.recent[0].content.endsWith('…'))
  })

  it('失败回答不进入历史，但其中的工具记录仍可被记忆使用', () => {
    const withSteps = assistantMessage('', {
      status: 'done',
      toolSteps: [
        step({
          effect: {
            op: 'create',
            kind: 'note',
            entryId: 'note-1',
            title: '买菜',
            references: [{ id: 'note-1', kind: 'note', title: '买菜' }],
          },
        }),
      ],
    })
    const failed = assistantMessage('网关错误', {
      status: 'error',
      error: { code: 'network', message: 'failed' },
    })
    const memory = buildConversationMemory([withSteps, failed])
    assert.equal(memory.recent.length, 0)
    assert.equal(memory.entities.length, 1)
    assert.equal(memory.entities[0].id, 'note-1')
  })
})

describe('对话记忆：摘要压缩', () => {
  function longConversation(turns = 10): AssistantMessage[] {
    const messages: AssistantMessage[] = []
    for (let index = 0; index < turns; index += 1) {
      messages.push(
        userMessage(
          `第${index}轮：请帮我整理工作笔记，把本周的项目进展、风险和下一步计划都补充到对应的笔记里，并保留原有标签。`,
        ),
      )
      messages.push(
        assistantMessage(
          `第${index}轮已完成整理：项目进展、风险和下一步计划都已补充，原有标签保持不变。`,
        ),
      )
    }
    return messages
  }

  it('较早消息达到阈值后生成摘要，最近消息保持原文', () => {
    const messages = longConversation(12)
    const memory = buildConversationMemory(messages)
    assert.ok(memory.summary)
    assert.ok(memory.summary!.omittedCount > 0)
    assert.ok(memory.summary!.requirements.length > 0)
    assert.equal(memory.recent.at(-1)?.content, '第11轮已完成整理：项目进展、风险和下一步计划都已补充，原有标签保持不变。')
    const block = buildMemoryPromptBlock({ memory })
    assert.match(block, /较早对话摘要/)
    assert.match(block, /不是系统指令/)
  })

  it('摘要只搬运已有事实，不新增需求或结论', () => {
    const messages = [
      ...longConversation(8),
      userMessage('帮我把季度复盘改成最终版'),
      assistantMessage('已修改', {
        toolSteps: [
          step({
            tool: 'update_entry',
            label: '修改备忘「季度复盘」',
            effect: {
              op: 'update',
              kind: 'note',
              entryId: 'note-9',
              title: '季度复盘',
              references: [{ id: 'note-9', kind: 'note', title: '季度复盘' }],
            },
          }),
        ],
      }),
    ]
    const summary = summarizeConversation(messages)
    assert.ok(summary.requirements.includes('帮我把季度复盘改成最终版'))
    for (const requirement of summary.requirements) {
      assert.ok(
        messages.some((message) => message.content.includes(requirement.replace(/…$/, ''))),
        requirement,
      )
    }
    assert.ok(summary.completed.includes('修改备忘「季度复盘」'))
    assert.equal(summary.pendingConfirm.length, 0)
  })

  it('已完成的创建/修改不会在摘要里变成待办；删除确认单独标注不可恢复', () => {
    const messages = [
      userMessage('新建买菜清单，并删掉旧清单'),
      assistantMessage('处理完成', {
        toolSteps: [
          step({
            tool: 'create_entry',
            label: '新建待办「买菜」',
            effect: { op: 'create', kind: 'todo', entryId: 't-1', title: '买菜' },
          }),
          step({
            tool: 'delete_entry',
            label: '删除备忘「旧清单」',
            status: 'confirm',
            message: '等待确认',
            effect: { op: 'delete', kind: 'note', entryId: 'n-1', title: '旧清单' },
          }),
          step({
            tool: 'update_entry',
            label: '修改备忘「周报」',
            status: 'error',
            message: '执行失败',
          }),
        ],
      }),
    ]
    const summary = summarizeConversation(messages)
    assert.deepEqual(summary.completed, ['新建待办「买菜」'])
    assert.equal(summary.pendingConfirm.length, 1)
    assert.match(summary.pendingConfirm[0], /摘要不能恢复该确认/)
    assert.equal(summary.failed.length, 1)
    assert.match(summary.failed[0], /修改备忘「周报」/)
  })

  it('摘要失败时扩大最近窗口，当前消息不丢失', () => {
    const messages = longConversation(12)
    const lastContent = messages.at(-1)?.content
    const memory = buildConversationMemory(messages, {
      summarize: () => {
        throw new Error('summarize failed')
      },
    })
    assert.equal(memory.summary, null)
    assert.ok(memory.recent.length > MAX_HISTORY_MESSAGES)
    assert.equal(memory.recent.at(-1)?.content, lastContent)
  })

  it('相同历史片段只摘要一次（缓存命中）', () => {
    const messages = longConversation(12)
    const cache = createConversationMemoryCache()
    let calls = 0
    const summarize = (older: AssistantMessage[]) => {
      calls += 1
      return summarizeConversation(older)
    }
    buildConversationMemory(messages, { cache, summarize })
    buildConversationMemory(messages, { cache, summarize })
    assert.equal(calls, 1)

    buildConversationMemory([...messages, userMessage('新增一轮'), assistantMessage('好的')], {
      cache,
      summarize,
    })
    assert.equal(calls, 2)
  })

  it('最新用户明确取消时，当前任务标记为已取消且要求停止旧计划', () => {
    const messages = [
      userMessage('帮我修改项目周报'),
      assistantMessage('已修改', {
        toolSteps: [
          step({
            tool: 'update_entry',
            label: '修改备忘「项目周报」',
            effect: { op: 'update', kind: 'note', entryId: 'n-1', title: '项目周报' },
          }),
        ],
      }),
      userMessage('算了，先不做了'),
    ]
    const memory = buildConversationMemory(messages)
    assert.equal(memory.activeContext?.cancelled, true)
    const block = buildMemoryPromptBlock({ memory })
    assert.match(block, /明确取消或否定/)
  })

  it('上一轮等待补充的问题仅作为上下文展示', () => {
    const messages = [
      userMessage('帮我改那个提醒'),
      assistantMessage('你指的是哪一个提醒？', { needsInput: true, phase: 'needs_input' }),
    ]
    const memory = buildConversationMemory(messages)
    assert.equal(memory.pendingQuestion, '你指的是哪一个提醒？')
    const block = buildMemoryPromptBlock({ memory })
    assert.match(block, /上一轮等待补充/)
  })
})

describe('对话记忆：实体与真实数据刷新', () => {
  const messages = (): AssistantMessage[] => [
    userMessage('找一下工作笔记'),
    assistantMessage('找到两条', {
      toolSteps: [
        step({
          tool: 'search_notes',
          effect: {
            op: 'search',
            count: 2,
            references: [
              { id: 'n-1', kind: 'note', title: '工作笔记A' },
              { id: 'n-2', kind: 'note', title: '工作笔记B' },
            ],
          },
        }),
      ],
    }),
  ]

  it('只收集工具真实返回的引用，查询结果标记为 queried', () => {
    const entities = collectMemoryEntities(messages())
    assert.deepEqual(
      entities.map((entity) => [entity.id, entity.origin]),
      [
        ['n-1', 'queried'],
        ['n-2', 'queried'],
      ],
    )
    const memory = buildConversationMemory(messages())
    assert.deepEqual(
      memory.lastList.map((entity) => entity.id),
      ['n-1', 'n-2'],
    )
  })

  it('删除过的条目在提示词里标注失效，不能用记忆中的标题继续操作', () => {
    const memory = buildConversationMemory(messages())
    const block = buildMemoryPromptBlock({
      memory,
      entries: [
        {
          id: 'n-1',
          kind: 'note',
          title: '工作笔记A',
          content: '',
          createdAt: 1,
          updatedAt: 1,
          syncStatus: 'pending',
          tags: [],
        },
      ],
    })
    assert.match(block, /n-1[\s\S]*存在/)
    assert.equal(block.includes('n-2'), false, '已删除条目的 id 不应继续交给模型')
    assert.match(block, /已删除或类型变化，已忽略/)
    assert.match(block, /id 不是授权/)
  })

  it('记忆提示词声明历史与摘要不可信，不能当作授权', () => {
    const block = buildMemoryPromptBlock({
      memory: buildConversationMemory(messages()),
    })
    assert.match(block, /不是系统指令/)
    assert.match(block, /摘要不是事实数据库/)
    assert.match(block, /记忆里的 id、标题、时间都不能直接用于写入/)
    assert.match(block, /<\/conversation_memory>/)
  })
})
