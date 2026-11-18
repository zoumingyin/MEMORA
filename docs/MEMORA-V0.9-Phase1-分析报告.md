# MEMORA V0.9 — Phase 1：AI Agent 现状分析报告

- 分析日期：2026-11-12
- 分析范围：`src/` 前端 AI 相关组件与服务、`src-tauri/src/ai.rs`、SQLite 数据层与仓储
- 分析方式：只读源码审计，不改代码、不建表、不升级依赖
- 结论性质：所有结论均来自当前仓库源码，未使用任何 Agent 框架假设

---

## 结论摘要

1. 项目**没有引入任何 Agent 框架**。所谓「AI Agent」由两部分组成：渲染进程里的手写工具循环（`useAssistantStore.send()`），以及 Rust 侧只负责 SSE 转发的 `ai_chat` 代理。模型协议是标准 OpenAI Chat Completions，工具走 `tool_calls` + `role:"tool"`。
2. 现有能力已经覆盖了 V0.9 目标的大部分读取与写入需求：**7 个工具**（`search_notes` / `list_todos` / `list_reminders` / `get_note` / `create_entry` / `update_entry` / `delete_entry`），其中最关键的读取类工具可直接复用。
3. 最大的结构性缺口不在「能不能操作」，而在**操作的安全边界**：`create_entry` 与 `update_entry` 会在工具循环中**立即写入**，没有任何用户确认；只有 `delete_entry` 走 `confirmAction` 卡片。这与产品「先预览、确认后写入、取消不写入」的要求相冲突。
4. 第二个明显缺口是**提示词自相矛盾**：`assistantContext.ts` 的系统提示仍告诉模型「删除、改标题、改提醒时间无法执行」，而 `AGENT_TOOL_PROMPT` 又提供了这些工具。模型行为因此不稳定。
5. 数据层只有一张 `entries` 表（迁移 v1–v7），没有分类表、标签表、会话表、审计表。V0.9 若要求会话持久化与操作审计，需要在**不改动既有迁移**的前提下新增迁移。
6. 建议的 V0.9 走**渲染层最小改造**：把写入类工具统一收口为「提议 → 确认 → 执行」，补齐参数校验与幂等，修正提示词冲突，再考虑新增工具。不需要引入新依赖，也不需要重写 Rust 代理。

---

## 一、当前架构

### 1.1 运行态分层

```
┌────────────────────────── 渲染进程（React） ──────────────────────────┐
│                                                                       │
│  AssistantPanel.tsx                                                   │
│    ├─ 消息列表 / Markdown 渲染 / ActionCard 确认卡片                   │
│    └─ 输入框（上下文开关、联网开关、模型选择、思考档位）                │
│              │                                                        │
│              ▼                                                        │
│  useAssistantStore.ts（Zustand）                                      │
│    ├─ send()            组装历史 + 上下文 + 系统提示 + tools           │
│    ├─ 工具循环          最多 MAX_TOOL_ROUNDS = 8 轮                    │
│    ├─ 降级重试          工具不被支持时去掉 tools 重发一次               │
│    └─ localStorage      bianqian.assistant.v1                          │
│              │                                                        │
│              ├──────────────► services/assistantContext.ts             │
│              │                 buildAssistantContext() 生成 <notes>    │
│              │                                                        │
│              ├──────────────► services/agentTools.ts                   │
│              │                 AGENT_TOOLS + executeAgentTool()        │
│              │                   └─► useEntryStore（直接读写仓储）      │
│              │                                                        │
│              └──────────────► services/aiClient.ts                     │
│                                streamChat() → invoke("ai_chat")        │
└───────────────────────────────────┬───────────────────────────────────┘
                                    │ Tauri IPC + Channel（流式事件）
                                    ▼
┌────────────────────────── Rust 主进程 ────────────────────────────────┐
│  ai.rs                                                                │
│    ├─ ai_chat()          构造请求体，透传 messages / tools             │
│    ├─ SSE 解析           ToolCallAggregator 聚合增量 tool_calls        │
│    ├─ 事件回传           AiStreamEvent::{Delta, ToolCalls, Done, Err}  │
│    └─ ai_cancel()        标记 request_id 取消                          │
│                                                                       │
│  配置：app_data_dir/ai-config.json（模型配置，密钥编译期内置源除外）    │
└───────────────────────────────────┬───────────────────────────────────┘
                                    │ HTTPS
                                    ▼
                         OpenAI 兼容网关（Chat Completions）
```

