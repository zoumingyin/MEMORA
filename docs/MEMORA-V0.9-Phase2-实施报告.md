# MEMORA V0.9 — Phase 2：Agent 工具执行机制优化 · 实施报告

- 实施日期：2026-11-13
- 实施范围：渲染进程 AI 工具层、删除确认卡片、系统提示词、仓储调用方式
- 约束遵守：未引入 Agent 框架 / 未引入 MCP / 未新增第三方依赖 / 未改 Rust SSE 代理 / 未改数据库迁移 / 未改数据模型 / 未创建演示页面
- 验证基线：`pnpm test:agent`、`tsc -b`、`pnpm lint`、`pnpm build`、`pnpm tauri:build`、浏览器 DOM 端到端验证

---

## 结论摘要

1. **查询、新增、修改全部直接执行**：参数校验通过后立即写库，工具返回前回读仓储确认结果，失败如实报错。
2. **删除是唯一的确认型操作**：`delete_entry` 只生成内存提议与确认卡片，用户点击确认后才 `moveToTrash`（软删除，可恢复）。
3. **ActionCard 只服务删除**：旧 `<action>` 协议不再产生创建/勾选/追加卡片，解析器仅保留用于剥离历史消息。
4. **停止与重复执行安全**：每个工具执行前后检查请求作用域；删除提议原子占用、10 分钟过期、取消/过期/已执行均不可再写库。
5. **提醒重复规则不再降级**：修改提醒时间只改目标闹钟的 `remindAt`，保留 `mode/method/intervalMs`；多闹钟未指定 `alarm_id` 时拒绝并要求先询问用户。
6. **提示词统一**：删除 `assistantContext.ts` 中「删除、改标题、改提醒时间无法执行」的旧规则，工具可用 / 不可用分别注入 `AGENT_TOOL_PROMPT` / `NO_TOOL_PROMPT`。
7. 自动化测试 **77/77 通过**；Windows 安装包构建成功。

---

## 一、改动文件

### 1.1 新增

| 文件 | 职责 |
| --- | --- |
| `src/services/agentToolArgs.ts` | 工具名白名单、参数解析与逐项校验、写入签名 |
| `src/services/agentToolExecutor.ts` | 工具执行、仓储回读校验、停止判断、幂等去重 |
| `src/services/agentToolSchema.ts` | 工具定义、`AGENT_TOOL_PROMPT`、`NO_TOOL_PROMPT`（纯常量，可独立测试） |
| `src/services/reminderAlarms.ts` | 提醒时间修改规则、闹钟模式文案 |
| `src/services/deleteProposals.ts` | 删除提议注册表（内存、TTL、原子 claim） |
| `src/services/deleteExecution.ts` | 确认/取消删除的执行编排与失败原因 |
| `tests/helpers.ts` | 测试环境：真实 `MemoryEntryRepository` + 内存 localStorage |
| `tests/agentTools.test.ts` | 新增/修改/删除/停止/去重/查询的真实执行测试 |
| `tests/deleteExecution.test.ts` | 确认流程、并发、过期、失败回滚测试 |
| `tests/reminderAlarms.test.ts` | 闹钟模式保留与候选选择测试 |
| `tests/prompts.test.ts` | 工具定义与提示词静态一致性测试 |
| `scripts/run-agent-tests.mjs` | 无新依赖的测试运行器（tsc → CJS → `node --test`） |
| `tsconfig.test.json` | 测试编译配置（CommonJS 输出到 `.test-build`） |

### 1.2 修改

