import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  analyzeAssistantIntent,
  planAssistantTools,
  type AssistantIntent,
} from '../src/services/assistantIntent'
import { isReadOnlyTool } from '../src/services/agentExecution'
import {
  AGENT_TOOLS,
  AGENT_TOOL_PROMPT,
  NO_TOOL_PROMPT,
  READ_ONLY_TOOL_PROMPT,
} from '../src/services/agentToolSchema'

function analyze(text: string, hasSelectedEntry = false) {
  return analyzeAssistantIntent(text, { hasSelectedEntry })
}

function plan(text: string, options?: { contextEnabled?: boolean; hasSelectedEntry?: boolean }) {
  return planAssistantTools(
    analyze(text, options?.hasSelectedEntry ?? false),
    options?.contextEnabled ?? true,
  )
}

function expectIntent(text: string, intent: AssistantIntent) {
  assert.equal(analyze(text).intent, intent, text)
}

describe('assistantIntent 意图分类', () => {
  it('普通聊天归为 chat，且不提供工具', () => {
    const analysis = analyze('你好，今天有点累')
    assert.equal(analysis.intent, 'chat')
    assert.equal(analysis.reason, 'no_signal')
    const result = plan('你好，今天有点累')
    assert.equal(result.mode, 'none')
    assert.equal(result.tools, null)
    assert.equal(result.prompt, NO_TOOL_PROMPT)
  })

  it('功能咨询归为 suggest，使用只读范围', () => {
    expectIntent('你能做哪些便签操作？', 'suggest')
    const result = plan('你能做哪些便签操作？')
    assert.equal(result.mode, 'read')
    assert.equal(result.prompt, READ_ONLY_TOOL_PROMPT)
  })

  it('搜索便签归为 search，使用只读范围', () => {
    expectIntent('帮我找一下上周的会议纪要', 'search')
    assert.equal(plan('帮我找一下上周的会议纪要').mode, 'read')
  })

  it('新增便签归为 create，使用写入范围', () => {
    expectIntent('新建一条备忘：明天买牛奶', 'create')
    assert.equal(plan('新建一条备忘：明天买牛奶').mode, 'write')
  })

  it('新增待办归为 create', () => {
    expectIntent('帮我创建一个待办事项：整理会议纪要', 'create')
  })

  it('创建提醒归为 create', () => {
    expectIntent('提醒我明天下午三点开会', 'create')
  })

  it('修改便签归为 update', () => {
    expectIntent('把会议纪要的正文补充一下', 'update')
  })

  it('删除便签归为 delete', () => {
    expectIntent('删除上周那条临时备忘', 'delete')
  })

  it('建议与明确创建区分开', () => {
    expectIntent('帮我想几个待办事项', 'suggest')
    expectIntent('帮我创建几个待办事项', 'create')
    expectIntent('帮我想三个待办并添加到列表', 'create')
    assert.equal(plan('帮我想几个待办事项').mode, 'read')
    assert.equal(plan('帮我创建几个待办事项').mode, 'write')
    assert.equal(plan('帮我想三个待办并添加到列表').mode, 'write')
  })

  it('查询后创建归为 multi_step', () => {
    expectIntent('查询明天的待办，然后创建一条总结备忘', 'multi_step')
    assert.equal(plan('查询明天的待办，然后创建一条总结备忘').mode, 'write')
  })

  it('模糊表达归为 unknown 并要求澄清', () => {
    const analysis = analyze('帮我弄一下那个东西')
    assert.equal(analysis.intent, 'unknown')
    assert.equal(analysis.requiresClarification, true)
    assert.equal(plan('帮我弄一下那个东西').mode, 'write')
  })

  it('同名目标表达不产生目标 id', () => {
    const text = '把标题为「会议纪要」的便签改成已完成'
    const analysis = analyze(text)
    assert.equal(analysis.intent, 'update')
    assert.deepEqual(Object.keys(analysis).sort(), [
      'confidence',
      'intent',
      'reason',
      'requiresClarification',
    ])
    assert.ok(!('id' in analysis))
    assert.ok(!('targetId' in analysis))
  })

  it('否定表达不得识别为写入', () => {
    const create = analyze('不要创建提醒')
    assert.notEqual(create.intent, 'create')
    assert.equal(create.reason, 'negated_write')
    assert.equal(plan('不要创建提醒').mode, 'read')

    const search = analyze('先查一下待办，但不要修改')
    assert.equal(search.intent, 'search')
    assert.equal(plan('先查一下待办，但不要修改').mode, 'read')

    const cancel = analyze('算了，不要改了')
    assert.equal(cancel.reason, 'negated_write')
    assert.equal(cancel.intent, 'chat')
    assert.equal(plan('算了，不要改了').mode, 'read')

    // “分别”不是否定词，不能因为它包含“别”就降为只读
    const distributed = analyze('请分别新建三条便签')
    assert.equal(distributed.intent, 'create')
    assert.equal(plan('请分别新建三条便签').mode, 'write')
  })

  it('假设表达归为建议，不执行写入', () => {
    const hypothetical = analyze('如果创建一个提醒会怎样？')
    assert.equal(hypothetical.intent, 'suggest')
    assert.equal(hypothetical.reason, 'hypothetical')
    assert.equal(plan('如果创建一个提醒会怎样？').mode, 'read')

    const example = analyze('能不能举例说明如何删除便签？')
    assert.equal(example.intent, 'suggest')
    assert.equal(plan('能不能举例说明如何删除便签？').mode, 'read')
  })

  it('历史指代无法解析时降为只读并要求澄清', () => {
    const analysis = analyze('把刚才那个改一下')
    assert.equal(analysis.intent, 'update')
    assert.equal(analysis.reason, 'referent_ambiguous')
    assert.equal(analysis.requiresClarification, true)
    assert.equal(plan('把刚才那个改一下').mode, 'read')
  })

  it('当前选中条目可解析“这个”，允许写入', () => {
    const analysis = analyze('把这个改一下', true)
    assert.equal(analysis.intent, 'update')
    assert.equal(analysis.reason, 'referent_resolved')
    assert.equal(analysis.requiresClarification, false)
    assert.equal(plan('把这个改一下', { hasSelectedEntry: true }).mode, 'write')
  })

  it('无选中条目时“这个”不可解析，降为只读', () => {
    const analysis = analyze('把这个改一下', false)
    assert.equal(analysis.intent, 'update')
    assert.equal(analysis.reason, 'referent_ambiguous')
    assert.equal(plan('把这个改一下', { hasSelectedEntry: false }).mode, 'read')
  })

  it('显式标题删除中的“这条”是同位语，不降为只读', () => {
    const text = '删除「阶段7待删除」这条便签。'
    const ambiguous = analyzeAssistantIntent(text, { hasSelectedEntry: false })
    assert.equal(ambiguous.intent, 'delete')
    assert.equal(ambiguous.reason, 'referent_ambiguous')
    assert.equal(planAssistantTools(ambiguous, true).mode, 'read')

    const explicit = analyzeAssistantIntent(text, {
      hasSelectedEntry: false,
      hasExplicitTarget: true,
    })
    assert.equal(explicit.intent, 'delete')
    assert.equal(explicit.reason, 'explicit_write')
    assert.equal(explicit.requiresClarification, false)
    const result = planAssistantTools(explicit, true)
    assert.equal(result.mode, 'write')
    assert.ok(
      result.tools?.some((tool) => tool.function.name === 'delete_entry'),
      '显式删除必须下发 delete_entry',
    )
  })

  it('显式目标存在时不再把选中项当作本次写入目标', () => {
    const analysis = analyzeAssistantIntent('删除「阶段7待删除」这条便签。', {
      hasSelectedEntry: true,
      hasExplicitTarget: true,
    })
    assert.equal(analysis.reason, 'explicit_write')
    assert.equal(analysis.requiresClarification, false)
  })

  it('没有显式目标的“删除这条”仍要求澄清并保持只读', () => {
    const analysis = analyzeAssistantIntent('删除这条便签。', {
      hasSelectedEntry: false,
    })
    assert.equal(analysis.intent, 'delete')
    assert.equal(analysis.reason, 'referent_ambiguous')
    assert.equal(planAssistantTools(analysis, true).mode, 'read')
  })

  it('查询与写入混合归为 multi_step', () => {
    expectIntent('查找未完成事项，并为其中符合条件的事项添加提醒', 'multi_step')
    assert.equal(
      plan('查找未完成事项，并为其中符合条件的事项添加提醒').mode,
      'write',
    )
  })

  it('混合写入与否定时只统计未否定的操作', () => {
    const deleteOnly = analyze('先删除旧草稿，但不要修改会议纪要')
    assert.equal(deleteOnly.intent, 'delete')
    assert.equal(plan('先删除旧草稿，但不要修改会议纪要').mode, 'write')

    const updateOnly = analyze('不要删除，只修改会议纪要')
    assert.equal(updateOnly.intent, 'update')
    assert.equal(plan('不要删除，只修改会议纪要').mode, 'write')
  })

  it('unknown 保留全部工具以兼容多轮补充回答', () => {
    const result = plan('帮我处理一下')
    assert.equal(result.mode, 'write')
    assert.equal(result.prompt, AGENT_TOOL_PROMPT)
    assert.deepEqual(
      result.tools?.map((tool) => tool.function.name),
      AGENT_TOOLS.map((tool) => tool.function.name),
    )
  })
})