关键事实：

- `ai.rs` 不做任何决策：不解析工具语义、不执行工具、不持有对话状态。它只把 `tools` 原样放进请求体，把 `tool_calls` 原样回传。
- 工具循环完全在渲染进程，因此**能力的上限由前端决定**，新增工具不需要改 Rust。
- 流式事件通过 `Channel` 回传，`ToolCalls` 在 `Done` 之前单独发一次完整聚合结果。

### 1.2 一次「工具调用」的完整时序

```
用户发送
  → send() 组装：历史消息 + <notes> 上下文 + 系统提示 + tools（仅上下文开启时）
  → aiClient.streamChat() → invoke("ai_chat")
  → Rust 转发 SSE，增量文本实时渲染
  → 模型返回 finish_reason = tool_calls
  → Rust 聚合 tool_calls，emit ToolCalls
  → 前端逐条 executeAgentTool()
        ├─ 读取类：生成文本结果
        ├─ create/update：直接写 useEntryStore → 返回执行结果
        └─ delete：不写，返回 confirmAction
  → 结果以 role:"tool" 回填 messages，进入下一轮
  → 最多 8 轮；到达上限直接结束
  → 最终文本入列表并与消息一起持久化
```

降级逻辑：若上游返回的错误码命中 `TOOL_UNSUPPORTED_CODES`（`http_error` / `endpoint_not_found` / `server_error`），则去掉 `tools` 与工具提示词重发一次，退回纯文本回答。

---

## 二、项目文件清单

| 层 | 文件 | 职责 | 规模 |
| --- | --- | --- | --- |
| UI | `src/components/AssistantPanel.tsx` | 对话面板、消息渲染、ActionCard 确认卡片、开关与模型选择 | 大 |
| UI | `src/components/SettingsDialog.tsx` | AI 配置、隐私开关、自动总结设置（`ai-privacy` / `ai-summary`） | 大 |
| 状态 | `src/store/useAssistantStore.ts` | 消息、历史、工具循环、降级、持久化 | 614 行 |
| 状态 | `src/store/useAiProfileStore.ts` | 模型配置的加载 / 激活 / 同步 | 小 |
| 状态 | `src/store/useEntryStore.ts` | 全部便签 CRUD 与筛选 | 中 |
| 服务 | `src/services/agentTools.ts` | 7 个工具定义 + 执行分发 | 516 行 |
| 服务 | `src/services/assistantContext.ts` | `<notes>` 上下文拼装与长度约束 | 189 行 |
| 服务 | `src/services/aiClient.ts` | 桌面 / 浏览器双通道流式调用、配置 CRUD、取消 | 968 行 |
| 服务 | `src/services/dailySummary.ts` | 独立的后台自动总结（写入一条备忘） | 中 |
| 工具 | `src/utils/assistantActions.ts` | 旧版 `<action>` 文本协议解析、`AssistantAction` 类型 | 中 |
| 类型 | `src/types/entry.ts` | `Entry` / `TodoItem` / `AlarmItem` / `EntryRow` | 中 |
| 数据 | `src-tauri/src/lib.rs` | 迁移 v1–v7、窗口与 IPC、图片预览中转 | 大 |
| 数据 | `src/repository/sqliteRepository.ts` | SQLite 仓储实现 | 中 |
| 数据 | `src-tauri/src/ai.rs` | AI 配置、SSE 代理、取消 | 2374 行 |

> 说明：仓库中**不存在** Agent 框架、向量库、RAG 索引、会话数据库、工具注册中心（插件式）等模块。`assistantActions.ts` 是 V0.8 及更早的文本协议路径，与 `agentTools.ts` 并存。

---

## 三、数据结构

### 3.1 数据库