| 文件 | 变更 |
| --- | --- |
| `src/services/agentTools.ts` | 改为绑定 store 的薄层，导出 schema；执行逻辑迁入执行器 |
| `src/services/assistantContext.ts` | 移除 `ACTION_PROTOCOL`；规则改为「工具直接执行、删除需确认、只报真实结果」 |
| `src/store/useAssistantStore.ts` | 请求作用域 `toolScope`、停止检查、提示词选择、卡片追加、取消记录 |
| `src/store/useEntryStore.ts` | 待办 items 变更时派生 `done/completedAt`；本地状态改用规范化 patch |
| `src/components/AssistantPanel.tsx` | ActionCard 改为删除专用；接入 `confirmDeleteProposal` / `cancelDeleteProposal`；失败可重试 |
| `src/types/ai.ts` | `AssistantAction` 类型迁入；新增 `toolActionsCancelled`，移除 `createdActions` |
| `src/utils/assistantActions.ts` | 仅保留历史 `<action>` 剥离解析；类型改为从 `types/ai` 再导出 |
| `.gitignore` | 忽略 `.test-build` |
| `package.json` | 新增 `test:agent` 脚本 |

未改动：`src-tauri/src/ai.rs`、SQLite 迁移、`Entry` 数据结构、Rust 依赖。

---

## 二、工具执行策略

```
模型 tool_calls
      │
      ▼
executeToolWithEnv(call, env, scope)
      │
      ├─ 1. scope.isStale()            → cancelled，不执行
      ├─ 2. executedCalls.has(id)      → duplicate，不执行
      ├─ 3. validateToolCall()         → 参数错误，返回明确文案
      ├─ 4. 写入签名去重               → duplicate，不写入
      │
      ▼
search / list / get   create_entry    update_entry    delete_entry
   直接执行            直接执行         直接执行        只创建提议
   返回真实摘要        回读确认         回读逐字段校验   返回 confirm 卡片数据
```

- 新增 / 修改成功后，工具结果包含真实 id、提醒时间、子任务数量、勾选结果等。
- 新增后校验条目存在且 kind 一致；修改后逐字段比对标题、正文、子任务、标签、目标闹钟时间与模式。
- 任何回读不一致都返回「修改未能确认：…」，不输出成功文案。

---

## 三、删除流程

```
delete_entry(id)
  ├─ 条目不存在            → 错误，不生成提议
  ├─ createDeleteProposal  → { id, entryId, kind, title, expiresAt }
  ├─ 生成期间用户已停止    → 提议 cancelled，不返回卡片
  └─ 返回 confirm + confirmAction(proposalId, expiresAt)

用户点击「确认删除」
  ├─ claimDeleteProposal：pending → executing（原子，只成功一次）
  ├─ 目标已不存在          → invalid，提示「已不存在」
  ├─ kind 变化             → invalid，提示重新确认
  ├─ moveToTrash 抛错      → release，提示「删除未生效，请稍后重试」
  ├─ 回读仍存在            → release，不谎报成功
  └─ 回读已消失            → done，卡片显示「已移入废纸篓」

用户点击「取消」
  └─ 提议 cancelled，不执行任何数据库操作
```

卡片状态：`待确认 / 已移入废纸篓 / 已取消 / 已失效`；写入失败且提议已释放时显示「删除失败，可重试」并保留按钮。

---

## 四、参数校验规则

| 项目 | 规则 |
| --- | --- |
| 工具名 | 仅允许 7 个白名单工具，未知工具报错 |
| 未知字段 | 整条拒绝（`id/createdAt/deletedAt` 等受保护字段无法写入） |
| 必填 | `create_entry.kind/title`、`update_entry.id`、`delete_entry.id`、`search_notes.query` |
| 长度 | 标题 ≤120、正文 ≤4000、子任务 ≤200×20、标签 ≤24×12、query ≤100 |
| 类型 | 字符串 / 字符串数组 / 时间；不允许对象混入 |
| 条目 | update/delete 前必须存在；涂鸦不可由 AI 修改 |
| 提醒时间 | 合法日期、归整到分钟、必须晚于当前时间 |
| 子任务 | `complete_items` 必须真实存在且未完成；`add_items` 不得重复；总数 ≤20 |
| 标签 | `remove_tags` 必须存在；增删后写入实际列表 |
| 组合 | `content` 与 `append_content` 互斥；`alarm_id` 必须与 `remind_at` 同时出现 |
| 写库方式 | 逐字段显式构造 patch，绝不展开模型对象 |

所有失败返回中文明确原因，不做静默截断、静默忽略或静默改参。

---

