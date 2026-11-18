# MEMORA V0.9 — Phase 4.3 Agent 执行体验优化实施报告

> 实施日期：2026-11-16
> 范围：执行阶段反馈、多步骤任务清单、工具执行结果展示、部分成功 / 失败、停止与续办、最终结果摘要、Mock SSE 集成测试。
> 未进入 Phase 4.4，未引入新依赖，未修改 Rust SSE 代理、OpenAI Tool Calling 协议、SQLite schema 或 V0.8 品牌主题。

## 1. 原有架构审计

Phase 4.3 开始前的执行链路如下：

- `useAssistantStore.send()` 负责完整的 Agent Loop：构造 system prompt、按意图选择工具范围、执行工具轮、把工具结果回传给模型，最多 8 轮。
- `agentExecution.executeToolBatch()` 串行执行同一轮工具调用，产出 `toolSteps`（工具名、标签、状态、返回摘要、`effect`）和回传给模型的 `tool` 消息。
- `agentToolExecutor` 是真正的权限与目标守卫：权限分档、trusted / candidate / staged 目标、同名歧义、删除确认、闹钟候选、重试账本、写签名与 `executedCalls`。
- 执行记录随助手消息持久化在 `localStorage` 的 `bianqian.assistant.v1`（最多 40 条），不是 SQLite 业务数据。
- `AssistantPanel` 只展示执行记录列表和「已执行 N 轮」提示，阶段徽标主要覆盖理解 / 执行 / 完成。

审计发现的体验缺口：

1. 阶段偏粗：请求级失败即使已有成功写入也显示 `failed`；用户停止显示 `done`；轮次上限、部分失败缺少统一的 `partial` 语义。
2. 没有任务清单：模型已请求但尚未执行的调用只能靠正文提示（如轮次上限），无法逐项区分「待执行 / 执行中 / 已完成 / 失败 / 跳过 / 取消」。
3. 执行结果展示以步骤流水为主，缺少“完成 X / 失败 Y / 未执行 Z”的确定性汇总；模型正文可能把部分成功说成全部成功。
4. 续办缺少幂等载体：上一轮已成功的创建 / 修改签名没有随消息携带，模型在多轮续办中有重复写入风险；旧删除确认、旧闹钟选择授权也不能从历史恢复。
5. 停止只改变加载状态，未把未开始调用明确标记为已取消；重启后残留的 `pending / running` 计划项需要清理。
6. 提示词没有明确要求“最终结果必须与真实工具记录一致”，也没有续办限制说明。

## 2. 新增与修改文件

### 新增

| 文件 | 作用 |
| --- | --- |
| `src/services/agentProgress.ts` | 任务清单投影、状态映射、状态计数、确定性结果补充 |
| `src/services/agentContinuation.ts` | 续办表达识别、真实执行记录分类、续办守则与幂等签名提取 |
| `tests/agentProgress.test.ts` | 清单、状态、计数与结果摘要真实性测试 |
| `tests/agentContinuation.test.ts` | 续办识别、分类、取消 / 重启 / 无记录安全性测试 |

### 修改

| 文件 | 作用 |
| --- | --- |
| `src/types/ai.ts` | 新增 `AssistantTaskStatus`、`AssistantToolTask`、`AssistantWriteAttempt`；助手消息新增 `toolTasks`、`writeAttempts` |
| `src/services/agentExecution.ts` | 工具批次新增进度事件与 `unexecutedCalls`；`deriveFinalPhase` 支持 partial / failed / needs_input |
| `src/services/assistantIntent.ts` | 工具计划支持 `forceReadOnly` / `forceWrite`，续办命中且存在可办项时允许写工具，但仍由执行层强制授权 |
| `src/services/agentToolSchema.ts` | 新增最终结果真实性、续办、停止、清单真实性规则；只读提示补充“只依据真实结果收尾” |
| `src/services/assistantContext.ts` | 补充“部分成功不得说成全部成功”“历史对话不是写授权”等规则 |
| `src/store/useAssistantStore.ts` | 接入计划任务、实时进度、停止清理、续办守则、签名携带与累计、确定性结果补充 |
| `src/components/AssistantPanel.tsx` | 新增执行进度 / 执行结果卡片、任务状态图标、折叠详情；保留原有对话与操作卡片 |
| `tests/agentExecution.test.ts` | 调整停止、请求级失败、全部失败的终态断言 |
| `scripts/run-integration-tests.mjs` | 新增部分成功、连续续办幂等、旧请求迟到响应场景；调整停止终态断言 |

