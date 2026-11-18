# MEMORA V0.9 Phase 4.4 失败恢复与可靠性实施报告

## 一、结论

Phase 4.4 已完成。本次在既有手写 Tool Calling loop 上补齐统一失败分类、重试边界、部分成功恢复、中断/重启恢复和写入结果一致性校验，未引入 Agent 框架、未修改 SQLite schema、未修改 Rust SSE 代理、未放宽任何权限或目标来源守卫。

核心原则落地：**写入状态不确定时不允许自动重试，只能要求用户核对真实数据。** 创建/修改失败后的「已执行 / 未执行 / 不确定」三种状态已分开记录；回读失败不再被报告为普通创建失败；重启后的旧删除卡片与闹钟授权全部失效；续办不会重放已经成功或状态未知的写入。

验收结果：

- 单元测试：291 通过 / 0 失败
- Mock SSE 集成测试：55 通过 / 0 失败（新增 15 个失败恢复场景）
- 真实模型验收 A–H：9 通过 / 0 失败（Tool Calling 探测 + 8 个场景，模型 `free:pollinations:openai-fast`）
- `pnpm lint`：0 warning / 0 error
- `pnpm build`：通过
- `pnpm tauri:build`：通过，产出 NSIS 安装包 `MEMORA_0.2.0_x64-setup.exe`（5,354,966 字节）
- 桌面端人工验收：未在 Windows 桌面应用内进行人工操作；删除卡片 / 闹钟授权重启失效、`execution_unknown`、`interrupted`、成功步骤保留 5 项已用浏览器预览复核 DOM 渲染，全部 8 项仍标记为「未人工验证」

最终判定：**CONDITIONAL PASS**。自动化验收全部通过、未发现产品行为缺陷；条件为桌面端人工验收尚未执行，详见第八节。

## 二、范围与约束

保持不变的既有规则：

1. 创建直接执行，不增加确认流程。
2. 普通修改直接执行，不增加确认流程。
3. 删除只生成 ActionCard，用户点击确认后才移入废纸篓。
4. 删除提案本身不直接触发 `moveToTrash`。
5. 历史 ID、模型传参、查询结果都不能成为写授权。
6. 模糊目标不自动选择；多闹钟目标不明确时询问用户。
7. 多闹钟选择授权保持一次性、绑定目标和参数。
8. Stop 后未开始的工具不执行；已开始的写操作不假装被回滚。
9. 续办不重复执行已经成功的写操作。
10. 模型文本不能替代真实工具执行结果。

技术约束：未引入 LangChain / AutoGen / MCP，未新增第三方依赖，未重写 Agent Loop，未修改 OpenAI Chat Completions 协议，未修改 Rust SSE 代理，未修改 SQLite schema，未改变 V0.8 品牌、布局、主题和视觉规范。

## 三、可靠性审计结论

审计覆盖模型请求、工具参数校验、权限与目标来源守卫、工具执行、仓储回读、批量执行、停止、续办、消息持久化、删除确认与闹钟选择授权。发现并处理的问题：

1. 仓储异常被 store 捕获后返回 `null`，执行层无法区分「未写入」与「写入后失败」，旧实现会误报为普通创建失败。
2. 创建/修改成功但回读失败时，缺少统一的「状态待核对」表达，容易被模型总结成普通失败并诱导重试。
3. 部分成功时，摘要只区分成功/失败，未单独列出「写入状态未知」。
4. 同一目标写入状态未知后，同批次后续修改仍可能继续执行。
5. 重启恢复只处理候选选择卡片，未处理旧删除 ActionCard；`running` 状态也没有区分只读中断和写入待核对。
6. 续办只携带成功写入签名，状态未知的写入签名没有进入续办幂等集合。
7. 失败分类散落在字符串文案中，重试策略无法被测试稳定约束。

## 四、实施内容

### 4.1 统一失败分类与重试策略

新增 `src/services/agentFailure.ts`：

- 失败类别：`model_request_failed`、`model_timeout`、`invalid_tool_arguments`、`permission_denied`、`target_not_found`、`target_ambiguous`、`business_execution_failed`、`execution_unknown`、`readback_failed`、`execution_cancelled`、`dependency_failed`。
- 写入状态：`none | failed | unknown | applied`。
- 每个失败同时携带 `autoRetryAllowed` 与 `requiresVerification`。
- `execution_unknown`、`readback_failed` 固定 `requiresVerification: true`、不允许自动重试。
- `classifyModelFailure` 根据是否已经执行过业务工具决定模型请求失败能否重试；超时只有在确认没有执行业务工具时才允许重试。