## 五、幂等与重复执行保护

- **单次请求内**：按 `tool_call_id` 去重；写入类再按「工具名 + 规范化参数」签名去重，签名在写库前登记。
- **删除提议**：`pending → executing → done` 原子流转；重复点击、并发点击只有一次进入执行。
- **取消 / 过期 / 已执行**：claim 分别返回 `cancelled / expired / done`，一律不写库。
- **作用域边界**：去重仅限单次用户请求；新的请求可重复执行相同内容。
- **重启边界**：提议表仅存内存，应用重启后历史卡片点击确认会提示「找不到删除提议（可能应用已重启），请让助手重新发起删除」。
- **清空会话**：`clear()` 同时 `resetDeleteProposals()`，避免内存表增长与旧卡片误执行。

---

## 六、停止（stop）处理

| 时机 | 行为 |
| --- | --- |
| 工具轮开始前 | `isStale()` 为真直接返回，不执行任何工具 |
| 每个工具执行前 | 已停止则跳过，后续工具不再执行 |
| 工具执行期间 | 不依赖 SSE cancel；以 `requestId` 为准 |
| 工具执行完成后 | 若已停止：不回传 tool 消息、不追加删除卡片、不继续下一轮 |
| 删除提议生成期间 | 提议立即作废，不展示卡片 |
| 已提交的写入 | 不回滚、不谎报取消；消息提示「停止前已开始的工具操作可能已经生效，请检查便签列表」 |

---

## 七、提醒重复规则保护

- `remind_at` 只修改目标闹钟：`{ ...target, remindAt, notified:false }`。
- 保留字段：`id / mode / method / interval / intervalMs`；其它闹钟对象原样保留。
- 支持模式：`once / loop / daily / weekly / monthly / yearly / lunar / workday`。
- 候选规则：优先未通知闹钟；全部已通知时退化为全部闹钟。
- 单个候选自动选中；多个候选且无 `alarm_id` 时拒绝，并在错误中列出 `alarm_id`、模式与时间，要求先询问用户。
- 工具没有修改 `mode` 的参数，重复规则只能由用户在界面手动调整。
- 修改成功后清除条目 `done/notified`，让提醒重新生效。

---

## 八、提示词统一

| 场景 | 注入内容 |
| --- | --- |
| 工具可用 + 上下文开启 | `assistantContext` 规则 + `AGENT_TOOL_PROMPT` |
| 上下文关闭 | 禁用上下文提示 + `NO_TOOL_PROMPT`（明确不能读写） |
| 模型不支持工具（降级重试） | 系统消息中移除 `AGENT_TOOL_PROMPT`，替换为 `NO_TOOL_PROMPT` |

`AGENT_TOOL_PROMPT` 关键规则：

1. 查询、新增、修改直接调用，立即生效；
2. 删除只生成确认卡片，必须如实说明「等待用户确认」，不能声称已删除；
3. 结果以工具返回为准，工具报错如实转述，不编造成功；
4. 修改提醒前先用 `get_note` 读取闹钟，多闹钟必须询问用户并指定 `alarm_id`；
5. 保留重复规则，不把重复提醒改成单次；
6. 不传受保护字段；不再输出 `<action>` 块。

`assistantContext.ts` 已删除以下旧内容：`ACTION_PROTOCOL` 注入、「删除、改标题、改提醒时间仍无法执行」规则。

---

## 九、测试与真实结果

### 9.1 命令与结果

| 命令 | 结果 |
| --- | --- |
| `pnpm test:agent` | **77 tests / 77 pass / 0 fail**（11 suites） |
| `tsc -b` | 0 错误 |
| `pnpm lint` | 0 warning / 0 error（113 files） |
| `pnpm build` | 成功（Vite 8 + Rolldown） |
| `pnpm tauri:build` | 成功，release 构建 1m58s |

### 9.2 测试环境说明

- 使用真实的 `MemoryEntryRepository`（与 SQLite 仓储同为 `EntryRepository` 实现，写入语义一致），localStorage 用内存 Map 顶替。
- 每个用例断言的是落库后的真实快照（含废纸篓），不是对调用参数的静态断言。
- 提示词、工具定义属于静态校验（文本与 required/properties 一致性）。

