import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import dayjs from 'dayjs'
import {
  commitStagedCandidates,
  createAgentToolScope,
  executeToolWithEnv,
  type ToolOutcome,
} from '../src/services/agentToolExecutor'
import {
  MAX_TOOL_ROUNDS,
  buildRoundLimitNotice,
  degradeSystemContent,
  deriveFinalPhase,
  executeToolBatch,
  executionSummaryLines,
  shouldDegradeTools,
  stepStatusLabel,
  summarizeExecution,
} from '../src/services/agentExecution'
import {
  cancelDeleteProposal,
  confirmDeleteProposal,
  type DeleteConfirmationAccess,
} from '../src/services/deleteExecution'
import { AGENT_TOOL_PROMPT } from '../src/services/agentToolSchema'
import { confirmAlarmSelection } from '../src/services/alarmSelectionExecution'
import type { AiToolCall, AssistantToolStep } from '../src/types/ai'
import {
  BASE_TIME,
  alarm,
  call,
  createHarness,
  makeBase,
  makeReminder,
  seed,
  type TestHarness,
} from './helpers'

const fmt = (ms: number): string => dayjs(ms).format('YYYY-MM-DDTHH:mm')

let h!: TestHarness
beforeEach(async () => {
  h = await createHarness()
})

function runOne(toolCall: AiToolCall, scope = h.scope()): Promise<ToolOutcome> {
  return executeToolWithEnv(toolCall, h.env, scope)
}

function runBatch(calls: AiToolCall[], scope = h.scope()) {
  return executeToolBatch(
    calls,
    (toolCall) => runOne(toolCall, scope),
    scope.isStale,
    () => commitStagedCandidates(scope),
  )
}

function extractId(result: string): string {
  const match = /id: ([A-Za-z0-9-]+)/.exec(result)
  assert.ok(match, `结果里应包含真实 id：${result}`)
  return match[1]
}

function confirm(input: Omit<Parameters<typeof confirmDeleteProposal>[0], 'now'>) {
  return confirmDeleteProposal({ ...input, now: h.now() })
}

function deleteAccess(moves: string[] = []): DeleteConfirmationAccess {
  return {
    findEntry: (id: string) => h.entries().find((entry) => entry.id === id),
    moveToTrash: async (id: string) => {
      moves.push(id)
      await h.repo.moveToTrash(id)
      await h.refresh()
    },
    stillExists: (id: string) => h.entries().some((entry) => entry.id === id),
  }
}

/** 模拟 store 的工具循环：按轮执行，超过上限时给出确定性提示而不执行该轮 */
async function simulateRounds(script: AiToolCall[][], scope = h.scope()) {
  const steps: AssistantToolStep[] = []
  let rounds = 0
  for (const calls of script) {
    if (rounds >= MAX_TOOL_ROUNDS) {
      return {
        steps,
        rounds,
        limitReached: true,
        notice: buildRoundLimitNotice(steps, calls),
      }
    }
    rounds += 1
    const batch = await executeToolBatch(
      calls,
      (toolCall) => runOne(toolCall, scope),
      scope.isStale,
      () => commitStagedCandidates(scope),
    )
    steps.push(...batch.steps)
    if (batch.aborted) {
      return { steps, rounds, limitReached: false, notice: null, aborted: true }
    }
  }
  return { steps, rounds, limitReached: false, notice: null }
}