只有一个业务表 `entries`，通过迁移 v1–v7 逐步演进；v7 重建表并把 `kind` 约束为四种类型。

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | `crypto.randomUUID()` |
| `kind` | TEXT | CHECK IN (`note`,`reminder`,`todo`,`draw`) |
| `title` | TEXT | 标题，写入前 trim |
| `content` | TEXT | Markdown 正文（涂鸦为 base64，禁止进入 AI 上下文） |
| `remind_at` | INTEGER NULL | 提醒条目级下次触发时间；非提醒为 NULL |
| `done` | INTEGER | 待办/提醒的完成态；待办由子任务派生 |
| `completed_at` | INTEGER NULL | 完成时间 |
| `notified` | INTEGER | 提醒是否已通知 |
| `created_at` | INTEGER | 创建时间 |
| `updated_at` | INTEGER | 编辑时间；`moveToTrash` 不改它 |
| `sync_status` | TEXT | `pending` / `synced` |
| `items` | TEXT (JSON) | 待办子任务 `TodoItem[]` |
| `alarms` | TEXT (JSON) | 提醒闹钟 `AlarmItem[]` |
| `tags` | TEXT (JSON) | 标签字符串数组 |
| `color` | TEXT NULL | 纸张颜色 key |
| `paper` | TEXT NULL | 纸张纹理 key |
| `deleted_at` | INTEGER NULL | 软删除标记，非空即在废纸篓 |

**没有的表**：分类表、标签表、对话/会话表、消息表、操作审计表、AI 调用日志表。

### 3.2 前端类型要点

- `TodoItem { id, text, done }`：待办的完成态由「全部子任务完成」派生，`update` 时同步写 `done` 与 `completed_at`。
- `AlarmItem { id, remindAt, mode, method, notified }`：`mode` 支持 `once/loop/daily/weekly/monthly/yearly/lunar/workday`，`method` 支持 `dialog/notification/sound`。
- 读取时 `EntryRow` 的 snake_case 统一映射为 camelCase，JSON 列做容错解析。

### 3.3 读写入口

- 仓储接口 `EntryRepository`：`listAll / listByKind / create / update / remove / listTrash / moveToTrash / restore / purge / emptyTrash / markNotified / markAlarmNotified / snoozeAlarm / listPendingSync / markSynced / importAll`。
- `update` 只写传入的列；`items` 变更会派生 `done`，`alarms` 变更会把 `remind_at` 重算为最近的未通知闹钟。
- Store 层动作：`addEntry / updateEntry / toggleTodo / toggleReminderDone / moveToTrash / restoreEntry / purgeEntry / emptyTrash / markNotified / markAlarmNotified / importEntries`。
- 删除是**软删除**，`moveToTrash` 只写 `deleted_at`；AI 侧删除因此天然可恢复。

### 3.4 AI 侧数据

- 对话持久化：`localStorage["bianqian.assistant.v1"] = { messages, contextEnabled, webSearch }`。
- 模型配置：桌面端在 Rust `app_data_dir/ai-config.json`；浏览器预览回落 `localStorage["bianqian.assistant.ai.v2"]`。
- 消息裁剪：`MAX_STORED_MESSAGES 40`、`MAX_HISTORY_MESSAGES 12`、`MAX_MESSAGE_CHARS 2000`、`MAX_HISTORY_CHARS 8000`。
- 上下文裁剪：`MAX_CONTEXT_CHARS 6000`、`MAX_RECENT_ENTRIES 15`、`SELECTED_CONTENT_CHARS 1200`、`ENTRY_CONTENT_CHARS 260`。
- 工具结果裁剪：`MAX_RESULT_CHARS 1600`、`MAX_SEARCH_HITS 8`、`MAX_NOTE_CHARS 1500`。

---

## 四、现有能力

### 4.1 已有工具清单

| 工具 | 类型 | 行为 | 是否自动写入 |
| --- | --- | --- | --- |
| `search_notes` | 读 | 按关键词匹配标题 / 正文 / 标签，可限定 kind | 否 |
| `list_todos` | 读 | 列出未完成待办与子任务完成度 | 否 |
| `list_reminders` | 读 | 列出待触发提醒，按时间升序 | 否 |
| `get_note` | 读 | 按 id 取单条正文（≤1500 字） | 否 |
| `create_entry` | 写 | 新建备忘 / 待办 / 提醒，`remindAt` 必填且须晚于当前 | **是，立即生效** |
| `update_entry` | 写 | 改标题 / 正文 / 追加正文 / 勾选子任务 / 加子任务 / 改提醒时间 | **是，立即生效** |
| `delete_entry` | 写 | 移入废纸篓 | 否，返回确认卡片 |