describe('assistantIntent 工具范围', () => {
  it('chat → none', () => {
    const result = plan('谢谢，今天先聊到这里')
    assert.equal(result.mode, 'none')
    assert.equal(result.tools, null)
  })

  it('suggest / search → read', () => {
    for (const text of ['帮我推荐几个整理方法', '我有哪些未完成的待办']) {
      const result = plan(text)
      assert.equal(result.mode, 'read', text)
      assert.ok(result.tools && result.tools.length > 0)
      assert.equal(result.tools.every((tool) => isReadOnlyTool(tool.function.name)), true)
      assert.equal(
        result.tools.some((tool) => !isReadOnlyTool(tool.function.name)),
        false,
      )
    }
  })

  it('明确否定 → read', () => {
    const result = plan('不要创建提醒')
    assert.equal(result.mode, 'read')
    assert.equal(result.prompt, READ_ONLY_TOOL_PROMPT)
  })

  it('create / update / delete / multi_step → write', () => {
    for (const text of [
      '创建一个待办',
      '修改会议纪要的标题',
      '删除旧草稿',
      '查询待办，然后创建一条备忘',
    ]) {
      const result = plan(text)
      assert.equal(result.mode, 'write', text)
      assert.equal(result.prompt, AGENT_TOOL_PROMPT)
      assert.deepEqual(
        result.tools?.map((tool) => tool.function.name),
        AGENT_TOOLS.map((tool) => tool.function.name),
      )
    }
  })

  it('unknown → write', () => {
    assert.equal(plan('帮我弄一下那个东西').mode, 'write')
  })

  it('未解析指代 → read', () => {
    assert.equal(plan('把刚才那个改一下').mode, 'read')
  })

  it('contextEnabled=false → none', () => {
    const result = plan('帮我创建一个待办', { contextEnabled: false })
    assert.equal(result.mode, 'none')
    assert.equal(result.tools, null)
    assert.equal(result.prompt, NO_TOOL_PROMPT)
  })

  it('只读计划不包含任何写入工具', () => {
    const result = plan('帮我找一下会议纪要')
    assert.deepEqual(
      result.tools?.map((tool) => tool.function.name),
      ['search_notes', 'list_todos', 'list_reminders', 'get_note'],
    )
  })
})

describe('assistantIntent 纯函数约束', () => {
  it('相同输入得到相同结果', () => {
    const first = analyze('查询明天的待办，然后创建一条总结备忘')
    const second = analyze('查询明天的待办，然后创建一条总结备忘')
    assert.deepEqual(first, second)
  })

  it('分析结果不包含目标 id、写入参数或授权字段', () => {
    const analysis = analyze('把标题为「会议纪要」的便签改成已完成')
    assert.deepEqual(Object.keys(analysis).sort(), [
      'confidence',
      'intent',
      'reason',
      'requiresClarification',
    ])
  })
})