describe('单步任务', () => {
  it('单次查询：只读工具直接执行并返回真实 id', async () => {
    const seeded = await seed(h, makeBase('note', { title: '项目计划', content: '第一阶段' }))
    const batch = await runBatch([call('q1', 'search_notes', { query: '项目' })])
    assert.equal(batch.steps.length, 1)
    assert.equal(batch.steps[0].status, 'ok')
    assert.equal(batch.steps[0].effect?.op, 'search')
    assert.equal(batch.steps[0].effect?.count, 1)
    assert.ok(batch.steps[0].message.includes(seeded.id))
    assert.equal(batch.toolMessages[0].tool_call_id, 'q1')
    assert.equal(batch.hadError, false)
  })

  it('单次新建：回读真实标题，执行记录带 entryId', async () => {
    const batch = await runBatch([
      call('c1', 'create_entry', { kind: 'note', title: '会议纪要', content: '要点' }),
    ])
    assert.equal(batch.steps[0].status, 'ok')
    const created = h.entries()[0]
    assert.equal(batch.steps[0].effect?.op, 'create')
    assert.equal(batch.steps[0].effect?.entryId, created.id)
    assert.equal(batch.steps[0].effect?.title, '会议纪要')
    assert.deepEqual(executionSummaryLines(summarizeExecution(batch.steps)), [
      '新建 1 项：备忘「会议纪要」',
    ])
  })

  it('单次修改：真实生效后记录 op=update', async () => {
    const seeded = await seed(h, makeBase('note', { title: '旧标题' }))
    const batch = await runBatch([
      call('u1', 'update_entry', { id: seeded.id, title: '新标题' }),
    ])
    assert.equal(batch.steps[0].status, 'ok')
    assert.equal(batch.steps[0].effect?.op, 'update')
    assert.equal(batch.steps[0].effect?.entryId, seeded.id)
    assert.equal(h.entries()[0].title, '新标题')
  })

  it('单次删除：只生成确认卡片，执行记录标记待确认', async () => {
    const seeded = await seed(h, makeBase('note', { title: '待删' }))
    const batch = await runBatch([call('d1', 'delete_entry', { id: seeded.id })])
    assert.equal(batch.steps[0].status, 'confirm')
    assert.equal(batch.steps[0].effect?.op, 'delete')
    assert.equal(batch.confirmCards.length, 1)
    assert.equal(batch.confirmCards[0].targetId, seeded.id)
    assert.equal(h.entries().length, 1, '确认前不得删除')
    assert.deepEqual(executionSummaryLines(summarizeExecution(batch.steps)), [
      '等待确认删除 1 项：备忘「待删」',
    ])
  })
})