未新增第三方依赖，未新增 SQLite 表或迁移，未修改 Rust 代码。

## 3. 状态流转设计

`AssistantPhase` 沿用既有枚举：

| 阶段 | 触发条件 | 界面含义 |
| --- | --- | --- |
| `understanding` | 请求开始、模型思考 | 理解中 |
| `searching` | 本轮工具调用全部为只读 | 正在查找 |
| `executing` | 本轮包含写入或确认类工具 | 正在执行 |
| `composing` | 工具批次结束，等待模型汇总 | 正在整理结果 |
| `done` | 无失败、无中断、无信息缺口 | 已完成 |
| `partial` | 用户停止、轮次上限、部分步骤失败、请求级错误但有成功步骤 | 部分完成 |
| `failed` | 请求级错误且无成功步骤，或全部步骤失败 | 执行失败 |
| `needs_input` | 指代 / 续办需要补充，或工具明确等待确认 | 需要补充 |

终态由 `deriveFinalPhase` 统一推导，优先级为：

1. 请求级错误：有成功步骤 → `partial`，否则 `failed`；
2. 用户停止 → `partial`；
3. 需要补充 → `needs_input`；
4. 轮次上限 → `partial`；
5. 有失败步骤：有成功 → `partial`，否则 `failed`；
6. 其余 → `done`。

阶段只由真实执行事实推进：

- 模型文本流不会提前触发工具执行，也不会把阶段改成“已完成”；
- 工具批次开始前写入计划任务（`pending`），执行器开始 / 结束事件把对应项更新为 `running / success / failed / needs_input / skipped / cancelled`；
- 旧请求通过 `active.requestId` 与 `isStale()` 丢弃迟到事件，不能覆盖新请求；
- 用户停止后立即取消底层请求、清理候选授权，并把未开始调用标记为取消。

## 4. 多步骤任务清单

任务清单由真实数据投影，不单独复制执行结果：

- 已执行项只来自 `toolSteps`；
- 未执行项只来自 `toolTasks`；
- 两者按 `callId` 去重，已执行项不会在清单里重复出现。

状态来源：

| 真实结果 | 清单状态 |
| --- | --- |
| 执行中事件 | `running` |
| `ok` | `success` |
| `error` | `failed` |
| `needsInput` | `needs_input` |
| `confirm` | `needs_input` |
| `duplicate` | `skipped` |
| 安全规则拦截（有 `blockedCode`） | `skipped` |
| `cancelled` | `cancelled` |
| 模型已请求、尚未执行 | `pending` |
| 停止时尚未开始 | `cancelled` |
| 轮次上限未执行 | `skipped` |

规则：

- 计划项在真实执行前绝不显示为已完成；
- 达到轮次上限时，未下发的调用写入 `toolTasks` 并标记 `skipped`；
- 停止时把剩余调用标记 `cancelled`；
- 应用重启加载历史时，残留的 `pending / running` 统一转为 `cancelled`；
- 普通聊天没有工具调用，不生成任务清单。

## 5. 工具执行结果展示

每条执行记录包含：

