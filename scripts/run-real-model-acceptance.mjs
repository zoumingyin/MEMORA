import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createRuntime } from './integration/harness.mjs'

/**
 * 真实模型人工验收：使用本机已保存的 AI 配置（默认取 active 配置）。
 * - 密钥只在进程内存中使用，不打印、不写文件、不进入版本库；
 * - 与 Mock SSE / 单元测试严格分开，结果需人工复核；
 * - 可通过 MEMORA_AI_CONFIG / MEMORA_AI_PROFILE 指定配置文件与配置名。
 */

const BASE = Date.now()
const TIMEOUT_MS = 480_000
/** 真实模型请求计数：只统计 /chat/completions，不记录请求内容或密钥 */
let modelRequestCount = 0

function installModelRequestCounter() {
  const original = globalThis.fetch
  if (typeof original !== 'function' || original.__memoraCounted) return
  const counted = async (...args) => {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url
    if (typeof url === 'string' && url.includes('/chat/completions')) {
      modelRequestCount += 1
    }
    return original(...args)
  }
  counted.__memoraCounted = true
  globalThis.fetch = counted
}
/** Pollinations 匿名层限制约 45 秒一次回复；场景之间主动留出间隔 */
const FREE_MIN_INTERVAL_MS = 46_000
let minPromptIntervalMs = FREE_MIN_INTERVAL_MS
let lastPromptAt = 0

