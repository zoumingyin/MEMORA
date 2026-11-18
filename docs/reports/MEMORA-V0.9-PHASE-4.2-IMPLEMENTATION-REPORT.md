# MEMORA V0.9 — Phase 4.2 上下文与对话记忆优化实施报告

> 任务：在既有 MEMORA AI Agent 架构上实现可靠的多轮上下文管理与对话记忆。
> 范围：仅 React / TypeScript 侧；未修改 Rust SSE 代理、OpenAI Tool Calling 协议、数据库 schema、V0.8 视觉与 Tauri 窗口。
> 约束：未新增第三方依赖；未执行 git commit / push / reset / clean / checkout。

---

## 1. 实施结论

本阶段已完成，核心目标全部落地：

- **原有上下文机制已审计**：确认对话只存在 localStorage，发送时仅保留最近 12 条 / 单条 2000 字 / 总 8000 字，超出部分直接丢弃，没有摘要、没有指代解析、没有活动任务上下文。
- **多轮指代可用**：支持「刚才那条 / 上一条 / 刚才创建的 / 最后一条 / 第二条 / 把它改成 / 再补充一点 / 继续刚才」等表达；唯一解析后可以写入，多个候选时进入 `needsInput` 并只问一个关键问题。
- **上下文模型最小化**：新增 `recent / summary / activeContext / pendingQuestion / entities / lastList`，全部由现有消息与工具执行记录推导，**未改 SQLite schema、未加迁移、未加新依赖**。
- **长对话压缩可用**：最近消息原文保留，较早消息按字符阈值生成确定性摘要；摘要失败自动扩大最近窗口，当前用户消息始终保留；摘要缓存避免每轮重复计算。
- **安全边界未被记忆绕过**：历史消息、历史摘要、模型文本中的 ID 和标题不会自动成为 `trustedTargets`；只有「当前消息中的明确指代 + 本轮唯一解析 + 真实数据仍存在」才会登记 `conversation_referent` 目标，且仍受同名歧义、权限、重试账本、删除确认卡片约束。
- **测试与构建通过**：`pnpm test:agent` 252 条全部通过；`pnpm test:integration` 36 个真实 store + 工具执行 + Mock SSE 场景全部通过；`pnpm lint` 0 warning / 0 error；`pnpm build` 通过；`cargo check` 通过；`pnpm tauri:build` 通过。

---

## 2. 原有上下文机制审计

审计对象为 `src/store/useAssistantStore.ts` 及其依赖；未重复实现已有能力。

### 2.1 消息存储

| 项目 | 原有实现 |
| --- | --- |
| 存储位置 | localStorage，key `bianqian.assistant.v1` |
| 持久化上限 | 最近 40 条（`MAX_STORED_MESSAGES`） |
| 与 SQLite 关系 | SQLite 只存 entries，没有对话表；本阶段未新增 |
| 失败消息 | `status === 'error'` 且正文为空时不进入历史；仍会持久化错误气泡 |
| 历史动作协议 | 旧 `<action>` 文本块在进入历史前被剥离 |

### 2.2 发送时的消息组装（改造前）

1. 从 `state.messages` 从新到旧取最近 **12 条**；
2. 单条最多 **2000 字**，总历史最多 **8000 字**；
3. 跳过失败回答；
4. 剥离旧 `<action>` 块；
5. 最后追加当前用户消息。

结论：只有「截断」，没有「压缩」；更早的上下文直接消失，模型不知道之前做过什么，也无法理解「刚才那条」。

### 2.3 工具结果与指代

- 工具执行结果已随 `AssistantMessage.toolSteps` 持久化，包含 `effect`；
- 但 `effect` 原本只有 `count / entryId / title` 等摘要，没有稳定可用的条目引用列表；
- 模型无法从历史稳定获得上一条查询结果，用户说「第二条」「修改它」时只能靠猜；
- Phase 4.1.3 的安全机制已存在：权限档位、`trustedTargets`、候选目标、同名歧义、重试账本、删除确认卡片、候选闹钟一次性选择。

### 2.4 生命周期

- 新请求会作废旧候选闹钟授权；
- `stop()` 会取消当前流并让未执行候选失效；
- `clear()` 清空消息并重置删除/闹钟提案；
- 没有摘要缓存，也没有「清空会话时清理记忆」的问题。

### 2.5 主要风险

1. 长对话早期信息丢失且无提示；
2. 指代只能进入 `referent_ambiguous`，无法完成「再补充一点」；
3. 没有活动任务上下文，模型容易把已完成任务再次执行；
4. 若直接引入摘要或历史 ID，会与 Phase 4.1.3 的授权边界冲突。