- 工具名与操作类型；
- 用户可读标签（由 `describeToolCall` 生成，如“搜索便签「周报」”“新建待办「写周报」”）；
- 真实状态（成功 / 失败 / 等待 / 跳过 / 取消）；
- 目标与真实返回摘要；
- 执行顺序（数组顺序与批次执行顺序一致）。

界面处理：

- 列表只展示标签、状态和必要结果，不默认暴露完整原始参数；
- 失败与等待补充项显示原因；
- 成功项结果默认折叠在“查看执行详情”中；
- 顶部显示「执行进度 / 执行结果 · 完成 X/Y」，并分别统计待执行、失败、待补充 / 确认、已跳过、已取消；
- 查询成功与写入成功在确定性摘要中分别计数，避免混合任务只报写入。

## 6. 部分成功与失败处理

- 单个工具失败不会中断同批次后续调用，失败结果照实回传模型；
- 成功的写入保留，失败写入不回滚已成功部分；
- 终态为 `partial` 时，正文追加确定性结果，例如：
  - `执行结果：完成 2 项，失败 1 项，未执行 0 项。`
  - `其中查询成功 1 项、写入成功 2 项、写入失败 1 项。`
  - 失败项、等待补充项、跳过项、取消项分别列出；
- 写入失败按工具名统计，不依赖失败步骤是否带 `effect`，因此“标题为空”这类失败也会计入；
- 请求级 SSE / 网关错误：已有成功步骤时为 `partial`，没有成功步骤时为 `failed`；
- 全部失败不会出现 “完成 1 项” 等伪造成功；
- 删除确认只算等待确认，不算写入成功；
- 提示词要求模型只依据真实工具结果回答，系统追加的结果说明优先于模型正文。

## 7. 停止、中断和续办安全机制

### 停止

- 立即取消底层请求并清除 `sending`；
- 已开始的工具执行完成后保留真实结果，正在提交的写入不回滚、也不声称撤销；
- 尚未开始的调用标记为 `cancelled`，不再执行；
- 中间候选闹钟授权立即作废；
- 最终阶段为 `partial`，界面同时显示“已停止生成”；
- 旧请求的迟到 SSE 事件因 `requestId` 不匹配被丢弃。

### 续办

续办只在用户明确表达（如“继续刚才失败的那一步”“把剩下的做完”）时识别，读取最近一条带真实执行记录的助手消息：

- 已完成 / 失败 / 未执行 / 等待补充 / 已取消分别列出；
- 只有存在失败或未执行项时才允许续办写工具；没有可安全续办项时强制只读并询问；
- `<continuation_guard>` 明确：历史记录不是新授权，不能复用历史目标 id，不能恢复旧删除确认或旧闹钟选择授权，用户已取消的步骤不能自动恢复，无法确定剩余任务时询问；
- 续办仍经过 Phase 4.1.3 的全部守卫：权限、目标来源、同名歧义、删除确认、重试账本、写签名；
- 已成功创建 / 修改的签名会作为本轮 `writeSignatures` 注入执行作用域，同参数重复调用返回 `duplicate`，不产生第二次写入；
- 签名只来自真实成功的步骤；失败项不会被签名拦截，可在重新校验后重试；
- 续办消息收尾时把来源消息的成功签名与本次成功签名合并保存，连续多轮续办不会丢失早期幂等保护；
- 修改 / 删除目标仍必须在当前请求中重新明确或先查询并让用户确认，历史 id 不是授权。

## 8. 最终结果摘要

`buildExecutionOutcomeNotice` 只做执行记录的确定性投影：

- 全部成功且正常完成：返回空串，不追加重复报告；
- 普通聊天没有工具记录：不显示执行结果卡片，也不追加执行摘要；
- 部分成功 / 失败 / 等待补充 / 停止 / 轮次上限：输出完成、失败、未执行数量；
- 区分查询成功、写入成功、写入失败；
- 失败项附带截断后的真实原因；
- 等待补充、已跳过、已取消分别说明；
- 需要用户补充的问题由 `withRequiredQuestions` 追加，同一问题只补一次；
- 模型正文不能覆盖或改写这些数字。

