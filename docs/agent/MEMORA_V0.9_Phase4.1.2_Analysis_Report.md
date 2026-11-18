# MEMORA V0.9 Phase 4.1.2 分析报告：轻量意图识别与上下文辅助

> 状态：只读分析与实施方案，尚未实施。
>
> 本阶段只读取源码、测试和架构，未修改任何源码、测试、配置、数据库或既有文档。本文件是按用户要求输出的分析报告。Mock SSE 只能验证本地装配与数据流，不能代表真实模型行为。

---

## 0. 结论先行

1. 当前 Agent 没有本地意图分类器。聊天、查询、写入完全由模型根据 system prompt、工具定义和上下文自行决定。
2. 工具可用性目前是“全有或全无”：`contextEnabled` 为真时暴露全部 7 个工具，否则全部不暴露。所有“建议不要写、不要删、不要猜 ID”的约束目前都只存在于提示词层。
3. 建议新增一个**纯本地、无模型调用、无第三方依赖**的 `src/services/assistantIntent.ts`，在 `send()` 中只做一次预判，用于选择**只读工具范围、写入工具范围和对应提示词档位**。
4. 意图不是授权。它不产生目标 ID、不产生写入参数、不产生确认卡片，也不能替代执行层的参数校验、目标校验、删除确认和多闹钟授权。
5. 本阶段最重要的安全收益是：让明确的“咨询 / 建议 / 查询 / 否定 / 假设”场景默认拿不到写入工具；而不是让意图去决定“是否已经执行成功”。
6. 不建议在本阶段做硬性拦截模型越权返回的工具调用，也不建议改执行器或重写 Agent 循环。目标来源守卫、跨轮次写入恢复等仍应拆到后续阶段。

---

## 1. 当前 Agent 意图处理流程

### 1.1 实际调用链

```text
用户输入
  ↓
useAssistantStore.send()  trim / 空输入检查
  ↓
取消上一轮候选闹钟、失效未完成选择
  ↓
构造历史消息（仅文本，剥离 <action>，限制 12 条 / 8000 字）
  ↓
buildAssistantContext(entries, selectedId, contextEnabled)
  ↓
toolsAvailable = contextEnabled ? AGENT_TOOLS : null
systemContent = context.systemPrompt
              + (toolsAvailable ? AGENT_TOOL_PROMPT : NO_TOOL_PROMPT)
              + webBlock
  ↓
streamChat(..., toolsAvailable)
  ↓
模型返回文本 或 tool_calls
  ├─ 纯文本 → 结束并推导 phase
  └─ tool_calls
       ↓
     工具轮次检查（MAX_TOOL_ROUNDS = 8）
       ↓
     executeToolBatch() 串行执行
       ↓
     executeToolWithEnv()
       ├─ 查询工具：直接执行
       ├─ create_entry：直接写入 + 回读
       ├─ update_entry：直接写入 + 回读
       │    └─ 多闹钟且未授权 → 候选选择卡片，needsInput
       ├─ delete_entry：只创建删除确认卡片，不删除
       └─ 参数 / 目标 / 授权校验失败 → tool error
       ↓
     追加 tool 消息，继续下一轮
  ↓
最终文本 + deriveFinalPhase(done / partial / failed / needs_input)
```

关键入口：

- `src/store/useAssistantStore.ts:206`：`send()` 主流程。
- `src/store/useAssistantStore.ts:299`：构建上下文。
- `src/store/useAssistantStore.ts:391`：当前工具可用性只有 `AGENT_TOOLS` 或 `null` 两种。
- `src/store/useAssistantStore.ts:527`：轮次上限检查。
- `src/store/useAssistantStore.ts:565`：批量工具执行入口。
- `src/services/agentExecution.ts:138`：串行批量执行。
- `src/services/agentExecution.ts:34`：只读工具集合；`callsAreReadOnly()` 只用于 phase 文案，不是安全门。
- `src/services/agentToolSchema.ts:7`：7 个工具定义。
- `src/services/agentToolSchema.ts:160`：当前完整工具提示词。
- `src/services/agentToolSchema.ts:184`：工具不可用提示词。