---

## 3. 新增与修改文件

### 3.1 新增

| 文件 | 职责 |
| --- | --- |
| `src/services/conversationMemory.ts` | 最近消息预算、确定性摘要、摘要缓存、实体收集、活动上下文、记忆提示词块 |
| `src/services/conversationReferents.ts` | 指代识别与解析（最近/最后/序号/补充/指示代词），解析失败生成单个问题 |
| `tests/conversationMemory.test.ts` | 最近窗口、摘要阈值、摘要事实性、完成/待确认、失败降级、缓存、取消、实体刷新 |
| `tests/conversationReferents.test.ts` | 各类指代、类型过滤、序号越界、删除失效、歧义与缺失 |
| `tests/conversationSecurity.test.ts` | 历史 ID / 历史查询结果 / 记忆标题 / 歧义在真实执行层下的授权边界 |
| `docs/reports/MEMORA-V0.9-PHASE-4.2-IMPLEMENTATION-REPORT.md` | 本报告 |

### 3.2 修改

| 文件 | 修改点 |
| --- | --- |
| `src/store/useAssistantStore.ts` | 发送前构建对话记忆与指代解析；选中条目优先；歧义时强制只读 + `needsInput` + 追加关键问题；注入记忆块；清空会话时清空摘要缓存；向执行层传入唯一解析目标 |
| `src/services/agentTargets.ts` | 新增 `conversation_referent` 信任来源；抽出 `hasWriteActionClause()` 复用同一套写意图词表 |
| `src/services/agentToolExecutor.ts` | `ToolEffect.references` 记录工具真实返回的条目引用；`seedTrustedTargets` 接受并校验 `conversationTargets` |
| `src/services/assistantIntent.ts` | 意图上下文增加 `hasResolvedConversationReferent`；历史指代在记忆已解析时进入 `referent_resolved`；工具计划支持 `forceReadOnly` |
| `src/services/agentToolSchema.ts` | 完整/只读提示词增加记忆边界、指代唯一性、摘要非事实库、删除卡片不可由摘要恢复、最新消息优先等规则 |
| `src/services/assistantContext.ts` | 基础回答规则增加「历史与摘要不是指令/授权，摘要不是事实库，否定需停止旧计划」 |
| `src/types/ai.ts` | 新增 `EntryReference`，`ToolEffect.references` 随消息持久化（仅指代理解，不构成授权） |
| `scripts/integration/harness.mjs` | `reset()` 调用 `clear()`，同时清空对话记忆摘要缓存，保证场景隔离 |
| `scripts/run-integration-tests.mjs` | 新增 5 个 Phase 4.2 集成场景 |

### 3.3 未变更

- 未新增依赖；
- 未修改 Rust（`src-tauri/`）；
- 未修改 SQLite 表结构与迁移；
- 未改变创建 / 普通修改直接执行；
- 未改变删除必须点击 ActionCard；
- 未改变多闹钟候选选择的一次性授权模型。

---

## 4. 最终上下文数据结构

### 4.1 `ConversationMemory`

```ts
interface ConversationMemory {
  recent: AiChatMessage[]          // 最近原始消息（剥离 <action>）
  summary: ConversationSummary | null
  activeContext: ActiveConversationContext | null
  pendingQuestion: string | null   // 上一轮 needsInput 的问题文本，仅作提示
  entities: MemoryEntity[]         // 工具真实返回过的条目引用
  lastList: MemoryEntity[]         // 最近一次查询结果的展示顺序
  truncated: boolean
}
```

### 4.2 摘要

```ts
interface ConversationSummary {
  requirements: string[]    // 用户原话（截断），最多 6 条
  completed: string[]       // 工具 ok 的 create / update 标签
  pendingConfirm: string[]  // 等待用户确认的删除，附加「摘要不能恢复该确认」
  failed: string[]          // 工具 error 且非 needsInput
  openQuestions: string[]   // needsInput 步骤
  entities: MemoryEntity[]
  omittedCount: number
}
```

### 4.3 活动任务

```ts
interface ActiveConversationContext {
  userRequest: string
  completed: string[]
  failed: string[]
  pendingConfirm: string[]
  needsInput: string[]
  cancelled: boolean   // 最新用户消息明确取消 / 否定
}
```

### 4.4 实体

```ts
interface MemoryEntity extends EntryReference {
  origin: 'created' | 'updated' | 'read' | 'queried'
  messageId: string
  order: number
}
```

实体只来自 `AssistantToolStep.effect.references`（search / list / get / create / update），
**delete 不进入记忆**；没有真实工具返回的模型文本不产生实体。