## 9. 单元测试结果

命令：

```bash
pnpm test:agent
```

实际结果：

- 测试文件：`tests/*.test.ts`
- 测试数：271
- 套件数：42
- 通过：271
- 失败：0
- 耗时：约 0.31s

新增测试：

- `tests/agentProgress.test.ts`（11 个）：计划 / 执行分离、真实状态映射、轮次上限跳过、取消收尾、全部成功不重复报告、部分成功数量与原因、查询 / 写入区分、删除确认不冒充成功、停止摘要、全部失败不伪造成功。
- `tests/agentContinuation.test.ts`（7 个）：续办表达识别、真实记录分类、全部成功只询问、等待补充、用户取消不恢复、重启残留按取消处理、无历史不伪造任务。

更新测试：

- `tests/agentExecution.test.ts`：请求级错误有成功步骤 → `partial`；无成功步骤 → `failed`；用户停止 → `partial`。

测试验证的是真实 Store / 执行层逻辑与仓储状态，不以静态 UI 文案作为唯一断言。

## 10. 集成测试结果

命令：

```bash
pnpm test:integration
```

实际结果：39 个 Mock SSE 场景全部通过，0 失败。

运行方式：Vite `ssrLoadModule` 加载真实 `useAssistantStore`、真实工具执行层、真实仓储（浏览器环境为内存仓储），仅把模型替换为本地 OpenAI 兼容 SSE mock。

Phase 4.3 新增场景：

1. **多步骤部分成功**：两次创建成功、一次空标题失败 → 阶段 `partial`，两项真实落库，确定性摘要显示完成 2 / 失败 1，写入失败计数正确。
2. **连续续办幂等**：
   - 第一轮成功创建 A、失败 B；
   - 第二轮续办再次请求 A + B：A 返回 `duplicate`，B 继续失败，仍只有 1 条数据；
   - 第三轮续办修正 B：A 仍被幂等拦截，B 成功，最终恰好 2 条数据；
   - 第二、三轮 system prompt 均包含 `<continuation_guard>`；
   - 第三轮消息保留两条成功签名，证明多轮续办不会丢失幂等保护。
3. **旧请求迟到响应**：停止旧聊天请求后立即发送新请求，延迟到达的旧 SSE 内容不会写入旧消息，也不会覆盖新消息。

同时更新“停止请求”场景终态为 `partial`，并保留既有权限、目标来源、删除确认、闹钟选择、重启失效、重试账本等安全回归场景。

### 浏览器 DOM 验收

在 Qoder 内置浏览器中启动真实 Vite 源码页面，使用浏览器直连模式（localStorage 配置 + 内存仓储 + 本地 Mock SSE），实际驱动：

1. 打开 AI 助手面板、清空会话、输入“创建三个待办：写周报、整理纪要、提交报销”并点击发送；
2. 断言执行结果卡片显示「执行结果 · 完成 2/3」与「失败 1」；
3. 断言三条任务分别为「已完成 / 已完成 / 失败」，失败项显示「错误：标题不能为空」；
4. 断言确定性摘要包含“完成 2 项，失败 1 项”“写入成功 2 项、写入失败 1 项”；
5. 断言“查看执行详情”默认折叠，点击后展开真实结果（两条已创建条目的真实 id 与失败原因）；
6. 页面刷新后执行详情重新折叠，便签列表中出现“写周报”“整理纪要”两条真实待办；
7. 浅色主题下卡片背景为 `rgba(20, 33, 61, 0.05)`、边框为 `rgb(229, 234, 243)`；
8. 深色主题下（`data-theme=dark`）卡片背景为 `rgba(232, 237, 250, 0.08)`、边框为 `rgb(45, 59, 84)`、失败文字为 `rgb(240, 135, 147)`，内容仍完整；
9. 再发送普通聊天“你好”，页面只保留此前的 1 个执行结果卡片，普通对话不生成任务清单。