### 1.2 当前“聊天 vs 工具调用”的判定方式

不是本地判定，而是模型判定：

- 模型看到完整工具定义后，自己决定返回普通文本还是 `tool_calls`。
- 只要返回了工具调用，本地就会进入执行器；本地不会先判断“这句话到底是不是写入意图”。
- 只读工具与写入工具的区别，是执行器根据工具名和参数执行的，不是发请求前的意图门禁。

因此当前架构中，“意图理解”实际上是模型内部行为，本地没有可复用的显式意图结果。

---

## 2. 现有问题清单与优先级

| 优先级 | 问题 | 现状证据 | 影响 | 本阶段处理 |
|---|---|---|---|---|
| P0 | 建议、假设、否定、能力咨询没有本地写入门禁 | 所有写入约束只在 `AGENT_TOOL_PROMPT` 第 11、13、17、19 条 | 模型可能把“帮我想几个待办”“如果创建提醒会怎样”执行成写入 | 用只读工具范围覆盖明确非写入意图 |
| P0 | 写入目标 ID 没有执行层来源守卫 | `update_entry` / `delete_entry` 只校验 ID 是否存在、类型是否正确 | 模型猜中一个真实 ID 时可能改错/删错目标 | 不在本阶段修复，留给 Phase 4.1.3 |
| P0 | `retry()` 会以新的请求作用域重放整段用户消息 | `retry()` 截断到最后一条用户消息后重新 `send()` | 已成功的 create/update 可能被重复执行 | 不在本阶段修复；报告中记录 |
| P1 | 同名目标去重仅靠提示词 | 搜索结果是文本提示，执行器不校验“目标是否唯一” | 模型可能默认第一条同名条目 | 意图层不解析目标；执行层守卫留给后续 |
| P1 | “刚才那个”缺少可信指代 | 历史只保留文本，工具调用和工具结果不进入历史；上下文预算还会截断 | 多轮后指代丢失，模型可能重新猜 ID | 对未解析指代降为只读，要求先查询/追问 |
| P1 | 同一批次中的多步调用彼此不可见 | 提示词要求“先查后写”，但同批次串行执行时模型看不到前一个结果 | 模型可能在同批写入中猜测 ID | 意图层只标记 `multi_step`，不改变执行顺序 |
| P1 | 工具范围全有或全无 | `toolsAvailable` 只有全量或 null | 咨询/查询场景也暴露写工具，增加误写概率 | 本次引入 `none / read / write` 三档 |
| P2 | 没有意图可观测性 | 无 intent 状态、无 intent 测试 | 无法回归验证“建议不写、否定不写” | 新增纯函数单元测试 |
| P2 | 提示词与工具集不匹配时模型容易困惑 | 当前只有完整工具提示词和“无工具”提示词 | 若只发只读工具却仍附加完整写工具提示词，模型会尝试不可用操作 | 为只读范围增加独立短提示词 |
| P2 | 跨轮次补充信息可能丢失写入意图 | 每轮独立判断，没有持久 intent | “帮我安排明天下午运动” → “下午3点”可能被当成普通聊天 | 让 `unknown` 保留全部工具，避免阻断补充回答；更严格的跨轮状态留后续 |

---

## 3. 八个分析问题的回答

### 3.1 Agent 如何区分聊天和工具调用？

当前没有本地区分。模型看到全部工具定义后自行决定：

- 普通聊天 → 返回文本；
- 查询 → 返回只读工具调用；
- 新建/修改 → 返回写入工具调用；
- 删除 → 返回 `delete_entry`，执行器只生成确认卡片。

本地只在收到 `tool_calls` 后执行，不先判断用户意图。因此“模型是否遵守提示词”是当前第一道、也是唯一一道软约束。

### 3.2 System prompt 和工具描述如何影响工具选择？

影响很大，但不是强制：

- system prompt 中的规则 11、13、17、19 明确要求区分建议、查询、写入、否定和不支持的能力。
- 工具 description 决定模型对参数和能力的理解，例如 `update_entry` 支持哪些字段、`delete_entry` 只生成确认卡片。
- 上下文中的 `<notes>`、当前选中条目、最近条目会影响模型是否认为“已经有足够信息”。