### 4.2 执行层

修改 `src/services/agentToolExecutor.ts`：

- `create_entry`：
  - 仓储返回 `null`（store 捕获异常）或直接抛异常 → `execution_unknown`，不声称未创建。
  - 创建后回读缺失或类型不符 → `readback_failed`，提示核对，不提示重试。
  - 回读成功才返回真实 `effect`。
- `update_entry`：
  - 目标不存在 → `target_not_found`。
  - 执行抛异常 → `execution_unknown`。
  - 执行后回读缺失/字段不一致 → `readback_failed`。
  - 失败后把目标 id 加入 `uncertainEntryIds`。
- 依赖失败守卫：同一请求内，若后续 `update_entry` / `delete_entry` 指向 `uncertainEntryIds` 中的目标，直接返回 `dependency_failed`，不再产生任何写入。
- 权限、目标来源、目标歧义、重试重复风险统一映射为结构化失败；这些拦截都不允许自动重试。
- 参数校验失败统一为 `invalid_tool_arguments`，允许模型修正参数后在同一请求内重试。

### 4.3 批量执行与结果摘要

修改 `src/services/agentExecution.ts`：

- 工具结果中的失败信息完整写入 `AssistantToolStep.failure`。
- 步骤状态标签增加「状态待核对」「状态未知」「依赖未完成」。
- `summarizeExecution` 将 `requiresVerification` 的失败从普通失败中分离为 `unknown`。
- 最终结果补充与轮次上限提示单列「写入状态待核对 N 项」，明确「可能已经生效，不要直接重试，先在便签列表核对」。

### 4.4 任务进度与停止语义

修改 `src/services/agentProgress.ts`：

- 任务状态增加 `execution_unknown`、`interrupted`，计数增加 `unknown`、`interrupted`。
- `cancelUnfinishedTasks`：
  - `pending` → `cancelled`；
  - `running` 且为写工具 → `execution_unknown`；
  - `running` 且为只读工具 → `interrupted`；
  - 已结束状态保持不变。
- 停止/部分成功提示分别说明「写入可能已生效」与「已中断未确认执行」。

### 4.5 续办与幂等

修改 `src/services/agentContinuation.ts`、`src/services/agentRetryLedger.ts`、`src/store/useAssistantStore.ts`：

- 续办上下文增加 `unknown` 分类；只有状态未知时优先要求核对，不自动恢复历史目标。
- 续办守卫明确「历史 id 不是授权」「多闹钟授权不能从历史恢复」「状态待核对不要重放相同创建/修改」。
- `writeAttempts` 同时携带成功写入和状态未知写入的签名；明确失败（`writeState: none`）不携带，允许重新校验后重试。
- 重试系统提示单独统计不确定写入，并禁止再次执行相同写入。
- 新任务不会被误判成旧失败的重试；执行层仍以签名和工具范围为准。

### 4.6 重启与中断恢复

修改 `src/store/useAssistantStore.ts`、`src/utils/assistantSelectionLifecycle.ts`：

- 应用启动加载历史消息时：
  - 未完成闹钟候选卡片标记失效（既有能力）。
  - 未执行/未取消的删除 ActionCard 写入 `toolActionsInvalidated`，显示「已失效」，不能执行。
- 持久化消息恢复时：
  - `pending` 任务按取消处理；
  - `running` 写任务转为 `execution_unknown`；
  - `running` 只读任务转为 `interrupted`；
  - `success / failed / skipped / cancelled / needs_input / execution_unknown` 保持。
- 不自动恢复 `running` 为可执行，不自动重放写入，不从历史恢复删除或闹钟授权。
- 删除提案与闹钟选择授权仍为内存注册表，重启即失效；未知写入要求用户检查真实数据。

### 4.7 界面

修改 `src/components/AssistantPanel.tsx`：

- 执行进度支持「状态待核对」「已中断」状态与计数。
- 失效的删除卡片显示为「已失效」，并提示需要助手重新发起删除。
- 部分成功、失败、待核对、中断四类结果可直接区分，不再混同。

## 五、修改文件