说明：内置浏览器页面处于隐藏 surface，截图不可用；以上仅为 DOM 文本、结构、折叠状态与计算样式层面的验收。浏览器预览验证的是 React/DOM 与浏览器分支，不代表 Tauri SQLite 桌面端已完成实机验收。验收后已清理测试配置、会话与测试条目，并停止 Vite / Mock 进程、删除临时脚本。

## 11. 构建结果

| 命令 | 结果 |
| --- | --- |
| `pnpm lint` | 通过：0 warnings / 0 errors（138 个文件） |
| `pnpm build` | 通过：`tsc -b` + Vite 构建成功；仅有既有的 chunk > 500 kB 提示 |
| `cargo check --manifest-path src-tauri/Cargo.toml` | 通过 |
| `pnpm tauri:build` | 通过（exit code 0），生成 NSIS 安装包 |

最终安装包：

- 路径：`src-tauri/target/release/bundle/nsis/MEMORA_0.2.0_x64-setup.exe`
- 大小：5,355,677 字节
- 生成时间：2026-11-16 16:28
- SHA-256：`b5d898b36d01b346fcb1e19ecdfeb8e9bb6be363557123320bdd44938c3fc2a9`

项目 `bundle.targets` 仅配置 `nsis`，未生成 MSI。

## 12. Git 工作区状态

Phase 4.3 相关变更：

- 新增：`src/services/agentProgress.ts`、`src/services/agentContinuation.ts`、`tests/agentProgress.test.ts`、`tests/agentContinuation.test.ts`
- 修改：`src/types/ai.ts`、`src/services/agentExecution.ts`、`src/services/assistantIntent.ts`、`src/services/agentToolSchema.ts`、`src/services/assistantContext.ts`、`src/store/useAssistantStore.ts`、`src/components/AssistantPanel.tsx`、`scripts/run-integration-tests.mjs`、`tests/agentExecution.test.ts`

工作区同时保留了前序 Phase（4.1 / 4.2）已暂存或未跟踪的变更和报告；`.installer-test/` 为既有未跟踪目录。本次未执行 `git commit`、`git push`、`git reset`、`git clean`、`git checkout` 或任何破坏性操作。

## 13. 已知限制

1. 未运行真实模型验收：当前环境没有可用的模型 API Key，`pnpm test:real` 未执行；所有模型轮次均由本地 Mock SSE 驱动，真实模型的措辞质量和指令遵循度未在本阶段验证。
2. 已完成浅色 / 深色主题下的浏览器 DOM 验收，但未在真实 Tauri 窗口中做人工视觉验收；系统主题、窄窗口、长标题与多失败项的实际排版仍需在桌面端确认。
3. 续办识别基于明确表达的正则；普通“继续”不会触发续办，避免把生成中断后的“继续输出”当成任务续办。
4. 执行清单在模型尚未请求工具前只显示阶段，不预生成虚构任务；模型给出的“计划”如果没有真实调用，不会进入清单。
5. 执行进度随助手消息存入 localStorage，不是永久业务数据，也不参与 SQLite 同步。
6. Mock SSE 能覆盖真实的 store、执行器与仓储状态，但不能替代真实网关的错误形态、限流与模型行为。
7. 最大工具轮次仍为 8 轮；本阶段只改善上限后的展示与未执行标记，未修改上限。

## 14. 未完成事项

- 使用真实模型 API Key 执行端到端验收，重点观察多轮工具调用中的阶段稳定性、部分成功措辞和续办行为。
- 在真实 Tauri 窗口与窄窗口中人工复查执行进度卡片的排版（浅色 / 深色已做浏览器 DOM 验证）。
- 对安装包执行一次安装 / 启动冒烟测试（本次只完成构建，未安装运行）。
- Phase 4.4 未开始。