describe('同批次执行与跨轮次依赖', () => {
  it('同批次：独立调用按模型顺序执行，且不读取彼此结果', async () => {
    await seed(h, makeBase('note', { title: '项目开发记录', content: '完成登录模块' }))
    const batch = await runBatch([
      call('q1', 'search_notes', { query: '项目开发' }),
      call('c1', 'create_entry', {
        kind: 'todo',
        title: '后续待办',
        items: ['补测试', '写文档'],
      }),
    ])
    assert.deepEqual(
      batch.steps.map((step) => [step.tool, step.status]),
      [
        ['search_notes', 'ok'],
        ['create_entry', 'ok'],
      ],
    )
    assert.ok(batch.steps[0].message.includes('完成登录模块'))
    assert.equal(h.entries().filter((entry) => entry.kind === 'todo').length, 1)
    assert.equal(batch.toolMessages.length, 2)
    assert.deepEqual(
      batch.toolMessages.map((message) => message.tool_call_id),
      ['q1', 'c1'],
    )
  })

  it('跨轮次：查询返回真实 id，下一轮用该 id 修改同一条', async () => {
    await runBatch([
      call('seed', 'create_entry', { kind: 'todo', title: '项目复盘', items: ['梳理问题'] }),
    ])
    const query = await runBatch([call('q', 'search_notes', { query: '复盘' })])
    const id = extractId(query.steps[0].message)
    const update = await runBatch([
      call('u', 'update_entry', { id, append_content: '下一步：排期' }),
    ])
    assert.equal(update.steps[0].status, 'ok')
    const target = h.entries().find((entry) => entry.id === id)
    assert.ok(target)
    assert.match(target.content, /下一步：排期/)
    assert.equal(h.entries().length, 1, '没有新增多余条目')
  })

  it('连续新建多个待办：全部真实写入，不互相覆盖', async () => {
    const batch = await runBatch([
      call('t1', 'create_entry', { kind: 'todo', title: '待办一' }),
      call('t2', 'create_entry', { kind: 'todo', title: '待办二' }),
      call('t3', 'create_entry', { kind: 'todo', title: '待办三' }),
    ])
    assert.equal(batch.steps.every((step) => step.status === 'ok'), true)
    assert.deepEqual(
      h.entries().map((entry) => entry.title).sort(),
      ['待办一', '待办三', '待办二'],
    )
    assert.equal(summarizeExecution(batch.steps).created.length, 3)
  })

  it('多个工具严格按模型给出的顺序执行', async () => {
    const order: string[] = []
    const calls = [
      call('a', 'search_notes', { query: 'x' }),
      call('b', 'get_note', { id: 'note-1' }),
      call('c', 'create_entry', { kind: 'note', title: 'y' }),
      call('d', 'update_entry', { id: 'note-1', title: 'z' }),
    ]
    const batch = await executeToolBatch(
      calls,
      async (toolCall) => {
        order.push(toolCall.function.name)
        return { status: 'ok', result: `done:${toolCall.function.name}` }
      },
      () => false,
    )
    assert.deepEqual(order, [
      'search_notes',
      'get_note',
      'create_entry',
      'update_entry',
    ])
    assert.deepEqual(
      batch.toolMessages.map((message) => message.tool_call_id),
      ['a', 'b', 'c', 'd'],
    )
  })

  it('同批次内不能依赖前一个调用的结果：猜测 id 的修改直接失败', async () => {
    await seed(h, makeBase('note', { id: 'note-real', title: '项目开发记录' }))
    const batch = await runBatch([
      call('q', 'search_notes', { query: '项目开发' }),
      // 模型在同一批次里「猜」了一个 id，实际上它尚未拿到 search 的结果
      call('u', 'update_entry', { id: 'guessed-id', title: '改错了' }),
    ])
    assert.equal(batch.steps[0].status, 'ok')
    assert.equal(batch.steps[1].status, 'error')
    assert.match(batch.steps[1].message, /找不到/)
    assert.equal(h.entries()[0].title, '项目开发记录', '猜测 id 不应命中任何条目')
  })

  it('同批次内先新建再修改：新记录对后续调用可见，但 id 必须真实存在', async () => {
    const batch = await runBatch([
      call('c', 'create_entry', { kind: 'note', title: '新记录' }),
      call('u1', 'update_entry', { id: 'guess-1', title: '猜测修改' }),
    ])
    assert.equal(batch.steps[0].status, 'ok')
    assert.equal(batch.steps[1].status, 'error')
    assert.equal(h.entries().length, 1)
    assert.equal(h.entries()[0].title, '新记录')
  })

  it('每个结果只对应自己的 tool_call_id，不串结果', async () => {
    const batch = await executeToolBatch(
      [call('x1', 'list_todos'), call('x2', 'list_reminders')],
      async (toolCall) => ({ status: 'ok', result: `result:${toolCall.id}` }),
      () => false,
    )
    assert.deepEqual(
      batch.toolMessages.map((message) => [message.tool_call_id, message.content]),
      [
        ['x1', 'result:x1'],
        ['x2', 'result:x2'],
      ],
    )
  })

  it('前置查询失败后，依赖该结果的修改不会成功也不会写入', async () => {
    const first = await runBatch([call('q', 'get_note', { id: 'missing-note' })])
    assert.equal(first.steps[0].status, 'error')
    const second = await runBatch([
      call('u', 'update_entry', { id: 'missing-note', title: '凭空修改' }),
    ])
    assert.equal(second.steps[0].status, 'error')
    assert.equal(h.entries().length, 0, '没有任何写入')
    assert.equal(
      deriveFinalPhase({
        steps: [...first.steps, ...second.steps],
        needsInput: false,
        limitReached: false,
        stopped: false,
        requestFailed: false,
      }),
      'failed',
    )
  })
})