| 文件 | 目的 |
| --- | --- |
| `src/services/agentFailure.ts` | 新增统一失败分类、写入状态与重试策略 |
| `src/services/agentToolExecutor.ts` | 创建/修改异常与回读失败分类、不确定目标依赖拦截 |
| `src/services/agentExecution.ts` | 失败信息传播、状态标签、摘要中的待核对项 |
| `src/services/agentProgress.ts` | 任务状态、停止语义、结果补充文案 |
| `src/services/agentContinuation.ts` | 续办中的未知写入分类与守卫 |
| `src/services/agentRetryLedger.ts` | 重试记录保留失败类别、提示不确定写入 |
| `src/store/useAssistantStore.ts` | 消息恢复、删除卡片失效、未知写入签名携带、模型失败提示 |
| `src/utils/assistantSelectionLifecycle.ts` | 新增删除 ActionCard 重启失效标记 |
| `src/components/AssistantPanel.tsx` | 新状态展示与失效卡片文案 |
| `src/types/ai.ts` | 扩展步骤/任务状态与失败元数据、失效索引 |
| `tests/failureRecovery.test.ts` | 新增失败分类、重试边界、回读一致性、重复调用、部分成功测试 |
| `tests/agentContinuation.test.ts` | 未知写入续办守卫测试 |
| `tests/agentProgress.test.ts` | 中断/待核对状态与计数测试 |
| `tests/assistantSelectionLifecycle.test.ts` | 删除卡片重启失效测试 |
| `scripts/integration/harness.mjs` | 新增仓储 update 失败注入 |
| `scripts/run-integration-tests.mjs` | 新增 15 个 Mock SSE 失败恢复场景 |
| `scripts/run-real-model-acceptance.mjs` | 新增 Phase 4.4 A–H 真实模型场景，调整续办语义 |

## 六、测试与验证

### 6.1 单元测试

命令：`pnpm test:agent`

结果：291 tests / 291 pass / 0 fail。

覆盖：模型失败重试策略、未知写入禁止重试、权限/目标/取消不重试、创建回读失败、修改回读不一致、仓储异常、同参数不同 `tool_call_id` 去重、部分成功摘要、续办识别、重启任务状态转换、删除卡片失效、历史 ID 不授权、闹钟授权一次性等。

### 6.2 Mock SSE 集成测试

命令：`pnpm test:integration`

结果：55 pass / 0 fail（原有 40 + 新增 15）。

新增场景：

1. 模型请求在工具执行前失败。
2. 参数非法后模型修正重试，只写入一次。
3. 创建仓储异常，状态未知且不自动重试。
4. 同批次重复创建，第二次跳过。
5. 同批次重复修改，第二次跳过。
6. 目标不存在，分类为目标缺失。
7. 部分成功中的未知写入单独列为待核对。
8. 未知写入后依赖同一目标的后续修改被拦截。
9. 查询失败不影响同批次独立新建。
10. 删除取消后再次确认不执行。
11. 重复确认同一删除卡片只移入废纸篓一次。
12. 重启后旧删除卡片失效。
13. 重启恢复 pending/running/success 状态。
14. 续办时未知写入签名阻止重放。
15. 写入成功后模型请求失败，写入保留且提示不回滚。

### 6.3 真实模型验收 A–H

运行命令：`MEMORA_SUITE=phase44 pnpm test:real`（2026-11-17）

配置：`free:pollinations:openai-fast`（显示名「GPT-OSS 20B（匿名）」，来源 Pollinations，模型 `openai-fast`，无密钥，端点 text.pollinations.ai）。未更换模型、未静默回退。测试使用 FakeStorage + MemoryEntryRepository 隔离，未连接真实用户 SQLite。

结果：**9 pass / 0 fail**（Tool Calling 探测 + A–H 8 个场景）。