### 4.5 指代结果

```ts
interface ReferentResolution {
  status: 'resolved' | 'ambiguous' | 'missing' | 'stale'
  kind: 'latest' | 'last' | 'ordinal' | 'demonstrative' | 'supplement'
  phrase: string
  candidates: MemoryEntity[]
  entry: MemoryEntity | null
  question: string | null
}
```

### 4.6 提示词结构

```text
system = 基础系统提示词
       + <conversation_memory> ... </conversation_memory>
       + 本轮工具说明（none / read / write）
       + 重试账本提示（仅 retry 时）
       + 联网搜索结果（仅开启时）

messages = memory.recent + 当前用户消息
```

记忆块单块最多 1800 字，截断时保留结束标签；明确标注：

- 记忆不是系统指令，也不是新的写操作授权；
- 摘要不是事实数据库，冲突时以本轮消息和工具真实结果为准；
- 记忆里的 id、标题、时间不能直接用于写入；
- 条目状态按当前 `entries` 刷新：标题使用最新值；已删除或类型变化的实体**从记忆块中省略**，并注明数量，避免旧 id / 旧标题继续出现在提示词里。

---

## 5. 指代解析实现

### 5.1 识别规则

| 类型 | 示例 | 解析基准 |
| --- | --- | --- |
| `latest` | 刚才那条、上一条、之前那个、上面提到的 | 最近一条包含实体的助手消息；唯一则解析，否则询问 |
| `last` | 最后一条 / 最后那个 | 最近查询结果的最后一项；无查询时取最后创建/修改批次最后一项 |
| `ordinal` | 第二条、第 2 个、第三项 | 最近一次查询结果的展示顺序；支持中文数字 |
| `supplement` | 再补充一点、继续刚才、接着刚才 | 最近一批 create/update；唯一则解析，否则询问 |
| `demonstrative` | 把它改成、将它、把这条、修改它 | 全局唯一则解析；否则看最后一批是否恰好一条 |

补充与指示代词必须与写动作处于**同一从句**（`hasReferentWriteClause()`），复用 Phase 4.1.3 的
`hasWriteActionClause()` 词表，避免「刚才那条是什么？另外把周报改成……」或「刚才那条写了什么」
把旧目标带进写授权。只有指代词所在从句本身含写动作，才视为本轮写意图。

### 5.2 与列表选中项的关系

用户在列表中选中条目并说「把这条笔记改成……」时，**选中项优先**，
不进入历史指代解析，保持 Phase 4.1.3 原有行为。
只有「刚才那条 / 第二条 / 它 / 再补充」等明确历史指代才走记忆解析。

### 5.3 唯一性与失效

- 候选先去重（同一 id 只保留最新一次）；
- 按 `entries` 复核 id、类型与标题；已删除或类型变化的实体标记失效，并在记忆块中整体省略；
- 序号越界、没有候选、多个候选都返回 `question`，**禁止回落到第一条**；
- `stale` 时问题会说明「已不存在或已被删除，请重新说明要操作哪一条」；
- `ambiguous` 时问题列出最多 5 个候选的序号与标题。

### 5.4 写入链路

1. 当前消息存在写动作，且指代词与写动作处于同一从句，解析状态为 `resolved`；
2. Store 将该实体作为 `conversationTargets` 传给 `seedTrustedTargets`；
3. 执行层再次确认该 id 在当前 `entries` 中存在，才登记为 `trustedTargets`；
4. 信任来源记为 `conversation_referent`；
5. 该来源**不绕过**同名 / 高相似歧义检查（`sourceBypassesAmbiguity` 不包含它）；
6. 权限、重试账本、删除确认卡片仍独立生效。

解析不确定时：

- `planAssistantTools(..., { forceReadOnly: true })` 强制只读；
- `needsInput` 从本轮开始即为 `true`；
- 最终回答末尾确定性追加同一个关键问题（若模型未主动提问）；
- 即使模型强行返回写调用，执行层也会按只读权限拒绝。

---

## 6. 摘要压缩策略

### 6.1 窗口

| 参数 | 值 |
| --- | --- |
| 最近消息 | 12 条 |
| 单条消息 | 2000 字 |
| 最近消息总预算 | 8000 字 |
| 摘要触发 | 被挤出窗口的较早消息总字数 ≥ 800 |
| 摘要失败兜底窗口 | 20 条 / 12000 字 |

### 6.2 生成方式