### 9.3 覆盖范围

- **新增**：备忘 / 待办（含子任务）/ 提醒（未来时间、单次闹钟）；无效时间、过期时间、缺少 reminder 时间、受保护字段、超长标题、仓储返回 null。
- **修改**：标题、整体替换、追加、勾选/新增子任务、标签增删；不存在条目、非法字段、互斥字段、空修改、涂鸦拒绝、勾选不存在项、重复新增项、回读不一致。
- **提醒**：8 种模式逐一验证模式/方式/间隔保留；多闹钟拒绝并列出候选；指定 `alarm_id` 只改目标；`alarm_id` 不存在；已处理提醒重新生效。
- **删除**：确认前不删、取消不删、确认进入废纸篓且列表消失、重复确认、并发确认、目标缺失、类型变化、过期、提议丢失（重启）、重复删除请求不生成第二张卡片。
- **停止**：执行前停止、执行中停止、已提交写入不回滚、删除卡片不展示。
- **去重**：同 `tool_call_id`、同参数不同 id、跨请求作用域隔离。
- **查询**：搜索返回真实 id、只列未完成待办、`get_note` 返回 `alarm_id`、查询工具拒绝多余参数。

---

## 十、Windows 构建结果

| 产物 | 路径 | 大小 |
| --- | --- | --- |
| 可执行文件 | `src-tauri/target/release/bianqian.exe` | 19.9 MB |
| NSIS 安装包 | `src-tauri/target/release/bundle/nsis/MEMORA_0.2.0_x64-setup.exe` | 5.09 MiB |

最终代码（含 ActionCard 失败重试调整）于 2026-11-13 10:17 重新打包完成。

---

## 十一、界面验证

本次验证会话中内置浏览器未提供可用视口（`NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`，0×0），**无法产出截图**；改用真实页面 DOM 断言完成端到端验证：

| 场景 | 结果 |
| --- | --- |
| 卡片初始态 | 「删除便签 · 备忘 / 待确认」，显示目标标题、影响说明、确认与取消按钮 |
| 点击确认 | 侧栏「全部 1→0」、废纸篓徽标 1、卡片「已移入废纸篓」、按钮消失；`localStorage` 条目写入 `deletedAt` |
| 点击取消 | 条目仍在、提议 `cancelled`、卡片「已取消」、无数据库写入 |
| 非本会话提议（模拟重启） | 卡片「已失效」+ 重启提示，条目未删除，无虚假成功 |

如需截图，可打开内置浏览器后重新验证；本次结论以 DOM 结构与存储状态为准。

---

## 十二、遗留问题

1. 删除提议仅存内存：应用重启后历史卡片必须由 AI 重新发起删除。
2. 不支持 function calling 的模型降级为只读对话，无法新增/修改/删除。
3. 旧 `<action>` 解析器仍保留，仅用于剥离历史回答中的动作块，不再渲染卡片。
4. 自动化测试不覆盖 React 渲染层；UI 行为以本次 DOM 端到端验证与类型检查为准。
5. `remind_at` 无法修改重复规则本身，用户需要改模式时只能手动编辑。
6. 改动尚未提交 git；工作区同时存在此前 V0.8 品牌相关未提交改动，本阶段未触碰。
7. Windows 安装包在构建目录中存在旧版 `便签_0.2.0_x64-setup.exe`（11-09），当前产物名为 `MEMORA_0.2.0_x64-setup.exe`（11-13）。

---

## 十三、验收结论

- 查询、新增、修改：直接执行并在界面立即可见。
- 删除：只通过确认卡片执行，取消与失效均不写库。
- 参数：全部校验，失败有明确原因，无静默修改。
- 结果：全部来自仓储回读，不虚构成功。
- 提醒：重复规则完整保留，多闹钟要求用户指定。
- V0.8 品牌视觉、主题、布局未改动。

Phase 2 完成，等待确认后进入 Phase 3。
