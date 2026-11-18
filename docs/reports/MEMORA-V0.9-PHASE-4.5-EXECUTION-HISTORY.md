# MEMORA V0.9 Phase 4.5 执行历史与可观测性实施报告

## 一、结论

Phase 4.5 已完成。执行历史现在独立于聊天消息持久化，只记录真实进入执行链路的工具调用；成功 / 失败 / 等待确认 / 状态未知由真实步骤推导，模型自然语言总结不参与成功判定。历史查询、删除、清空都不会接触业务便签，也不会恢复任何旧删除卡片或闹钟授权。

验收结果：

- 单元测试：**314 通过 / 0 失败**
- Mock SSE 集成测试：**61 通过 / 0 失败**（其中 Phase 4.5 新增 6 个执行历史场景）
- 真实模型验收（第二次完整重跑）：**13 通过 / 0 失败**（Tool Calling 探测 + A–L 12 个场景）
- `pnpm lint`：**0 warning / 0 error**
- `pnpm build`：通过
- `cargo check`：通过
- `pnpm tauri:build`：通过，产出 `MEMORA_0.2.0_x64-setup.exe`（**5,372,860 字节**，5.12 MiB）
- 浏览器预览：历史列表 / 详情 / 搜索 / 状态筛选 / 分页 / 删除 / 清空 / 跳回消息已复核 DOM 渲染

最终判定：**CONDITIONAL PASS**。功能、自动化测试与真实模型执行均通过，条件为：

1. 本机当前激活配置是 Doubao（`p1793850069851`），不是任务书要求的 `free:pollinations:openai-fast`；本次没有静默切换或修改用户配置，真实模型结果来自实际激活模型。
2. 未在打包后的 Tauri 桌面窗口内逐项手工点击历史界面；浏览器预览已验证主要交互，桌面端人工验收仍应补做。
3. 删除 / 闹钟授权在 Agent Loop 之外由用户点击确认后执行，当前不会追加为新的历史步骤；原步骤保持「等待补充」，不会被改写成成功。详见第十一节。

## 二、范围与约束

保持不变的既有规则：

1. 创建直接执行，不增加确认流程。
2. 普通修改直接执行，不增加确认流程。
3. 删除只生成 ActionCard，用户确认后才移入废纸篓。
4. 删除提案本身不触发 `moveToTrash`。
5. 历史 ID、模型传参、查询结果都不能成为写授权。
6. 模糊目标不自动选择；多闹钟目标不明确时询问用户。
7. 多闹钟选择授权一次性、绑定目标和参数。
8. Stop 后未开始的工具不执行；已开始的写操作不假装回滚。
9. 续办不重复执行已经成功的写操作。
10. 模型文本不能替代真实工具执行结果。

技术约束：未引入 LangChain / AutoGen / MCP，未新增第三方依赖，未重写 Agent Loop，未修改现有工具执行机制，未修改 OpenAI Chat Completions SSE 协议，未修改 Rust SSE 代理，未破坏既有 SQLite 数据，未改变 V0.8 品牌、主题和视觉规范，未执行 Git reset / clean / checkout，未进入 Phase 5。

## 三、审计与缺陷处理

审计覆盖 `useAssistantStore`、`agentExecution`、`agentProgress`、`agentFailure`、`agentContinuation`、`agentRetryLedger`、`agentToolExecutor`、`AssistantPanel`、消息持久化与 SQLite 迁移。Phase 4.5 期间发现并处理：

1. **`分别` 被误判为否定词**：意图分析把「请分别新建三条便签」中的「别」当成否定，导致整轮降为只读。已把「分别」加入否定误报白名单，并补单元测试。
2. **删除确认被记录为 failed**：删除步骤状态是 `needs_input`，但记录级状态只依赖 store 显式上报，未上报时按「有跳过步骤」推导为 `failed`。现已从真实步骤推导 `needs_input`，删除等待确认不再显示为失败或成功。
3. **记录标题未脱敏**：标题取用户输入首行，之前只截断未脱敏。现统一经过 `redactSensitive`。
4. **记录级错误文本未脱敏**：摘要中的 `errorMessage` 现先脱敏再截断。
5. **历史收尾漏步骤**：`finish()` 只写 session 内已知步骤，store 后续补入的步骤可能丢失。现会补齐缺失步骤并落盘。
6. **未知步骤未升级记录状态**：store 侧未知步骤现在会升级为记录级 `execution_unknown` 并附带禁止重试的失败分类。
7. **只读结果可能保存正文**：只读工具步骤改为「检索 / 列出 / 读取 N 条结果」，不落笔记正文。
8. **目标引用重复**：同一便签不同 effect 的引用按 `entryId` 去重。
9. **验收脚本问题**：首次真实运行中，B/C 场景提示词使用「这条便签」但未在动作子句给出明确标题，被产品既有的指代守卫正确降为只读；I 场景使用「当前时间前 60 秒」在长时间运行的验收进程中晚于进程启动时间，被恢复逻辑当作活跃任务跳过。两者都是验收设计问题，已改为明确标题和一天前时间戳。
10. **首次真实验收 8/13，修复后完整重跑 13/13**。首次失败没有被隐藏或改写为通过，明细见第九节。