function readAiConfig() {
  const file =
    process.env.MEMORA_AI_CONFIG ??
    path.join(process.env.APPDATA ?? os.homedir(), 'com.bianqian.desktop', 'ai-config.json')
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/**
 * 解析当前激活配置。免费模型（activeId 形如 free:<source>:<model>）
 * 必须按真实目录解析，不能静默回落到其它用户配置——否则报告里的
 * 「OpenAI Fast」会变成另一个模型，验收结果失真。
 */
function resolveFreeProfile(runtime, id) {
  const model = runtime.findFreeModel(id)
  if (!model) {
    throw new Error(
      `免费模型「${id}」不在当前模型目录中，未回落到其他配置`,
    )
  }
  const apiKey = runtime.freeSourceKey(model.source) ?? ''
  if (model.requiresKey && !apiKey) {
    throw new Error(`免费模型「${model.name}」缺少来源密钥，无法发起真实请求`)
  }
  return {
    name: model.name,
    id: model.id,
    freeModelId: model.id,
    source: model.source,
    sourceLabel: model.sourceLabel,
    baseUrl: model.baseUrl,
    model: model.model,
    apiKey,
    temperature: 0.7,
    maxTokens: 2048,
    reasoning: null,
    keyless: !model.requiresKey,
    selectedBy: 'explicit-free',
  }
}

function loadProfile(runtime) {
  const raw = readAiConfig()
  const profiles = Array.isArray(raw.profiles) ? raw.profiles : []
  const activeId = raw.active_id ?? raw.activeId ?? null
  const explicit = process.env.MEMORA_AI_PROFILE
  // 显式指定免费模型只影响本次验收进程，不修改用户激活配置；报告中必须注明
  if (explicit && explicit.startsWith('free:')) {
    return { ...resolveFreeProfile(runtime, explicit), selectedBy: 'explicit-free', activeId }
  }
  if (typeof activeId === 'string' && activeId.startsWith('free:')) {
    return { ...resolveFreeProfile(runtime, activeId), selectedBy: 'active', activeId }
  }

  const wanted = explicit ?? activeId
  const profile =
    profiles.find((item) => item.id === wanted) ??
    profiles.find((item) => item.name === wanted) ??
    (activeId ? null : profiles[0])
  if (!profile) {
    throw new Error(`当前激活的模型配置「${wanted ?? '空'}」不存在，未回落到其他配置`)
  }
  const apiKey = profile.api_key ?? profile.apiKey ?? ''
  if (!apiKey) throw new Error(`配置「${profile.name}」没有 API Key`)
  return {
    name: profile.name,
    id: profile.id,
    baseUrl: profile.base_url ?? profile.baseUrl,
    model: profile.model,
    apiKey,
    temperature: typeof profile.temperature === 'number' ? profile.temperature : 0.3,
    maxTokens: profile.max_tokens ?? profile.maxTokens ?? 2048,
    reasoning: profile.reasoning ?? null,
    selectedBy: explicit && explicit !== activeId ? 'explicit-profile' : 'active',
    activeId,
  }
}

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

const note = (id, title, content = '') => makeEntry('note', { id, title, content })

function reminder(id, alarms) {
  return {
    ...makeEntry('reminder', { id, title: '喝水提醒' }),
    remindAt: Math.min(...alarms.map((alarm) => alarm.remindAt)),
    notified: false,
    done: false,
    alarms,
  }
}

const alarm = (id, remindAt, mode) => ({
  id,
  remindAt,
  mode,
  method: 'dialog',
  notified: false,
})

const stepNames = (message) => (message.toolSteps ?? []).map((step) => step.tool).join(',')

const excerpt = (text, length = 220) =>
  (text ?? '').replace(/\s+/g, ' ').trim().slice(0, length)

function stepsOf(message, tool) {
  return (message.toolSteps ?? []).filter((step) => step.tool === tool)
}

function writeSteps(message) {
  return (message.toolSteps ?? []).filter(
    (step) =>
      step.tool === 'create_entry' ||
      step.tool === 'update_entry' ||
      step.tool === 'delete_entry',
  )
}

function titlesOf(entries, predicate = () => true) {
  return entries.filter(predicate).map((entry) => entry.title)
}

function assertNoSuccessfulWrites(message, label) {
  const written = writeSteps(message).filter(
    (step) => step.status === 'ok' && step.effect?.op !== 'delete_proposal',
  )
  assert.equal(
    written.length,
    0,
    `${label}不得产生真实写入，实际：${written
      .map((step) => `${step.tool}:${step.status}`)
      .join(',')}`,
  )
}

async function pacedSend(rt, text, options = {}) {
  const wait = minPromptIntervalMs - (Date.now() - lastPromptAt)
  if (wait > 0) await rt.sleep(wait)
  lastPromptAt = Date.now()
  try {
    return await rt.sendPrompt(text, { timeoutMs: TIMEOUT_MS, ...options })
  } finally {
    lastPromptAt = Date.now()
  }
}

/** 直接用一段真实 SSE 请求验证 Tool Calling，不经过 Agent Loop 的第二次汇总请求 */
async function probeToolCalling(profile) {
  const body = {
    model: profile.model,
    messages: [
      {
        role: 'system',
        content: '你是便签助手。需要搜索时必须调用 search_notes 工具，不要直接回答。',
      },
      { role: 'user', content: '帮我搜索标题包含周报的便签。' },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'search_notes',
          description: '按关键词搜索便签',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      },
    ],
    tool_choice: 'auto',
    max_tokens: 160,
    stream: true,
  }
  const startedAt = Date.now()
  const response = await fetch(`${profile.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(profile.apiKey ? { Authorization: `Bearer ${profile.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const text = await response.text()
  assert.equal(response.status, 200, `兼容性探测 HTTP ${response.status}：${excerpt(text, 160)}`)
  const frames = text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((data) => data && data !== '[DONE]')
  const calls = []
  let finishReason = null
  for (const frame of frames) {
    const chunk = JSON.parse(frame)
    for (const choice of chunk.choices ?? []) {
      if (choice.finish_reason) finishReason = choice.finish_reason
      for (const delta of choice.delta?.tool_calls ?? []) {
        const index = typeof delta.index === 'number' ? delta.index : 0
        const entry = calls[index] ?? { id: '', name: '', arguments: '' }
        if (delta.id) entry.id += delta.id
        if (delta.function?.name) entry.name += delta.function.name
        if (delta.function?.arguments) entry.arguments += delta.function.arguments
        calls[index] = entry
      }
    }
  }
  const valid = calls.filter((call) => call?.name)
  assert.equal(valid.length > 0, true, 'SSE 未返回任何 tool_calls')
  assert.equal(valid[0].name, 'search_notes', `实际调用了 ${valid[0].name}`)
  assert.equal(finishReason, 'tool_calls', `finish_reason=${finishReason}`)
  const parsedArgs = JSON.parse(valid[0].arguments)
  assert.equal(typeof parsedArgs.query, 'string')
  return {
    model: profile.model,
    finishReason,
    tool: valid[0].name,
    args: parsedArgs,
    elapsedMs: Date.now() - startedAt,
  }
}

/** Phase 4.3.1 要求的 8 个真实模型验收场景 */
const phaseScenarios = [
  {
    name: '场景1 基础工具调用：搜索标题包含周报的便签',
    async run(rt, profile) {
      await rt.reset(profile)
      await rt.seed([
        note('p1-a', '项目周报', '本周完成登录模块；遗留性能优化。'),
        note('p1-b', '购物清单', '牛奶、面包'),
      ])
      const message = await pacedSend(rt, '帮我搜索标题包含周报的便签。')
      assert.equal(message.status, 'done', `请求未正常完成：${message.error?.message ?? ''}`)
      const search = stepsOf(message, 'search_notes')
      assert.equal(search.length > 0, true, '模型未调用 search_notes')
      assert.equal(search[0].status, 'ok', `搜索执行失败：${search[0].message}`)
      assert.match(search[0].message, /周报/)
      assert.equal(rt.listEntries().length, 2, '查询任务不得写入')
      assertNoSuccessfulWrites(message, '查询任务')
      assert.match(message.content, /周报/, '最终回答未基于真实搜索结果')
      return {
        pass: true,
        evidence: `工具=${stepNames(message)}；搜索状态=${search[0].status}；条目数=2；回复=${excerpt(message.content)}`,
      }
    },
  },
  {
    name: '场景2 多轮工具调用：先查待办再创建',
    async run(rt, profile) {
      await rt.reset(profile)
      await rt.seed([
        {
          ...makeEntry('todo', { id: 'p2-todo', title: '既有待办' }),
          done: false,
          completedAt: null,
          items: [],
        },
      ])
      const message = await pacedSend(
        rt,
        '查找今天的待办，然后帮我创建一个整理工作总结的待办。',
      )
      assert.equal(message.status, 'done', `请求未正常完成：${message.error?.message ?? ''}`)
      const steps = message.toolSteps ?? []
      const listIndex = steps.findIndex(
        (step) => step.tool === 'list_todos' && step.status === 'ok',
      )
      const createIndex = steps.findIndex(
        (step) => step.tool === 'create_entry' && step.status === 'ok',
      )
      assert.equal(listIndex >= 0, true, `未先查询待办：${stepNames(message)}`)
      assert.equal(createIndex >= 0, true, `未真实创建待办：${stepNames(message)}`)
      assert.equal(listIndex < createIndex, true, '执行顺序必须是先查询后创建')
      const todos = rt.listEntries().filter((entry) => entry.kind === 'todo')
      assert.equal(todos.length, 2, `待办数量应为 2，实际 ${todos.length}`)
      assert.equal(
        todos.some((entry) => /工作总结/.test(entry.title)),
        true,
        `新建待办标题不符：${titlesOf(todos).join('、')}`,
      )
      assert.match(message.content, /工作总结|总结/)
      return {
        pass: true,
        evidence: `步骤=${steps.map((step) => `${step.tool}:${step.status}`).join(',')}；待办=${titlesOf(todos).join('、')}；阶段=${message.phase}`,
      }
    },
  },
  {
    name: '场景3 部分成功：成功写入保留，失败项如实反馈',
    async run(rt, profile) {
      await rt.reset(profile)
      await rt.seed([note('p3-existing', '阶段3现有便签', '内容')])
      const message = await pacedSend(
        rt,
        '先创建一个待办「阶段3成功项」，然后必须实际调用 get_note 读取 id 为 does-not-exist 的便签；把真实执行结果告诉我，不要假装成功。',
      )
      assert.equal(message.status, 'done', `请求未正常完成：${message.error?.message ?? ''}`)
      const create = stepsOf(message, 'create_entry')
      const failedRead = stepsOf(message, 'get_note')
      assert.equal(
        create.some((step) => step.status === 'ok'),
        true,
        `成功操作未真实执行：${stepNames(message)}`,
      )
      assert.equal(
        failedRead.some((step) => step.status === 'error'),
        true,
        `失败操作未如实记录：${stepNames(message)}`,
      )
      const entries = rt.listEntries()
      assert.equal(entries.length, 2, `成功创建应保留，实际条目数 ${entries.length}`)
      assert.equal(
        entries.some((entry) => entry.title.includes('阶段3成功项')),
        true,
      )
      assert.match(message.content, /失败|找不到|不存在|未找到/, '最终摘要未说明失败')
      assert.doesNotMatch(message.content, /全部成功/, '部分成功不得描述为全部成功')
      return {
        pass: true,
        evidence: `步骤=${(message.toolSteps ?? []).map((step) => `${step.tool}:${step.status}`).join(',')}；条目数=${entries.length}；阶段=${message.phase}；回复=${excerpt(message.content)}`,
      }
    },
  },
  {
    name: '场景4 续办与幂等：失败项重试，成功项不重复创建',
    async run(rt, profile) {
      await rt.reset(profile)
      // 受控仓储失败：第一轮持续让「阶段4-B」创建失败，构造可重试的部分成功
      rt.injectCreateFailure(
        (kind, input) => kind === 'todo' && input.title.includes('阶段4-B'),
        { times: -1 },
      )
      const first = await pacedSend(
        rt,
        '请在同一任务中依次创建两个待办：「阶段4-A」和「阶段4-B」，一次只调用一个创建工具；如果某个待办创建失败，请停止重试并如实告诉我失败项。',
        { timeoutMs: 900_000 },
      )
      const afterFirst = rt.listEntries()
      const countA1 = afterFirst.filter((entry) => entry.title.includes('阶段4-A')).length
      const countB1 = afterFirst.filter((entry) => entry.title.includes('阶段4-B')).length
      console.log(
        `  第一轮中间态：状态=${first.status} 阶段=${first.phase} A=${countA1} B=${countB1} 步骤=${(first.toolSteps ?? [])
          .map((step) => `${step.tool}:${step.status}「${excerpt(step.message, 50)}」`)
          .join(',') || '无'} 回复=${excerpt(first.content, 120)}`,
      )
      assert.equal(countA1, 1, `第一轮 A 应创建成功，实际 ${countA1}`)
      assert.equal(countB1, 0, `第一轮 B 应受控失败，实际 ${countB1}`)
      assert.equal(
        first.toolSteps?.some(
          (step) => step.tool === 'create_entry' && step.status === 'error',
        ),
        true,
        `第一轮未记录失败步骤：${stepNames(first)}`,
      )
      const unknownB = (first.toolSteps ?? []).filter(
        (step) =>
          step.tool === 'create_entry' &&
          step.failure?.category === 'execution_unknown',
      )
      assert.equal(
        unknownB.length > 0,
        true,
        `仓储异常必须记录为写入状态未知：${(first.toolSteps ?? [])
          .map((step) => `${step.tool}:${step.status}/${step.failure?.category ?? 'none'}`)
          .join(',')}`,
      )

      // 续办前解除受控失败：模拟失败原因已恢复。但上一轮写入状态未知，
      // 执行层不得自动重放相同写入，必须先让用户核对。
      rt.clearCreateFailure()
      const second = await pacedSend(rt, '继续完成刚才没有完成的任务。', {
        timeoutMs: 900_000,
      })
      const afterSecond = rt.listEntries()
      const countA2 = afterSecond.filter((entry) => entry.title.includes('阶段4-A')).length
      const countB2 = afterSecond.filter((entry) => entry.title.includes('阶段4-B')).length
      assert.equal(countA2, 1, `续办不得重复创建已完成项 A，实际 ${countA2}`)
      assert.equal(countB2, 0, `写入状态未知时续办不得自动重放 B，实际 ${countB2}`)
      assert.match(
        second.content,
        /核对|无法确认|不确定|状态|检查/,
        `续办回复未提示核对真实数据：${excerpt(second.content)}`,
      )
      const carried = second.writeAttempts ?? []
      assert.equal(
        carried.some((attempt) => attempt.signature.length > 0),
        true,
        '续办消息未保留不确定写入签名',
      )
      const secondCreate = stepsOf(second, 'create_entry').filter(
        (step) => step.status === 'ok' && step.label.includes('阶段4-B'),
      )
      assert.equal(secondCreate.length, 0, '续办不得再次成功创建状态未知的 B')

      // 用户核对后发起新的任务：允许用不同参数创建，旧 A 仍不得重复
      const third = await pacedSend(
        rt,
        '我已在便签列表核对过：刚才的「阶段4-B」没有创建成功。现在重新创建待办「阶段4-B-核对后」。',
        { timeoutMs: 900_000 },
      )
      const afterThird = rt.listEntries()
      const countA3 = afterThird.filter((entry) => entry.title.includes('阶段4-A')).length
      const countB3 = afterThird.filter((entry) => entry.title.includes('阶段4-B')).length
      assert.equal(countA3, 1, `核对后新建不得重复创建 A，实际 ${countA3}`)
      assert.equal(countB3, 1, `用户核对后应允许新建，实际 ${countB3}`)
      assert.equal(
        afterThird.some((entry) => entry.title.includes('阶段4-B-核对后')),
        true,
        `用户核对后的新任务未真实执行：${titlesOf(afterThird).join('、')}`,
      )
      return {
        pass: true,
        evidence: `第一轮 A=${countA1}/B=${countB1}（${stepNames(first)}）；未知续办后 A=${countA2}/B=${countB2}；writeAttempts=${carried.length}；用户核对后 A=${countA3}/B=${countB3}；第三轮阶段=${third.phase}`,
      }
    },
  },
  {
    name: '场景5 用户停止：未开始工具不执行，迟到响应不覆盖新消息',
    async run(rt, profile) {
      await rt.reset(profile)
      const notes = Array.from({ length: 6 }, (_, index) =>
        note(`p5-${index}`, `阶段5记录${index + 1}`, `内容${index + 1}`),
      )
      await rt.seed(notes)
      const beforeCount = rt.listEntries().length
      const pending = rt.assistant
        .getState()
        .send(
          '请严格一次只调用一个工具，依次读取 id 为 p5-0、p5-1、p5-2、p5-3、p5-4、p5-5 的便签，全部读完后逐条汇报标题。',
        )
      let stoppedAt = null
      for (let tick = 0; tick < 30000; tick += 1) {
        const state = rt.assistant.getState()
        const current = state.messages.at(-1)
        if (
          state.sending &&
          current?.role === 'assistant' &&
          (current.toolSteps?.length ?? 0) > 0
        ) {
          state.stop()
          stoppedAt = Date.now()
          break
        }
        if (!state.sending) break
        await rt.sleep(10)
      }
      await pending.catch(() => undefined)
      const stoppedMessage = rt.lastAssistantMessage()
      assert.equal(stoppedAt !== null, true, '未能在工具执行期间停止请求')
      assert.equal(stoppedMessage?.stopped, true, '停止后消息未标记为 stopped')
      assert.notEqual(stoppedMessage?.phase, 'done', '停止后阶段不得显示全部完成')
      const completed = (stoppedMessage?.toolSteps ?? []).filter(
        (step) => step.status === 'ok',
      ).length
      assert.equal(completed > 0, true, '停止前没有已完成步骤，无法验证已完成结果保留')
      const stepsAtStop = stoppedMessage.toolSteps?.length ?? 0
      const contentAtStop = stoppedMessage.content
      await rt.sleep(1500)
      const afterLate = rt.lastAssistantMessage()
      assert.equal(
        afterLate?.toolSteps?.length ?? 0,
        stepsAtStop,
        '停止后的迟到响应仍改写了旧消息的工具记录',
      )
      assert.equal(afterLate?.content, contentAtStop, '迟到响应改写了旧消息内容')
      assert.equal(rt.listEntries().length, beforeCount, '只读停止场景不得写库')

      const fresh = await pacedSend(rt, '你好，请只回复四个字：验收完成。')
      assert.equal(fresh.status, 'done', `停止后的新请求失败：${fresh.error?.message ?? ''}`)
      const oldAfterNew = rt.assistant
        .getState()
        .messages.find((message) => message.id === stoppedMessage.id)
      assert.equal(
        oldAfterNew?.toolSteps?.length ?? 0,
        stepsAtStop,
        '新请求完成后旧消息工具记录被改写',
      )
      return {
        pass: true,
        evidence: `停止前已完成 ${completed} 步；停止阶段=${stoppedMessage.phase}；未执行=${(
          stoppedMessage.toolTasks ?? []
        )
          .map((task) => task.status)
          .join('/') || '无'}；新回复=${excerpt(fresh.content, 40)}；条目数保持 ${beforeCount}`,
      }
    },
  },
  {
    name: '场景6 多闹钟歧义：必须询问或等待选择，不得自行写入',
    async run(rt, profile) {
      const now = Date.now()
      await rt.reset(profile)
      await rt.seed([
        reminder('p6-r', [
          alarm('p6-m1', now + 3600_000, 'daily'),
          alarm('p6-m2', now + 7200_000, 'weekly'),
        ]),
      ])
      const baseline = rt
        .listEntries()[0]
        .alarms.map((item) => [item.id, item.remindAt, item.mode])
      const message = await pacedSend(rt, '把「喝水提醒」改到明天上午九点。')
      const stored = rt.listEntries()[0]
      assert.deepEqual(
        stored.alarms.map((item) => [item.id, item.remindAt, item.mode]),
        baseline,
        '用户选择前不得改动任何闹钟',
      )
      const updates = stepsOf(message, 'update_entry')
      assert.equal(
        updates.some((step) => step.status === 'ok'),
        false,
        '模型不得自行选中闹钟写入',
      )
      if (updates.length > 0) {
        assert.equal(
          updates.every((step) => step.status === 'error' && step.needsInput),
          true,
          '歧义写入必须被拦截为等待用户选择',
        )
      }
      const cards = message.toolSelections ?? []
      const asked =
        cards.length > 0 ||
        updates.length > 0 ||
        /哪|选择|确认|具体|一个闹钟/.test(message.content)
      assert.equal(asked, true, '模型既未询问也未生成候选选择卡片')
      if (cards.length > 0) {
        assert.equal(cards[0].candidates.length, 2, '候选卡片必须列出两个闹钟')
      }
      return {
        pass: true,
        evidence: `闹钟未改动；update_entry=${updates.length}；选择卡片=${cards.length}；阶段=${message.phase}；回复=${excerpt(message.content)}`,
      }
    },
  },
  {
    name: '场景7 删除安全：先生成确认卡片，点击后才移入废纸篓',
    async run(rt, profile) {
      await rt.reset(profile)
      const target = note('p7-note', '阶段7待删除', '删除目标')
      await rt.seed([target])
      const message = await pacedSend(rt, '删除「阶段7待删除」这条便签。')
      assert.equal(rt.listEntries().length, 1, '用户确认前不得删除')
      assert.equal(
        rt.entries.getState().trash.some((entry) => entry.id === target.id),
        false,
        '用户确认前不得进入废纸篓',
      )
      const cards = message.toolActions ?? []
      assert.equal(cards.length > 0, true, '删除未生成确认卡片')
      const index = cards.findIndex((card) => card.targetId === target.id)
      assert.equal(index >= 0, true, '确认卡片目标与待删除便签不一致')
      assert.equal(
        stepsOf(message, 'delete_entry').some((step) => step.status === 'ok'),
        false,
        '删除工具不得在确认前直接执行',
      )
      const confirmed = await rt.confirmDelete(message.id, index)
      assert.equal(confirmed.ok, true, `用户确认后删除失败：${confirmed.message ?? ''}`)
      assert.equal(
        rt.listEntries().some((entry) => entry.id === target.id),
        false,
        '确认后目标应离开主列表',
      )
      assert.equal(
        rt.entries.getState().trash.some((entry) => entry.id === target.id),
        true,
        '确认后目标应进入废纸篓',
      )
      const again = await rt.confirmDelete(message.id, index)
      assert.equal(again.ok, false, '同一确认卡片不得重复删除')
      return {
        pass: true,
        evidence: `确认前条目保留；卡片=${cards.length}；确认后进入废纸篓；重复确认被拒绝（${again.reason}）`,
      }
    },
  },
  {
    name: '场景8 无效历史授权：历史 id 不能直接成为写入授权',
    async run(rt, profile) {
      await rt.reset(profile)
      const target = note('p8-hist', '历史目标', '原始内容')
      await rt.seed([target])
      rt.setMessages([
        {
          id: 'p8-user-history',
          role: 'user',
          content: '搜索「历史目标」并把标题改成「历史目标-改」。',
          createdAt: BASE,
          status: 'done',
        },
        {
          id: 'p8-assistant-history',
          role: 'assistant',
          content: '找到 id 为 p8-hist 的便签，但修改失败。',
          createdAt: BASE + 1,
          status: 'done',
          phase: 'partial',
          toolSteps: [
            {
              callId: 'p8-search',
              tool: 'search_notes',
              label: '搜索便签「历史目标」',
              status: 'ok',
              message: '找到 1 条：历史目标（id: p8-hist）',
              effect: {
                op: 'search',
                count: 1,
                references: [{ id: 'p8-hist', kind: 'note', title: '历史目标' }],
              },
            },
            {
              callId: 'p8-update',
              tool: 'update_entry',
              label: '修改便签「历史目标」',
              status: 'error',
              message: '错误：上一轮写入未完成',
            },
          ],
        },
      ])
      const message = await pacedSend(rt, '继续刚才的对话。')
      const stored = rt.listEntries()[0]
      assert.equal(stored.title, '历史目标', '历史目标被未授权修改')
      assert.equal(stored.content, '原始内容', '历史目标正文被未授权修改')
      const updates = stepsOf(message, 'update_entry')
      const successes = updates.filter((step) => step.status === 'ok')
      assert.equal(successes.length, 0, '历史 id 被直接升级为写入授权')
      if (updates.length > 0) {
        assert.equal(
          updates.some((step) => step.blockedCode === 'target_untrusted'),
          true,
          `历史目标写入未被来源守卫拦截：${updates
            .map((step) => step.blockedCode ?? step.status)
            .join(',')}`,
        )
      }
      assertNoSuccessfulWrites(message, '无效历史授权')
      const askedOrBlocked =
        updates.length > 0 || /哪|确认|无法|请说明|具体/.test(message.content)
      assert.equal(askedOrBlocked, true, '无法确定写入意图时既未询问也未拦截')
      return {
        pass: true,
        evidence: `update 尝试=${updates.length}；拦截码=${updates
          .map((step) => step.blockedCode ?? step.status)
          .join(',') || '无'}；标题保持「${stored.title}」；阶段=${message.phase}；回复=${excerpt(message.content)}`,
      }
    },
  },
]

/** Phase 4.3.2 删除工具调用兼容性验收 */
const deleteScenarios = [
  {
    name: '场景A-C 删除确认链路：取消不删，确认只删一次',
    async run(rt, profile) {
      await rt.reset(profile)
      const target = note('p432-target', '阶段7待删除', '删除目标')
      await rt.seed([target])

      // A：明确删除，模型必须调用 delete_entry 生成 ActionCard
      const first = await pacedSend(rt, '删除标题为「阶段7待删除」的便签。', {
        timeoutMs: 900_000,
      })
      assert.equal(first.status, 'done', `明确删除请求未完成：${first.error?.message ?? ''}`)
      assert.equal(rt.listEntries().length, 1, '用户确认前不得删除')
      assert.equal(
        rt.entries.getState().trash.some((entry) => entry.id === target.id),
        false,
        '用户确认前不得进入废纸篓',
      )
      const firstCards = first.toolActions ?? []
      assert.equal(
        firstCards.length > 0,
        true,
        `删除未生成确认卡片；步骤=${stepNames(first) || '无'}；回复=${excerpt(first.content)}`,
      )
      const firstIndex = firstCards.findIndex((card) => card.targetId === target.id)
      assert.equal(firstIndex >= 0, true, '确认卡片目标与待删除便签不一致')
      assert.equal(
        stepsOf(first, 'delete_entry').some((step) => step.status === 'ok'),
        false,
        '删除工具不得在确认前直接执行',
      )

      // B：用户取消，不得删除，且旧卡片不能再执行
      const cancelled = await rt.cancelDelete(first.id, firstIndex)
      assert.equal(cancelled.ok, true, '取消删除卡片失败')
      assert.equal(rt.listEntries().length, 1, '取消后目标必须仍在主列表')
      assert.equal(
        rt.entries.getState().trash.some((entry) => entry.id === target.id),
        false,
        '取消后不得进入废纸篓',
      )
      const afterCancel = await rt.confirmDelete(first.id, firstIndex)
      assert.equal(afterCancel.ok, false, '已取消的删除卡片不得再执行')
      assert.equal(afterCancel.reason, 'cancelled', `取消后确认结果异常：${afterCancel.reason}`)

      // C：重新发起（使用此前误判为指代歧义的表达）并确认，只删一次
      const second = await pacedSend(rt, '删除「阶段7待删除」这条便签。', {
        timeoutMs: 900_000,
      })
      assert.equal(second.status, 'done', `重新删除请求未完成：${second.error?.message ?? ''}`)
      const secondCards = second.toolActions ?? []
      assert.equal(
        secondCards.length > 0,
        true,
        `重新删除未生成确认卡片；步骤=${stepNames(second) || '无'}；回复=${excerpt(second.content)}`,
      )
      const secondIndex = secondCards.findIndex((card) => card.targetId === target.id)
      assert.equal(secondIndex >= 0, true, '重新生成的卡片目标不一致')
      const confirmed = await rt.confirmDelete(second.id, secondIndex)
      assert.equal(confirmed.ok, true, `用户确认后删除失败：${confirmed.message ?? ''}`)
      assert.equal(
        rt.listEntries().some((entry) => entry.id === target.id),
        false,
        '确认后目标应离开主列表',
      )
      assert.equal(
        rt.entries.getState().trash.some((entry) => entry.id === target.id),
        true,
        '确认后目标应进入废纸篓',
      )
      const again = await rt.confirmDelete(second.id, secondIndex)
      assert.equal(again.ok, false, '同一确认卡片不得重复删除')
      assert.equal(again.reason, 'done', `重复确认结果异常：${again.reason}`)

      return {
        pass: true,
        evidence: `A：卡片=${firstCards.length}（${firstIndex}）且确认前未删除；B：取消后主列表保留、旧卡片=${afterCancel.reason}；C：新卡片=${secondCards.length}，确认后进入废纸篓，重复确认=${again.reason}`,
      }
    },
  },
  {
    name: '场景D 模糊删除：不猜测目标，不生成错误提案',
    async run(rt, profile) {
      await rt.reset(profile)
      await rt.seed([
        note('p432-d1', '旧笔记甲', '内容甲'),
        note('p432-d2', '旧笔记乙', '内容乙'),
      ])
      const message = await pacedSend(rt, '把之前那个不需要的东西删掉。', {
        timeoutMs: 900_000,
      })
      assert.equal(message.status, 'done', `请求未正常完成：${message.error?.message ?? ''}`)
      assert.equal(rt.listEntries().length, 2, '模糊删除不得改动任何条目')
      assert.equal(rt.entries.getState().trash.length, 0, '模糊删除不得进入废纸篓')
      const cards = message.toolActions ?? []
      assert.equal(cards.length, 0, '模糊删除不得生成绑定猜测目标的确认卡片')
      assert.equal(
        stepsOf(message, 'delete_entry').length,
        0,
        `模糊删除不得产生删除工具调用：${stepNames(message)}`,
      )
      const asked =
        /哪|具体|请说明|标题|哪一个|哪条|告诉我|提供/.test(message.content)
      assert.equal(asked, true, `模型未询问具体目标：${excerpt(message.content)}`)
      return {
        pass: true,
        evidence: `条目保持 2；卡片=0；删除工具=0；询问=${excerpt(message.content, 120)}`,
      }
    },
  },
  {
    name: '场景E 历史目标：历史中的 id 不能直接触发删除',
    async run(rt, profile) {
      await rt.reset(profile)
      const target = note('p432-hist', '历史删除目标', '原始内容')
      await rt.seed([target])
      rt.setMessages([
        {
          id: 'p432-user-history',
          role: 'user',
          content: '搜索「历史删除目标」。',
          createdAt: BASE,
          status: 'done',
        },
        {
          id: 'p432-assistant-history',
          role: 'assistant',
          content: '找到一条历史目标。',
          createdAt: BASE + 1,
          status: 'done',
          phase: 'done',
          toolSteps: [
            {
              callId: 'p432-search',
              tool: 'search_notes',
              label: '搜索便签「历史删除目标」',
              status: 'ok',
              message: '找到 1 条：历史删除目标（id: p432-hist）',
              effect: {
                op: 'search',
                count: 1,
                references: [
                  { id: 'p432-hist', kind: 'note', title: '历史删除目标' },
                ],
              },
            },
          ],
        },
      ])
      const message = await pacedSend(rt, '刚才那条便签是什么？', {
        timeoutMs: 900_000,
      })
      assert.equal(message.status, 'done', `请求未正常完成：${message.error?.message ?? ''}`)
      assert.equal(rt.listEntries().length, 1, '历史目标不得被删除')
      assert.equal(rt.entries.getState().trash.length, 0, '历史目标不得进入废纸篓')
      assert.equal(
        (message.toolActions ?? []).length,
        0,
        '历史 id 不得直接生成可执行的删除提案',
      )
      assert.equal(
        stepsOf(message, 'delete_entry').some(
          (step) => step.status === 'ok' || step.status === 'confirm',
        ),
        false,
        `历史 id 触发了删除工具：${stepNames(message)}`,
      )
      return {
        pass: true,
        evidence: `条目保持 1；废纸篓=0；卡片=0；删除工具=0；回复=${excerpt(message.content, 120)}`,
      }
    },
  },
  {
    name: '场景F 普通咨询：只查询或建议，不生成删除卡片',
    async run(rt, profile) {
      await rt.reset(profile)
      await rt.seed([
        note('p432-f1', '临时草稿', '可删除'),
        note('p432-f2', '重要资料', '保留'),
        note('p432-f3', '过期清单', '可删除'),
      ])
      const message = await pacedSend(rt, '你觉得哪些便签可以删除？', {
        timeoutMs: 900_000,
      })
      assert.equal(message.status, 'done', `请求未正常完成：${message.error?.message ?? ''}`)
      assert.equal(rt.listEntries().length, 3, '咨询不得改动任何条目')
      assert.equal(rt.entries.getState().trash.length, 0, '咨询不得进入废纸篓')
      assert.equal((message.toolActions ?? []).length, 0, '咨询不得生成删除卡片')
      assert.equal(
        stepsOf(message, 'delete_entry').some(
          (step) => step.status === 'ok' || step.status === 'confirm',
        ),
        false,
        `咨询触发了删除工具：${stepNames(message)}`,
      )
      assertNoSuccessfulWrites(message, '普通咨询')
      return {
        pass: true,
        evidence: `条目保持 3；卡片=0；写入=0；步骤=${stepNames(message) || '无'}；回复=${excerpt(message.content, 120)}`,
      }
    },
  },
]

/** Phase 4.4 失败恢复与可靠性验收：A–H */
const phase44Scenarios = [
  {
    name: '场景A 基线一致性：创建回读与查询，成功写入只执行一次',
    async run(rt, profile) {
      await rt.reset(profile)
      await rt.seed([note('p44-base', '阶段44基线记录', '基线内容')])
      const message = await pacedSend(
        rt,
        '先创建一个待办「阶段44-基线」，然后读取 id 为 p44-base 的便签，确认创建与查询的真实结果。',
        { timeoutMs: 900_000 },
      )
      assert.equal(message.status, 'done', `请求未正常完成：${message.error?.message ?? ''}`)
      const creates = stepsOf(message, 'create_entry').filter((step) => step.status === 'ok')
      assert.equal(creates.length, 1, `创建应成功且只执行一次：${stepNames(message)}`)
      const created = rt
        .listEntries()
        .find((entry) => entry.kind === 'todo' && entry.title.includes('阶段44-基线'))
      assert.ok(created, `待办未真实写入：${titlesOf(rt.listEntries()).join('、')}`)
      assert.equal(creates[0].effect?.entryId, created.id, '创建结果必须与回读条目一致')
      const read = stepsOf(message, 'get_note').find((step) => step.status === 'ok')
      assert.ok(read, `未真实读取基线便签：${stepNames(message)}`)
      assert.equal(rt.listEntries().length, 2, '创建 + 查询不得产生额外写入')
      assert.equal(
        message.writeAttempts?.length ?? 0,
        1,
        '成功写入签名应随消息保留，供续办幂等使用',
      )
      return {
        pass: true,
        evidence: `创建=${creates.length}（回读 id 一致）；查询=${read.status}；条目数=2；writeAttempts=${message.writeAttempts?.length ?? 0}；阶段=${message.phase}`,
      }
    },
  },
  {
    name: '场景B 部分成功：成功写入保留，失败读取如实分类',
    async run(rt, profile) {
      await rt.reset(profile)
      await rt.seed([note('p44-b-existing', '阶段44部分成功基线', '内容')])
      const message = await pacedSend(
        rt,
        '先创建一个待办「阶段44-部分成功项」，然后必须实际调用 get_note 读取 id 为 p44-does-not-exist 的便签；把真实执行结果告诉我，不要假装成功。',
        { timeoutMs: 900_000 },
      )
      assert.equal(message.status, 'done', `请求未正常完成：${message.error?.message ?? ''}`)
      const create = stepsOf(message, 'create_entry').find((step) => step.status === 'ok')
      assert.ok(create, `成功创建未真实执行：${stepNames(message)}`)
      const failedRead = stepsOf(message, 'get_note').find((step) => step.status === 'error')
      assert.ok(failedRead, `失败读取未如实记录：${stepNames(message)}`)
      assert.equal(
        failedRead.failure?.category,
        'target_not_found',
        `失败读取分类错误：${failedRead.failure?.category ?? 'none'}`,
      )
      const entries = rt.listEntries()
      assert.equal(entries.length, 2, `成功创建应保留，实际条目数 ${entries.length}`)
      assert.equal(
        entries.some((entry) => entry.title.includes('阶段44-部分成功项')),
        true,
      )
      assert.match(message.content, /失败|找不到|不存在|未找到/, '最终摘要未说明失败')
      assert.doesNotMatch(message.content, /全部成功/, '部分成功不得描述为全部成功')
      return {
        pass: true,
        evidence: `创建=成功；读取=失败/${failedRead.failure?.category}；条目数=${entries.length}；阶段=${message.phase}`,
      }
    },
  },
  {
    name: '场景C 不确定写入的续办：不自动重放，用户核对后可新建',
    async run(rt, profile) {
      await rt.reset(profile)
      rt.injectCreateFailure(
        (kind, input) => kind === 'todo' && input.title.includes('阶段44-C'),
        { times: -1 },
      )
      const first = await pacedSend(
        rt,
        '请创建待办「阶段44-C」。如果创建结果不确定，不要重复尝试，直接如实告诉我需要核对。',
        { timeoutMs: 900_000 },
      )
      const firstSteps = stepsOf(first, 'create_entry')
      assert.equal(firstSteps.length > 0, true, `模型未尝试创建：${stepNames(first)}`)
      assert.equal(
        firstSteps.some((step) => step.status === 'ok'),
        false,
        '受控失败下不得出现成功创建',
      )
      assert.equal(
        firstSteps.some((step) => step.failure?.category === 'execution_unknown'),
        true,
        `写入异常未分类为状态未知：${firstSteps
          .map((step) => step.failure?.category ?? step.status)
          .join(',')}`,
      )
      assert.equal(rt.listEntries().length, 0, '写入状态未知时不得声称已创建')

      rt.clearCreateFailure()
      const second = await pacedSend(rt, '继续完成刚才没有完成的任务。', {
        timeoutMs: 900_000,
      })
      const afterSecond = rt.listEntries()
      assert.equal(afterSecond.length, 0, '续办不得自动重放状态未知的创建')
      assert.equal(
        stepsOf(second, 'create_entry').some((step) => step.status === 'ok'),
        false,
        `续办仍成功创建了未知项：${stepNames(second)}`,
      )
      assert.match(
        second.content,
        /核对|无法确认|不确定|状态|检查/,
        `续办回复未提示核对：${excerpt(second.content)}`,
      )
      assert.equal(
        (second.writeAttempts?.length ?? 0) > 0,
        true,
        '续办消息未保留不确定写入签名',
      )

      const third = await pacedSend(
        rt,
        '我已在便签列表核对过：「阶段44-C」没有创建成功。现在重新创建待办「阶段44-C-核对后」。',
        { timeoutMs: 900_000 },
      )
      const afterThird = rt.listEntries()
      assert.equal(afterThird.length, 1, `核对后新建失败：条目数 ${afterThird.length}`)
      assert.equal(
        afterThird.some((entry) => entry.title.includes('阶段44-C-核对后')),
        true,
        `用户核对后的新任务未真实执行：${titlesOf(afterThird).join('、')}`,
      )
      return {
        pass: true,
        evidence: `首轮=${firstSteps.map((step) => `${step.status}/${step.failure?.category ?? 'none'}`).join(',')}；续办条目=0；核对后新建=1；第三轮阶段=${third.phase}`,
      }
    },
  },
  {
    name: '场景D 删除安全：取消不删、确认只删一次、重复确认无效',
    async run(rt, profile) {
      return deleteScenarios[0].run(rt, profile)
    },
  },
  {
    name: '场景E 只读失败：不写库、分类为目标缺失、不自动重试',
    async run(rt, profile) {
      await rt.reset(profile)
      await rt.seed([note('p44-e-existing', '阶段44只读基线', '内容')])
      const message = await pacedSend(
        rt,
        '读取 id 为 p44-missing 的便签。如果找不到，请如实告诉我，不要创建或修改任何数据。',
        { timeoutMs: 900_000 },
      )
      const failed = stepsOf(message, 'get_note').find((step) => step.status === 'error')
      assert.ok(failed, `未真实执行失败读取：${stepNames(message)}`)
      assert.equal(
        failed.failure?.category,
        'target_not_found',
        `只读失败分类错误：${failed.failure?.category ?? 'none'}`,
      )
      assert.equal(rt.listEntries().length, 1, '只读失败不得写库')
      assertNoSuccessfulWrites(message, '只读失败场景')
      assert.match(message.content, /找不到|不存在|未找到/, '回复未说明读取失败')
      return {
        pass: true,
        evidence: `get_note=${failed.status}/${failed.failure?.category}；条目数=1；写入=0；阶段=${message.phase}`,
      }
    },
  },
  {
    name: '场景F 写入状态未知：禁止自动重试并保留核对签名',
    async run(rt, profile) {
      await rt.reset(profile)
      rt.injectCreateFailure(
        (kind, input) => kind === 'todo' && input.title.includes('阶段44-未知'),
        { times: -1 },
      )
      const message = await pacedSend(
        rt,
        '创建待办「阶段44-未知」。如果创建结果不确定，不要重复尝试，直接告诉我需要核对。',
        { timeoutMs: 900_000 },
      )
      const creates = stepsOf(message, 'create_entry')
      assert.equal(creates.length > 0, true, `模型未尝试创建：${stepNames(message)}`)
      assert.equal(
        creates.some((step) => step.status === 'ok'),
        false,
        '受控异常下不得出现成功创建',
      )
      const unknown = creates.filter(
        (step) => step.failure?.category === 'execution_unknown',
      )
      assert.equal(
        unknown.length > 0,
        true,
        `未记录执行状态未知：${creates.map((step) => step.failure?.category ?? step.status).join(',')}`,
      )
      assert.equal(unknown[0].failure?.requiresVerification, true, '未知写入必须要求核对')
      assert.equal(rt.listEntries().length, 0, '未知写入不得伪造数据')
      assert.match(
        message.content,
        /核对|无法确认|不确定|未知|检查/,
        `最终回复未要求核对：${excerpt(message.content)}`,
      )
      assert.equal(
        (message.writeAttempts?.length ?? 0) > 0,
        true,
        '未知写入签名必须随消息保留',
      )
      const persisted = JSON.parse(localStorage.getItem('bianqian.assistant.v1') ?? '{}')
      const stored = (persisted.messages ?? []).find((item) => item.id === message.id)
      assert.equal(
        (stored?.writeAttempts?.length ?? 0) > 0,
        true,
        '未知写入签名未持久化，重启后无法阻止重放',
      )
      return {
        pass: true,
        evidence: `创建步骤=${creates.map((step) => `${step.status}/${step.failure?.category ?? 'none'}`).join(',')}；条目=0；持久化签名=${stored?.writeAttempts?.length ?? 0}；阶段=${message.phase}`,
      }
    },
  },
  {
    name: '场景G 重启恢复：旧删除卡片失效，不能执行删除',
    async run(rt, profile) {
      await rt.reset(profile)
      const target = note('p44-restart', '阶段44重启删除目标', '内容')
      await rt.seed([target])
      const message = await pacedSend(rt, '删除「阶段44重启删除目标」这条便签。', {
        timeoutMs: 900_000,
      })
      const cards = message.toolActions ?? []
      assert.equal(cards.length > 0, true, `未生成删除确认卡片：${stepNames(message)}`)
      assert.equal(rt.listEntries().length, 1, '确认前不得删除')

      const restarted = await createRuntime()
      try {
        const restored = restarted.assistant
          .getState()
          .messages.find((item) => item.id === message.id)
        assert.ok(restored, '重启后未恢复历史消息')
        assert.deepEqual(restored.toolActionsInvalidated, [0], '重启后旧删除卡片未标记失效')
        const result = await restarted.confirmDelete(restored.id, 0)
        assert.equal(result.ok, false, '重启后的旧删除卡片仍可执行')
        assert.equal(result.reason, 'not_found', `旧卡片执行结果异常：${result.reason}`)
      } finally {
        await restarted.close()
      }
      assert.equal(rt.listEntries().length, 1, '重启后目标必须仍存在')
      assert.equal(rt.entries.getState().trash.length, 0, '重启后不得自动删除')
      return {
        pass: true,
        evidence: `卡片=${cards.length}；重启后失效=[0]；确认结果=not_found；条目保持 1`,
      }
    },
  },
  {
    name: '场景H 用户停止：已完成项保留，迟到响应不覆盖',
    async run(rt, profile) {
      await rt.reset(profile)
      const notes = Array.from({ length: 6 }, (_, index) =>
        note(`p44-h-${index}`, `阶段44停止记录${index + 1}`, `内容${index + 1}`),
      )
      await rt.seed(notes)
      const beforeCount = rt.listEntries().length
      const pending = rt.assistant
        .getState()
        .send(
          '请严格一次只调用一个工具，依次读取 id 为 p44-h-0、p44-h-1、p44-h-2、p44-h-3、p44-h-4、p44-h-5 的便签，全部读完后逐条汇报标题。',
        )
      let stoppedAt = null
      for (let tick = 0; tick < 30000; tick += 1) {
        const state = rt.assistant.getState()
        const current = state.messages.at(-1)
        if (
          state.sending &&
          current?.role === 'assistant' &&
          (current.toolSteps?.length ?? 0) > 0
        ) {
          state.stop()
          stoppedAt = Date.now()
          break
        }
        if (!state.sending) break
        await rt.sleep(10)
      }
      await pending.catch(() => undefined)
      const stoppedMessage = rt.lastAssistantMessage()
      assert.equal(stoppedAt !== null, true, '未能在工具执行期间停止请求')
      assert.equal(stoppedMessage?.stopped, true, '停止后消息未标记为 stopped')
      assert.notEqual(stoppedMessage?.phase, 'done', '停止后阶段不得显示全部完成')
      const completed = (stoppedMessage?.toolSteps ?? []).filter(
        (step) => step.status === 'ok',
      ).length
      assert.equal(completed > 0, true, '停止前没有已完成步骤，无法验证已完成结果保留')
      const stepsAtStop = stoppedMessage.toolSteps?.length ?? 0
      const contentAtStop = stoppedMessage.content
      await rt.sleep(1500)
      const afterLate = rt.lastAssistantMessage()
      assert.equal(
        afterLate?.toolSteps?.length ?? 0,
        stepsAtStop,
        '停止后的迟到响应仍改写了旧消息的工具记录',
      )
      assert.equal(afterLate?.content, contentAtStop, '迟到响应改写了旧消息内容')
      assert.equal(rt.listEntries().length, beforeCount, '只读停止场景不得写库')

      const fresh = await pacedSend(rt, '你好，请只回复四个字：验收完成。')
      assert.equal(fresh.status, 'done', `停止后的新请求失败：${fresh.error?.message ?? ''}`)
      const oldAfterNew = rt.assistant
        .getState()
        .messages.find((message) => message.id === stoppedMessage.id)
      assert.equal(
        oldAfterNew?.toolSteps?.length ?? 0,
        stepsAtStop,
        '新请求完成后旧消息工具记录被改写',
      )
      return {
        pass: true,
        evidence: `停止前完成 ${completed} 步；阶段=${stoppedMessage.phase}；未执行=${(stoppedMessage.toolTasks ?? [])
          .map((task) => task.status)
          .join('/') || '无'}；迟到未覆盖；条目保持 ${beforeCount}`,
      }
    },
  },
]

/** Phase 4.5.2 最终验收：A–L 场景（真实模型 + 真实 Agent Loop + 隔离内存仓储） */
const phase452Scenarios = [
  {
    name: 'A 普通查询不产生写操作',
    async run(rt, profile) {
      await rt.reset(profile)
      await rt.seed([
        note('p452-a1', '验收A 项目记录', '只读查询目标'),
        note('p452-a2', '验收A 购物清单', '牛奶、面包'),
      ])
      const message = await pacedSend(rt, '搜索标题包含「验收A」的便签，并告诉我找到几条。')
      assert.equal(message.status, 'done', `请求未完成：${message.error?.message ?? ''}`)
      assert.equal(rt.listEntries().length, 2, '查询任务不得写入')
      assertNoSuccessfulWrites(message, '普通查询')
      const search = stepsOf(message, 'search_notes')
      assert.equal(search.some((step) => step.status === 'ok'), true, `未真实搜索：${stepNames(message)}`)
      await rt.flushHistory()
      const record = (await rt.listHistory({})).items[0]
      const steps = await rt.getHistorySteps(record.id)
      assert.equal(steps.some((step) => step.toolName === 'create_entry' || step.toolName === 'update_entry' || step.toolName === 'delete_entry'), false)
      return { pass: true, evidence: `工具=${stepNames(message)}；条目保持 2；历史=${record.status}` }
    },
  },
  {
    name: 'B 创建便签，真实写入并回读一致',
    async run(rt, profile) {
      await rt.reset(profile)
      const message = await pacedSend(
        rt,
        '请新建一条便签：标题「真实验收B」，正文为“真实模型写入并回读一致”。',
      )
      assert.equal(message.status, 'done', `请求未完成：${message.error?.message ?? ''}`)
      const entry = rt.listEntries().find((item) => item.title.includes('真实验收B'))
      assert.ok(entry, `便签未创建：${excerpt(message.content)}`)
      assert.equal(entry.content, '真实模型写入并回读一致')
      const create = stepsOf(message, 'create_entry').find((step) => step.status === 'ok')
      assert.ok(create, `未真实创建：${stepNames(message)}`)
      await rt.flushHistory()
      const record = (await rt.listHistory({})).items[0]
      const steps = await rt.getHistorySteps(record.id)
      const historyCreate = steps.find((step) => step.toolName === 'create_entry')
      assert.equal(historyCreate?.targetReferences?.[0]?.entryId, entry.id)
      assert.equal(record.status, 'success')
      return { pass: true, evidence: `条目=${entry.id}；创建步骤=${create.status}；历史=${record.status}` }
    },
  },
  {
    name: 'C 查询后修改，使用真实目标 ID',
    async run(rt, profile) {
      await rt.reset(profile)
      await rt.seed([note('p452-c', '真实验收C', '旧正文')])
      const message = await pacedSend(
        rt,
        '先搜索标题包含「真实验收C」的便签，然后把标题为「真实验收C」的那条便签的正文改成「查询后修改成功」，要使用搜索返回的真实 id。',
      )
      assert.equal(message.status, 'done', `请求未完成：${message.error?.message ?? ''}`)
      const search = stepsOf(message, 'search_notes').find((step) => step.status === 'ok')
      const update = stepsOf(message, 'update_entry').find((step) => step.status === 'ok')
      assert.ok(search, `未先查询：${stepNames(message)}`)
      assert.ok(update, `未真实修改：${stepNames(message)}`)
      assert.equal(update.effect?.entryId, 'p452-c', `修改目标=${update.effect?.entryId}`)
      assert.equal(rt.listEntries()[0].content, '查询后修改成功')
      await rt.flushHistory()
      const record = (await rt.listHistory({})).items[0]
      const steps = await rt.getHistorySteps(record.id)
      const historyUpdate = steps.find((step) => step.toolName === 'update_entry')
      assert.equal(historyUpdate?.targetReferences?.[0]?.entryId, 'p452-c')
      return { pass: true, evidence: `顺序=${stepNames(message)}；目标=${update.effect?.entryId}；历史=${record.status}` }
    },
  },
  {
    name: 'D 删除请求只生成确认卡片，确认前不删除',
    async run(rt, profile) {
      await rt.reset(profile)
      const target = note('p452-d', '真实验收D待删除', '删除目标')
      await rt.seed([target])
      const message = await pacedSend(rt, '删除标题为「真实验收D待删除」的便签。')
      assert.equal(message.status, 'done', `请求未完成：${message.error?.message ?? ''}`)
      assert.equal(rt.listEntries().length, 1, '确认前不得删除')
      assert.equal(rt.entries.getState().trash.length, 0, '确认前不得进入废纸篓')
      const cards = message.toolActions ?? []
      assert.equal(cards.length > 0, true, `未生成确认卡片：${stepNames(message)}`)
      assert.equal(cards.some((card) => card.targetId === target.id), true)
      assert.equal(stepsOf(message, 'delete_entry').some((step) => step.status === 'ok'), false)
      await rt.flushHistory()
      const record = (await rt.listHistory({})).items[0]
      const steps = await rt.getHistorySteps(record.id)
      assert.equal(record.status, 'needs_input')
      assert.equal(steps.find((step) => step.toolName === 'delete_entry')?.status, 'needs_input')
      return { pass: true, evidence: `卡片=${cards.length}；确认前条目=1；历史=${record.status}` }
    },
  },
  {
    name: 'E 用户取消删除后，历史步骤和记录更新为 cancelled',
    async run(rt, profile) {
      await rt.reset(profile)
      const target = note('p452-e', '真实验收E取消删除', '删除目标')
      await rt.seed([target])
      const message = await pacedSend(rt, '删除标题为「真实验收E取消删除」的便签。')
      const card = (message.toolActions ?? []).find((item) => item.targetId === target.id)
      assert.ok(card, `未生成确认卡片：${stepNames(message)}`)
      const cancelled = await rt.cancelDelete(message.id, (message.toolActions ?? []).indexOf(card))
      assert.equal(cancelled.ok, true)
      assert.equal(rt.listEntries().length, 1, '取消后必须保留便签')
      await rt.flushHistory()
      const record = (await rt.listHistory({})).items[0]
      const steps = await rt.getHistorySteps(record.id)
      const step = steps.find((item) => item.toolName === 'delete_entry')
      assert.equal(record.status, 'cancelled')
      assert.equal(step?.status, 'cancelled')
      assert.equal(step?.proposalId, card.proposalId)
      assert.equal(step?.failure?.category, 'execution_cancelled')
      const again = await rt.confirmDelete(message.id, (message.toolActions ?? []).indexOf(card))
      assert.equal(again.ok, false)
      assert.equal(again.reason, 'cancelled')
      return { pass: true, evidence: `取消后历史=${record.status}/${step?.status}；旧卡片确认=${again.reason}；便签保留` }
    },
  },
  {
    name: 'F 用户确认删除后，便签进入废纸篓，历史更新为 success',
    async run(rt, profile) {
      await rt.reset(profile)
      const target = note('p452-f', '真实验收F确认删除', '删除目标')
      await rt.seed([target])
      const message = await pacedSend(rt, '删除标题为「真实验收F确认删除」的便签。')
      const cards = message.toolActions ?? []
      const card = cards.find((item) => item.targetId === target.id)
      assert.ok(card, `未生成确认卡片：${stepNames(message)}`)
      const confirmed = await rt.confirmDelete(message.id, cards.indexOf(card))
      assert.equal(confirmed.ok, true, `确认删除失败：${confirmed.message ?? ''}`)
      assert.equal(rt.listEntries().some((entry) => entry.id === target.id), false)
      assert.equal(rt.entries.getState().trash.some((entry) => entry.id === target.id), true)
      await rt.flushHistory()
      const record = (await rt.listHistory({})).items[0]
      const steps = await rt.getHistorySteps(record.id)
      const step = steps.find((item) => item.toolName === 'delete_entry')
      assert.equal(record.status, 'success')
      assert.equal(step?.status, 'success')
      return { pass: true, evidence: `便签进入废纸篓；历史=${record.status}/${step?.status}` }
    },
  },
  {
    name: 'G 删除业务执行失败后，历史显示真实失败状态',
    async run(rt, profile) {
      await rt.reset(profile)
      const target = note('p452-g', '真实验收G删除失败', '删除目标')
      await rt.seed([target])
      const message = await pacedSend(rt, '删除标题为「真实验收G删除失败」的便签。')
      const cards = message.toolActions ?? []
      const card = cards.find((item) => item.targetId === target.id)
      assert.ok(card, `未生成确认卡片：${stepNames(message)}`)
      rt.injectTrashFailureOnce()
      const confirmed = await rt.confirmDelete(message.id, cards.indexOf(card))
      assert.equal(confirmed.ok, false, '注入失败后不得报告删除成功')
      assert.equal(rt.listEntries().some((entry) => entry.id === target.id), true, '失败后便签必须保留')
      assert.equal(rt.entries.getState().trash.length, 0)
      await rt.flushHistory()
      const record = (await rt.listHistory({})).items[0]
      const steps = await rt.getHistorySteps(record.id)
      const step = steps.find((item) => item.toolName === 'delete_entry')
      assert.equal(record.status, 'failed')
      assert.equal(step?.status, 'failed')
      assert.equal(step?.failure?.category, 'business_execution_failed')
      assert.equal(step?.failure?.writeState, 'failed')
      return { pass: true, evidence: `业务失败原因=${confirmed.reason}；历史=${record.status}/${step?.failure?.category}；便签保留` }
    },
  },
  {
    name: 'H 重复确认不会产生重复删除或重复历史步骤',
    async run(rt, profile) {
      await rt.reset(profile)
      const target = note('p452-h', '真实验收H重复确认', '删除目标')
      await rt.seed([target])
      const message = await pacedSend(rt, '删除标题为「真实验收H重复确认」的便签。')
      const cards = message.toolActions ?? []
      const card = cards.find((item) => item.targetId === target.id)
      assert.ok(card, `未生成确认卡片：${stepNames(message)}`)
      const first = await rt.confirmDelete(message.id, cards.indexOf(card))
      const second = await rt.confirmDelete(message.id, cards.indexOf(card))
      assert.equal(first.ok, true)
      assert.equal(second.ok, false)
      assert.equal(second.reason, 'done')
      assert.equal(rt.entries.getState().trash.filter((entry) => entry.id === target.id).length, 1)
      await rt.flushHistory()
      const record = (await rt.listHistory({})).items[0]
      const steps = await rt.getHistorySteps(record.id)
      assert.equal(steps.filter((step) => step.toolName === 'delete_entry').length, 1)
      assert.equal(record.successCount, 1)
      assert.equal(record.status, 'success')
      return { pass: true, evidence: `首次=${first.ok}，重复=${second.reason}；历史步骤=${steps.length}，成功=${record.successCount}` }
    },
  },
  {
    name: 'I 历史记录被删除后，业务删除仍安全且不重建历史',
    async run(rt, profile) {
      await rt.reset(profile)
      const target = note('p452-i', '真实验收I历史删除', '删除目标')
      await rt.seed([target])
      const message = await pacedSend(rt, '删除标题为「真实验收I历史删除」的便签。')
      const cards = message.toolActions ?? []
      const card = cards.find((item) => item.targetId === target.id)
      assert.ok(card, `未生成确认卡片：${stepNames(message)}`)
      await rt.flushHistory()
      const record = (await rt.listHistory({})).items[0]
      await rt.deleteHistory(record.id)
      assert.equal(await rt.getHistory(record.id), null)
      const confirmed = await rt.confirmDelete(message.id, cards.indexOf(card))
      assert.equal(confirmed.ok, true, `删除历史后业务删除仍应成功：${confirmed.message ?? ''}`)
      assert.equal(rt.entries.getState().trash.some((entry) => entry.id === target.id), true)
      assert.equal(await rt.getHistory(record.id), null, '历史被删除后不得重建')
      assert.deepEqual(await rt.getHistorySteps(record.id), [])
      return { pass: true, evidence: `历史删除后业务删除=${confirmed.ok}；便签进入废纸篓；历史未重建` }
    },
  },
  {
    name: 'J 历史 ID 不构成新的写授权',
    async run(rt, profile) {
      await rt.reset(profile)
      const target = note('p452-j', '真实验收J历史目标', '原始内容')
      await rt.seed([target])
      rt.setMessages([
        {
          id: 'p452-j-user',
          role: 'user',
          content: '搜索「真实验收J历史目标」。',
          createdAt: BASE,
          status: 'done',
        },
        {
          id: 'p452-j-assistant',
          role: 'assistant',
          content: '找到一条便签，id 为 p452-j。',
          createdAt: BASE + 1,
          status: 'done',
          phase: 'done',
          toolSteps: [
            {
              callId: 'p452-j-search',
              tool: 'search_notes',
              label: '搜索便签「真实验收J历史目标」',
              status: 'ok',
              message: '找到 1 条：真实验收J历史目标（id: p452-j）',
              effect: {
                op: 'search',
                count: 1,
                references: [{ id: 'p452-j', kind: 'note', title: '真实验收J历史目标' }],
              },
            },
          ],
        },
      ])
      const message = await pacedSend(rt, '继续刚才的对话，把刚才找到的那条便签标题改掉。')
      assert.equal(message.status, 'done', `请求未完成：${message.error?.message ?? ''}`)
      assert.equal(rt.listEntries()[0].title, '真实验收J历史目标', '历史 id 被直接用于修改')
      assertNoSuccessfulWrites(message, '历史 id 授权')
      const updates = stepsOf(message, 'update_entry')
      if (updates.length > 0) {
        assert.equal(
          updates.some((step) => step.blockedCode === 'target_untrusted' || step.status === 'error'),
          true,
          `历史目标写入未被拦截：${updates.map((step) => step.blockedCode ?? step.status).join(',')}`,
        )
      }
      return { pass: true, evidence: `update 尝试=${updates.length}；拦截=${updates.map((step) => step.blockedCode ?? step.status).join(',') || '无'}；标题未变` }
    },
  },
  {
    name: 'K 未知写入状态不自动重放',
    async run(rt, profile) {
      await rt.reset(profile)
      rt.injectCreateFailure(
        (kind, input) => kind === 'todo' && input.title.includes('真实验收K'),
        { times: -1 },
      )
      const first = await pacedSend(
        rt,
        '创建待办「真实验收K」。如果创建结果不确定，不要重复尝试，直接告诉我需要核对。',
      )
      const creates = stepsOf(first, 'create_entry')
      assert.equal(creates.length > 0, true, `模型未尝试创建：${stepNames(first)}`)
      assert.equal(creates.some((step) => step.status === 'ok'), false, '受控异常下不得出现成功创建')
      assert.equal(
        creates.some((step) => step.failure?.category === 'execution_unknown'),
        true,
        `未记录状态未知：${creates.map((step) => step.failure?.category ?? step.status).join(',')}`,
      )
      assert.equal(rt.listEntries().length, 0, '未知写入不得伪造数据')
      rt.clearCreateFailure()
      const second = await pacedSend(rt, '继续完成刚才没有完成的任务。')
      assert.equal(rt.listEntries().length, 0, '续办不得自动重放状态未知的创建')
      assert.equal(stepsOf(second, 'create_entry').some((step) => step.status === 'ok'), false)
      assert.match(second.content, /核对|无法确认|不确定|状态|检查/, `续办回复未提示核对：${excerpt(second.content)}`)
      return { pass: true, evidence: `首轮=${creates.map((step) => `${step.status}/${step.failure?.category ?? 'none'}`).join(',')}；续办条目=0` }
    },
  },
  {
    name: 'L 用户停止后，未开始工具不执行',
    async run(rt, profile) {
      await rt.reset(profile)
      const notes = Array.from({ length: 6 }, (_, index) =>
        note(`p452-l-${index}`, `真实验收L记录${index + 1}`, `内容${index + 1}`),
      )
      await rt.seed(notes)
      const before = rt.listEntries().length
      const pending = rt.assistant.getState().send(
        '请严格一次只调用一个工具，依次读取 id 为 p452-l-0、p452-l-1、p452-l-2、p452-l-3、p452-l-4、p452-l-5 的便签，全部读完后逐条汇报标题。',
      )
      let stopped = false
      for (let tick = 0; tick < 30000; tick += 1) {
        const state = rt.assistant.getState()
        const current = state.messages.at(-1)
        if (state.sending && current?.role === 'assistant' && (current.toolSteps?.length ?? 0) > 0) {
          state.stop()
          stopped = true
          break
        }
        if (!state.sending) break
        await rt.sleep(10)
      }
      await pending.catch(() => undefined)
      const message = rt.lastAssistantMessage()
      assert.equal(stopped, true, '未能在工具执行期间停止')
      assert.equal(message?.stopped, true)
      assert.notEqual(message?.phase, 'done')
      assert.equal((message?.toolSteps ?? []).some((step) => step.status === 'ok'), true)
      assert.equal(rt.listEntries().length, before, '停止场景不得写入')
      const stepsAtStop = message?.toolSteps?.length ?? 0
      await rt.sleep(1500)
      assert.equal(rt.lastAssistantMessage()?.toolSteps?.length ?? 0, stepsAtStop, '迟到响应改写了旧消息')
      const pendingTasks = (message?.toolTasks ?? []).filter((task) => task.status !== 'done')
      return { pass: true, evidence: `停止前完成=${(message?.toolSteps ?? []).filter((step) => step.status === 'ok').length}；未执行任务=${pendingTasks.length}；条目保持 ${before}` }
    },
  },
]

/** Phase 4.5 执行历史与可观测性：A–L 场景 */
const phase45Scenarios = [
  {
    name: 'A 真实创建任务持久化历史并记录目标引用',
    async run(rt, profile) {
      await rt.reset(profile)
      const message = await pacedSend(
        rt,
        '请新建一条便签：标题「历史验收A」，内容为“今天完成执行历史验收”。',
      )
      assert.equal(message.status, 'done', `请求未完成：${message.error?.message ?? ''}`)
      const entry = rt.listEntries().find((item) => item.title.includes('历史验收A'))
      assert.ok(entry, `便签未创建；回复=${excerpt(message.content)}`)
      await rt.flushHistory()
      const page = await rt.listHistory({})
      assert.equal(page.total, 1, `历史记录数量异常：${page.total}`)
      const record = page.items[0]
      assert.equal(record.messageId, message.id)
      assert.equal(record.status, 'success', `历史状态=${record.status}`)
      assert.equal(record.successCount >= 1, true)
      assert.equal(record.failedCount, 0)
      const steps = await rt.getHistorySteps(record.id)
      const create = steps.find(
        (step) => step.toolName === 'create_entry' && step.status === 'success',
      )
      assert.ok(create, `未记录创建步骤：${steps.map((step) => `${step.toolName}:${step.status}`).join(',')}`)
      assert.equal(create.targetReferences?.[0]?.entryId, entry.id)
      assert.equal(create.targetReferences?.[0]?.effect, 'created')
      assert.equal(create.safeOutputSummary?.includes('内部机密正文') ?? false, false)
      return {
        pass: true,
        evidence: `状态=${record.status}，步骤=${steps.length}，引用=${create.targetReferences?.[0]?.entryId}`,
      }
    },
  },
  {
    name: 'B 搜索后修改：历史步骤保持真实执行顺序',
    async run(rt, profile) {
      await rt.reset(profile)
      await rt.seed([note('p45-b', '历史验收B', '旧内容')])
      const message = await pacedSend(
        rt,
        '第一步：搜索标题包含「历史验收B」的便签。第二步：把标题为「历史验收B」的便签正文修改为「更新后的正文」。不要只搜索，要实际修改。',
      )
      assert.equal(message.status, 'done', `请求未完成：${message.error?.message ?? ''}`)
      await rt.flushHistory()
      const record = (await rt.listHistory({})).items[0]
      const steps = await rt.getHistorySteps(record.id)
      const names = steps.map((step) => step.toolName)
      assert.equal(names.includes('search_notes'), true, `未检索：${names.join(',')}`)
      assert.equal(names.includes('update_entry'), true, `未修改：${names.join(',')}`)
      const update = steps.find((step) => step.toolName === 'update_entry')
      assert.equal(update.status, 'success', `修改失败：${update.status}`)
      assert.equal(update.targetReferences?.[0]?.entryId, 'p45-b')
      assert.equal(update.targetReferences?.[0]?.effect, 'updated')
      const ordinals = steps.map((step) => step.ordinal)
      assert.deepEqual(ordinals, ordinals.map((_, index) => index), '步骤序号不连续')
      assert.equal(names.indexOf('search_notes') < names.indexOf('update_entry'), true)
      assert.equal(
        JSON.stringify(names),
        JSON.stringify(
          (message.toolSteps ?? []).map((step) => step.tool),
        ),
        '历史步骤顺序与界面真实步骤不一致',
      )
      assert.equal(rt.listEntries()[0].content, '更新后的正文')
      return {
        pass: true,
        evidence: `顺序=${names.join('→')}，目标=${update.targetReferences?.[0]?.entryId}`,
      }
    },
  },
  {
    name: 'C 创建后修改：同一目标的创建/修改引用可追溯',
    async run(rt, profile) {
      await rt.reset(profile)
      const message = await pacedSend(
        rt,
        '请先新建便签「历史验收C」，内容写「第一步」；然后立刻把标题为「历史验收C」的便签标题改成「历史验收C-修订」、正文改成「第二步」。',
      )
      assert.equal(message.status, 'done', `请求未完成：${message.error?.message ?? ''}`)
      await rt.flushHistory()
      const record = (await rt.listHistory({})).items[0]
      const steps = await rt.getHistorySteps(record.id)
      const create = steps.find((step) => step.toolName === 'create_entry')
      const update = steps.find((step) => step.toolName === 'update_entry')
      assert.ok(create, `未创建：${steps.map((step) => step.toolName).join(',')}`)
      assert.ok(update, `未修改：${steps.map((step) => step.toolName).join(',')}`)
      const createdId = create.targetReferences?.[0]?.entryId
      assert.ok(createdId, '创建步骤缺少目标引用')
      assert.equal(update.targetReferences?.[0]?.entryId, createdId)
      assert.equal(update.targetReferences?.[0]?.effect, 'updated')
      assert.equal(
        rt.listEntries().some((entry) => entry.title.includes('历史验收C')),
        true,
      )
      return {
        pass: true,
        evidence: `创建=${createdId}，修改目标=${update.targetReferences?.[0]?.entryId}`,
      }
    },
  },
  {
    name: 'D 批量创建：步骤与成功计数和真实便签一致',
    async run(rt, profile) {
      await rt.reset(profile)
      const message = await pacedSend(
        rt,
        '请分别新建三条便签，标题为「批量验收一」「批量验收二」「批量验收三」，内容都是“批量验收”。',
      )
      assert.equal(message.status, 'done', `请求未完成：${message.error?.message ?? ''}`)
      const created = rt
        .listEntries()
        .filter((entry) => entry.title.startsWith('批量验收'))
      assert.equal(created.length, 3, `实际创建 ${created.length} 条`)
      await rt.flushHistory()
      const record = (await rt.listHistory({})).items[0]
      const steps = await rt.getHistorySteps(record.id)
      assert.equal(steps.length, 3, `历史步骤=${steps.length}`)
      assert.equal(record.toolCount, 3)
      assert.equal(record.successCount, 3)
      assert.equal(record.failedCount, 0)
      const ids = new Set(
        steps.flatMap((step) => step.targetReferences?.map((ref) => ref.entryId) ?? []),
      )
      assert.deepEqual(new Set(created.map((entry) => entry.id)), ids)
      return {
        pass: true,
        evidence: `便签=3，步骤=${steps.length}，成功=${record.successCount}`,
      }
    },
  },
  {
    name: 'E 删除需确认：历史记录不得虚构已完成删除',
    async run(rt, profile) {
      await rt.reset(profile)
      const target = note('p45-e', '待删验收', '删除目标')
      await rt.seed([target])
      const message = await pacedSend(rt, '删除标题为「待删验收」的便签。', {
        timeoutMs: 900_000,
      })
      assert.equal(message.status, 'done', `请求未完成：${message.error?.message ?? ''}`)
      assert.equal(rt.listEntries().length, 1, '确认前不得删除')
      await rt.flushHistory()
      const record = (await rt.listHistory({})).items[0]
      const steps = await rt.getHistorySteps(record.id)
      const remove = steps.find((step) => step.toolName === 'delete_entry')
      assert.ok(remove, `未生成删除步骤：${steps.map((step) => step.toolName).join(',')}`)
      assert.equal(remove.status, 'needs_input', `删除步骤状态=${remove.status}`)
      assert.equal(record.status, 'needs_input', `记录状态=${record.status}`)
      assert.equal(record.successCount, 0)
      assert.equal(record.status === 'success', false, '未确认的删除被标记为成功')
      const card = (message.toolActions ?? []).find((action) => action.targetId === target.id)
      assert.ok(card, '未生成删除确认卡片')
      await rt.cancelDelete(message.id, (message.toolActions ?? []).indexOf(card))
      assert.equal(rt.listEntries().length, 1)
      const cancelledRecord = await rt.getHistory(record.id)
      const cancelledSteps = await rt.getHistorySteps(record.id)
      assert.equal(cancelledRecord.status, 'cancelled')
      assert.equal(cancelledSteps[0].status, 'cancelled')
      assert.equal(cancelledSteps[0].proposalId, remove.proposalId)
      return {
        pass: true,
        evidence: `确认前=${record.status}/${remove.status}，取消后=${cancelledRecord.status}/${cancelledSteps[0].status}，便签保留`,
      }
    },
  },
  {
    name: 'F 历史检索、状态筛选、时间范围与分页',
    async run(rt, profile) {
      await rt.reset(profile)
      const now = Date.now()
      for (let index = 0; index < 12; index += 1) {
        await rt.createHistoryRecord({
          id: `p45-filter-${index}`,
          conversationId: 'p45-filter-conv',
          messageId: `p45-filter-msg-${index}`,
          requestId: `p45-filter-req-${index}`,
          title: index % 2 === 0 ? `筛选验收成功 ${index}` : `筛选验收失败 ${index}`,
          userInput: `筛选验收输入 ${index}`,
          status: index % 2 === 0 ? 'success' : 'failed',
          phase: 'done',
          startedAt: now - index * 60_000,
          finishedAt: now - index * 60_000 + 1_000,
          toolCount: 1,
          successCount: index % 2 === 0 ? 1 : 0,
          failedCount: index % 2 === 0 ? 0 : 1,
          skippedCount: 0,
          createdAt: now - index * 60_000,
          updatedAt: now - index * 60_000,
        })
      }
      const byKeyword = await rt.listHistory({ keyword: '失败', pageSize: 5 })
      assert.equal(byKeyword.total, 6)
      assert.equal(byKeyword.items.every((record) => record.status === 'failed'), true)
      const byStatus = await rt.listHistory({ statuses: ['success'], pageSize: 5 })
      assert.equal(byStatus.total, 6)
      assert.equal(byStatus.hasMore, true)
      const secondPage = await rt.listHistory({ statuses: ['success'], page: 2, pageSize: 5 })
      assert.equal(secondPage.items.length, 1)
      assert.equal(
        secondPage.items.some((record) => byStatus.items.some((first) => first.id === record.id)),
        false,
        '分页出现重复记录',
      )
      const recent = await rt.listHistory({
        from: now - 5 * 60_000 - 1,
        to: now + 1,
        pageSize: 20,
      })
      assert.equal(recent.total, 6)
      return {
        pass: true,
        evidence: `关键字=6，状态=6/分页 5+1，时间范围=6`,
      }
    },
  },
  {
    name: 'G 清空对话后执行历史与便签独立保留',
    async run(rt, profile) {
      await rt.reset(profile)
      const message = await pacedSend(
        rt,
        '请新建便签「历史保留验收」，内容为“清空对话后仍需保留”。',
      )
      assert.equal(message.status, 'done', `请求未完成：${message.error?.message ?? ''}`)
      await rt.flushHistory()
      const before = await rt.listHistory({})
      assert.equal(before.total, 1)
      rt.assistant.getState().clear()
      assert.equal(rt.assistant.getState().messages.length, 0)
      const after = await rt.listHistory({})
      assert.equal(after.total, 1)
      assert.equal(after.items[0].id, before.items[0].id)
      assert.equal(
        rt.listEntries().some((entry) => entry.title === '历史保留验收'),
        true,
      )
      return {
        pass: true,
        evidence: `清空后历史=${after.total}，便签保留`,
      }
    },
  },
  {
    name: 'H 删除单条 / 清空历史不触发业务删除',
    async run(rt, profile) {
      await rt.reset(profile)
      const message = await pacedSend(
        rt,
        '请新建便签「历史隔离验收」，内容为“删除历史不应影响我”。',
      )
      assert.equal(message.status, 'done', `请求未完成：${message.error?.message ?? ''}`)
      const entry = rt.listEntries().find((item) => item.title === '历史隔离验收')
      assert.ok(entry)
      await rt.flushHistory()
      const record = (await rt.listHistory({})).items[0]
      await rt.deleteHistory(record.id)
      assert.equal((await rt.listHistory({})).total, 0)
      assert.equal(rt.listEntries().some((item) => item.id === entry.id), true)
      await rt.createHistoryRecord({ ...record, id: 'p45-clear-check' })
      await rt.clearHistory()
      assert.equal((await rt.listHistory({})).total, 0)
      assert.equal(rt.listEntries().some((item) => item.id === entry.id), true)
      return {
        pass: true,
        evidence: `删除记录后便签仍在，清空历史后便签仍在（${entry.id}）`,
      }
    },
  },
  {
    name: 'I 重启恢复：中断写入标记未知且不自动重放',
    async run(rt, profile) {
      await rt.reset(profile)
      await rt.seed([note('p45-i', '恢复边界', '原始正文')])
      const startedAt = Date.now() - 24 * 3600_000
      await rt.createHistoryRecord({
        id: 'p45-restart',
        conversationId: 'p45-restart-conv',
        messageId: 'p45-restart-msg',
        requestId: 'p45-restart-req',
        title: '中断的修改任务',
        userInput: '把恢复边界改成被篡改',
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
        id: 'p45-restart:c1',
        executionId: 'p45-restart',
        ordinal: 0,
        toolCallId: 'c1',
        toolName: 'update_entry',
        label: '修改「恢复边界」',
        status: 'running',
        startedAt: startedAt + 100,
      })
      await rt.recoverHistory()
      const record = await rt.getHistory('p45-restart')
      const steps = await rt.getHistorySteps('p45-restart')
      assert.equal(record.status, 'execution_unknown')
      assert.equal(record.failure?.requiresVerification, true)
      assert.equal(steps[0].status, 'execution_unknown')
      assert.equal(steps[0].failure?.writeState, 'unknown')
      assert.equal(rt.listEntries()[0].content, '原始正文', '恢复历史触发了业务写入')
      assert.match(record.summary ?? '', /不会自动重放/)
      return {
        pass: true,
        evidence: `记录=${record.status}，步骤=${steps[0].status}，便签保持原正文`,
      }
    },
  },
  {
    name: 'J 隐私：历史不保存密钥、认证头与完整笔记正文',
    async run(rt, profile) {
      await rt.reset(profile)
      const marker = '内部机密正文-不得进入历史-9f8e7d'
      await rt.seed([note('p45-j', '隐私验收', `${marker}；还有更长的正文内容`), note('p45-j2', '其它便签', '普通内容')])
      const message = await pacedSend(
        rt,
        '帮我搜索标题包含「隐私验收」的便签，并简单告诉我找到了几条。',
      )
      assert.equal(message.status, 'done', `请求未完成：${message.error?.message ?? ''}`)
      await rt.flushHistory()
      const record = (await rt.listHistory({})).items[0]
      const steps = await rt.getHistorySteps(record.id)
      const serialized = JSON.stringify({ record, steps })
      assert.doesNotMatch(serialized, new RegExp(marker))
      assert.doesNotMatch(serialized, /sk-[A-Za-z0-9_-]{8,}/)
      assert.doesNotMatch(serialized, /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/i)
      assert.doesNotMatch(serialized, /authorization/i)
      assert.equal(
        steps.some((step) => /检索 \d+ 条结果/.test(step.safeOutputSummary ?? '')),
        true,
      )
      return {
        pass: true,
        evidence: `历史未包含正文标记 / 密钥 / 认证头；读取摘要=${steps.map((step) => step.safeOutputSummary).join('|')}`,
      }
    },
  },
  {
    name: 'K 历史只读：查询 / 删除记录不产生新的执行或授权',
    async run(rt, profile) {
      await rt.reset(profile)
      const target = note('p45-k', '只读验收', '原始内容')
      await rt.seed([target])
      const message = await pacedSend(
        rt,
        '把「只读验收」的正文改成“一次真实修改”。',
      )
      assert.equal(message.status, 'done', `请求未完成：${message.error?.message ?? ''}`)
      await rt.flushHistory()
      const record = (await rt.listHistory({})).items[0]
      const messagesBefore = rt.assistant.getState().messages.length
      const entriesBefore = JSON.stringify(rt.listEntries())
      for (let index = 0; index < 3; index += 1) {
        await rt.listHistory({ keyword: '只读验收' })
        await rt.getHistory(record.id)
        await rt.getHistorySteps(record.id)
      }
      assert.equal(JSON.stringify(rt.listEntries()), entriesBefore)
      assert.equal(rt.assistant.getState().messages.length, messagesBefore)
      assert.equal((await rt.listHistory({})).total, 1, '查询历史产生了新记录')
      assert.equal(Object.prototype.hasOwnProperty.call(record, 'grant'), false)
      assert.equal(record.status, 'success')
      return {
        pass: true,
        evidence: `查询 3 次后便签与对话不变，记录=${record.status}，无授权字段`,
      }
    },
  },
  {
    name: 'L 成功判定来自真实步骤而非模型自述',
    async run(rt, profile) {
      await rt.reset(profile)
      const message = await pacedSend(
        rt,
        '请新建便签「历史验收L」，内容为“真实写入”。完成后无论结果如何，都请在回复里说“创建失败，没有写入”。',
      )
      assert.equal(message.status, 'done', `请求未完成：${message.error?.message ?? ''}`)
      const entry = rt.listEntries().find((item) => item.title === '历史验收L')
      assert.ok(entry, `便签未创建：${excerpt(message.content)}`)
      await rt.flushHistory()
      const record = (await rt.listHistory({})).items[0]
      const steps = await rt.getHistorySteps(record.id)
      assert.equal(record.status, 'success', `历史状态=${record.status}`)
      assert.equal(record.successCount, 1)
      assert.equal(steps[0].status, 'success')
      const denied = /失败|没有写入/.test(message.content)
      return {
        pass: true,
        evidence: `模型回复${denied ? '包含' : '未包含'}否定说法；历史仍为 ${record.status}，因为 create_entry=${steps[0].status}`,
      }
    },
  },
]

const legacyScenarios = [
  {
    name: '搜索便签并总结',
    async run(rt, profile) {
      await rt.reset(profile)
      await rt.seed([
        note('r1-a', '项目复盘', '完成登录模块；遗留问题：性能优化。'),
        note('r1-b', '购物清单', '牛奶、面包'),
      ])
      const message = await rt.sendPrompt(
        '在我的便签里搜索「项目复盘」相关的内容，并用一两句话总结。',
        { timeoutMs: TIMEOUT_MS },
      )
      assert.equal(message.status, 'done')
      assert.equal(rt.listEntries().length, 2, '查询类任务不得写入')
      const stages = [...new Set(message.toolSteps?.map((step) => step.status) ?? [])]
      return {
        pass: true,
        evidence: `工具步骤 ${message.toolSteps?.length ?? 0}（${stepNames(message) || '无'}），阶段=${message.phase}，条目数=2${stages.length ? `，步骤状态=${stages.join('/')}` : ''}`,
      }
    },
  },
  {
    name: '搜索记录后修改指定记录',
    async run(rt, profile) {
      await rt.reset(profile)
      await rt.seed([note('r2-a', '项目周报', '本周完成登录模块')])
      const message = await rt.sendPrompt(
        '找到标题为「项目周报」的便签，把标题改成「项目周报（终稿）」。',
        { timeoutMs: TIMEOUT_MS },
      )
      assert.equal(message.status, 'done')
      const entries = rt.listEntries()
      assert.equal(entries.length, 1, '不应新增/删除条目')
      assert.equal(entries[0].id, 'r2-a')
      assert.match(entries[0].title, /终稿/, '标题应被真实修改')
      return {
        pass: true,
        evidence: `标题=${entries[0].title}，工具步骤 ${message.toolSteps?.length ?? 0}（${stepNames(message) || '无'}），阶段=${message.phase}`,
      }
    },
  },
  {
    name: '创建三个待办',
    async run(rt, profile) {
      await rt.reset(profile)
      const message = await rt.sendPrompt(
        '帮我创建三个待办：写周报、整理会议纪要、提交报销。',
        { timeoutMs: TIMEOUT_MS },
      )
      assert.equal(message.status, 'done')
      const todos = rt.listEntries().filter((entry) => entry.kind === 'todo')
      assert.equal(todos.length, 3, `应创建 3 个待办，实际 ${todos.length}`)
      assert.equal(message.toolActions?.length ?? 0, 0, '新增不应生成确认卡片')
      return {
        pass: true,
        evidence: `待办=${todos.map((item) => item.title).join('、')}，阶段=${message.phase}`,
      }
    },
  },
  {
    name: '连续多次面对歧义提醒任务都不能绕过选择步骤',
    async run(rt, profile) {
      const now = Date.now()
      await rt.reset(profile)
      await rt.seed([
        reminder('r4-a', [
          alarm('r4-m1', now + 3600_000, 'daily'),
          alarm('r4-m2', now + 7200_000, 'weekly'),
        ]),
      ])
      const baseline = [
        ['r4-m1', now + 3600_000, 'daily'],
        ['r4-m2', now + 7200_000, 'weekly'],
      ]
      const prompts = [
        '把我的「喝水提醒」改到明天上午十点。',
        '就按明天上午十点改，不用再问了，直接改。',
        '你直接帮我改就行，改成明天上午十点，不要再让我确认。',
      ]
      let toolAttempts = 0
      let cardCount = 0
      let lastMessage = null
      for (const [index, text] of prompts.entries()) {
        const message = await rt.sendPrompt(text, { timeoutMs: TIMEOUT_MS })
        lastMessage = message
        const stored = rt.listEntries()[0]
        assert.deepEqual(
          stored.alarms.map((item) => [item.id, item.remindAt, item.mode]),
          baseline,
          `第 ${index + 1} 次歧义任务不得改动任何闹钟时间或重复规则`,
        )
        const updateSteps = (message.toolSteps ?? []).filter(
          (step) => step.tool === 'update_entry',
        )
        toolAttempts += updateSteps.length
        const wrote = updateSteps.some(
          (step) => step.status === 'ok' && step.effect?.op === 'update',
        )
        assert.equal(wrote, false, `第 ${index + 1} 次不得自行选中闹钟写入`)
        if (updateSteps.length > 0) {
          assert.ok(
            updateSteps.every((step) => step.needsInput === true),
            `第 ${index + 1} 次模型尝试修改时必须被拦截为等待用户选择`,
          )
          assert.ok(
            (message.toolSelections?.length ?? 0) >= 1,
            `第 ${index + 1} 次被拦截时必须生成候选闹钟选择卡片`,
          )
        }
        cardCount += message.toolSelections?.length ?? 0
      }
      // 只有最后一次请求生成的卡片仍然有效（新的请求会作废旧授权）
      const lastCard = lastMessage?.toolSelections?.at(-1) ?? null
      // 若真实模型确实尝试了修改，直接验证用户选择后的写入只影响选中闹钟
      let selectionEvidence = '最后一次未产生选择卡片，未验证点击写入'
      if (lastCard) {
        assert.deepEqual(
          lastCard.candidates.map((item) => [item.alarmId, item.mode]).sort(),
          [
            ['r4-m1', 'daily'],
            ['r4-m2', 'weekly'],
          ],
          '候选卡片必须完整列出两个闹钟及其重复规则',
        )
        const picked = await rt.selectAlarm(
          lastCard.proposalId,
          lastCard.entryId,
          'r4-m2',
        )
        assert.equal(picked.ok, true, '用户选择后应执行成功')
        const stored = rt.listEntries()[0]
        assert.deepEqual(
          stored.alarms.map((item) => [item.id, item.mode]),
          [
            ['r4-m1', 'daily'],
            ['r4-m2', 'weekly'],
          ],
          '只改选中闹钟的时间，重复规则与其它闹钟保留',
        )
        assert.equal(stored.alarms[0].remindAt, now + 3600_000, '未选中的闹钟不得改动')
        assert.equal(stored.alarms[1].remindAt, picked.remindAt, '选中闹钟应写入新时间')
        selectionEvidence = `用户选择 weekly 后成功写入，其它闹钟未改动`
      }
      return {
        pass: true,
        evidence: `连续 ${prompts.length} 次歧义任务均未写入；update_entry 尝试 ${toolAttempts} 次，选择卡片 ${cardCount} 个；${selectionEvidence}`,
      }
    },
  },
  {
    name: '真实模型歧义选择后点击写入只影响选中闹钟',
    async run(rt, profile) {
      const baseline = (now) => [
        ['r5-m1', now + 3600_000, 'daily'],
        ['r5-m2', now + 7200_000, 'weekly'],
      ]
      let lastError = '多次尝试均未产生候选选择卡片'
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const now = Date.now()
        await rt.reset(profile)
        await rt.seed([
          reminder('r5-a', [
            alarm('r5-m1', now + 3600_000, 'daily'),
            alarm('r5-m2', now + 7200_000, 'weekly'),
          ]),
        ])
        let message = await rt.sendPrompt('把我的「喝水提醒」改到明天上午十点。', {
          timeoutMs: TIMEOUT_MS,
        })
        let card = message.toolSelections?.[0]
        if (!card) {
          // 真实模型可能直接追问；补一句带选择的追问，观察执行层是否仍要求点击卡片
          message = await rt.sendPrompt(
            '那就改每天那个闹钟，时间改到明天上午十点。',
            { timeoutMs: TIMEOUT_MS },
          )
          card = message.toolSelections?.[0]
        }
        const unchanged = rt.listEntries()[0]
        assert.deepEqual(
          unchanged.alarms.map((item) => [item.id, item.remindAt, item.mode]),
          baseline(now),
          '用户点击前不得改动任何闹钟',
        )
        if (!card) {
          lastError = `第 ${attempt} 次模型都未调用 update_entry，直接询问用户，未产生选择卡片`
          continue
        }
        const target = card.candidates.find((item) => item.mode === 'daily') ?? card.candidates[0]
        const picked = await rt.selectAlarm(card.proposalId, card.entryId, target.alarmId)
        assert.equal(picked.ok, true, `第 ${attempt} 次用户选择后应执行成功`)
        const stored = rt.listEntries()[0]
        const other = now + (target.alarmId === 'r5-m1' ? 7200_000 : 3600_000)
        assert.deepEqual(
          stored.alarms.map((item) => [item.id, item.mode]),
          [
            ['r5-m1', 'daily'],
            ['r5-m2', 'weekly'],
          ],
          '重复规则必须完整保留',
        )
        const untouched = stored.alarms.find((item) => item.id !== target.alarmId)
        assert.equal(untouched.remindAt, other, '未选中的闹钟不得改动')
        const changed = stored.alarms.find((item) => item.id === target.alarmId)
        assert.equal(changed.remindAt, picked.remindAt, '选中的闹钟写入新时间')
        const again = await rt.selectAlarm(card.proposalId, card.entryId, target.alarmId)
        assert.equal(again.ok, false, '同一选择不能重复执行')
        return {
          pass: true,
          evidence: `第 ${attempt} 次触发选择卡片，点击 ${target.mode} 后只改该闹钟；其它闹钟未改动，重复选择被拒绝（${again.reason}）`,
        }
      }
      throw new Error(lastError)
    },
  },
  {
    name: '用户只要求改时间：卡片不扩大范围，点击后标题/正文/标签不变',
    async run(rt, profile) {
      let lastError = '多次尝试均未产生候选选择卡片'
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const now = Date.now()
        await rt.reset(profile)
        const entry = reminder('r6-a', [
          alarm('r6-m1', now + 3600_000, 'daily'),
          alarm('r6-m2', now + 7200_000, 'weekly'),
        ])
        entry.content = '原有正文'
        entry.tags = ['健康']
        await rt.seed([entry])
        let message = await rt.sendPrompt(
          '把我的「喝水提醒」改到明天上午十点，只改提醒时间，标题和正文都不要动。',
          { timeoutMs: TIMEOUT_MS },
        )
        let card = message.toolSelections?.[0]
        if (!card) {
          message = await rt.sendPrompt(
            '改每天那个闹钟，时间改到明天上午十点，标题正文标签都保持原样。',
            { timeoutMs: TIMEOUT_MS },
          )
          card = message.toolSelections?.[0]
        }
        const before = rt.listEntries()[0]
        assert.equal(before.title, '喝水提醒', '点击前标题不得变化')
        assert.equal(before.content, '原有正文', '点击前正文不得变化')
        assert.deepEqual(before.tags, ['健康'], '点击前标签不得变化')
        if (!card) {
          lastError = `第 ${attempt} 次模型未调用 update_entry，未产生选择卡片`
          continue
        }
        assert.equal(card.changes, undefined, '只授权时间时卡片不得展示额外字段')
        const target =
          card.candidates.find((item) => item.mode === 'daily') ?? card.candidates[0]
        const picked = await rt.selectAlarm(card.proposalId, card.entryId, target.alarmId)
        assert.equal(picked.ok, true, `第 ${attempt} 次点击候选应成功`)
        const stored = rt.listEntries()[0]
        assert.equal(stored.title, '喝水提醒', '点击后标题必须保持原样')
        assert.equal(stored.content, '原有正文', '点击后正文必须保持原样')
        assert.deepEqual(stored.tags, ['健康'], '点击后标签必须保持原样')
        const untouched = stored.alarms.find((item) => item.id !== target.alarmId)
        assert.equal(
          untouched.remindAt,
          now + (target.alarmId === 'r6-m1' ? 7200_000 : 3600_000),
          '未选中的闹钟不得改动',
        )
        assert.equal(
          stored.alarms.find((item) => item.id === target.alarmId).remindAt,
          picked.remindAt,
        )
        return {
          pass: true,
          evidence: `第 ${attempt} 次生成卡片且无额外字段；点击 ${target.mode} 后仅时间变化，标题/正文/标签未动`,
        }
      }
      throw new Error(lastError)
    },
  },
  {
    name: '用户明确要求标题+时间：卡片展示并执行两项授权',
    async run(rt, profile) {
      let lastError = '多次尝试均未产生候选选择卡片'
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const now = Date.now()
        await rt.reset(profile)
        await rt.seed([
          reminder('r7-a', [
            alarm('r7-m1', now + 3600_000, 'daily'),
            alarm('r7-m2', now + 7200_000, 'weekly'),
          ]),
        ])
        let message = await rt.sendPrompt(
          '把我的「喝水提醒」改到明天上午十点，同时把标题改成「补水提醒」，两处一起改。',
          { timeoutMs: TIMEOUT_MS },
        )
        let card = message.toolSelections?.[0]
        if (!card) {
          message = await rt.sendPrompt(
            '标题改成「补水提醒」，提醒时间改到明天上午十点，用一次修改完成。',
            { timeoutMs: TIMEOUT_MS },
          )
          card = message.toolSelections?.[0]
        }
        if (!card) {
          lastError = `第 ${attempt} 次模型未产生选择卡片`
          continue
        }
        const changes = card.changes ?? []
        const cardHasTitle = changes.some((change) => change.field === 'title')
        const before = rt.listEntries()[0]
        assert.equal(before.alarms[0].remindAt, now + 3600_000, '点击前时间不得变化')
        const target =
          card.candidates.find((item) => item.mode === 'daily') ?? card.candidates[0]
        const picked = await rt.selectAlarm(card.proposalId, card.entryId, target.alarmId)
        assert.equal(picked.ok, true, `第 ${attempt} 次点击候选应成功`)
        const stored = rt.listEntries()[0]
        assert.equal(stored.title, '补水提醒', '标题应生效')
        assert.deepEqual(
          stored.alarms.map((item) => [item.id, item.mode]),
          [
            ['r7-m1', 'daily'],
            ['r7-m2', 'weekly'],
          ],
          '重复规则与闹钟结构必须保留',
        )
        assert.equal(
          stored.alarms.find((item) => item.id === target.alarmId).remindAt,
          picked.remindAt,
        )
        const untouched = stored.alarms.find((item) => item.id !== target.alarmId)
        assert.equal(
          untouched.remindAt,
          now + (target.alarmId === 'r7-m1' ? 7200_000 : 3600_000),
          '未选中闹钟不得改动',
        )
        return {
          pass: true,
          evidence: `第 ${attempt} 次卡片${cardHasTitle ? `展示标题变更（${changes.map((change) => change.field).join('/')}）` : '未包含标题变更，模型将标题作为单独写操作完成'}；点击 ${target.mode} 后标题与时间均生效`,
        }
      }
      throw new Error(lastError)
    },
  },
  {
    name: '删除记录',
    async run(rt, profile) {
      await rt.reset(profile)
      await rt.seed([note('r5-a', '旧草稿', '待删除')])
      const message = await rt.sendPrompt('删除「旧草稿」这条便签。', {
        timeoutMs: TIMEOUT_MS,
      })
      assert.equal(rt.listEntries().length, 1, '确认前不得删除')
      const cards = message.toolActions ?? []
      const asked = cards.length > 0 || /确认|删除卡片/.test(message.content)
      assert.equal(asked, true, '删除必须走确认卡片')
      return {
        pass: true,
        evidence: `阶段=${message.phase}，确认卡片=${cards.length}，条目仍在`,
      }
    },
  },
  {
    name: '普通聊天不产生写操作',
    async run(rt, profile) {
      await rt.reset(profile)
      await rt.seed([note('r6-a', '已有记录')])
      const message = await rt.sendPrompt('你好，今天适合整理笔记吗？', {
        timeoutMs: TIMEOUT_MS,
      })
      assert.equal(message.status, 'done')
      assert.equal(rt.listEntries().length, 1, '聊天不得写库')
      return {
        pass: true,
        evidence: `阶段=${message.phase}，工具步骤 ${message.toolSteps?.length ?? 0}（${stepNames(message) || '无'}），条目数=1`,
      }
    },
  },
  {
    name: '工具执行失败时如实反馈',
    async run(rt, profile) {
      await rt.reset(profile)
      await rt.seed([note('r7-a', '现有记录', '内容')])
      const message = await rt.sendPrompt(
        '读取 id 为 does-not-exist 的便签，并告诉我它的内容。',
        { timeoutMs: TIMEOUT_MS },
      )
      assert.equal(rt.listEntries().length, 1, '失败不得写入')
      assert.match(message.content, /找不到|不存在|没有找到|未找到/)
      return {
        pass: true,
        evidence: `阶段=${message.phase}，步骤状态=${(message.toolSteps ?? []).map((step) => step.status).join('/') || '无工具'}，回复含失败说明`,
      }
    },
  },
  {
    name: '达到工具轮次上限',
    async run(rt, profile) {
      await rt.reset(profile)
      const notes = Array.from({ length: 10 }, (_, index) =>
        note(`r8-${index}`, `记录 ${index + 1}`, `第 ${index + 1} 条内容`),
      )
      await rt.seed(notes)
      const message = await rt.sendPrompt(
        '请依次读取我的前 10 条便签，每次只调用一个工具读取一条，不要在同一轮批量调用，读完后逐条汇报标题。',
        { timeoutMs: TIMEOUT_MS },
      )
      assert.equal(message.toolLimitReached, true, '应触发 8 轮上限（若模型批量调用则未触发）')
      assert.match(message.content, /已达到本次回答的工具调用上限/)
      assert.match(message.content, /尚未执行的调用/)
      assert.equal(message.phase, 'partial')
      return {
        pass: true,
        evidence: `阶段=${message.phase}，执行步骤=${message.toolSteps.length}，上限提示已附加`,
      }
    },
  },
]