| 场景 | 结果 | 关键证据 |
| --- | --- | --- |
| 探测 | PASS | `search_notes`，`finish=tool_calls`，参数 `{"query":"周报"}`，1123ms |
| A 基线一致性 | PASS | `create_entry` 成功且只执行 1 次，`effect.entryId` 与回读条目 id 一致；`get_note` ok；条目数 2（无额外写入）；`writeAttempts=1`；阶段 `done` |
| B 部分成功 | PASS | 创建成功；`get_note` 失败并分类为 `target_not_found`；成功创建保留（条目数 2）；阶段 `partial` |
| C 不确定写入续办 | PASS | 注入仓储创建异常 → `error/execution_unknown`，条目 0；续办未自动重放（条目仍 0、无成功创建、回复要求核对、续办消息保留不确定签名）；用户核对后新建「阶段44-C-核对后」成功（条目 1）；第三轮阶段 `done` |
| D 删除安全 | PASS | 生成确认卡片 1 张，确认前未删除；取消后目标保留、旧卡片 `cancelled`；新卡片确认后进入废纸篓，重复确认阶段 `done` |
| E 只读失败 | PASS | `get_note` 失败分类 `target_not_found`；条目数 1；写入 0；阶段 `failed` |
| F 状态未知 | PASS | 创建步骤 `error/execution_unknown`，`requiresVerification=true`；条目 0；未伪造数据；`writeAttempts` 已随消息持久化（重启后仍可阻止重放） |
| G 重启恢复 | PASS | 删除卡片 1 张；重建运行时后 `toolActionsInvalidated=[0]`；旧卡片确认结果 `not_found`；目标保持 1 条、废纸篓 0 |
| H 用户停止 | PASS | 首步完成后停止，已完成 1 步保留，阶段 `partial`；1.5s 后迟到响应未改写 `toolSteps` / 内容；条目保持 6（只读场景无写入）；随后新请求正常完成 |

真实请求耗时（首字 / 总耗时）：

| 请求 | 首字 | 总耗时 |
| --- | --- | --- |
| Probe | — | 1.1s |
| A 基线 | 48.4s | 49.4s |
| B 部分成功 | 51.8s | 52.5s |
| C 首轮（工具后模型请求失败） | 无 | 14.6s |
| C 续办 | 50.8s | 53.5s |
| C 核对后新建 | 47.5s | 47.9s |
| D 首轮 | 47.4s | 47.7s |
| D 确认后请求 | 6.2s | 6.6s |
| E 只读失败 | 47.6s | 48.2s |
| F 状态未知 | 48.8s | 49.8s |
| G 重启前请求 | 47.6s | 47.9s |
| H 停止前请求 | 无（4.9s 时中断） | 4.9s |
| H 停止后新请求 | 2.3s | 2.4s |

真实模型不稳定记录：

- 场景 C 首轮工具已执行（注入的创建异常，状态 `execution_unknown`）后，用于生成总结的模型请求返回 `network_error`，14,634ms 内未收到任何数据段。执行状态未被覆盖，续办与后续核对流程仍按预期完成；该次失败仅影响模型回复文本，未影响工具结果与仓储状态。
- Pollinations 匿名层首字延迟波动明显（本次多为 47–52s，个别 2–6s），场景超时设置为 900s。本次未出现限流错误。
- 场景 G 运行时日志出现 `WebSocket server error: Port 24678 is already in use`，为本地 Vite HMR 端口冲突提示，不影响验收脚本与断言结果。

Mock SSE 与真实模型分开统计：上述 9 项为真实 `openai-fast` 请求（共 13 次模型调用）；第 6.2 节的 55 个集成场景全部使用本地 Mock SSE，不混入本节统计。场景 B 的取消、场景 C 的确认、场景 G 的重启后确认是 harness 对 ActionCard / 运行时 API 的真实调用，不额外消耗模型请求。

验收层级说明：真实模型场景通过 harness 调用 `confirmDelete` 等运行时 API 模拟用户点击卡片，未驱动桌面端真实鼠标点击；模型回复文本仅作为回复内容，成功与否一律以 `toolSteps` 与仓储状态为准。

### 6.4 Lint 与构建

- `pnpm lint`：0 warning / 0 error（142 files）。
- `pnpm build`：通过；仅有既有的 chunk 体积提示，无错误。

### 6.5 Windows Tauri 构建验收

- 实际命令：`pnpm tauri:build`
- 结果：成功（exit 0）；Rust release 编译 `Finished release profile ... in 2m 28s`
- 安装包：`src-tauri/target/release/bundle/nsis/MEMORA_0.2.0_x64-setup.exe`，5,354,966 字节（约 5.11 MiB）
- 主程序：`src-tauri/target/release/bianqian.exe`，19,935,232 字节（约 19.0 MiB）
- 失败原因：无

### 6.6 桌面端人工验收

本轮未在 Windows 10/11 桌面应用内进行人工点击操作，因此下表全部项目均标记为「未人工验证」；其中 1–5 项额外用浏览器预览（Vite dev server + 注入历史消息后刷新）复核了 DOM 渲染与重启失效逻辑，但浏览器预览不等同于桌面端验收。