但提示词不能阻止模型误判，也不能阻止模型返回本地不期望的工具调用。它只能降低概率。

### 3.3 有哪些可复用上下文，能避免重复解析意图？

现有可复用的信息：

1. `selectedId` 与当前条目列表：`buildAssistantContext()` 已经把当前选中条目和最近条目放入上下文。
2. `AssistantMessage.toolSteps` / `toolActions` / `toolSelections`：这些是真实执行结果，可用于判断“刚才是否发生过写入”，但当前 `send()` 构造历史时没有把它们传给模型。
3. 上一条用户消息和上一条助手文本：可用于判断是否处于追问后的补充回答，但工具结果不进入历史，不能可靠还原目标。
4. `phase` 与 `needsInput`：只反映工具批次是否报告信息缺口，不覆盖模型纯文本追问。

本阶段建议只复用 `hasSelectedEntry` 这一项来确定“这个/当前”的指代是否可信，不把历史全文、工具结果或 ID 重新注入意图分析。理由是：意图模块不应成为第二套目标解析器。

### 3.4 意图应该在哪一层生成、传递、消费？

建议：

- **生成**：`useAssistantStore.send()` 中，在去除首尾空白之后、构建工具计划之前，只调用一次纯函数。
- **传递**：只传给同一个 `send()` 调用内的 `planAssistantTools()`，不写入数据库、不写入长期状态。
- **消费**：
  - 选择 `none / read / write` 工具范围；
  - 选择对应的提示词档位；
  - 记录 `reason` 供测试和调试；
  - 不消费于执行器、不消费于删除确认、不消费于闹钟授权、不消费于最终成功文案。
- **不传递**：不把意图作为参数传给 `executeAgentTool()`，不把意图写进工具参数，不把意图当作授权凭证。

### 3.5 独立意图模块是否必要？

建议需要，但必须是**纯函数、小模块、无模型调用**。

理由：

- 如果直接把正则和规则写进 `send()`，测试只能走完整 store，成本高、耦合重。
- 独立模块可以单独测试“否定、假设、建议、查询、写入、指代、混合任务”等边界。
- 独立模块可以明确限制职责：只输出意图标签和工具范围，不输出 ID、不输出目标、不输出授权。
- 不需要 LangChain、AutoGen、MCP、第三方 NLU 或额外模型调用。

不推荐把意图做成持久化的 `IntentProfile`，也不推荐做置信度校准模型。当前阶段只需要确定性规则。

### 3.6 如何防止意图和真实执行结果背离？

原则：**意图只做预判，执行结果只以工具记录为准。**

- 最终回复必须依据 `toolSteps`、`toolActions`、`confirmCards` 和 `deriveFinalPhase()`，不能依据“意图说应该创建”就声称创建成功。
- `delete` 意图只表示“可能想删除”，不代表已删除；仍然必须走删除确认卡片。
- `update` 意图不代表目标有效；仍然必须通过参数校验、目标存在校验和回读。
- 多闹钟场景中，`alarm_id` 仍然不是授权；仍然由候选卡片和用户点击产生一次性授权。
- 本阶段不新增“意图—执行结果对账器”。对账应依赖现有执行记录，而不是再引入一套事实来源。

### 3.7 多轮对话中是否存在意图丢失、覆盖、误判风险？

存在，主要风险：

1. **指代丢失**：历史不含工具结果，且上下文有预算截断，“刚才那个”可能没有可信目标。
2. **补充回答被误判**：第一轮“帮我安排明天下午运动”是 create，第二轮“下午3点”本身没有写入动词，容易被判成聊天或查询。
3. **后续否定覆盖前一轮**：前一轮是 update，后一轮“算了，不要改”必须重新判为否定，不能继承上一轮写入意图。
4. **追问后的确认**：“可以，就那个”依赖前文目标；没有可信目标时不能直接写。
5. **重试放大**：`retry()` 会重新发送用户消息，已成功的写入可能再次发生。
6. **历史截断**：多轮后旧的工具结果和旧的目标信息会丢失。