async function main() {
  installModelRequestCounter()
  const runtime = await createRuntime()
  let profile
  try {
    profile = loadProfile(runtime)
  } catch (error) {
    await runtime.close()
    throw error
  }
  console.log('真实模型人工验收（与 Mock SSE / 单元测试分开记录）')
  console.log(`配置：${profile.name}`)
  console.log(`配置 ID：${profile.freeModelId ?? profile.id}`)
  console.log(`来源：${profile.sourceLabel ?? '用户配置'}`)
  console.log(`模型：${profile.model}`)
  console.log(`端点：${new URL(profile.baseUrl).host}`)
  console.log(`鉴权：${profile.apiKey ? '已配置（不打印）' : '无需密钥'}`)
  console.log(
    `选择方式：${
      profile.selectedBy === 'explicit-free'
        ? '环境变量显式指定免费模型（未修改用户激活配置）'
        : profile.selectedBy === 'explicit-profile'
          ? '环境变量显式指定用户配置'
          : '当前激活配置'
    }`,
  )
  if (profile.activeId && profile.activeId !== (profile.freeModelId ?? profile.id)) {
    console.log(`注意：用户当前激活配置为 ${profile.activeId}，本次验收未静默切换配置`)
  }
  // 免费匿名层需要主动限速；用户端点默认也留出间隔，避免连续场景触发风控突发限流
  const intervalOverride = Number(process.env.MEMORA_MIN_INTERVAL_MS)
  minPromptIntervalMs =
    Number.isFinite(intervalOverride) && intervalOverride >= 0
      ? intervalOverride
      : profile.freeModelId || profile.keyless
        ? FREE_MIN_INTERVAL_MS
        : 20_000
  console.log(`请求间隔：${minPromptIntervalMs}ms`)
  console.log('（API Key 不打印、不写文件）\n')

  const suites = {
    phase452: { name: 'Phase 4.5.2 最终验收 A–L', scenarios: phase452Scenarios },
    delete: { name: 'Phase 4.3.2 删除工具兼容性', scenarios: deleteScenarios },
    phase431: { name: 'Phase 4.3.1', scenarios: phaseScenarios },
    phase44: { name: 'Phase 4.4 失败恢复与可靠性', scenarios: phase44Scenarios },
    phase45: { name: 'Phase 4.5 执行历史与可观测性', scenarios: phase45Scenarios },
    legacy: { name: '历史场景', scenarios: legacyScenarios },
  }
  const selectedSuite = suites[process.env.MEMORA_SUITE ?? 'delete'] ?? suites.delete
  const suite = selectedSuite.scenarios
  const suiteName = selectedSuite.name
  let passed = 0
  const failures = []
  try {
    if (process.env.MEMORA_SKIP_PROBE === '1') {
      // 单独补跑场景时进程内没有上次请求时间：先留出一个额度窗口
      lastPromptAt = Date.now()
    }
    if (process.env.MEMORA_SKIP_PROBE !== '1') {
      console.log('[0] Tool Calling 兼容性探测 ...')
      try {
        const probe = await probeToolCalling(profile)
        passed += 1
        console.log(
          `  PASS ${probe.model} 支持 Tool Calling（${probe.tool}，finish=${probe.finishReason}，参数=${JSON.stringify(probe.args)}，${probe.elapsedMs}ms）`,
        )
      } catch (error) {
        failures.push({ name: 'Tool Calling 兼容性探测', error })
        console.log(`  FAIL ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        lastPromptAt = Date.now()
      }
    }

    const only = process.env.MEMORA_ONLY
      ? process.env.MEMORA_ONLY.split(',').map((item) => Number(item.trim()))
      : null
    console.log(`\n验收套件：${suiteName}（${suite.length} 个场景）\n`)
    const totalToolSteps = () =>
      runtime.assistant
        .getState()
        .messages.reduce((count, message) => count + (message.toolSteps?.length ?? 0), 0)
    for (const [index, scenario] of suite.entries()) {
      if (only && !only.includes(index + 1)) continue
      console.log(`[${index + 1}/${suite.length}] ${scenario.name} ...`)
      const requestsBefore = modelRequestCount
      const toolsBefore = totalToolSteps()
      try {
        const result = await scenario.run(runtime, profile)
        passed += 1
        console.log(
          `  PASS ${result.evidence} [模型请求=${modelRequestCount - requestsBefore}，工具步骤=${totalToolSteps() - toolsBefore}]`,
        )
      } catch (error) {
        failures.push({ name: scenario.name, error })
        console.log(
          `  FAIL ${error instanceof Error ? error.message : String(error)} [模型请求=${modelRequestCount - requestsBefore}，工具步骤=${totalToolSteps() - toolsBefore}]`,
        )
        // 失败时打印真实回答与步骤，便于人工判断是模型行为偏差、额度限制还是断言过窄
        const message = runtime.lastAssistantMessage()
        if (message) {
          console.log(
            `  实测：状态=${message.status} 阶段=${message.phase} 错误=${message.error?.message ?? '无'} 步骤=${(message.toolSteps ?? [])
              .map(
                (step) =>
                  `${step.tool}:${step.status}${step.blockedCode ? `/${step.blockedCode}` : ''}${step.needsInput ? '/needsInput' : ''}「${excerpt(step.message, 60)}」`,
              )
              .join(',') || '无'}`,
          )
          console.log(`  回答：${message.content.replace(/\s+/g, ' ').slice(0, 300)}`)
        }
      }
    }
  } finally {
    await runtime.close()
  }
  console.log(`\n# pass ${passed}`)
  console.log(`# fail ${failures.length}`)
  console.log(`# model requests ${modelRequestCount}`)
  if (failures.length > 0) process.exitCode = 1
}

await main()