`executeAgentTool` 统一按名称分发，返回 `ToolOutcome { result: string; confirmAction?: AssistantAction }`。

### 4.2 V0.9 目标能力对照

| 目标能力 | 现状 | 结论 |
| --- | --- | --- |
| 搜索便签 | `search_notes` | 直接复用 |
| 读取单条便签 | `get_note` | 直接复用 |
| 列出未完成待办 | `list_todos` | 直接复用 |
| 列出近期提醒 | `list_reminders` | 直接复用 |
| 新建备忘 / 待办 / 提醒 | `create_entry` | 复用逻辑，**改为确认后写入** |
| 修改标题 / 正文 / 追加内容 | `update_entry` | 复用，需补参数校验与确认 |
| 勾选待办子任务 | `update_entry(complete_items)` | 复用，文本匹配需消歧 |
| 删除便签 | `delete_entry` | 已确认化，复用 |
| 按时间范围查询 / 统计汇总 | 无 | 需新增（纯读取，风险低） |
| 标签读写 | `tags` 字段存在，工具未暴露 | 需在 `update_entry` 扩展或新增工具 |
| 批量操作 | 无（单次一轮最多 8 轮） | 需新增，且必须逐条确认 |

### 4.3 其他已具备的能力

- **多轮对话**：历史按 12 条 / 8000 字裁剪后随请求发送。
- **流式输出**：Rust 逐 token 回传，前端增量渲染，支持 `ai_cancel`。
- **模型降级**：工具不被上游支持时自动退回纯文本。
- **工具轮次上限**：8 轮，防止无限循环。
- **上下文开关**：关闭时不发送 `tools`，不发 `<notes>`，模型退化为普通聊天。
- **操作卡片**：`ActionCard` 支持创建 / 勾选 / 追加 / 删除四种展示与执行，含「目标已删除」保护。

---

## 五、风险分析

| 编号 | 风险 | 位置 | 影响 |
| --- | --- | --- | --- |
| R1 | 系统提示自相矛盾 | `assistantContext.ts:182` 说「删除、改标题、改提醒时间无法执行」，`AGENT_TOOL_PROMPT` 又提供这些工具 | 模型时而拒绝、时而直接改，行为不可预期 |
| R2 | 写操作无确认 | `agentTools.ts` 的 `create_entry` / `update_entry` 在循环中直接写仓储 | 模型误判或提示注入即可改数据，违反「确认后写入」 |
| R3 | 取消不中断写入 | 工具执行块未逐条检查 `isStale()` | 用户点「停止」后仍在途的工具仍会落库 |
| R4 | 改提醒时间破坏重复规则 | `update_entry` 的 `remind_at` 用单个 `once/dialog` 闹钟整体替换 `alarms` | 每日 / 每周 / 农历等重复提醒被静默降级为一次性 |
| R5 | 无幂等 | 重试 / 重复点击会产生重复条目 | 数据污染 |
| R6 | 轮次上限静默结束 | 达到 `MAX_TOOL_ROUNDS` 直接结束，无提示 | 用户看到半截结果，不知道被截断 |
| R7 | 关闭上下文仍保留历史 | 历史持久化与 `contextEnabled` 解耦 | 隐私预期不符（用户以为关闭后不再带任何便签信息） |
| R8 | 静默截断 | 1600 / 1500 / 260 字的上限无任何标记 | 模型基于残缺内容作答，用户无从判断 |
| R9 | 文本匹配歧义 | `complete_items` / `complete-todo` 按子任务文本匹配 | 同名子任务会误勾，找不到时只提示「可能已被修改」 |
| R10 | 无审计与撤销 | 没有操作日志，`update_entry` 覆盖后无法回滚 | 误改难以恢复（删除尚可从废纸篓恢复） |
| R11 | 搜索为全表 O(n) | `search_notes` 在内存中遍历全部条目 | 条目增多后每次工具调用都全量扫描 |
| R12 | 无会话隔离 | 单一消息数组，自动总结与手动对话共用 `contextEnabled` | 同时开启时相互影响，无法分开管理 |