本阶段的处理策略：

- 意图每轮重新计算，不从上一条助手消息继承写入授权。
- `unknown` 不降为只读，避免“下午3点”这类补充回答被工具范围直接阻断；但仍要求模型先追问，执行层校验不变。
- 对“刚才那个/上一个”这类无法从当前选中条目解析的指代，降为只读，迫使模型先查询或追问。
- 不解决 `retry()` 重复写入，记录为后续问题。

### 3.8 一句话包含多个目标时如何处理？

意图层只做粗分类，不做目标拆解：

- 多个同一操作，例如“创建三个待办”：归为 `create`，允许写入工具；由模型逐条调用，执行器串行执行。
- 混合操作，例如“把 A 改成已完成，把 B 删掉”：归为 `multi_step`，允许全部工具；提示词要求先查询、确认目标、逐条执行。
- 查询后依赖结果写入，例如“查一下明天的待办，然后把没完成的整理成备忘”：归为 `multi_step`；同一批次不能假设查询结果可见，必须等下一轮。
- 目标不唯一、同名、多个候选闹钟：意图层不选目标，不生成 ID；由执行层返回错误或候选卡片。
- 任一步骤缺少目标/时间/内容：不继续执行依赖该输入的写入；先问一个关键问题。

---

## 4. 推荐的数据结构

建议把用户提出的结构收敛为下面这样，避免把“意图”做成第二套授权系统：

```ts
export type AssistantIntent =
  | 'chat'
  | 'suggest'
  | 'search'
  | 'create'
  | 'update'
  | 'delete'
  | 'multi_step'
  | 'unknown'

export type IntentConfidence = 'high' | 'medium' | 'low'

export type IntentReason =
  | 'explicit_write'
  | 'advice'
  | 'query'
  | 'negated_write'
  | 'hypothetical'
  | 'referent_ambiguous'
  | 'referent_resolved'
  | 'mixed_actions'
  | 'no_signal'

export interface IntentAnalysis {
  intent: AssistantIntent
  confidence: IntentConfidence
  requiresClarification: boolean
  reason: IntentReason
}

export interface IntentContext {
  /** 当前是否有用户选中的条目，仅用于判断“这个/当前”的指代 */
  hasSelectedEntry: boolean
}
```

### 字段必要性

| 字段 | 为什么需要 | 不应该做什么 |
|---|---|---|
| `intent` | 决定使用 `none / read / write` 哪档工具与提示词 | 不决定是否已执行成功 |
| `confidence` | 区分明确指令与模糊表达；低置信度不冒充确定意图 | 不用数值假装概率校准；不因高置信度跳过执行层校验 |
| `requiresClarification` | 标记“目标或关键信息尚不明确”，用于未解析指代的只读降级和测试断言 | 不直接生成追问文案；不替代执行器的 `needsInput` |
| `reason` | 让策略、日志和测试可复现，避免依赖自由文本 | 不作为权限、目标或参数来源 |
| `IntentContext.hasSelectedEntry` | 只解决“这个/当前”这类可由选中条目解析的指代 | 不把条目内容当指令；不用于“刚才那个”的自动猜测 |

不加入：

- `needs_input` 意图值：已有 `AssistantPhase.needs_input` 和工具返回的 `needsInput`，再增加一个同义枚举会造成状态重复。
- `targetId` / `id` / `allowedFields` / `writeIntent`：这些属于执行授权或派生态，不能让意图模块持有。
- `confidence: number`：启发式规则没有真实概率意义，离散档位更诚实、更容易测试。

---

## 5. 与当前架构的接入方式

### 5.1 接入点

只在 `useAssistantStore.send()` 内增加一次预判：

```ts
const intent = analyzeAssistantIntent(content, {
  hasSelectedEntry: Boolean(selectedId),
})

const toolPlan = planAssistantTools(intent, {
  contextEnabled: state.contextEnabled,
})
```

然后用 `toolPlan.tools` 和 `toolPlan.prompt` 替换当前：