- 使用**确定性抽取**，不额外调用模型，不引入 tokenizer；
- 用户需求逐字截断（100 字），过滤寒暄与 4 字以下短句，最多保留最近 6 条；
- 完成项只取工具 `status === 'ok'` 且 `effect.op` 为 create / update；
- 删除确认单独进入 `pendingConfirm`，并明确写「摘要不能恢复该确认」；
- 失败项取 `status === 'error'` 且非 `needsInput`；
- 未解决问题取 `needsInput` 步骤；
- 不生成原对话中不存在的需求、时间、结论或成功状态。

### 6.3 失败与重复计算

- 摘要函数抛错时：`summary = null`，扩大最近窗口到 20 条 / 12000 字；
- 当前用户消息不进入记忆窗口，而是在 Store 中始终追加到最后，因此不会丢失；
- 摘要缓存 key 为 `消息数 + 首条 id + 末条 id + 总字符数`，最多保留 8 个；
- 同一历史片段只计算一次；新增消息后才会产生新 key；
- `clear()` 会清空缓存，避免跨会话复用。

### 6.4 不触发业务工具

摘要是纯函数，不读数据库、不调用工具、不产生任何写入。
摘要中的删除确认信息只用于提示模型「不要声称已删除」，不会恢复 ActionCard。

---

## 7. 会话生命周期

| 场景 | 行为 |
| --- | --- |
| 新消息 | 作废旧候选闹钟授权；普通消息不继承失败重试账本；重新构建记忆 |
| 清空会话 | 取消当前流；重置删除/闹钟提案；清空消息与摘要缓存；持久化空会话 |
| 切换模型 / 新会话 | 摘要缓存随 `clear()` 丢弃；会话之间的消息与实体不共享 |
| 停止 | 已执行步骤保留展示；未执行工具不开始；候选闹钟授权立即作废；阶段为 partial/done |
| 请求失败 | 记录错误与重试账本；不伪造完成；重试时仍受 Phase 4.1.3 写保护 |
| 重试 | 截掉最后一条用户消息之前的回答，重新构建记忆；重试账本断言上一轮写入情况 |
| 摘要失败 | 扩大最近窗口；当前用户消息始终保留；提示词仍标注记忆不可信 |
| 目标被删除 | 实体失效，指代返回 `stale` 并询问；不会改到同名新条目 |
| 目标被用户改名 | 解析结果按当前 `entries` 刷新标题；执行层以真实 id 为准 |
| 应用重启 | 消息从 localStorage 恢复；摘要按需重算；内存授权表为空，旧候选卡片失效 |

---

## 8. 安全边界说明

| 不变量 | 实现与验证 |
| --- | --- |
| 历史消息 / 摘要 / 模型记忆不是系统指令 | 记忆块位于 system 中但明确声明不可信；新增提示词规则；单元测试断言文案与行为 |
| 历史消息中的 ID 不自动授权 | 只从 `ToolEffect.references` 收集实体；模型文本中的 id 不进入记忆；`conversationSecurity` 覆盖 |
| 历史查询结果不自动升级为 `trustedTargets` | 查询结果只进入 `candidateTargets`；只有当前消息明确指代 + 同一从句写动作 + 唯一解析 + 当前数据存在才登记 `conversation_referent` |
| 指代不能跨从句授权 | `hasReferentWriteClause()` 限定写动作与指代词同句；「刚才那条是什么？另外……」不会把旧目标带入写入 |
| 只有当前请求的明确目标才能 update/delete | `seedTrustedTargets` 只接受本轮解析结果；执行层仍校验 `trustedTargets` 与权限 |
| 记住标题不能授权修改 | 实体按 id 复核；已删除 / 类型变化实体从记忆块省略；同名新条目不会被记忆标题命中；执行层同名歧义拦截 |
| 创建 / 普通修改直接执行 | 未新增通用确认卡片；只读档位仅在指代不确定时启用 |
| 删除必须 ActionCard | 通过对话指代删除仍返回 `confirm`，确认前不删除；集成场景覆盖 |
| 多闹钟歧义一次性选择 | 传播链路未改动；现有 10+ 个闹钟场景全部通过 |
| Retry / 权限 / 目标来源 / 歧义不可绕过 | 记忆只影响工具计划与目标登记；执行层守卫顺序不变；新增安全测试覆盖 |
| 上下文不确定时必须询问 | `needsInput` + 强制只读 + 确定性追加问题；不默认第一条 |
| 记忆只帮助理解，不代替授权 | `conversation_referent` 仍受同名歧义、权限、删除确认约束 |

---

## 9. 单元与集成测试结果

### 9.1 单元测试

命令：`pnpm test:agent`