## 四、数据模型与 SQLite 迁移

新增 `src/types/executionHistory.ts`：

- `AgentExecutionRecord`：会话 / 消息 / 请求 ID、标题、输入摘要、状态、阶段、开始 / 结束 / 时长、工具 / 成功 / 失败 / 跳过计数、记录级失败、错误文本。
- `AgentExecutionStep`：真实执行序号、工具调用 ID、工具名、标签、状态、耗时、effect、失败分类、目标引用、脱敏输入 / 输出摘要。
- 状态：`success | partial | failed | cancelled | interrupted | execution_unknown | needs_input | running`。
- 步骤状态：`pending | running | success | failed | skipped | cancelled | needs_input | execution_unknown`。

`src-tauri/src/lib.rs` 新增 migration 8（`IF NOT EXISTS`，可重复执行，只新增表，不修改既有 1–7）：

- `agent_executions`：主键 `id`，`request_id` 唯一索引，另有 `started_at`、`status` 索引。
- `agent_execution_steps`：主键 `id`，`(execution_id, ordinal)` 索引。
- JSON 字段只保存 effect / failure / targets，均为结构化小数据。

## 五、仓储与记录器

仓储接口 `src/repository/agentExecutionRepository.ts`，按运行环境选择：

- Tauri：`SqliteAgentExecutionRepository`，独立表，不接触业务条目表。
- 浏览器预览 / 测试：`LocalAgentExecutionRepository`，`localStorage` 键 `bianqian.agent.executions.v1`，上限 300 条，避免配额打满。
- `executionRepository.ts` 提供单例与测试替换入口。

`src/services/executionRecorder.ts`：

- 请求开始创建记录；工具开始 / 结束写步骤；请求收尾更新记录。
- 所有写入串行排队，`create` 永远先于步骤和收尾更新。
- 历史写入失败只输出诊断日志，不改变 Agent 结果、权限守卫或幂等保护。
- 同一 `requestId` 重复 `create` 被仓储忽略。
- 收尾时补齐 store 额外提供的步骤；未知写入会升级记录状态。
- `flush()` 供测试和隔离验收等待队列落盘。

`src/services/executionHistoryRecovery.ts`：

- 应用启动时调用一次；只处理本进程启动前创建、且没有 `finishedAt` 的记录。
- 未完成的写入步骤 → `execution_unknown`，`requiresVerification: true`，禁止自动重放。
- 未完成的只读步骤 → `cancelled`，明确没有写入。
- 已成功步骤保持成功，不会被重启恢复改写。
- 恢复失败只记录日志，不阻塞启动。

## 六、Agent Loop 集成与状态推导

`src/store/useAssistantStore.ts`：

- 每次请求开始调用 `start()`，携带真实请求 ID、消息 ID、输入摘要和标题。
- 在工具开始 / 结束位置调用 `stepStarted()` / `stepFinished()`，只传真实进入执行链路的调用。
- 收尾统一调用 `finish()`，状态由步骤、停止、请求失败、等待确认、轮次上限推导。
- 历史记录器与权限 scope、重试账本、删除提案注册表完全解耦；历史不参与任何执行判断。

`src/services/executionHistory.ts` 的确定性规则：

1. 任意步骤或任务为 `execution_unknown` → 记录 `execution_unknown`。
2. `restarted` → `interrupted`；`stopped` → `cancelled`（均在未知之后）。
3. 真实失败步骤存在 → 有成功步骤为 `partial`，否则 `failed`。
4. 模型请求失败 → 有成功步骤为 `partial`，否则 `failed`。
5. 步骤或任务等待用户补充（删除确认 / 闹钟选择）→ `needs_input`，即使 store 没有显式上报。
6. 轮次上限或存在跳过调用 → 有成功步骤为 `partial`，否则 `failed`。
7. 以上都不满足 → `success`。

摘要只由确定性事实拼接（状态、计数、失败分类、停止提示），不复制模型自然语言总结。

