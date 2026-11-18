import assert from 'node:assert/strict'
import { createRuntime } from './integration/harness.mjs'
import {
  extractId,
  lastToolResult,
  startMockSseServer,
} from './integration/mockSseServer.mjs'

/**
 * Mock SSE 集成测试：真实 store + 真实工具执行 + 真实仓储，只有模型换成
 * 本地脚本化 SSE 服务。与 tests/ 下的「模拟工具调用」单元测试严格区分。
 */

const BASE = Date.now()

function makeEntry(kind, overrides = {}) {
  return {
    id: `${kind}-base`,
    kind,
    title: '标题',
    content: '',
    createdAt: BASE,
    updatedAt: BASE,
    syncStatus: 'pending',
    tags: [],
    deletedAt: null,
    ...overrides,
  }
}

function note(id, title, content = '') {
  return makeEntry('note', { id, title, content })
}

function reminder(id, alarms) {
  return {
    ...makeEntry('reminder', { id, title: '喝水提醒' }),
    remindAt: Math.min(...alarms.map((alarm) => alarm.remindAt)),
    notified: false,
    done: false,
    alarms,
  }
}

function alarm(id, remindAt, mode = 'once') {
  return { id, remindAt, mode, method: 'dialog', notified: false }
}

const READ_ONLY_TOOL_NAMES = [
  'search_notes',
  'list_todos',
  'list_reminders',
  'get_note',
]
const ALL_TOOL_NAMES = [
  ...READ_ONLY_TOOL_NAMES,
  'create_entry',
  'update_entry',
  'delete_entry',
]

function requestToolNames(request) {
  return (request.tools ?? []).map((tool) => tool.function.name)
}