describe('失败、上限与部分完成', () => {
  it('部分失败：成功项保留，失败项如实记录，终态为部分完成', async () => {
    const batch = await runBatch([
      call('ok', 'create_entry', { kind: 'note', title: '正常' }),
      call('bad', 'create_entry', { kind: 'note', title: '   ' }),
    ])
    assert.equal(batch.hadError, true)
    assert.deepEqual(
      batch.steps.map((step) => step.status),
      ['ok', 'error'],
    )
    assert.equal(h.entries().length, 1, '失败项没有写库')
    assert.match(batch.steps[1].message, /标题不能为空/)
    const phase = deriveFinalPhase({
      steps: batch.steps,
      needsInput: batch.needsInput,
      limitReached: false,
      stopped: false,
      requestFailed: false,
    })
    assert.equal(phase, 'partial')
  })

  it('全部失败：终态为执行失败', async () => {
    const batch = await runBatch([call('bad', 'create_entry', { kind: 'nope', title: 'x' })])
    assert.equal(batch.hadError, true)
    assert.equal(
      deriveFinalPhase({
        steps: batch.steps,
        needsInput: false,
        limitReached: false,
        stopped: false,
        requestFailed: false,
      }),
      'failed',
    )
  })

  it('达到轮次上限：停止继续执行，并明确已完成与未执行', async () => {
    const script = Array.from({ length: MAX_TOOL_ROUNDS + 1 }, (_, index) => [
      call(`c${index}`, 'create_entry', { kind: 'note', title: `记录 ${index + 1}` }),
    ])
    const result = await simulateRounds(script)
    assert.equal(result.limitReached, true)
    assert.equal(result.rounds, MAX_TOOL_ROUNDS)
    assert.equal(h.entries().length, MAX_TOOL_ROUNDS, '上限外的调用不得执行')
    assert.ok(result.notice)
    assert.match(result.notice, /已达到本次回答的工具调用上限/)
    assert.match(result.notice, new RegExp(`已完成 ${MAX_TOOL_ROUNDS} 项`))
    assert.match(result.notice, /尚未执行的调用 1 项/)
    assert.match(result.notice, new RegExp(`记录 ${MAX_TOOL_ROUNDS + 1}`))
    assert.match(result.notice, /继续/)
    assert.equal(
      deriveFinalPhase({
        steps: result.steps,
        needsInput: false,
        limitReached: true,
        stopped: false,
        requestFailed: false,
      }),
      'partial',
    )
  })

  it('轮次上限提示不会把失败项算进已完成', async () => {
    const steps: AssistantToolStep[] = [
      {
        callId: 'a',
        tool: 'create_entry',
        label: '新建备忘「成功」',
        status: 'ok',
        message: 'ok',
        effect: { op: 'create', kind: 'note', entryId: 'n1', title: '成功' },
      },
      {
        callId: 'b',
        tool: 'update_entry',
        label: '修改便签 n2',
        status: 'error',
        message: '错误：找不到',
      },
    ]
    const notice = buildRoundLimitNotice(steps, [])
    assert.match(notice, /已完成 1 项/)
    assert.match(notice, /失败 1 项/)
    assert.match(notice, /尚未执行的调用：无/)
  })
})