## 七、界面

新增 `src/components/AgentHistoryPanel.tsx`，在 AI 面板头部通过 History 按钮打开：

- 列表：标题、输入摘要、开始时间、时长、状态、阶段、工具 / 成功 / 失败 / 跳过计数、摘要。
- 详情：按真实 `ordinal` 展示步骤；显示输入 / 输出安全摘要、effect、目标便签链接、失败分类与下一步建议。
- 检索：关键字（标题 / 输入）；状态多选；日期范围（今天 / 近 7 天 / 近 30 天 / 全部）。
- 分页：每页 10 条；删除最后一页记录时自动回退页码。
- 删除单条：只删历史；清空全部：二次确认，只清历史。
- 跳回消息：按 `data-message-id` 定位当前会话消息；消息已清空或超限时明确提示，不静默失败。
- 成功记录不显示「未发现问题」的冗余提示；未知写入不会因分类标签重复显示。

`src/components/AssistantPanel.tsx`：历史按钮、`aria-pressed`、Esc 优先关闭历史、消息根节点增加 `data-message-id`。

## 八、安全与隐私不变量

1. **历史不能授权写入**：仓储只有增删查改历史记录的方法，没有执行工具、重放任务或恢复授权的方法。
2. **历史不能恢复旧授权**：删除 / 清空历史不触碰删除提案注册表或闹钟选择注册表；重启仍使旧卡片失效。
3. **历史不能触发业务删除**：删除历史记录只删除 `agent_executions` / `agent_execution_steps` 行。
4. **模型总结不判定成功**：状态只看真实步骤；Mock SSE 已验证「写入成功 + 总结请求 500」仍为 `partial` 且成功步骤保留。
5. **未知写入不成功、不自动重试**：`execution_unknown` 与 `readback_failed` 固定要求用户核对，`autoRetryAllowed: false`。
6. **不保存密钥 / 认证头 / 完整正文**：
   - 用户输入先脱敏再截断；
   - 标题首行也脱敏；
   - 工具参数中的正文只记录字数；
   - 只读工具结果只记录结果数量；
   - 记录级错误文本先脱敏；
   - 验收脚本断言历史序列化结果不包含正文标记、`sk-` 密钥、Bearer 或 authorization。
7. **不保存完整提示词**：历史只保存用户输入摘要和工具安全摘要，不保存 system prompt / 上下文全文。

## 九、测试结果

### 9.1 单元测试

`pnpm test:agent`：**314 pass / 0 fail**（52 suites）。

新增 `tests/executionHistory.test.ts` 覆盖：

- 仓储分页、同 ID 幂等、更新、步骤排序、筛选、删除、清空；
- 安全摘要、正文不落库、目标引用去重；
- 状态推导、等待确认、未知写入优先、停止、部分成功；
- 记录器事件、缺失步骤补齐、未知升级、仓储异常隔离、重复开始；
- 重启恢复、只读中断、写入未知；
- 标题 / 输入 / 参数脱敏。

### 9.2 Mock SSE 集成测试

`pnpm test:integration`：**61 pass / 0 fail**。

Phase 4.5 新增 6 个场景：

1. 只读检索记录真实步骤且不保存笔记正文。
2. 删除 / 清空历史不影响真实便签。
3. 模型总结失败不把已完成写入改为失败。
4. 停止任务记录 `cancelled` 且不虚构已完成步骤。
5. 轮次上限时未执行调用只计入跳过。
6. 重启恢复中断写入为未知且不能授权新的写入。

### 9.3 真实模型验收

命令：`MEMORA_SUITE=phase45 node scripts/run-real-model-acceptance.mjs`

实际配置（未静默切换）：

- 配置：`推理-Doubao-Seed-Evolving`
- 配置 ID：`p1793850069851`
- 模型：`VOLCENGINE_ENDPOINT_ID`
- 端点：`ark.cn-beijing.volces.com`
- 选择方式：当前激活配置
- API Key：已配置，不打印、不写文件

第二次完整重跑结果：**13 pass / 0 fail**。