const scenarios = [
  {
    name: '搜索便签并总结（无写入）',
    async run(rt) {
      const mock = await startMockSseServer([
        { calls: [{ id: 'call_s', name: 'search_notes', arguments: { query: '复盘' } }] },
        { content: '找到一条「项目复盘」，内容是完成登录模块。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([note('n1', '项目复盘', '完成登录模块')])
        const message = await rt.sendPrompt('帮我找一下项目复盘的便签，并总结内容')
        assert.equal(message.phase, 'done')
        assert.equal(message.toolSteps.length, 1)
        assert.equal(message.toolSteps[0].effect.op, 'search')
        assert.equal(message.toolSteps[0].effect.count, 1)
        assert.equal(rt.listEntries().length, 1)
        assert.equal(message.toolActions?.length ?? 0, 0)
        assert.equal(mock.requests.length, 2, '搜索一轮 + 总结一轮')
        assert.deepEqual(requestToolNames(mock.requests[0]), READ_ONLY_TOOL_NAMES)
        assert.deepEqual(requestToolNames(mock.requests[1]), READ_ONLY_TOOL_NAMES)
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '跨轮次：搜索返回真实 id 后修改指定记录',
    async run(rt) {
      let observedId = null
      const mock = await startMockSseServer([
        {
          calls: [
            { id: 'call_s', name: 'search_notes', arguments: { query: '项目周报' } },
          ],
        },
        (body) => {
          observedId = extractId(lastToolResult(body))
          return {
            calls: [
              {
                id: 'call_u',
                name: 'update_entry',
                arguments: { id: observedId ?? 'missing', title: '项目周报（终稿）' },
              },
            ],
          }
        },
        { content: '已改为「项目周报（终稿）」。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([note('n2', '项目周报', '本周完成登录模块')])
        const message = await rt.sendPrompt('把标题为「项目周报」的便签改成「项目周报（终稿）」')
        assert.ok(observedId, '第二轮请求的 tool 消息里应带上一轮的真实 id')
        assert.equal(observedId, 'n2')
        assert.equal(message.phase, 'done')
        assert.deepEqual(
          message.toolSteps.map((step) => step.status),
          ['ok', 'ok'],
        )
        const entries = rt.listEntries()
        assert.equal(entries.length, 1)
        assert.equal(entries[0].id, 'n2')
        assert.equal(entries[0].title, '项目周报（终稿）')
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '只读搜索请求后模型强行修改：执行层拒绝且不写库',
    async run(rt) {
      const mock = await startMockSseServer([
        { calls: [{ id: 'call_read', name: 'search_notes', arguments: { query: '项目周报' } }] },
        {
          calls: [
            {
              id: 'call_force',
              name: 'update_entry',
              arguments: { id: 'n-read-only', title: '搜索后擅自修改' },
            },
          ],
        },
        { content: '当前只做了搜索，没有修改任何便签。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([note('n-read-only', '项目周报', '本周完成登录模块')])
        const message = await rt.sendPrompt('帮我找一下项目周报')
        assert.deepEqual(
          message.toolSteps.map((step) => step.status),
          ['ok', 'error'],
        )
        assert.equal(message.toolSteps[1].blockedCode, 'permission_denied')
        assert.equal(rt.listEntries()[0].title, '项目周报')
        assert.equal(rt.listEntries()[0].content, '本周完成登录模块')
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '写意图但目标不明确：查询候选不能被模型当成写授权',
    async run(rt) {
      const mock = await startMockSseServer([
        { calls: [{ id: 'call_search', name: 'search_notes', arguments: { query: '工作笔记' } }] },
        (body) => {
          const picked = extractId(lastToolResult(body))
          return {
            calls: [
              {
                id: 'call_pick',
                name: 'update_entry',
                arguments: { id: picked ?? 'missing', append_content: '模型自选修改' },
              },
            ],
          }
        },
        { content: '有多条工作笔记，请确认要修改哪一条。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([
          note('n-work-a', '工作笔记A', ''),
          note('n-work-b', '工作笔记B', ''),
        ])
        const message = await rt.sendPrompt('修改我的工作笔记')
        assert.equal(message.phase, 'needs_input')
        assert.equal(message.toolSteps[1].status, 'error')
        assert.equal(message.toolSteps[1].blockedCode, 'target_untrusted')
        assert.deepEqual(
          rt.listEntries().map((entry) => [entry.id, entry.content]),
          [
            ['n-work-a', ''],
            ['n-work-b', ''],
          ],
        )
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '查询句中的“修改”是名词用法：模型强行写仍被拦截',
    async run(rt) {
      const mock = await startMockSseServer([
        {
          calls: [
            {
              id: 'call_noun',
              name: 'update_entry',
              arguments: { id: 'n-mod-log', title: '误改记录' },
            },
          ],
        },
        { content: '这只是在查询修改记录，没有修改任何便签。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([note('n-mod-log', '项目总结', '')])
        const message = await rt.sendPrompt('项目总结里有哪些修改')
        assert.equal(message.toolSteps[0].status, 'error')
        assert.equal(message.toolSteps[0].needsInput, true)
        assert.equal(rt.listEntries()[0].title, '项目总结')
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '创建同名标题只授权新建，不授权修改已有条目',
    async run(rt) {
      const mock = await startMockSseServer([
        {
          calls: [
            {
              id: 'call_conflict',
              name: 'update_entry',
              arguments: { id: 'n-existing-summary', title: '旧项目总结被误改' },
            },
          ],
        },
        { content: '现有同名条目未被修改。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([note('n-existing-summary', '项目总结', '旧内容')])
        const message = await rt.sendPrompt('帮我新建一条叫项目总结的笔记')
        assert.equal(message.phase, 'needs_input')
        assert.equal(message.toolSteps[0].status, 'error')
        assert.equal(message.toolSteps[0].needsInput, true)
        assert.equal(rt.listEntries().length, 1)
        assert.equal(rt.listEntries()[0].title, '项目总结')
        assert.equal(rt.listEntries()[0].content, '旧内容')
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '一次要求修改多条时，模型不能自行选择第一条',
    async run(rt) {
      const mock = await startMockSseServer([
        {
          calls: [
            {
              id: 'call_multi',
              name: 'update_entry',
              arguments: { id: 'n-weekly', append_content: '批量误改' },
            },
          ],
        },
        { content: '请确认要先修改哪一条。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([
          note('n-weekly', '项目周报', ''),
          note('n-review', '项目复盘', ''),
        ])
        const message = await rt.sendPrompt('修改项目周报和项目复盘')
        assert.equal(message.phase, 'needs_input')
        assert.equal(message.toolSteps[0].status, 'error')
        assert.equal(message.toolSteps[0].needsInput, true)
        assert.deepEqual(
          rt.listEntries().map((entry) => entry.content),
          ['', ''],
        )
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '用户在列表中选中候选后，只修改选中条目',
    async run(rt) {
      const mock = await startMockSseServer([
        {
          calls: [
            {
              id: 'call_selected',
              name: 'update_entry',
              arguments: { id: 'n-selected', title: '已整理' },
            },
          ],
        },
        { content: '已修改你选中的那条笔记。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([
          note('n-selected', '周报草稿', '待整理'),
          note('n-other', '购物清单', '牛奶'),
        ])
        rt.selectEntry('n-selected')
        const message = await rt.sendPrompt('把这条笔记改成已整理')
        assert.equal(message.phase, 'done')
        assert.equal(message.toolSteps[0].status, 'ok')
        const byId = new Map(rt.listEntries().map((entry) => [entry.id, entry]))
        assert.equal(byId.get('n-selected')?.title, '已整理')
        assert.equal(byId.get('n-other')?.title, '购物清单')
        assert.equal(byId.get('n-other')?.content, '牛奶')
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '选中条目出现在查询句里也不能成为写授权',
    async run(rt) {
      const mock = await startMockSseServer([
        {
          calls: [
            {
              id: 'call_selected_query',
              name: 'update_entry',
              arguments: { id: 'n-selected-query', title: '查询误改' },
            },
          ],
        },
        { content: '这只是查询，没有修改任何便签。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([note('n-selected-query', '选中查询目标', '原内容')])
        rt.selectEntry('n-selected-query')
        const message = await rt.sendPrompt('这条笔记里有哪些修改')
        assert.equal(message.toolSteps[0].status, 'error')
        assert.equal(message.toolSteps[0].needsInput, true)
        assert.equal(rt.listEntries()[0].title, '选中查询目标')
        assert.equal(rt.listEntries()[0].content, '原内容')
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '创建 A 与修改 B 分属不同从句：只授权 B',
    async run(rt) {
      const mock = await startMockSseServer([
        {
          calls: [
            {
              id: 'call_create_a',
              name: 'create_entry',
              arguments: { kind: 'note', title: '笔记A' },
            },
            {
              id: 'call_update_b',
              name: 'update_entry',
              arguments: { id: 'n-target-b', append_content: '已修改' },
            },
          ],
        },
        { content: '已新建笔记A，并修改笔记B。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([
          note('n-existing-a', '笔记A', '旧A'),
          note('n-target-b', '笔记B', '旧B'),
        ])
        const message = await rt.sendPrompt('创建笔记A，然后修改笔记B')
        assert.equal(message.phase, 'done')
        assert.deepEqual(
          message.toolSteps.map((step) => step.status),
          ['ok', 'ok'],
        )
        const entries = rt.listEntries()
        assert.equal(entries.filter((entry) => entry.title === '笔记A').length, 2)
        assert.equal(
          entries.find((entry) => entry.id === 'n-existing-a')?.content,
          '旧A',
        )
        assert.match(
          String(entries.find((entry) => entry.id === 'n-target-b')?.content),
          /已修改/,
        )
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '历史指代“刚才那个”不能绕过目标授权',
    async run(rt) {
      const mock = await startMockSseServer([
        {
          calls: [
            {
              id: 'call_history',
              name: 'update_entry',
              arguments: { id: 'n-history', title: '历史误改' },
            },
          ],
        },
        { content: '请说明要修改哪一条，我没有直接改。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([note('n-history', '历史目标', '原内容')])
        rt.selectEntry('n-history')
        const message = await rt.sendPrompt('把刚才那个改一下')
        assert.equal(message.toolSteps[0].status, 'error')
        assert.equal(message.toolSteps[0].blockedCode, 'permission_denied')
        assert.equal(rt.listEntries()[0].title, '历史目标')
        assert.equal(rt.listEntries()[0].content, '原内容')
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '多轮指代：再补充一点修改上一条查询到的条目',
    async run(rt) {
      const mock = await startMockSseServer([
        { calls: [{ id: 'call_find', name: 'search_notes', arguments: { query: '项目复盘' } }] },
        { content: '找到「项目复盘」，当前内容是完成登录模块。' },
        {
          calls: [
            {
              id: 'call_followup',
              name: 'update_entry',
              arguments: { id: 'n-followup', append_content: '下周一同步验收结果' },
            },
          ],
        },
        { content: '已把补充内容写入「项目复盘」。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([note('n-followup', '项目复盘', '完成登录模块')])
        const first = await rt.sendPrompt('帮我找一下项目复盘')
        assert.equal(first.toolSteps[0].status, 'ok')

        const second = await rt.sendPrompt('再补充一点：下周一同步验收结果')
        assert.equal(second.phase, 'done')
        assert.equal(second.toolSteps[0].status, 'ok')
        assert.match(rt.listEntries()[0].content, /下周一同步验收结果/)

        const system = String(mock.requests[2].messages?.[0]?.content ?? '')
        assert.match(system, /<conversation_memory>/)
        assert.match(system, /对话中提到的条目/)
        assert.match(system, /n-followup/)
        assert.deepEqual(requestToolNames(mock.requests[2]), ALL_TOOL_NAMES)
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '多轮指代：多个候选时修改它必须询问且不写入',
    async run(rt) {
      const mock = await startMockSseServer([
        { calls: [{ id: 'call_find_many', name: 'search_notes', arguments: { query: '工作笔记' } }] },
        { content: '找到两条工作笔记。' },
        {
          calls: [
            {
              id: 'call_pick_it',
              name: 'update_entry',
              arguments: { id: 'n-amb-a', append_content: '模型自选补充' },
            },
          ],
        },
        { content: '我无法确定你要修改哪一条。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([
          note('n-amb-a', '工作笔记A', ''),
          note('n-amb-b', '工作笔记B', ''),
        ])
        await rt.sendPrompt('找一下工作笔记')
        const message = await rt.sendPrompt('修改它')
        assert.equal(message.phase, 'needs_input')
        assert.equal(message.needsInput, true)
        assert.match(message.content, /你指的是哪一条/)
        assert.match(message.content, /工作笔记A/)
        assert.match(message.content, /工作笔记B/)
        assert.equal(message.toolSteps[0].status, 'error')
        assert.equal(message.toolSteps[0].blockedCode, 'permission_denied')
        assert.deepEqual(
          rt.listEntries().map((entry) => entry.content),
          ['', ''],
          '指代歧义时不得写入任何条目',
        )
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '多轮指代：删除仍只生成确认卡片',
    async run(rt) {
      const mock = await startMockSseServer([
        { calls: [{ id: 'call_find_del', name: 'search_notes', arguments: { query: '旧草稿' } }] },
        { content: '找到「旧草稿」。' },
        { calls: [{ id: 'call_del_it', name: 'delete_entry', arguments: { id: 'n-del-ref' } }] },
        { content: '已生成删除确认卡片，请点击确认。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([note('n-del-ref', '旧草稿', '待删除')])
        await rt.sendPrompt('找一下旧草稿')
        const message = await rt.sendPrompt('删除刚才那条')
        assert.equal(message.phase, 'done')
        assert.equal(message.toolSteps[0].status, 'confirm')
        assert.equal(message.toolActions.length, 1)
        assert.equal(message.toolActions[0].targetId, 'n-del-ref')
        assert.equal(rt.listEntries().length, 1, '确认前条目必须仍在')
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '显式标题中的“这条”是同位语：取消后重新删除仍下发写工具',
    async run(rt) {
      const mock = await startMockSseServer([
        { calls: [{ id: 'call_del_title', name: 'delete_entry', arguments: { id: 'n-appositive' } }] },
        { content: '已生成删除确认卡片，等待您确认。' },
        { calls: [{ id: 'call_del_appositive', name: 'delete_entry', arguments: { id: 'n-appositive' } }] },
        { content: '已重新生成删除确认卡片，等待您确认。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([note('n-appositive', '阶段7待删除', '待删除')])
        const first = await rt.sendPrompt('删除标题为「阶段7待删除」的便签。')
        assert.equal(first.toolActions?.length ?? 0, 1, '首次删除必须生成确认卡片')
        assert.equal((await rt.cancelDelete(first.id, 0)).ok, true)

        // 取消后历史里已有卡片和消息；当前消息的「这条」是标题同位语，不能被当成
        // 无法解析的历史指代而把工具范围降为只读。
        const second = await rt.sendPrompt('删除「阶段7待删除」这条便签。')
        assert.deepEqual(requestToolNames(mock.requests[2]), ALL_TOOL_NAMES)
        assert.equal(second.toolSteps[0].status, 'confirm')
        assert.equal(second.toolSteps[0].tool, 'delete_entry')
        assert.equal(second.toolActions?.length ?? 0, 1)
        assert.equal(second.toolActions[0].targetId, 'n-appositive')
        assert.equal(rt.listEntries().length, 1, '确认前条目必须仍在')
        assert.equal(rt.entries.getState().trash.length, 0, '确认前不得进入废纸篓')
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '清空会话后历史指代失效，不能凭旧对话写入',
    async run(rt) {
      const mock = await startMockSseServer([
        { calls: [{ id: 'call_find_old', name: 'search_notes', arguments: { query: '会话目标' } }] },
        { content: '找到「会话目标」。' },
        {
          calls: [
            {
              id: 'call_write_old',
              name: 'update_entry',
              arguments: { id: 'n-session', append_content: '旧会话误改' },
            },
          ],
        },
        { content: '我没有找到你刚才提到的条目。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([note('n-session', '会话目标', '原内容')])
        await rt.sendPrompt('找一下会话目标')
        rt.assistant.getState().clear()
        assert.equal(rt.assistant.getState().messages.length, 0)

        const message = await rt.sendPrompt('把刚才那条改成已处理')
        assert.equal(message.phase, 'needs_input')
        assert.equal(message.needsInput, true)
        assert.match(message.content, /没有找到/)
        assert.equal(message.toolSteps[0].status, 'error')
        assert.equal(message.toolSteps[0].blockedCode, 'permission_denied')
        assert.equal(rt.listEntries()[0].content, '原内容')
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '长对话：较早消息进入摘要块，最近消息保持原文',
    async run(rt) {
      const mock = await startMockSseServer([{ content: '已根据前文总结当前进展。' }])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([note('n-long', '长对话目标')])
        const history = []
        for (let index = 0; index < 14; index += 1) {
          history.push({
            id: `long-u-${index}`,
            role: 'user',
            content: `第${index}轮：请把本周的项目进展、风险和下一步计划补充到对应笔记，并保留原有标签、分类和更新时间，同时检查是否有遗漏的待办事项。`,
            createdAt: index * 2,
            status: 'done',
          })
          history.push({
            id: `long-a-${index}`,
            role: 'assistant',
            content: `第${index}轮已完成：项目进展、风险和下一步计划都已补充，原有标签、分类和更新时间保持不变，并确认所有改动都能在列表中看到。`,
            createdAt: index * 2 + 1,
            status: 'done',
          })
        }
        rt.assistant.setState({ messages: history })

        const message = await rt.sendPrompt('总结一下我们刚才做了什么')
        assert.equal(message.phase, 'done')

        const requestMessages = mock.requests[0].messages ?? []
        const system = String(requestMessages[0]?.content ?? '')
        assert.match(system, /<conversation_memory>/)
        assert.match(system, /较早对话摘要/)
        assert.match(system, /第2轮/)
        assert.equal(requestMessages[0].role, 'system')
        const nonSystem = requestMessages.slice(1)
        assert.equal(nonSystem.length, 13, '最近 12 条 + 当前用户消息')
        assert.equal(nonSystem[0].content.includes('第8轮'), true)
        assert.equal(nonSystem.at(-1).role, 'user')
        assert.match(nonSystem.at(-1).content, /总结一下我们刚才做了什么/)
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '创建三个待办（直接写入、无确认卡片）',
    async run(rt) {
      const mock = await startMockSseServer([
        {
          calls: [
            { id: 'call_t1', name: 'create_entry', arguments: { kind: 'todo', title: '写周报' } },
            { id: 'call_t2', name: 'create_entry', arguments: { kind: 'todo', title: '整理纪要' } },
            { id: 'call_t3', name: 'create_entry', arguments: { kind: 'todo', title: '提交报销' } },
          ],
        },
        { content: '已创建三个待办。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        const message = await rt.sendPrompt('创建三个待办：写周报、整理纪要、提交报销')
        assert.equal(message.phase, 'done')
        assert.equal(message.toolSteps.length, 3)
        assert.equal(message.toolSteps.every((step) => step.effect.op === 'create'), true)
        assert.equal(message.toolActions?.length ?? 0, 0)
        assert.deepEqual(requestToolNames(mock.requests[0]), ALL_TOOL_NAMES)
        assert.deepEqual(
          rt.listEntries().map((entry) => entry.title).sort(),
          ['写周报', '提交报销', '整理纪要'].sort(),
        )
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '目标不明确的提醒修改：不修改任何闹钟，等待补充',
    async run(rt) {
      const future = Date.now() + 24 * 3600_000
      const mock = await startMockSseServer([
        {
          calls: [
            {
              id: 'call_r',
              name: 'update_entry',
              arguments: { id: 'r1', remind_at: new Date(future).toISOString() },
            },
          ],
        },
        { content: '这个提醒有两个闹钟，请确认要改哪一个。' },
      ])
      try {
        const now = Date.now()
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([
          reminder('r1', [
            alarm('a1', now + 3600_000, 'daily'),
            alarm('a2', now + 7200_000, 'weekly'),
          ]),
        ])
        const message = await rt.sendPrompt('把喝水提醒改到明天上午十点')
        assert.equal(message.phase, 'needs_input')
        assert.equal(message.toolSteps[0].needsInput, true)
        assert.equal(message.toolSteps[0].status, 'error')
        assert.equal(message.toolSelections.length, 1, '应生成候选闹钟选择卡片')
        const selection = message.toolSelections[0]
        assert.equal(selection.entryId, 'r1')
        assert.deepEqual(
          selection.candidates.map((item) => [item.alarmId, item.mode, item.method]),
          [
            ['a1', 'daily', 'dialog'],
            ['a2', 'weekly', 'dialog'],
          ],
        )
        const stored = rt.listEntries()[0]
        assert.equal(stored.alarms.length, 2)
        assert.deepEqual(
          stored.alarms.map((item) => [item.id, item.mode]),
          [
            ['a1', 'daily'],
            ['a2', 'weekly'],
          ],
        )
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '用户选择候选闹钟后只修改选中闹钟，授权不可重复使用',
    async run(rt) {
      // remind_at 按分钟归一化，预期值先对齐到整分
      const future = Math.floor((Date.now() + 24 * 3600_000) / 60_000) * 60_000
      const mock = await startMockSseServer([
        {
          calls: [
            {
              id: 'call_r',
              name: 'update_entry',
              arguments: {
                id: 'r1',
                title: '喝水提醒（新）',
                remind_at: new Date(future).toISOString(),
                alarm_id: 'a2',
              },
            },
          ],
        },
        { content: '这个提醒有两个闹钟，请确认要改哪一个。' },
      ])
      try {
        const now = Date.now()
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([
          reminder('r1', [
            alarm('a1', now + 3600_000, 'daily'),
            alarm('a2', now + 7200_000, 'weekly'),
          ]),
        ])
        const message = await rt.sendPrompt('把喝水提醒改到明天上午十点')
        assert.equal(message.phase, 'needs_input')
        assert.equal(rt.listEntries()[0].title, '喝水提醒', '选择前标题也不能被改')
        const selection = message.toolSelections[0]
        const result = await rt.selectAlarm(
          selection.proposalId,
          selection.entryId,
          'a2',
        )
        assert.equal(result.ok, true)
        const stored = rt.listEntries()[0]
        assert.equal(stored.title, '喝水提醒（新）')
        assert.deepEqual(
          stored.alarms.map((item) => [item.id, item.mode, item.remindAt, item.method]),
          [
            ['a1', 'daily', now + 3600_000, 'dialog'],
            ['a2', 'weekly', future, 'dialog'],
          ],
        )
        const again = await rt.selectAlarm(
          selection.proposalId,
          selection.entryId,
          'a2',
        )
        assert.equal(again.ok, false)
        assert.equal(again.reason, 'done')
        assert.deepEqual(
          rt.listEntries()[0].alarms.map((item) => item.remindAt),
          [now + 3600_000, future],
          '重复选择不能再写入',
        )
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '只授权提醒时间：卡片不展示额外字段，点击后其它字段不变',
    async run(rt) {
      const future = Math.floor((Date.now() + 24 * 3600_000) / 60_000) * 60_000
      const mock = await startMockSseServer([
        {
          calls: [
            {
              id: 'call_t',
              name: 'update_entry',
              arguments: { id: 'r1', remind_at: new Date(future).toISOString() },
            },
          ],
        },
        { content: '这个提醒有两个闹钟，请确认要改哪一个。' },
      ])
      try {
        const now = Date.now()
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([reminder('r1', [alarm('a1', now + 3600_000, 'daily'), alarm('a2', now + 7200_000, 'weekly')])])
        const message = await rt.sendPrompt('把喝水提醒改到明天上午十点')
        const selection = message.toolSelections[0]
        assert.equal(selection.changes, undefined, '只授权时间时不应展示额外字段')
        const result = await rt.selectAlarm(selection.proposalId, selection.entryId, 'a1')
        assert.equal(result.ok, true)
        const stored = rt.listEntries()[0]
        assert.equal(stored.title, '喝水提醒')
        assert.equal(stored.content, '')
        assert.deepEqual(stored.tags, [])
        assert.equal(stored.alarms[0].remindAt, future)
        assert.equal(stored.alarms[1].remindAt, now + 7200_000)
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '用户取消选择：不写入任何数据',
    async run(rt) {
      const future = Math.floor((Date.now() + 24 * 3600_000) / 60_000) * 60_000
      const mock = await startMockSseServer([
        {
          calls: [
            { id: 'call_c', name: 'update_entry', arguments: { id: 'r1', remind_at: new Date(future).toISOString() } },
          ],
        },
        { content: '请确认要改哪一个闹钟。' },
      ])
      try {
        const now = Date.now()
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([reminder('r1', [alarm('a1', now + 3600_000, 'daily'), alarm('a2', now + 7200_000, 'weekly')])])
        const message = await rt.sendPrompt('把喝水提醒改到明天上午十点')
        const selection = message.toolSelections[0]
        rt.cancelSelection(selection.proposalId, message.id)
        assert.equal(rt.getSelection(selection.proposalId)?.status, 'cancelled')
        const result = await rt.selectAlarm(selection.proposalId, selection.entryId, 'a1')
        assert.equal(result.ok, false)
        assert.equal(result.reason, 'cancelled')
        assert.deepEqual(
          rt.listEntries()[0].alarms.map((item) => item.remindAt),
          [now + 3600_000, now + 7200_000],
        )
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '授权过期：不能再执行',
    async run(rt) {
      const future = Math.floor((Date.now() + 24 * 3600_000) / 60_000) * 60_000
      const mock = await startMockSseServer([
        {
          calls: [
            { id: 'call_e', name: 'update_entry', arguments: { id: 'r1', remind_at: new Date(future).toISOString() } },
          ],
        },
        { content: '请确认要改哪一个闹钟。' },
      ])
      try {
        const now = Date.now()
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([reminder('r1', [alarm('a1', now + 3600_000, 'daily'), alarm('a2', now + 7200_000, 'weekly')])])
        const message = await rt.sendPrompt('把喝水提醒改到明天上午十点')
        const selection = message.toolSelections[0]
        rt.expireSelection(selection.proposalId)
        const result = await rt.selectAlarm(selection.proposalId, selection.entryId, 'a1')
        assert.equal(result.ok, false)
        assert.equal(result.reason, 'expired')
        assert.deepEqual(
          rt.listEntries()[0].alarms.map((item) => item.remindAt),
          [now + 3600_000, now + 7200_000],
        )
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '目标在等待期间被修改：授权失效且不写入',
    async run(rt) {
      const future = Math.floor((Date.now() + 24 * 3600_000) / 60_000) * 60_000
      const mock = await startMockSseServer([
        {
          calls: [
            { id: 'call_ch', name: 'update_entry', arguments: { id: 'r1', remind_at: new Date(future).toISOString() } },
          ],
        },
        { content: '请确认要改哪一个闹钟。' },
      ])
      try {
        const now = Date.now()
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([reminder('r1', [alarm('a1', now + 3600_000, 'daily'), alarm('a2', now + 7200_000, 'weekly')])])
        const message = await rt.sendPrompt('把喝水提醒改到明天上午十点')
        const selection = message.toolSelections[0]
        await rt.updateEntryDirect('r1', { title: '喝水提醒（用户改名）' })
        const result = await rt.selectAlarm(selection.proposalId, selection.entryId, 'a1')
        assert.equal(result.ok, false)
        assert.equal(result.reason, 'changed')
        const stored = rt.listEntries()[0]
        assert.equal(stored.title, '喝水提醒（用户改名）')
        assert.deepEqual(
          stored.alarms.map((item) => item.remindAt),
          [now + 3600_000, now + 7200_000],
        )
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '开始新任务后旧卡片失效，旧授权不能再写入',
    async run(rt) {
      const future = Math.floor((Date.now() + 24 * 3600_000) / 60_000) * 60_000
      const mock = await startMockSseServer([
        {
          calls: [
            { id: 'call_n', name: 'update_entry', arguments: { id: 'r1', remind_at: new Date(future).toISOString() } },
          ],
        },
        { content: '请确认要改哪一个闹钟。' },
        { content: '好的，这是一个新任务。' },
      ])
      try {
        const now = Date.now()
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([reminder('r1', [alarm('a1', now + 3600_000, 'daily'), alarm('a2', now + 7200_000, 'weekly')])])
        const message = await rt.sendPrompt('把喝水提醒改到明天上午十点')
        const selection = message.toolSelections[0]
        await rt.sendPrompt('先聊点别的')
        const storedMessage = rt.assistant
          .getState()
          .messages.find((item) => item.id === message.id)
        assert.deepEqual(storedMessage.toolSelectionsInvalidated, [selection.proposalId])
        const result = await rt.selectAlarm(selection.proposalId, selection.entryId, 'a1')
        assert.equal(result.ok, false)
        assert.equal(result.reason, 'cancelled')
        assert.deepEqual(
          rt.listEntries()[0].alarms.map((item) => item.remindAt),
          [now + 3600_000, now + 7200_000],
        )
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '重复点击同一候选：只写入一次',
    async run(rt) {
      const future = Math.floor((Date.now() + 24 * 3600_000) / 60_000) * 60_000
      const mock = await startMockSseServer([
        {
          calls: [
            { id: 'call_dup', name: 'update_entry', arguments: { id: 'r1', remind_at: new Date(future).toISOString() } },
          ],
        },
        { content: '请确认要改哪一个闹钟。' },
      ])
      try {
        const now = Date.now()
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([reminder('r1', [alarm('a1', now + 3600_000, 'daily'), alarm('a2', now + 7200_000, 'weekly')])])
        const message = await rt.sendPrompt('把喝水提醒改到明天上午十点')
        const selection = message.toolSelections[0]
        const [first, second] = await Promise.all([
          rt.selectAlarm(selection.proposalId, selection.entryId, 'a1'),
          rt.selectAlarm(selection.proposalId, selection.entryId, 'a1'),
        ])
        assert.equal([first, second].filter((item) => item.ok).length, 1)
        assert.deepEqual(
          rt.listEntries()[0].alarms.map((item) => item.remindAt),
          [future, now + 7200_000],
        )
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '授权 patch 被加入范围外字段：执行层拒绝且不写入',
    async run(rt) {
      const future = Math.floor((Date.now() + 24 * 3600_000) / 60_000) * 60_000
      const mock = await startMockSseServer([
        {
          calls: [
            { id: 'call_x', name: 'update_entry', arguments: { id: 'r1', remind_at: new Date(future).toISOString() } },
          ],
        },
        { content: '请确认要改哪一个闹钟。' },
      ])
      try {
        const now = Date.now()
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([reminder('r1', [alarm('a1', now + 3600_000, 'daily'), alarm('a2', now + 7200_000, 'weekly')])])
        const message = await rt.sendPrompt('把喝水提醒改到明天上午十点')
        const selection = message.toolSelections[0]
        rt.tamperSelection(selection.proposalId, { title: '越权改标题' })
        const result = await rt.selectAlarm(selection.proposalId, selection.entryId, 'a1')
        assert.equal(result.ok, false)
        assert.match(result.message, /授权范围不包括：标题/)
        const stored = rt.listEntries()[0]
        assert.equal(stored.title, '喝水提醒')
        assert.deepEqual(
          stored.alarms.map((item) => item.remindAt),
          [now + 3600_000, now + 7200_000],
        )
        assert.equal(rt.getSelection(selection.proposalId)?.status, 'invalid')
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '应用重启：旧候选卡片标记失效且不能执行',
    async run(rt) {
      const future = Math.floor((Date.now() + 24 * 3600_000) / 60_000) * 60_000
      const mock = await startMockSseServer([
        {
          calls: [
            { id: 'call_rs', name: 'update_entry', arguments: { id: 'r1', remind_at: new Date(future).toISOString() } },
          ],
        },
        { content: '请确认要改哪一个闹钟。' },
      ])
      try {
        const now = Date.now()
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([reminder('r1', [alarm('a1', now + 3600_000, 'daily'), alarm('a2', now + 7200_000, 'weekly')])])
        const message = await rt.sendPrompt('把喝水提醒改到明天上午十点')
        const selection = message.toolSelections[0]
        assert.ok(localStorage.getItem('bianqian.assistant.v1'), '消息应已持久化')

        // 新运行时从同一份 localStorage 冷启动：内存授权表为空
        const restarted = await createRuntime()
        try {
          const messages = restarted.assistant.getState().messages
          const restored = messages.find((item) => item.id === message.id)
          assert.ok(restored, '重启后应恢复历史消息')
          assert.deepEqual(restored.toolSelectionsInvalidated, [selection.proposalId])
          const result = await restarted.selectAlarm(
            selection.proposalId,
            selection.entryId,
            'a1',
          )
          assert.equal(result.ok, false)
          assert.equal(result.reason, 'not_found')
        } finally {
          await restarted.close()
        }
        assert.deepEqual(
          rt.listEntries()[0].alarms.map((item) => item.remindAt),
          [now + 3600_000, now + 7200_000],
          '旧授权不能在重启后写入',
        )
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '删除只生成确认卡片，确认前不写入',
    async run(rt) {
      const mock = await startMockSseServer([
        { calls: [{ id: 'call_d', name: 'delete_entry', arguments: { id: 'n5' } }] },
        { content: '已生成删除确认卡片，请点击确认。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([note('n5', '旧草稿', '待删除')])
        const message = await rt.sendPrompt('删除「旧草稿」')
        assert.equal(message.phase, 'done')
        assert.equal(message.toolSteps[0].status, 'confirm')
        assert.equal(message.toolActions.length, 1)
        assert.equal(message.toolActions[0].targetId, 'n5')
        assert.equal(rt.listEntries().length, 1, '确认前条目必须仍在')
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '普通聊天不产生写操作',
    async run(rt) {
      const mock = await startMockSseServer([
        { content: '你好，今天想整理点什么？' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([note('n6', '已有记录')])
        const message = await rt.sendPrompt('你好')
        assert.equal(message.phase, 'done')
        assert.equal(message.toolSteps?.length ?? 0, 0)
        assert.equal(rt.listEntries().length, 1)
        assert.equal(mock.requests[0].tools, undefined, '普通聊天不下发工具')
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '建议与否定只下发查询工具，不产生写入',
    async run(rt) {
      const mock = await startMockSseServer([
        { content: '可以先从最小的一步开始。' },
        { content: '好的，不创建提醒。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([note('n-scope', '已有记录')])
        const advice = await rt.sendPrompt('帮我想几个待办事项')
        const negated = await rt.sendPrompt('不要创建提醒')
        assert.equal(advice.phase, 'done')
        assert.equal(negated.phase, 'done')
        assert.equal(rt.listEntries().length, 1, '建议与否定不得产生写入')
        assert.deepEqual(requestToolNames(mock.requests[0]), READ_ONLY_TOOL_NAMES)
        assert.deepEqual(requestToolNames(mock.requests[1]), READ_ONLY_TOOL_NAMES)
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '工具执行失败：如实反馈，终态为执行失败',
    async run(rt) {
      const mock = await startMockSseServer([
        { calls: [{ id: 'call_m', name: 'get_note', arguments: { id: 'missing-note' } }] },
        { content: '没有找到该便签，未做任何修改。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([note('n7', '现有记录')])
        const message = await rt.sendPrompt('读取 id 为 missing-note 的便签')
        assert.equal(message.phase, 'failed')
        assert.equal(message.toolSteps[0].status, 'error')
        assert.match(message.toolSteps[0].message, /找不到/)
        assert.equal(rt.listEntries().length, 1)
        assert.match(message.content, /没有找到/)
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '达到工具轮次上限：停止执行并列出未完成事项',
    async run(rt) {
      const script = Array.from({ length: 9 }, (_, index) => ({
        calls: [{ id: `call_l${index}`, name: 'list_todos', arguments: {} }],
      }))
      const mock = await startMockSseServer(script)
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        const message = await rt.sendPrompt('反复列待办直到上限', { timeoutMs: 30000 })
        assert.equal(mock.requests.length, 9, '第 9 轮模型调用被上限拦下')
        assert.equal(message.phase, 'partial')
        assert.equal(message.toolLimitReached, true)
        assert.equal(message.toolSteps.length, 8)
        assert.match(message.content, /已达到本次回答的工具调用上限（8 轮）/)
        assert.match(message.content, /尚未执行的调用 1 项/)
        assert.match(message.content, /已完成 8 项/)
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '同批次猜测 id：修改失败且不写入',
    async run(rt) {
      const mock = await startMockSseServer([
        {
          calls: [
            { id: 'call_q', name: 'search_notes', arguments: { query: '开发' } },
            {
              id: 'call_g',
              name: 'update_entry',
              arguments: { id: 'guessed-id', title: '猜测修改' },
            },
          ],
        },
        { content: '搜索完成；修改因目标不存在未执行。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([note('n8', '开发记录', '完成登录模块')])
        const message = await rt.sendPrompt('搜索开发记录并顺手改一下')
        assert.equal(message.phase, 'partial')
        assert.deepEqual(
          message.toolSteps.map((step) => step.status),
          ['ok', 'error'],
        )
        assert.equal(rt.listEntries()[0].title, '开发记录')
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '普通对话没有工具权限：模型强行调用写入也被执行层拦截',
    async run(rt) {
      const mock = await startMockSseServer([
        {
          calls: [
            {
              id: 'call_illegal',
              name: 'create_entry',
              arguments: { kind: 'note', title: '越权创建' },
            },
          ],
        },
        { content: '当前场景没有写入权限，未创建任何内容。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([note('n-scope-perm', '已有记录')])
        const message = await rt.sendPrompt('你好')
        assert.equal(mock.requests[0].tools, undefined, '普通聊天不下发工具')
        assert.equal(rt.listEntries().length, 1, '未授权写入不得落库')
        assert.equal(message.toolSteps.length, 1)
        assert.equal(message.toolSteps[0].status, 'error')
        assert.equal(message.toolSteps[0].blockedCode, 'permission_denied')
        assert.equal(message.phase, 'failed')
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '失败重试不会重复创建上一轮已写入的条目',
    async run(rt) {
      const mock = await startMockSseServer([
        {
          calls: [
            {
              id: 'call_create_once',
              name: 'create_entry',
              arguments: { kind: 'note', title: '只应创建一次' },
            },
          ],
        },
        { streamErrorAfter: '正在整理创建结果…' },
        {
          calls: [
            {
              id: 'call_create_retry',
              name: 'create_entry',
              arguments: { kind: 'note', title: '只应创建一次' },
            },
          ],
        },
        { content: '上一轮可能已经创建成功，本次没有重复创建。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        const failed = await rt.sendPrompt('新建一个备忘：只应创建一次')
        assert.equal(failed.phase, 'partial')
        assert.equal(failed.toolSteps[0].status, 'ok')
        assert.equal(rt.listEntries().length, 1, '第一轮已真实写入')

        const retried = await rt.retryPrompt()
        assert.equal(mock.requests.length, 4, '首轮 + 失败 + 重试工具轮 + 重试总结')
        assert.equal(rt.listEntries().length, 1, '重试不得重复创建')
        assert.equal(retried.toolSteps[0].status, 'error')
        assert.equal(retried.toolSteps[0].blockedCode, 'retry_duplicate_risk')
        assert.equal(retried.phase, 'needs_input')
        assert.match(
          String(mock.requests[2].messages?.[0]?.content ?? ''),
          /执行层本轮禁止自动再次新建或修改/,
        )
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '多步骤部分成功：成功项保留，失败项如实展示并追加确定性结果',
    async run(rt) {
      const mock = await startMockSseServer([
        {
          calls: [
            { id: 'call_p1', name: 'create_entry', arguments: { kind: 'todo', title: '写周报' } },
            { id: 'call_p2', name: 'create_entry', arguments: { kind: 'todo', title: '整理纪要' } },
            { id: 'call_p3', name: 'create_entry', arguments: { kind: 'todo', title: '　' } },
          ],
        },
        { content: '三个待办都已创建。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        const message = await rt.sendPrompt('创建三个待办：写周报、整理纪要、提交报销')
        assert.equal(message.phase, 'partial')
        assert.deepEqual(
          message.toolSteps.map((step) => step.status),
          ['ok', 'ok', 'error'],
        )
        assert.equal(
          rt.listEntries().filter((entry) => entry.kind === 'todo').length,
          2,
          '只有真实成功的两项落库',
        )
        assert.match(message.content, /执行结果：完成 2 项，失败 1 项，未执行 0 项/)
        assert.match(message.content, /其中写入成功 2 项、写入失败 1 项/)
        assert.match(message.content, /失败项/)
        assert.equal(message.writeAttempts.length, 2)
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '连续续办：失败项可重试，已成功写入不能被重复创建',
    async run(rt) {
      const successArgs = { kind: 'todo', title: '写周报' }
      const brokenArgs = { kind: 'todo', title: '　' }
      const mock = await startMockSseServer([
        {
          calls: [
            { id: 'call_c1', name: 'create_entry', arguments: successArgs },
            { id: 'call_c2', name: 'create_entry', arguments: brokenArgs },
          ],
        },
        { content: '已创建周报待办，第二个未完成。' },
        {
          calls: [
            { id: 'call_c3', name: 'create_entry', arguments: successArgs },
            { id: 'call_c4', name: 'create_entry', arguments: brokenArgs },
          ],
        },
        { content: '仍未完成，请补充标题。' },
        {
          calls: [
            { id: 'call_c5', name: 'create_entry', arguments: successArgs },
            {
              id: 'call_c6',
              name: 'create_entry',
              arguments: { kind: 'todo', title: '整理纪要' },
            },
          ],
        },
        { content: '剩余任务已完成。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        const first = await rt.sendPrompt('创建两个待办：写周报、整理纪要')
        assert.equal(first.phase, 'partial')
        assert.deepEqual(
          first.toolSteps.map((step) => step.status),
          ['ok', 'error'],
        )
        assert.equal(rt.listEntries().length, 1)
        assert.deepEqual(
          first.writeAttempts.map((attempt) => attempt.signature.length > 0),
          [true],
        )

        const second = await rt.sendPrompt('继续刚才失败的那一步，把剩下的做完')
        assert.equal(second.phase, 'failed')
        assert.deepEqual(
          second.toolSteps.map((step) => step.status),
          ['duplicate', 'error'],
          '上一轮已成功的创建必须被幂等拦截',
        )
        assert.match(second.toolSteps[0].message, /重复调用已忽略/)
        assert.equal(rt.listEntries().length, 1, '续办失败时也不能重复写入')
        assert.equal(second.writeAttempts.length, 1, '续办消息仍携带成功签名')

        const third = await rt.sendPrompt('继续刚才失败的那一步，把剩下的做完')
        assert.equal(third.phase, 'done')
        assert.deepEqual(
          third.toolSteps.map((step) => step.status),
          ['duplicate', 'ok'],
        )
        assert.equal(
          rt.listEntries().filter((entry) => entry.kind === 'todo').length,
          2,
          '多轮续办后仍只有两条真实创建',
        )
        assert.deepEqual(
          rt.listEntries().map((entry) => entry.title).sort(),
          ['写周报', '整理纪要'].sort(),
        )
        assert.equal(
          third.writeAttempts.length,
          2,
          '续办链上的成功签名不能因新一轮收尾而丢失',
        )
        assert.match(
          String(mock.requests[2].messages?.[0]?.content ?? ''),
          /<continuation_guard>/,
        )
        assert.match(
          String(mock.requests[4].messages?.[0]?.content ?? ''),
          /<continuation_guard>/,
        )
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '旧请求的迟到响应不能覆盖新请求状态',
    async run(rt) {
      const mock = await startMockSseServer([
        { delayMs: 400, content: '旧回答不应出现' },
        { content: '新回答正常。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        rt.assistant.getState().send('给我讲个很长的故事')
        await rt.sleep(100)
        rt.assistant.getState().stop()
        const oldMessage = rt.lastAssistantMessage()
        assert.equal(oldMessage.stopped, true)

        const next = await rt.sendPrompt('你好')
        assert.equal(next.phase, 'done')
        await rt.sleep(600)
        const messages = rt.assistant.getState().messages
        const oldAfter = messages.find((message) => message.id === oldMessage.id)
        assert.equal(
          String(oldAfter?.content ?? '').includes('旧回答不应出现'),
          false,
          '停止后的迟到流内容不能写入旧消息',
        )
        const latest = rt.lastAssistantMessage()
        assert.equal(latest.id, next.id)
        assert.match(latest.content, /新回答正常/)
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '停止请求：立即清除加载状态',
    async run(rt) {
      const mock = await startMockSseServer([
        { delayMs: 5000, content: '这条回答会被停止。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        rt.assistant.getState().send('给我一段很长的回答')
        await rt.sleep(150)
        assert.equal(rt.assistant.getState().sending, true)
        rt.assistant.getState().stop()
        await rt.sleep(50)
        assert.equal(rt.assistant.getState().sending, false, '停止后必须清除发送状态')
        const message = rt.lastAssistantMessage()
        assert.equal(message.status, 'done')
        assert.equal(message.stopped, true)
        assert.equal(message.phase, 'partial')
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '模型请求在工具执行前失败：无写入，阶段为失败',
    async run(rt) {
      const mock = await startMockSseServer([
        { status: 500, error: 'gateway down' },
        { status: 500, error: 'gateway down again' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([note('n-model-fail', '原有记录')])
        const message = await rt.sendPrompt('新建一个备忘：不应写入')
        assert.equal(message.status, 'error')
        assert.equal(message.phase, 'failed')
        assert.equal(message.toolSteps?.length ?? 0, 0)
        assert.equal(rt.listEntries().length, 1)
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '参数非法后模型修正重试：只写入一次',
    async run(rt) {
      const mock = await startMockSseServer([
        {
          calls: [
            { id: 'call_bad_args', name: 'create_entry', arguments: { kind: 'note', title: '' } },
          ],
        },
        {
          calls: [
            { id: 'call_fixed_args', name: 'create_entry', arguments: { kind: 'note', title: '参数修正后' } },
          ],
        },
        { content: '已创建。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        const message = await rt.sendPrompt('新建一个备忘：参数修正后')
        assert.equal(message.phase, 'partial')
        assert.deepEqual(
          message.toolSteps.map((step) => step.status),
          ['error', 'ok'],
        )
        assert.equal(message.toolSteps[0].failure.category, 'invalid_tool_arguments')
        assert.equal(rt.listEntries().length, 1)
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '创建仓储异常：写入状态未知，不自动重试创建',
    async run(rt) {
      const mock = await startMockSseServer([
        {
          calls: [
            { id: 'call_create_unknown', name: 'create_entry', arguments: { kind: 'note', title: '状态未知' } },
          ],
        },
        { content: '创建结果需要你核对。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        rt.injectCreateFailure((kind, input) => input.title === '状态未知')
        const message = await rt.sendPrompt('新建一个备忘：状态未知')
        const step = message.toolSteps[0]
        assert.equal(step.status, 'error')
        assert.equal(step.failure.category, 'execution_unknown')
        assert.equal(step.failure.requiresVerification, true)
        assert.equal(message.phase, 'failed')
        assert.match(message.content, /写入状态待核对/)
        assert.match(message.content, /不要直接重试/)
        assert.equal(message.writeAttempts.length, 1, '不确定的写入签名必须随消息保留')
        assert.equal(mock.requests.length, 2, '执行层不得自动再次请求创建')
        assert.equal(rt.listEntries().length, 0)
      } finally {
        rt.clearCreateFailure()
        await mock.close()
      }
    },
  },
  {
    name: '同一批次重复创建：第二次按重复调用跳过',
    async run(rt) {
      const mock = await startMockSseServer([
        {
          calls: [
            { id: 'call_dup_a', name: 'create_entry', arguments: { kind: 'todo', title: '唯一待办' } },
            { id: 'call_dup_b', name: 'create_entry', arguments: { kind: 'todo', title: '唯一待办' } },
          ],
        },
        { content: '已创建。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        const message = await rt.sendPrompt('新建待办「唯一待办」')
        assert.deepEqual(
          message.toolSteps.map((step) => step.status),
          ['ok', 'duplicate'],
        )
        assert.equal(rt.listEntries().length, 1)
        assert.equal(message.toolSteps[1].status, 'duplicate')
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '同一批次重复修改：第二次不重复写入',
    async run(rt) {
      const mock = await startMockSseServer([
        {
          calls: [
            { id: 'call_up_a', name: 'update_entry', arguments: { id: 'n-dup-update', content: '只改一次' } },
            { id: 'call_up_b', name: 'update_entry', arguments: { id: 'n-dup-update', content: '只改一次' } },
          ],
        },
        { content: '已修改。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([note('n-dup-update', '重复修改目标')])
        const message = await rt.sendPrompt('把「重复修改目标」的正文改成「只改一次」')
        assert.deepEqual(
          message.toolSteps.map((step) => step.status),
          ['ok', 'duplicate'],
        )
        assert.equal(rt.listEntries()[0].content, '只改一次')
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '目标不存在：分类为目标缺失且不产生写入',
    async run(rt) {
      const mock = await startMockSseServer([
        { calls: [{ id: 'call_missing', name: 'get_note', arguments: { id: 'missing-id' } }] },
        { content: '没有找到这条便签。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([note('n-exists', '存在')])
        const message = await rt.sendPrompt('帮我找一下这条不存在的便签')
        assert.equal(message.toolSteps[0].status, 'error')
        assert.equal(message.toolSteps[0].failure.category, 'target_not_found')
        assert.equal(rt.listEntries().length, 1)
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '部分成功中的未知写入：摘要单独列为待核对',
    async run(rt) {
      const mock = await startMockSseServer([
        {
          calls: [
            { id: 'call_ok', name: 'create_entry', arguments: { kind: 'todo', title: '确定成功' } },
            { id: 'call_unknown', name: 'create_entry', arguments: { kind: 'todo', title: '状态未知项' } },
          ],
        },
        { content: '处理完成。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        rt.injectCreateFailure((kind, input) => input.title === '状态未知项')
        const message = await rt.sendPrompt('创建待办「确定成功」和「状态未知项」')
        assert.equal(message.phase, 'partial')
        assert.deepEqual(
          message.toolSteps.map((step) => step.failure?.category ?? step.status),
          ['ok', 'execution_unknown'],
        )
        assert.equal(rt.listEntries().length, 1)
        assert.match(message.content, /写入状态待核对 1 项/)
        assert.match(message.content, /写入失败 0 项/)
      } finally {
        rt.clearCreateFailure()
        await mock.close()
      }
    },
  },
  {
    name: '写入状态未知后，依赖同一目标的后续修改被拦截',
    async run(rt) {
      const mock = await startMockSseServer([
        {
          calls: [
            { id: 'call_dep_1', name: 'update_entry', arguments: { id: 'n-dep', title: '第一次修改' } },
            { id: 'call_dep_2', name: 'update_entry', arguments: { id: 'n-dep', title: '第二次修改' } },
          ],
        },
        { content: '第一步结果需要核对。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([note('n-dep', '依赖目标')])
        rt.injectUpdateFailure((id) => id === 'n-dep')
        const message = await rt.sendPrompt('把「依赖目标」改成「第一次修改」，再改成「第二次修改」')
        assert.equal(message.toolSteps[0].failure.category, 'readback_failed')
        assert.equal(message.toolSteps[1].failure.category, 'dependency_failed')
        assert.equal(rt.listEntries()[0].title, '依赖目标', '依赖未确认时不得继续写入')
      } finally {
        rt.clearUpdateFailure()
        await mock.close()
      }
    },
  },
  {
    name: '查询失败不影响同批次中独立的新建',
    async run(rt) {
      const mock = await startMockSseServer([
        {
          calls: [
            { id: 'call_q_missing', name: 'get_note', arguments: { id: 'missing-q' } },
            { id: 'call_q_create', name: 'create_entry', arguments: { kind: 'note', title: '查询失败后新建' } },
          ],
        },
        { content: '已完成新建。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        const message = await rt.sendPrompt('先找一下不存在的便签，然后新建备忘「查询失败后新建」')
        assert.equal(message.toolSteps[0].failure.category, 'target_not_found')
        assert.equal(message.toolSteps[1].status, 'ok')
        assert.equal(message.phase, 'partial')
        assert.equal(rt.listEntries().length, 1)
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '删除取消后，再次确认也不会执行',
    async run(rt) {
      const mock = await startMockSseServer([
        { calls: [{ id: 'call_del_cancel', name: 'delete_entry', arguments: { id: 'n-cancel' } }] },
        { content: '已生成删除确认卡片。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([note('n-cancel', '取消删除目标')])
        const message = await rt.sendPrompt('删除「取消删除目标」')
        assert.equal((await rt.cancelDelete(message.id, 0)).ok, true)
        const afterCancel = await rt.confirmDelete(message.id, 0)
        assert.equal(afterCancel.ok, false)
        assert.equal(afterCancel.reason, 'cancelled')
        assert.equal(rt.listEntries().length, 1)
        assert.equal(rt.entries.getState().trash.length, 0)
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '重复确认同一删除卡片：只移入废纸篓一次',
    async run(rt) {
      const mock = await startMockSseServer([
        { calls: [{ id: 'call_del_twice', name: 'delete_entry', arguments: { id: 'n-del-twice' } }] },
        { content: '请确认删除。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([note('n-del-twice', '只删一次')])
        const message = await rt.sendPrompt('删除「只删一次」')
        const first = await rt.confirmDelete(message.id, 0)
        assert.equal(first.ok, true)
        const second = await rt.confirmDelete(message.id, 0)
        assert.equal(second.ok, false)
        assert.equal(second.reason, 'done')
        assert.equal(rt.listEntries().length, 0)
        assert.equal(rt.entries.getState().trash.length, 1, '不能产生第二条废纸篓记录')
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '重启后旧删除卡片失效，不能删除任何数据',
    async run(rt) {
      const mock = await startMockSseServer([
        { calls: [{ id: 'call_del_restart', name: 'delete_entry', arguments: { id: 'n-del-restart' } }] },
        { content: '请确认删除。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([note('n-del-restart', '重启后仍存在')])
        const message = await rt.sendPrompt('删除「重启后仍存在」')
        assert.equal(message.toolActions.length, 1)

        const restarted = await createRuntime()
        try {
          const restored = restarted.assistant
            .getState()
            .messages.find((item) => item.id === message.id)
          assert.ok(restored, '重启后应恢复历史消息')
          assert.deepEqual(restored.toolActionsInvalidated, [0])
          const result = await restarted.confirmDelete(restored.id, 0)
          assert.equal(result.ok, false)
          assert.equal(result.reason, 'not_found')
        } finally {
          await restarted.close()
        }
        assert.equal(rt.listEntries().length, 1)
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '重启恢复：pending 取消、running 写入待核对、成功保持',
    async run(rt) {
      await rt.reset({ baseUrl: 'http://127.0.0.1:1/v1', model: 'mock' })
      localStorage.setItem(
        'bianqian.assistant.v1',
        JSON.stringify({
          messages: [
            {
              id: 'restart-message',
              role: 'assistant',
              content: '正在执行',
              createdAt: Date.now(),
              status: 'streaming',
              toolTasks: [
                { callId: 't-pending', tool: 'create_entry', label: '新建 A', status: 'pending' },
                { callId: 't-running', tool: 'update_entry', label: '修改 B', status: 'running' },
                { callId: 't-success', tool: 'create_entry', label: '新建 C', status: 'success' },
              ],
            },
          ],
          contextEnabled: true,
          webSearch: false,
        }),
      )

      const restarted = await createRuntime()
      try {
        const message = restarted.assistant
          .getState()
          .messages.find((item) => item.id === 'restart-message')
        assert.ok(message)
        assert.equal(message.status, 'done')
        assert.deepEqual(
          message.toolTasks.map((task) => task.status),
          ['cancelled', 'execution_unknown', 'success'],
        )
      } finally {
        await restarted.close()
      }
    },
  },
  {
    name: '续办时未知写入不能重放：相同签名被跳过',
    async run(rt) {
      const updateArgs = { id: 'n-cont', title: '续办新标题' }
      const signature = `update_entry:${JSON.stringify(updateArgs)}`
      const mock = await startMockSseServer([
        {
          calls: [
            { id: 'call_cont_replay', name: 'update_entry', arguments: updateArgs },
          ],
        },
        { content: '没有重复修改。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([note('n-cont', '续办目标')])
        rt.setMessages([
          {
            id: 'u-cont',
            role: 'user',
            content: '把「续办目标」改成「续办新标题」',
            createdAt: 1,
            status: 'done',
          },
          {
            id: 'a-cont',
            role: 'assistant',
            content: '上一轮状态不确定。',
            createdAt: 2,
            status: 'done',
            toolSteps: [
              {
                callId: 'old-unknown',
                tool: 'update_entry',
                label: '修改「续办目标」',
                status: 'error',
                message: '错误：修改未能确认',
                failure: {
                  category: 'readback_failed',
                  writeState: 'unknown',
                  autoRetryAllowed: false,
                  requiresVerification: true,
                },
              },
              {
                callId: 'old-failed',
                tool: 'create_entry',
                label: '新建「另一个」',
                status: 'error',
                message: '错误：标题为空',
                failure: {
                  category: 'invalid_tool_arguments',
                  writeState: 'none',
                  autoRetryAllowed: true,
                  requiresVerification: false,
                },
              },
            ],
            writeAttempts: [
              { callId: 'old-unknown', tool: 'update_entry', signature },
              { callId: 'old-failed', tool: 'create_entry', signature: 'create_entry:{}' },
            ],
          },
        ])

        const message = await rt.sendPrompt('继续刚才没完成的任务，把「续办目标」改成「续办新标题」')
        assert.match(
          String(mock.requests[0].messages?.[0]?.content ?? ''),
          /状态待核对/,
        )
        assert.match(
          String(mock.requests[0].messages?.[0]?.content ?? ''),
          /不要重放相同创建/,
        )
        assert.equal(message.toolSteps[0].status, 'duplicate')
        assert.equal(rt.listEntries()[0].title, '续办目标')
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '写入成功后模型请求失败：写入保留且提示不回滚',
    async run(rt) {
      const mock = await startMockSseServer([
        {
          calls: [
            { id: 'call_then_model_fail', name: 'create_entry', arguments: { kind: 'note', title: '已写入再失败' } },
          ],
        },
        { status: 500, error: 'summary upstream failed' },
        { status: 500, error: 'summary upstream failed again' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        const message = await rt.sendPrompt('新建备忘「已写入再失败」')
        assert.equal(message.status, 'error')
        assert.equal(message.phase, 'partial')
        assert.equal(message.toolSteps[0].status, 'ok')
        assert.equal(rt.listEntries().length, 1)
        assert.match(message.content, /已完成的写入不会回滚/)
        assert.equal(message.writeAttempts.length, 1)
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '执行历史：只读检索记录真实步骤且不保存笔记正文',
    async run(rt) {
      const mock = await startMockSseServer([
        { calls: [{ id: 'call_hist_search', name: 'search_notes', arguments: { query: '复盘' } }] },
        { content: '找到一条项目复盘。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([note('n-hist-read', '项目复盘', '内部机密正文内容，不应进入执行历史')])
        const message = await rt.sendPrompt('帮我找一下项目复盘的便签')
        assert.equal(message.phase, 'done')
        await rt.flushHistory()
        const page = await rt.listHistory({})
        assert.equal(page.total, 1)
        const record = page.items[0]
        assert.equal(record.status, 'success')
        assert.equal(record.toolCount, 1)
        assert.equal(record.successCount, 1)
        assert.equal(record.failedCount, 0)
        assert.equal(record.messageId, message.id)
        assert.ok(record.finishedAt >= record.startedAt)
        const steps = await rt.getHistorySteps(record.id)
        assert.equal(steps.length, 1)
        assert.equal(steps[0].toolName, 'search_notes')
        assert.equal(steps[0].status, 'success')
        assert.equal(steps[0].ordinal, 0)
        assert.equal(steps[0].effect?.op, 'search')
        assert.match(steps[0].safeOutputSummary ?? '', /检索 1 条结果/)
        const serialized = JSON.stringify({ record, steps })
        assert.doesNotMatch(serialized, /内部机密正文内容/)
        assert.doesNotMatch(serialized, /sk-[A-Za-z0-9]{16,}|Bearer\s+[A-Za-z0-9._-]{8,}/)
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '执行历史：删除与清空历史不影响真实便签数据',
    async run(rt) {
      const mock = await startMockSseServer([
        {
          calls: [
            { id: 'call_hist_create', name: 'create_entry', arguments: { kind: 'note', title: '历史隔离验证' } },
          ],
        },
        { content: '已创建「历史隔离验证」。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        const message = await rt.sendPrompt('新建备忘「历史隔离验证」')
        assert.equal(message.phase, 'done')
        await rt.flushHistory()
        const before = rt.listEntries()
        assert.equal(before.length, 1)
        assert.equal(before[0].title, '历史隔离验证')

        const page = await rt.listHistory({})
        assert.equal(page.total, 1)
        const record = page.items[0]
        assert.equal(record.status, 'success')
        assert.equal(record.successCount, 1)
        const steps = await rt.getHistorySteps(record.id)
        assert.equal(steps[0].toolName, 'create_entry')
        assert.equal(steps[0].status, 'success')
        assert.equal(steps[0].targetReferences?.[0]?.entryId, before[0].id)
        assert.equal(steps[0].targetReferences?.[0]?.effect, 'created')

        await rt.deleteHistory(record.id)
        assert.equal((await rt.listHistory({})).total, 0)
        assert.deepEqual(rt.listEntries().map((entry) => entry.id), [before[0].id])

        await rt.createHistoryRecord({ ...record, id: 'hist-manual' })
        await rt.clearHistory()
        assert.equal((await rt.listHistory({})).total, 0)
        assert.deepEqual(rt.listEntries().map((entry) => entry.title), ['历史隔离验证'])
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '执行历史：模型总结失败不把已完成写入改为失败',
    async run(rt) {
      const mock = await startMockSseServer([
        {
          calls: [
            { id: 'call_hist_then_fail', name: 'create_entry', arguments: { kind: 'note', title: '写入后总结失败' } },
          ],
        },
        { status: 500, error: 'summary upstream failed' },
        { status: 500, error: 'summary upstream failed again' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        const message = await rt.sendPrompt('新建备忘「写入后总结失败」')
        assert.equal(message.status, 'error')
        assert.equal(message.phase, 'partial')
        await rt.flushHistory()
        const record = (await rt.listHistory({})).items[0]
        assert.equal(record.status, 'partial')
        assert.notEqual(record.status, 'failed')
        assert.equal(record.successCount, 1)
        assert.equal(record.failedCount, 0)
        assert.equal(record.failure?.category, 'model_request_failed')
        const steps = await rt.getHistorySteps(record.id)
        assert.equal(steps[0].status, 'success')
        assert.equal(rt.listEntries().length, 1)
        assert.equal(rt.listEntries()[0].title, '写入后总结失败')
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '执行历史：停止任务记录 cancelled 且不虚构已完成步骤',
    async run(rt) {
      const mock = await startMockSseServer([
        { delayMs: 5000, content: '这条回答会被停止。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        rt.assistant.getState().send('给我一段很长的回答')
        await rt.sleep(150)
        rt.assistant.getState().stop()
        await rt.sleep(80)
        await rt.flushHistory()
        const page = await rt.listHistory({})
        assert.equal(page.total, 1)
        const record = page.items[0]
        assert.equal(record.status, 'cancelled')
        assert.equal(record.toolCount, 0)
        assert.equal(record.successCount, 0)
        assert.equal(record.skippedCount, 0)
        assert.deepEqual(await rt.getHistorySteps(record.id), [])
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '执行历史：轮次上限时未执行调用只计入跳过',
    async run(rt) {
      const script = Array.from({ length: 9 }, (_, index) => ({
        calls: [{ id: `call_hist_limit_${index}`, name: 'list_todos', arguments: {} }],
      }))
      const mock = await startMockSseServer(script)
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        const message = await rt.sendPrompt('反复列待办直到上限', { timeoutMs: 30000 })
        assert.equal(message.toolLimitReached, true)
        await rt.flushHistory()
        const record = (await rt.listHistory({})).items[0]
        assert.equal(record.status, 'partial')
        assert.equal(record.toolCount, 9)
        assert.equal(record.successCount, 8)
        assert.equal(record.skippedCount, 1)
        const steps = await rt.getHistorySteps(record.id)
        assert.equal(steps.length, 8)
        assert.ok(steps.every((step) => step.status === 'success'))
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '执行历史：重启恢复中断写入为未知且不能授权新的写入',
    async run(rt) {
      const mock = await startMockSseServer([
        {
          calls: [
            { id: 'call_hist_force', name: 'update_entry', arguments: { id: 'n-hist-authz', title: '历史授权越权修改' } },
          ],
        },
        { content: '没有修改任何便签。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([note('n-hist-authz', '授权边界', '原始正文')])
        const startedAt = Date.now() - 60_000
        await rt.createHistoryRecord({
          id: 'hist-restart',
          conversationId: 'conv-restart',
          messageId: 'msg-restart',
          requestId: 'req-restart',
          title: '中断的写入任务',
          userInput: '新建备忘「中断写入」',
          status: 'running',
          phase: 'executing',
          startedAt,
          toolCount: 1,
          successCount: 0,
          failedCount: 0,
          skippedCount: 0,
          createdAt: startedAt,
          updatedAt: startedAt,
        })
        await rt.upsertHistoryStep({
          id: 'hist-restart:c1',
          executionId: 'hist-restart',
          ordinal: 0,
          toolCallId: 'c1',
          toolName: 'create_entry',
          label: '创建备忘「中断写入」',
          status: 'running',
          startedAt: startedAt + 100,
        })
        await rt.recoverHistory()
        const recovered = await rt.getHistory('hist-restart')
        assert.equal(recovered.status, 'execution_unknown')
        assert.equal(recovered.failure?.requiresVerification, true)
        assert.match(recovered.summary ?? '', /不会自动重放/)
        const recoveredSteps = await rt.getHistorySteps('hist-restart')
        assert.equal(recoveredSteps[0].status, 'execution_unknown')
        assert.equal(recoveredSteps[0].failure?.writeState, 'unknown')

        const message = await rt.sendPrompt('你好')
        assert.equal(message.toolSteps[0].blockedCode, 'permission_denied')
        assert.equal(rt.listEntries()[0].title, '授权边界')
        assert.equal(rt.listEntries()[0].content, '原始正文')
        assert.equal((await rt.getHistory('hist-restart'))?.status, 'execution_unknown')
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '删除确认历史：等待确认后取消，历史与业务同时收敛',
    async run(rt) {
      const mock = await startMockSseServer([
        {
          calls: [
            { id: 'call_hist_del_cancel', name: 'delete_entry', arguments: { id: 'n-hist-cancel' } },
          ],
        },
        { content: '已生成删除确认卡片。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([note('n-hist-cancel', '历史取消目标', '不删除')])
        const message = await rt.sendPrompt('删除「历史取消目标」')
        await rt.flushHistory()
        const record = (await rt.listHistory({})).items[0]
        const steps = await rt.getHistorySteps(record.id)
        assert.equal(record.status, 'needs_input')
        assert.equal(steps[0].status, 'needs_input')
        assert.equal(steps[0].proposalId, message.toolActions?.[0]?.proposalId)
        assert.equal(message.toolActions?.[0]?.executionId, record.id)
        assert.equal(message.toolActions?.[0]?.stepId, steps[0].id)

        assert.equal((await rt.cancelDelete(message.id, 0)).ok, true)
        const cancelled = await rt.getHistory(record.id)
        const cancelledSteps = await rt.getHistorySteps(record.id)
        assert.equal(cancelled.status, 'cancelled')
        assert.equal(cancelledSteps[0].status, 'cancelled')
        assert.equal(cancelledSteps[0].failure?.category, 'execution_cancelled')
        assert.equal(rt.listEntries().length, 1)
        assert.equal(rt.entries.getState().trash.length, 0)

        const again = await rt.confirmDelete(message.id, 0)
        assert.equal(again.ok, false)
        assert.equal(again.reason, 'cancelled')
        assert.equal((await rt.getHistory(record.id))?.status, 'cancelled')

        // 删除历史记录不会恢复旧提议，也不会触发业务删除
        await rt.deleteHistory(record.id)
        assert.equal((await rt.listHistory({})).total, 0)
        const afterHistoryDelete = await rt.confirmDelete(message.id, 0)
        assert.equal(afterHistoryDelete.ok, false)
        assert.equal(afterHistoryDelete.reason, 'cancelled')
        assert.equal(rt.listEntries().length, 1)
        assert.equal(rt.entries.getState().trash.length, 0)
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '删除确认历史：确认成功回写真实结果，重复点击不重复写',
    async run(rt) {
      const mock = await startMockSseServer([
        {
          calls: [
            { id: 'call_hist_del_ok', name: 'delete_entry', arguments: { id: 'n-hist-ok' } },
          ],
        },
        { content: '等待确认。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([note('n-hist-ok', '历史成功目标', '删除我')])
        const message = await rt.sendPrompt('删除「历史成功目标」')
        await rt.flushHistory()
        const record = (await rt.listHistory({})).items[0]
        assert.equal(record.status, 'needs_input')

        const first = await rt.confirmDelete(message.id, 0)
        assert.equal(first.ok, true)
        const after = await rt.getHistory(record.id)
        const steps = await rt.getHistorySteps(record.id)
        assert.equal(after.status, 'success')
        assert.equal(after.successCount, 1)
        assert.equal(steps.length, 1)
        assert.equal(steps[0].status, 'success')
        assert.match(steps[0].safeOutputSummary ?? '', /已移入废纸篓/)
        assert.equal(rt.listEntries().length, 0)
        assert.equal(rt.entries.getState().trash.length, 1)

        const second = await rt.confirmDelete(message.id, 0)
        assert.equal(second.ok, false)
        assert.equal(second.reason, 'done')
        const afterDuplicate = await rt.getHistory(record.id)
        assert.equal(afterDuplicate.status, 'success')
        assert.equal((await rt.getHistorySteps(record.id)).length, 1)
        assert.equal(rt.entries.getState().trash.length, 1)
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '删除确认历史：业务失败记录真实分类，重试成功后清除失败',
    async run(rt) {
      const mock = await startMockSseServer([
        {
          calls: [
            { id: 'call_hist_del_fail', name: 'delete_entry', arguments: { id: 'n-hist-fail' } },
          ],
        },
        { content: '等待确认。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([note('n-hist-fail', '历史失败目标', '先失败再成功')])
        const message = await rt.sendPrompt('删除「历史失败目标」')
        await rt.flushHistory()
        const record = (await rt.listHistory({})).items[0]

        rt.injectTrashFailureOnce()
        const failed = await rt.confirmDelete(message.id, 0)
        assert.equal(failed.ok, false)
        assert.equal(failed.reason, 'failed')
        const afterFailure = await rt.getHistory(record.id)
        const failureSteps = await rt.getHistorySteps(record.id)
        assert.equal(afterFailure.status, 'failed')
        assert.equal(afterFailure.failedCount, 1)
        assert.equal(failureSteps[0].status, 'failed')
        assert.equal(failureSteps[0].failure?.category, 'business_execution_failed')
        assert.equal(rt.listEntries().length, 1)

        rt.clearTrashFailure()
        const retry = await rt.confirmDelete(message.id, 0)
        assert.equal(retry.ok, true)
        const afterRetry = await rt.getHistory(record.id)
        const retrySteps = await rt.getHistorySteps(record.id)
        assert.equal(afterRetry.status, 'success')
        assert.equal(afterRetry.failedCount, 0)
        assert.equal(retrySteps[0].status, 'success')
        assert.equal(retrySteps[0].failure, undefined)
        assert.equal(rt.entries.getState().trash.length, 1)
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '删除确认历史：旧卡片重启失效后不执行删除，历史不写成功',
    async run(rt) {
      const mock = await startMockSseServer([
        {
          calls: [
            { id: 'call_hist_del_old', name: 'delete_entry', arguments: { id: 'n-hist-old' } },
          ],
        },
        { content: '等待确认。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([note('n-hist-old', '历史旧卡片', '重启后失效')])
        const message = await rt.sendPrompt('删除「历史旧卡片」')
        await rt.flushHistory()
        const record = (await rt.listHistory({})).items[0]
        rt.resetDeleteProposals()

        const result = await rt.confirmDelete(message.id, 0)
        assert.equal(result.ok, false)
        assert.equal(result.reason, 'not_found')
        const after = await rt.getHistory(record.id)
        assert.notEqual(after.status, 'success')
        assert.equal(after.successCount, 0)
        assert.equal(rt.listEntries().length, 1)
        assert.equal(rt.entries.getState().trash.length, 0)
      } finally {
        await mock.close()
      }
    },
  },
  {
    name: '删除确认历史：历史不存在时业务删除仍按原安全流程执行',
    async run(rt) {
      const mock = await startMockSseServer([
        {
          calls: [
            { id: 'call_hist_del_missing', name: 'delete_entry', arguments: { id: 'n-hist-missing' } },
          ],
        },
        { content: '等待确认。' },
      ])
      try {
        await rt.reset({ baseUrl: mock.url, model: 'mock' })
        await rt.seed([note('n-hist-missing', '历史缺失目标', '业务仍可删除')])
        const message = await rt.sendPrompt('删除「历史缺失目标」')
        await rt.flushHistory()
        const record = (await rt.listHistory({})).items[0]
        await rt.deleteHistory(record.id)

        const result = await rt.confirmDelete(message.id, 0)
        assert.equal(result.ok, true)
        assert.equal(rt.listEntries().length, 0)
        assert.equal(rt.entries.getState().trash.length, 1)
        assert.equal((await rt.listHistory({})).total, 0)
      } finally {
        await mock.close()
      }
    },
  },
]
async function main() {
  console.log('Mock SSE 集成测试（真实 store loop + 本地 SSE mock）')
  const runtime = await createRuntime()
  let passed = 0
  const failures = []
  try {
    for (const [index, scenario] of scenarios.entries()) {
      try {
        await scenario.run(runtime)
        passed += 1
        console.log(`ok ${index + 1} - ${scenario.name}`)
      } catch (error) {
        failures.push({ name: scenario.name, error })
        console.error(`not ok ${index + 1} - ${scenario.name}`)
        console.error(`  ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  } finally {
    await runtime.close()
  }
  console.log(`# pass ${passed}`)
  console.log(`# fail ${failures.length}`)
  if (failures.length > 0) process.exitCode = 1
}

await main()