```ts
const toolsAvailable = state.contextEnabled ? AGENT_TOOLS : null
const systemContent = [
  context.systemPrompt,
  toolsAvailable ? AGENT_TOOL_PROMPT : NO_TOOL_PROMPT,
  webBlock,
].filter(Boolean).join('\n\n')
```

不改变后半段 `streamChat`、`executeToolBatch`、轮次上限和错误降级逻辑。

### 5.2 工具范围策略

建议第一版只做三档，不做“只给 create_entry”这种精细白名单，避免误判后阻断合法写入：

| 意图分析结果 | 工具范围 | 提示词 |
|---|---|---|
| `chat` | `none` | `NO_TOOL_PROMPT` |
| `suggest` / `search` | `read` | 新增只读提示词 |
| 明确否定、假设、能力咨询 | `read` | 新增只读提示词 |
| `create` / `update` / `delete` / `multi_step` | `write` | 现有 `AGENT_TOOL_PROMPT` |
| `unknown` | `write` | 现有 `AGENT_TOOL_PROMPT` |
| `update` / `delete` 且指代为“刚才那个/上一个”且无可信选中目标 | `read` | 新增只读提示词 |
| `contextEnabled = false` | `none` | `NO_TOOL_PROMPT` |

几个刻意选择：

1. **`unknown` 保留全部工具**：这是为了不阻断“下午3点”这类补充回答。它不是授权；模型仍必须按提示词追问，执行层仍会校验。
2. **明确建议/查询使用只读工具**：这是本阶段最主要的误写防护。
3. **“这个/当前”可由选中条目解析，“刚才那个”不可自动解析**：历史中没有工具结果，不能假装知道“刚才那个”的 ID。
4. **不硬拦截模型返回范围外工具**：执行器仍然是实际执行层；本阶段不在 `send()` 里改写 `tool_calls` 或改变执行机制。
5. **新增只读提示词必须短于完整提示词**：这样不会增加额外 Token 消耗，反而会减少非写入场景的提示词体积。

### 5.3 为什么不把意图写进 system prompt

用户明确要求“不增加额外 Token 消耗”。把意图标签、候选目标或解释注入 system prompt 会增加每轮 token，而且会把一个可能错误的预判变成模型上下文。第一版只在本地选择工具和提示词档位，不注入意图文本。

---

## 6. 预计修改文件清单

| 文件 | 操作 | 原因 | 风险 |
|---|---|---|---|
| `src/services/assistantIntent.ts` | 新增 | 纯函数意图分类与工具计划 | 规则误判；需充分单测 |
| `src/services/agentToolSchema.ts` | 修改 | 增加只读提示词，保持现有完整提示词不变 | 提示词与工具范围不匹配需测试 |
| `src/store/useAssistantStore.ts` | 修改 | 在 `send()` 中加入一次预判和工具计划选择 | 不改循环主体；需回归全部 Agent 测试 |
| `tests/assistantIntent.test.ts` | 新增 | 15 类意图与工具范围测试 | 无 |
| `tests/prompts.test.ts` | 修改 | 增加只读提示词边界断言 | 无 |
| `scripts/run-integration-tests.mjs` | 可选修改 | 增加“请求中 tools 数组随意图变化”的装配测试 | Mock 只能验证装配，不代表真实模型 |

不修改：

- `src/services/agentToolExecutor.ts`
- `src/services/agentExecution.ts`
- `src/services/alarmSelections.ts`
- `src/services/alarmSelectionExecution.ts`
- `src/services/deleteProposals.ts`
- `src/services/deleteExecution.ts`
- SQLite schema / Rust SSE / `package.json`

---

## 7. 需要新增的测试用例

### 7.1 十五类意图测试