| 场景 | 结果 | 实测证据 |
| --- | --- | --- |
| Tool Calling 探测 | PASS | `search_notes`，finish=`tool_calls`，2,647ms |
| A 创建任务持久化历史 | PASS | 状态 success，步骤 1，目标引用真实条目 ID |
| B 搜索后修改顺序 | PASS | `search_notes → update_entry`，目标 `p45-b` |
| C 创建后修改引用 | PASS | 创建与修改引用同一目标 ID |
| D 批量创建 | PASS | 便签 3，历史步骤 3，成功 3 |
| E 删除需确认 | PASS | 记录 / 步骤 `needs_input`，成功计数 0，便签保留 |
| F 检索 / 筛选 / 分页 | PASS | 关键字 6，状态 6，分页 5+1，时间范围 6 |
| G 清空对话 | PASS | 历史保留，便签保留 |
| H 删除 / 清空历史隔离 | PASS | 便签始终保留 |
| I 重启恢复 | PASS | 记录 / 步骤 `execution_unknown`，正文未变 |
| J 隐私 | PASS | 无正文标记、密钥、认证头；只读摘要「检索 1 条结果」 |
| K 历史只读 | PASS | 查询 3 次后便签与对话不变，无授权字段 |
| L 成功判定来源 | PASS | 模型回复含否定说法，历史仍为 success（create_entry 成功） |

首次运行结果为 8 pass / 5 fail：

- B/C：提示词在动作子句使用「这条便签」但未给出明确标题，被既有指代守卫降为只读；改为明确标题后通过。
- D：真实缺陷「分别」被误判为否定；修复意图白名单后通过。
- E：真实缺陷删除确认被记录为 `failed`；修复状态推导后通过。
- I：验收时间戳晚于进程启动时间，被恢复逻辑当作活跃任务；改为一天前后通过。

以上失败均保留在验收日志中，没有修改断言伪造通过。

## 十、Windows 构建

- `pnpm lint`：0 warning / 0 error（152 文件，116 规则）。
- `pnpm build`：通过（`tsc -b && vite build`）；仍有既有的大 chunk 提示，不是错误。
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过（18.74s）。
- `pnpm tauri:build`：通过（release 编译 2m 13s）。
- 安装包：`src-tauri/target/release/bundle/nsis/MEMORA_0.2.0_x64-setup.exe`
- 大小：**5,372,860 字节**（5.12 MiB）。

## 十一、已知限制与未完成项

1. **真实模型不是指定免费模型**：任务书要求 `free:pollinations:openai-fast`，本机激活配置为 Doubao。未修改用户配置、未偷偷切换；本次真实结果来自实际激活模型。如需免费模型结果，应先把该免费模型设为激活配置后重跑 `MEMORA_SUITE=phase45`。
2. **Loop 外确认已在 Phase 4.5.1 补齐**：新生成的删除卡片会携带真实 `executionId` / `stepId` / `proposalId`，用户取消、确认成功或失败都会回写同一条历史步骤。Phase 4.5 及更早生成的旧卡片没有关联字段，仍保持 `needs_input`，不会伪造成 `success`。详见 `MEMORA-V0.9-PHASE-4.5.1-DELETE-CONFIRMATION-HISTORY.md`。
3. **桌面端人工点击未逐项执行**：历史界面已在浏览器预览中用真实 DOM 验证；打包后的 Tauri 窗口仍需人工复核一次滚动、筛选和多窗口布局。
4. **跳回消息范围**：只能定位当前内存会话中的消息；对话已清空或超出保留条数时给出明确提示。
5. **浏览器预览容量**：localStorage 仓储上限 300 条；Tauri SQLite 仓储不设该上限。
6. **删除历史不删除便签**：这是产品设计，不是缺陷；界面文案已明确「只删除执行历史」。

## 十二、Git 状态

工作区包含 Phase 1–4.5 的既有未提交改动。本阶段新增 / 修改的主要文件：

- 新增：`src/types/executionHistory.ts`、`src/services/executionHistory.ts`、`src/services/executionRecorder.ts`、`src/services/executionHistoryRecovery.ts`、`src/repository/agentExecutionRepository.ts`、`src/repository/executionRepository.ts`、`src/repository/localExecutionRepository.ts`、`src/repository/sqliteExecutionRepository.ts`、`src/components/AgentHistoryPanel.tsx`、`tests/executionHistory.test.ts`。
- 修改：`src-tauri/src/lib.rs`（migration 8）、`src/store/useAssistantStore.ts`、`src/components/AssistantPanel.tsx`、`src/services/assistantIntent.ts`、`scripts/integration/harness.mjs`、`scripts/run-integration-tests.mjs`、`scripts/run-real-model-acceptance.mjs`、`tests/assistantIntent.test.ts`、`tests/executionHistory.test.ts`。

未执行提交、未执行破坏性 Git 操作。测试与验收使用隔离仓储（localStorage），未连接用户真实 SQLite 数据。

## 十三、停止声明

Phase 4.5 到此停止。未开始 Phase 5，未增加历史重放、历史授权、自动恢复执行等超出本阶段范围的能力。