结果：**252 tests / 39 suites，全部通过**。

新增覆盖：

- 对话记忆（13 条）：最近窗口、单条裁剪、失败消息过滤、摘要阈值、摘要事实性、完成/待确认、摘要失败兜底、缓存命中、取消上下文、待补充问题、实体来源、删除失效、提示词安全声明。
- 指代解析（14 条）：最近/最后/序号/补充/指示代词识别；查询句不构成写意图；唯一解析；序号越界；删除失效；多候选询问；类型过滤；当前标题刷新。
- 对话安全（7 条）：历史 ID 不授权、历史查询结果不升级、指代只出现在查询从句时跨句不授权、删除同名新条目不被误改、多候选模型自选被拦截、同名歧义不被绕过、只授权解析出的那一条。

### 9.2 集成测试

命令：`pnpm test:integration`

结果：**36 个场景全部通过**（真实 `useAssistantStore` agent loop + 真实工具执行 + 真实仓储 + 本地 Mock SSE）。

Phase 4.2 新增场景：

1. 多轮指代：再补充一点修改上一条查询到的条目；
2. 多轮指代：多个候选时修改它必须询问且不写入；
3. 多轮指代：删除仍只生成确认卡片；
4. 清空会话后历史指代失效，不能凭旧对话写入；
5. 长对话：较早消息进入摘要块，最近消息保持原文。

回归场景全部通过，包括：只读搜索后强行修改、目标不明确、同名创建、选中条目、跨轮次真实 id、轮次上限、重试重复写入保护、候选闹钟选择/取消/过期/篡改/重启、删除确认卡片、停止请求等。

---

## 10. 构建结果

| 检查 | 结果 |
| --- | --- |
| `pnpm lint` | 通过：0 warnings / 0 errors（134 files） |
| `pnpm build`（tsc -b + vite build） | 通过；仅有既有的 chunk > 500 kB 提示 |
| `cargo check --manifest-path src-tauri/Cargo.toml` | 通过 |
| `pnpm tauri:build` | 见下方执行结果 |

`pnpm tauri:build` 执行结果：通过（exit 0）。Vite 构建 1.45s，Rust release 编译 2m22s；产物 `src-tauri/target/release/bianqian.exe`，NSIS 安装包 `src-tauri/target/release/bundle/nsis/MEMORA_0.2.0_x64-setup.exe`（5.10 MiB）。

---

## 11. 已知限制

1. **摘要是抽取式而非语义摘要**：不调用模型，因此不会生成新的概括句；极长会话中更早的细节只能保留最近 6 条用户需求。
2. **指代识别基于规则**：非常口语化或省略主语的说法可能无法识别，此时会退化为询问，而不是猜测。
3. **序号依赖最近一次查询顺序**：没有查询历史时，`第 N 条` 会退化为最近创建/修改批次；若仍不唯一则询问。
4. **`最后一条` 优先解释为最近查询结果的最后一项**；如果用户在同一轮查询后又创建了多条，语义可能与本意不同，系统会在不唯一时询问。
5. **实体引用受工具返回上限约束**：每次工具返回最多记录 8 条引用；未返回的条目无法通过记忆指代。
6. **摘要缓存只在内存**：重启后首次长对话会重新摘要一次；摘要本身不写数据库。
7. **字符预算代替 tokenizer**：阈值是保守估算，不针对具体模型 token 计费。
8. **提示词记忆块上限 1800 字**：极端情况下会截断实体列表，但保留安全声明与结束标签。
9. **未使用真实模型密钥验收**：本轮以 Mock SSE 驱动完整 agent loop；`pnpm test:real` 需要外部模型环境，未执行。

---

## 12. Git 状态

本次实施**未执行任何 git 写操作**（无 add / commit / push / reset / clean / checkout）。

Phase 4.2 相关文件在当前工作区中：

- 新增（未跟踪）：`src/services/conversationMemory.ts`、`src/services/conversationReferents.ts`、`tests/conversationMemory.test.ts`、`tests/conversationReferents.test.ts`、`tests/conversationSecurity.test.ts`、本报告；
- 修改（工作区）：`src/store/useAssistantStore.ts`、`src/services/agentTargets.ts`、`src/services/agentToolExecutor.ts`、`src/services/assistantIntent.ts`、`src/services/agentToolSchema.ts`、`src/services/assistantContext.ts`、`src/types/ai.ts`、`scripts/integration/harness.mjs`、`scripts/run-integration-tests.mjs`。

注意：工作区同时包含此前阶段（Phase 4.1.x）尚未提交的改动与文档，本次未对其做任何回滚或清理。