describe('歧义与信息不足', () => {
  it('同名便签：搜索结果为模型提供确定性歧义提示', async () => {
    const first = await seed(h, makeBase('note', { title: '周报', content: '第一份' }))
    const second = await seed(h, makeBase('note', { title: '周报', content: '第二份' }))
    const batch = await runBatch([call('q', 'search_notes', { query: '周报' })])
    assert.equal(batch.steps[0].status, 'ok')
    assert.equal(batch.steps[0].effect?.count, 2)
    assert.match(batch.steps[0].message, /多条记录/)
    assert.match(batch.steps[0].message, /不要自行挑选/)
    assert.ok(batch.steps[0].message.includes(first.id))
    assert.ok(batch.steps[0].message.includes(second.id))
  })

  it('提醒有多个闹钟且未指定 alarm_id：不执行修改，标记等待补充', async () => {
    const seeded = await seed(
      h,
      makeReminder({
        alarms: [
          alarm('a1', BASE_TIME + 3600_000, 'daily'),
          alarm('a2', BASE_TIME + 7200_000, 'weekly'),
        ],
      }),
    )
    const batch = await runBatch([
      call('u', 'update_entry', {
        id: seeded.id,
        remind_at: fmt(BASE_TIME + 10800_000),
      }),
    ])
    assert.equal(batch.needsInput, true)
    assert.equal(batch.steps[0].needsInput, true)
    assert.equal(stepStatusLabel(batch.steps[0]), '等待补充')
    assert.match(batch.steps[0].message, /选择卡片/)
    assert.equal(batch.alarmSelections.length, 1)
    assert.deepEqual(
      batch.alarmSelections[0].candidates.map((candidate) => [
        candidate.alarmId,
        candidate.mode,
        candidate.remindAt,
        candidate.method,
      ]),
      [
        ['a1', 'daily', BASE_TIME + 3600_000, 'dialog'],
        ['a2', 'weekly', BASE_TIME + 7200_000, 'dialog'],
      ],
    )
    assert.equal(
      deriveFinalPhase({
        steps: batch.steps,
        needsInput: true,
        limitReached: false,
        stopped: false,
        requestFailed: false,
      }),
      'needs_input',
    )
    const unchanged = h.entries()[0]
    if (unchanged.kind !== 'reminder') throw new Error('kind changed')
    assert.deepEqual(
      unchanged.alarms.map((item) => item.remindAt),
      [BASE_TIME + 3600_000, BASE_TIME + 7200_000],
    )
  })

  it('模型指定真实 alarm_id 但无用户授权：不写入；用户选择后只改选中闹钟', async () => {
    const seeded = await seed(
      h,
      makeReminder({
        alarms: [
          alarm('a1', BASE_TIME + 3600_000, 'daily'),
          alarm('a2', BASE_TIME + 7200_000, 'weekly'),
        ],
      }),
    )
    const next = BASE_TIME + 10800_000
    // 模型自行从 get_note 拿到 a2 并指定：仍然只是「请求」，不是用户授权
    const batch = await runBatch([
      call('u', 'update_entry', {
        id: seeded.id,
        title: '喝水提醒（新）',
        remind_at: fmt(next),
        alarm_id: 'a2',
      }),
    ])
    assert.equal(batch.steps[0].status, 'error')
    assert.equal(batch.steps[0].needsInput, true)
    assert.equal(batch.alarmSelections.length, 1)
    const unchanged = h.entries()[0]
    if (unchanged.kind !== 'reminder') throw new Error('kind changed')
    assert.equal(unchanged.title, '提醒')
    assert.deepEqual(
      unchanged.alarms.map((item) => [item.id, item.remindAt, item.mode]),
      [
        ['a1', BASE_TIME + 3600_000, 'daily'],
        ['a2', BASE_TIME + 7200_000, 'weekly'],
      ],
    )

    const selection = batch.alarmSelections[0]
    const result = await confirmAlarmSelection({
      proposalId: selection.proposalId,
      entryId: seeded.id,
      alarmId: 'a2',
      env: h.env,
      now: h.now(),
    })
    assert.equal(result.ok, true)
    const updated = h.entries()[0]
    if (updated.kind !== 'reminder') throw new Error('kind changed')
    assert.equal(updated.title, '喝水提醒（新）')
    assert.deepEqual(
      updated.alarms.map((item) => [item.id, item.remindAt, item.mode, item.method]),
      [
        ['a1', BASE_TIME + 3600_000, 'daily', 'dialog'],
        ['a2', next, 'weekly', 'dialog'],
      ],
    )
    // 同一授权不能重复执行
    const again = await confirmAlarmSelection({
      proposalId: selection.proposalId,
      entryId: seeded.id,
      alarmId: 'a2',
      env: h.env,
      now: h.now(),
    })
    assert.equal(again.ok, false)
  })
})