| 项目 | 桌面端人工验证 | 补充证据 |
| --- | --- | --- |
| 1. 删除卡片重启后失效 | 未验证 | 浏览器预览：刷新后卡片显示「已失效」、说明「这张确认卡片已失效（应用重启后一次性授权已丢失）」且无「确认删除」按钮；真实场景 G：重启后 `toolActionsInvalidated=[0]`，确认返回 `not_found` |
| 2. 闹钟授权重启后失效 | 未验证 | 浏览器预览：刷新后显示「已开始新任务或应用已重启，这次选择已失效；闹钟没有任何改动。」，候选闹钟按钮数量为 0 |
| 3. `execution_unknown` 展示 | 未验证 | 浏览器预览：进度头部显示「状态待核对 1」，步骤显示「修改便签「待核对」状态待核对」并展开失败原因；真实场景 C/F 产出该状态 |
| 4. `interrupted` 展示 | 未验证 | 浏览器预览：显示「已中断 2」，分别来自重启时仍在执行的只读步骤与只读任务；`pending` 任务显示「已取消 1」 |
| 5. 已成功步骤保留 | 未验证 | 浏览器预览：显示「执行结果 · 完成 1/5」且成功步骤保留；真实场景 A/H 亦验证成功步骤保留 |
| 6. 续办不重复成功 / 未知写入 | 未验证 | 真实场景 C：未知写入续办条目保持 0；场景 F：签名持久化；Mock SSE 场景 14 覆盖成功与未知写入签名阻止重放 |
| 7. 创建、普通修改直接执行 | 未验证 | 真实场景 A：创建直接执行且只执行一次；创建/普通修改不进入确认流程由单元与 Mock SSE 集成测试覆盖 |
| 8. 删除仍必须用户确认 | 未验证 | 真实场景 D/G：确认前目标始终保留，确认后仅移入废纸篓一次；取消不产生任何数据改动 |

浏览器预览复核时使用的历史消息为临时注入的 `bianqian.assistant.v1` 测试数据，验收后已删除该键；预览仅走前端 localStorage 分支，未验证 Rust 命令、系统闹钟与真实文件写入。

## 七、已知限制与未解决问题

1. **桌面端人工验收未执行**：本轮未在 Windows 10/11 桌面应用内人工点击验证 8 个项目，只用浏览器预览复核了 1–5 项的 DOM 渲染与重启失效文案。浏览器预览不覆盖 Tauri 命令、系统通知/闹钟与窗口行为，需要后续人工补验。
2. **免费模型延迟与偶发网络失败**：Pollinations 匿名层首字延迟 47–52s 常见；场景 C 出现过一次工具执行后的模型请求 `network_error`（14.6s 无数据）。该失败被如实记录为模型失败，未影响仓储状态；产品通过统一失败提示要求用户核对，不自动重试。
3. **不确定写入的签名会阻止同一对话内的相同重试**：这是有意设计（宁可要求核对，也不重复写入）。用户必须先在列表核对真实数据；若需再次创建相同内容，应换用新任务或在核对后明确发起新的写入。
4. **重启恢复只覆盖已持久化的历史消息**：删除确认卡片与闹钟多候选授权都是内存注册表，重启后旧卡片一律失效；这是安全边界而不是缺陷，用户需让助手重新发起。
5. **`execution_unknown` 的最终事实只能由用户核对**：执行层无法在仓储异常时判断写入是否生效，界面只提供「状态待核对」与核对指引，不做自动探测性重放。
6. **H 场景未观察到「已规划但未执行」的工具**：该场景中模型一次只发起一个工具调用，因此 `toolTasks` 中没有未启动项；`pending`/`running` 未执行语义由 Mock SSE 场景 13 与单元测试覆盖。
7. **既存构建告警**：`pnpm build` 仍有 chunk 体积提示，本阶段未做代码拆分。

## 八、最终判定

**CONDITIONAL PASS**

- Phase 4.4 实现、单元测试（291/291）、Mock SSE 集成测试（55/55）、真实模型 A–H（9/9）、lint、前端构建与 Windows Tauri 构建均通过；未发现绕过权限、目标来源、删除确认、停止、幂等或重启失效规则的行为。
- 条件：桌面端人工验收 8 项尚未在 Windows 桌面应用内执行，全部标记为「未人工验证」；其中 1–5 项仅有浏览器预览级证据。补验通过后可升级为 PASS；若人工验收发现渲染或交互缺陷，应按缺陷修复后重新验收。
- 未进入 Phase 4.5；未执行提交、推送或破坏性 Git 操作。