| # | 输入示例 | 期望意图 | 期望工具范围 | 关键断言 |
|---|---|---|---|---|
| 1 | “你好，今天有点累” | `chat` | `none` | 不产生写入工具 |
| 2 | “你能帮我创建提醒吗？” | `suggest` | `read` | 能力咨询不直接创建 |
| 3 | “帮我找一下上周的会议纪要” | `search` | `read` | 只读工具 |
| 4 | “新建一条备忘：明天买牛奶” | `create` | `write` | create 直接执行，无确认卡片 |
| 5 | “提醒我明天下午三点开会” | `create` | `write` | 创建提醒不等同于多闹钟授权 |
| 6 | “把会议纪要的正文补充一下” | `update` | `write` | 更新直接执行，仍需参数校验 |
| 7 | “删除上周那条临时备忘” | `delete` | `write` | 执行器只返回确认卡片，不删除 |
| 8 | “帮我想几个待办事项” vs “帮我创建一个待办事项” | `suggest` vs `create` | `read` vs `write` | 建议不写，明确创建才给写工具 |
| 9 | “查一下明天的待办，然后把没完成的整理成备忘” | `multi_step` | `write` | 先查询，不能同批假设查询结果 |
| 10 | “帮我弄一下那个东西” | `unknown` | `write` / 需追问 | 不猜测目标、时间或操作 |
| 11 | “把标题为会议纪要的改成已完成” | `update` | `write` | 意图不产生目标 ID；同名目标仍由执行层/提示词处理 |
| 12 | “把那个提醒的时间改一下” | `update` | `write` | 多闹钟仍走候选卡片，`alarm_id` 不是授权 |
| 13 | “不要创建提醒” | 非写入 | `read` / `none` | 否定词不能被写成 create |
| 14 | “如果创建一个提醒会怎样？” | `suggest` | `read` | 假设句不执行写入 |
| 15 | “把刚才那个改一下” | `update` + `requiresClarification` | `read`（无可信选中目标） | 不猜测“刚才那个”的 ID |

补充指代测试：

- “把这个当前便签改一下” + 有选中条目 → `update`，允许写。
- “把刚才那个改一下” + 即使有选中条目 → 仍视为指代未解析，先查询/追问。
- “算了，不要改了” → 否定，不写入。

### 7.2 安全边界测试

必须证明意图不绕过现有安全机制：

1. `create` 意图不会自动生成确认卡片；仍需执行器实际写入并回读。
2. `update` 意图不会跳过 `agentToolArgs` 的目标、字段和值校验。
3. `delete` 意图仍然只生成删除确认卡片，未点击前条目不消失。
4. 多闹钟更新仍然生成候选选择卡片；模型传入的 `alarm_id` 不构成授权。
5. 未知目标 ID 仍然被执行器拒绝；意图层不提供 ID 兜底。
6. 已失效/已使用的闹钟候选授权不能因为意图为 `update` 而重放。
7. 请求停止后，意图预判不会让已中止批次继续执行。
8. 只读工具范围下，模型返回的请求中 `tools` 数组不包含写入工具；但需注明“本地不硬拦截模型无视工具列表返回的调用”。

### 7.3 多轮与装配测试

- “帮我安排明天下午运动” → “下午3点”：第二轮 `unknown` 仍保留写入工具，不能被工具范围直接阻断。
- 上一轮候选闹钟卡片未确认，下一轮新任务开始仍会失效旧授权。
- Mock SSE 捕获请求体，断言不同输入对应不同 `tools` 数组；明确这只是装配测试，不是真实模型意图准确率测试。

---

## 8. 对现有行为的风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| 规则误判为只读 | 用户实际想写入，但被降为只读，模型无法调用写工具 | 只对高置信度非写入意图降级；`unknown` 保留全部工具；用户可改写明确指令 |
| 规则误判为写入 | 建议句被当成写入，仍可能误写 | 写入范围不构成授权；提示词、参数校验、目标校验、删除确认仍在 |
| 多轮补充回答丢失 | “下午3点”没有写入动词 | `unknown` 保留写入工具；更严格的跨轮意图继承留后续 |
| 工具范围与提示词不匹配 | 只读工具却附加完整写提示词，模型会尝试不可用工具 | 新增独立只读提示词，短于完整提示词 |
| 现有测试假设全量工具 | 现有集成测试可能断言 `tools` 全量存在 | 实施时只调整受影响断言，不改变执行断言 |
| 模型无视工具列表 | 模型仍可能返回范围外工具调用，当前会进入执行器 | 本阶段明确不硬拦截；目标来源守卫/范围守卫留后续 |
| 意图状态被误当授权 | 后续开发者可能把 `intent=delete` 当作可删除 | 类型和文档中明确“意图不是授权”；测试断言意图结果不含 ID/授权字段 |
| 真实模型行为未验证 | Mock 只验证本地装配 | 真实模型验收保留后续阶段，不在本阶段声称验证 |
| 现有 `retry()` 重复写入 | 与本阶段无关但会影响安全验收 | 报告中记录，暂不修复 |