describe('停止与幂等', () => {
  it('执行中途停止：后续工具不再执行，已完成项保留记录', async () => {
    const scopeRef = { stale: false }
    // 用闭包变量控制停止时机：第一条写入完成后立即视为停止
    h.onAdd = () => {
      scopeRef.stale = true
    }
    const scope = createAgentToolScope('req-stop', () => scopeRef.stale, undefined, {
      permission: 'write',
    })
    const batch = await runBatch(
      [
        call('a', 'create_entry', { kind: 'note', title: '已写入' }),
        call('b', 'create_entry', { kind: 'note', title: '未执行' }),
      ],
      scope,
    )
    assert.equal(batch.aborted, true)
    assert.equal(h.entries().length, 1)
    assert.equal(h.entries()[0].title, '已写入')
    assert.equal(batch.steps.length, 1, '已完成的写入仍要出现在执行记录里')
    assert.equal(batch.steps[0].status, 'ok')
    assert.equal(batch.confirmCards.length, 0)
    assert.equal(
      deriveFinalPhase({
        steps: batch.steps,
        needsInput: false,
        limitReached: false,
        stopped: true,
        requestFailed: false,
      }),
      'partial',
    )
  })

  it('重复调用不会重复写入，第二次标记为已跳过', async () => {
    const args = { kind: 'note', title: '唯一' }
    const batch = await runBatch([
      call('a', 'create_entry', args),
      call('b', 'create_entry', args),
    ])
    assert.equal(h.entries().length, 1)
    assert.deepEqual(
      batch.steps.map((step) => step.status),
      ['ok', 'duplicate'],
    )
    assert.equal(batch.hadError, false)
    assert.match(executionSummaryLines(summarizeExecution(batch.steps)).join('\n'), /已跳过重复调用/)
  })

  it('取消删除后不写入任何数据，提议也不能再执行', async () => {
    const seeded = await seed(h, makeBase('note', { title: '别删' }))
    const batch = await runBatch([call('d', 'delete_entry', { id: seeded.id })])
    const card = batch.confirmCards[0]
    cancelDeleteProposal(card.proposalId)
    const moves: string[] = []
    const result = await confirm({
      proposalId: card.proposalId,
      targetId: seeded.id,
      expectedKind: 'note',
      access: deleteAccess(moves),
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'cancelled')
    assert.deepEqual(moves, [])
    assert.equal(h.entries().length, 1)
  })
})

describe('不支持工具时的降级判定', () => {
  it('只在首次带工具、无任何输出且错误码匹配时降级', () => {
    assert.equal(
      shouldDegradeTools({
        toolsEnabled: true,
        alreadyDegraded: false,
        received: false,
        code: 'http_error',
      }),
      true,
    )
    assert.equal(
      shouldDegradeTools({
        toolsEnabled: true,
        alreadyDegraded: true,
        received: false,
        code: 'http_error',
      }),
      false,
      '只允许降级一次',
    )
    assert.equal(
      shouldDegradeTools({
        toolsEnabled: true,
        alreadyDegraded: false,
        received: true,
        code: 'http_error',
      }),
      false,
      '已有输出时不降级（避免重复回答）',
    )
    assert.equal(
      shouldDegradeTools({
        toolsEnabled: true,
        alreadyDegraded: false,
        received: false,
        code: 'unauthorized',
      }),
      false,
      '密钥错误不应被当作不支持工具',
    )
  })

  it('降级后的系统提示移除工具说明，并明确不能写数据', () => {
    const withTools = `回答规则：基于便签回答。\n\n${AGENT_TOOL_PROMPT}`
    const degraded = degradeSystemContent(withTools)
    assert.ok(degraded.includes('回答规则'))
    assert.ok(!degraded.includes('先判断任务类型'))
    assert.ok(degraded.includes('不能执行任何新增、修改或删除'))
    assert.ok(degraded.includes('不要声称已经创建、修改或删除'))
  })
})

describe('阶段推导', () => {
  it('无失败、无上限、无缺口时为已完成', () => {
    assert.equal(
      deriveFinalPhase({
        steps: [],
        needsInput: false,
        limitReached: false,
        stopped: false,
        requestFailed: false,
      }),
      'done',
    )
  })

  it('请求级错误但有成功步骤时标记部分完成', () => {
    assert.equal(
      deriveFinalPhase({
        steps: [
          {
            callId: 'a',
            tool: 'create_entry',
            label: '新建',
            status: 'ok',
            message: 'ok',
          },
        ],
        needsInput: false,
        limitReached: false,
        stopped: false,
        requestFailed: true,
      }),
      'partial',
    )
  })

  it('请求级错误且没有任何成功步骤时标记失败', () => {
    assert.equal(
      deriveFinalPhase({
        steps: [],
        needsInput: false,
        limitReached: false,
        stopped: false,
        requestFailed: true,
      }),
      'failed',
    )
  })

  it('用户主动停止标记为被中断的部分完成', () => {
    assert.equal(
      deriveFinalPhase({
        steps: [],
        needsInput: false,
        limitReached: false,
        stopped: true,
        requestFailed: false,
      }),
      'partial',
    )
  })
})