补充观察：

- 涂鸦条目的 `content` 是 base64，现有 `assistantContext` / `search_notes` 已将其排除在摘要外，但若新增「全文检索」类工具，必须沿用这一排除规则。
- `delete_entry` 只返回 `confirmAction`，实际删除由前端卡片触发，这是目前唯一符合「确认后写入」的写路径，可作为其余写操作的模板。

---

## 六、V0.9 最小改造方案

原则：**不新增依赖、不改 Rust 代理、不重写迁移、复用现有工具与卡片体系**。

### A. 统一写操作的「提议 → 确认 → 执行」契约

- 让 `create_entry` / `update_entry` 与 `delete_entry` 一致：只返回 `confirmAction`，不在工具内写入。
- 由 `ActionCard` 统一执行写入，保证「取消不写入」。
- 工具返回值改为「已生成待确认操作，请等待用户确认」，避免模型声称已执行。

### B. 修正提示词冲突

- 删除 `assistantContext.ts:182` 中「无法执行」的旧表述，改为引用 `AGENT_TOOL_PROMPT` 的能力清单。
- 明确「所有写操作都需要用户确认」这一条只出现一次，避免两处措辞漂移。

### C. 参数校验与幂等

- 在 `executeAgentTool` 入口做统一校验：必填、长度、时间必须晚于当前、id 必须存在且类型匹配。
- 为写操作引入一次性 `requestId` / 目标版本号，重复提交直接拒绝。

### D. 破坏性变更保护

- `update_entry` 的 `remind_at` 改为「修改最近一个未通知闹钟的时间」，不再整体替换 `alarms`。
- 勾选子任务支持 id 优先、文本兜底，并在结果中回显实际勾选项。

### E. 可观测性

- 轮次达到上限时给出明确提示。
- 截断结果追加「（已截断）」标记。
- 关闭上下文时同步清理历史，或明确提示历史仍会发送。

### F. 工具扩展（按需）

- 只在上述契约稳定后新增读取类工具（时间范围查询、统计汇总、标签筛选），写类工具保持最少。

---

## 七、分阶段开发计划

### Phase 2：契约与校验层

- 写工具统一返回 `confirmAction`；`executeAgentTool` 增加集中校验；工具返回文案与 `AGENT_TOOL_PROMPT` 对齐。
- 验收：`create_entry` / `update_entry` 不再直接落库；取消后数据库无变化；非法参数返回可读错误且不写库。

### Phase 3：确认卡片与破坏性保护

- `ActionCard` 覆盖新增 / 修改 / 勾选 / 追加 / 删除全部操作，展示「改前 → 改后」。
- `remind_at` 改为单闹钟更新；勾选支持 id 优先。
- 验收：每日提醒改时间后 `mode` 不变；同名子任务按 id 勾选正确。

### Phase 4：上下文与会话

- 关闭上下文时清理或隔离历史；自动总结与手动对话的开关解耦；补充截断标记。
- 验收：关闭上下文后的请求体不含任何条目信息；自动总结开关不影响手动对话。

### Phase 5：新工具（只读优先）

- 时间范围查询、统计汇总、标签筛选；沿用 base64 排除规则与结果长度上限。
- 验收：新工具对涂鸦条目不泄露 base64；结果超长时有截断标记。

### Phase 6：审计与回归

- 轻量操作记录（可先只存内存或单表），关键写操作可追溯；补全回归用例。
- 验收：任一写操作可从记录中还原「谁在何时改了什么」。

---

## 附：本报告的边界

- 本次未执行任何数据库迁移，`entries` 表结构维持 v7。
- 未新增或升级依赖。
- 未修改 V0.8 已交付的视觉与主题系统。
- 报告中提到的行号以当前 `main` 分支（`3603b2c`）源码为准，后续改动可能导致偏移。

Phase 1 到此结束，等待确认后进入 Phase 2。