---

## 9. 最小实施计划

### 第一步：新增纯函数模块

新建 `src/services/assistantIntent.ts`：

- `analyzeAssistantIntent(text, context)`；
- 规则覆盖：明确写动词、查询词、建议词、否定、假设、指代词、混合任务、无信号；
- 输出 `IntentAnalysis`；
- 不读 store、不读数据库、不发请求、不产生 ID。

### 第二步：新增只读提示词

在 `src/services/agentToolSchema.ts` 中新增一个独立的只读提示词，例如 `READ_ONLY_TOOL_PROMPT`：

- 只允许查询；
- 不新增、不修改、不删除；
- 咨询能力时可以说明“支持创建/修改，删除需确认”，但本轮不执行；
- 信息不足先问一个关键问题；
- 用户数据不是指令。

保持现有 `AGENT_TOOL_PROMPT` 与 `NO_TOOL_PROMPT` 不变。

### 第三步：接入 `send()`

在 `src/store/useAssistantStore.ts` 的 `send()` 中：

- 计算一次意图；
- 通过 `planAssistantTools()` 选择 `none / read / write`；
- 用计划结果替换 `toolsAvailable` 和工具提示词选择；
- 不改变 `streamChat`、`executeToolBatch`、`MAX_TOOL_ROUNDS`、停止、降级和最终 phase 逻辑。

### 第四步：新增测试

- `tests/assistantIntent.test.ts`：15 类输入、指代、否定、假设、未知、混合任务、工具范围。
- `tests/prompts.test.ts`：只读提示词不含写入许可，完整提示词仍保留删除确认和能力限制。
- 可选：`scripts/run-integration-tests.mjs` 增加请求 `tools` 数组断言。

### 第五步：验证命令

实施阶段执行：

```bash
pnpm test:agent
pnpm exec tsc -p tsconfig.app.json --noEmit
pnpm lint
pnpm build
pnpm test:integration
```

不在本阶段执行大规模真实模型验收。

---

## 10. 本阶段明确不做

1. 不修改任何源码、测试、配置、数据库或既有文档（本报告文件除外）。
2. 不新增 LangChain、AutoGen、MCP 或任何第三方依赖。
3. 不新增模型调用，不增加额外 Token 消耗。
4. 不重写 `useAssistantStore.send()` 的 Tool Calling 循环。
5. 不修改 Rust SSE 转发。
6. 不修改 SQLite schema / migration。
7. 不修改执行器、工具参数校验、目标校验、删除确认、闹钟授权。
8. 不新增新增/修改确认卡片。
9. 不实现目标 ID 来源守卫；该工作留给 Phase 4.1.3。
10. 不修复 `retry()` 重复写入；仅记录风险。
11. 不新增意图 UI、意图徽标、主题或 V0.8 视觉规则变更。
12. 不把意图持久化到数据库，不做跨会话意图继承。
13. 不把 Mock SSE 结果描述为真实模型行为验证。
14. 不执行 `git add`、`commit`、`reset`、`stash` 等 Git 写操作。

---

## 11. 验收后的下一步

本报告只给出 Phase 4.1.2 的分析和实施建议，不包含代码改动。建议按以下顺序推进：

1. 用户确认本报告与工具范围策略。
2. 实施纯函数意图模块与单元测试。
3. 实施只读提示词与 `send()` 接入。
4. 运行 Agent 测试、类型检查、Lint、构建和集成测试。
5. 统一进行真实模型验收；Mock SSE 不作为真实意图准确率依据。
6. 进入 Phase 4.1.3，单独处理目标 ID 来源守卫、同名目标与跨轮次写入安全问题。