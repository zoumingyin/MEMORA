# MEMORA V0.9 — Phase 3.2：提醒歧义安全拦截 实施报告

> 范围：在**执行层**拦截「多闹钟提醒未指定目标」的修改，用户点击候选后才产生一次性授权。
> 未修改 SQLite 表结构，未新增第三方依赖，未引入 LangChain / AutoGen / MCP，未改变新增/普通修改直接执行、删除确认的既有规则。
> 本报告只记录本阶段实际执行过的验证；未验证项在第十节明确标记。

## 一、修改文件清单

### 新增

| 文件 | 作用 |
| --- | --- |
| `src/services/alarmSelections.ts` | 候选闹钟选择提议的内存注册表：候选生成、快照指纹、一次性 claim、取消/失效/清理 |
| `src/services/alarmSelectionExecution.ts` | 用户点击候选后的执行：claim → 写入前复查 → 复用 update_entry 写入 → 写入后回读 → 状态收尾 |
| `tests/alarmSelection.test.ts` | 13 项授权与歧义拦截单元测试（真实 MemoryEntryRepository + FakeStorage） |
| `docs/MEMORA-V0.9-Phase3.2-实施报告.md` | 本报告 |

### 修改

| 文件 | 变更 |
| --- | --- |
| `src/types/ai.ts` | 新增 `AlarmSelectionCandidate` / `AssistantAlarmSelection`；`AssistantMessage` 增加 `toolSelections`、`toolSelectionsDone`、`toolSelectionsCancelled` |
| `src/services/agentToolExecutor.ts` | `AgentToolScope` 增加 `messageId`；`ToolOutcome` 增加 `alarmSelection`；`update_entry` 在写入前做多闹钟歧义拦截与授权校验；新增 `executeAuthorizedAlarmUpdate` |
| `src/services/agentExecution.ts` | `ToolBatchResult` 汇总 `alarmSelections`，随批次结果交由 store 展示 |
| `src/services/agentTools.ts` | 抽出 `createAgentToolEnv()`，点击执行与模型执行共用同一套 store 绑定 |
| `src/store/useAssistantStore.ts` | 新任务/停止时作废旧授权；工具批次结果写入消息卡片；清空会话时清理注册表；新增 `markToolSelectionDone/Cancelled` |
| `src/services/reminderAlarms.ts` | 新增 `ALARM_METHOD_LABEL`（弹窗 / 通知 / 提示音） |
| `src/components/AssistantPanel.tsx` | 新增候选闹钟选择卡片：候选按钮、等待/已修改/已取消/失败状态、取消与重试 |
| `tests/agentExecution.test.ts` | 更新为「模型自选 alarm_id 不等于授权」；覆盖选择后只改选中闹钟与不可重复执行 |
| `tests/agentTools.test.ts` | 更新多闹钟场景断言：返回 `needsInput` + 候选卡片，不写入 |
| `scripts/integration/harness.mjs` | 暴露 `selectAlarm`（真实 store + 仓储执行点击），reset 时清理授权注册表 |
| `scripts/integration/mockSseServer.mjs` | 支持浏览器 CORS 预检（OPTIONS），便于真实页面联调；Node 集成测试行为不变 |
| `scripts/run-integration-tests.mjs` | 场景 4 增加候选卡片断言；新增「用户选择后只改选中闹钟」场景（共 11 项） |
| `scripts/run-real-model-acceptance.mjs` | 场景 4 改为连续 3 次歧义任务；新增场景 5 真实模型触发卡片后点击写入 |

**未修改**：SQLite 表结构与仓储接口、新增/普通修改/删除的执行规则、系统提示词约束（本阶段坚持在执行层兜底，而不是继续加强提示词）。

## 二、歧义检测逻辑

位置：`src/services/agentToolExecutor.ts` 的 `updateEntry`，在构造任何 patch 之前执行。

触发条件：`update_entry` 带 `remind_at`，目标是 reminder，且**没有用户授权**时：

1. `pendingAlarmCandidates(entry.alarms)` 先取未触发闹钟；全部已触发时退化为全部闹钟（与既有「已触发时可改最近闹钟」规则一致）。
2. 候选数 ≤ 1：保持原行为，直接执行。
3. 候选数 ≥ 2：
   - **不执行** `env.updateEntry`，不改任何 alarms；
   - 生成 `AlarmSelectionProposal` 并写入内存注册表；
   - 返回 `status=error` + `needsInput=true` + `alarmSelection` 卡片；
   - 工具结果明确告知模型「已向用户展示选择卡片，不要自行挑选或重复调用」；
   - 批次执行器把 `needsInput` 汇总为终态 `needs_input`，任务进入等待用户补充。

候选只包含 `alarmId / mode / remindAt / method`，不暴露 `notified`、内部快照、请求 id 等无关字段。

**关键边界**：模型自己在参数里给出一个真实存在的 `alarm_id`，仍然走「无授权」分支，不会直接写入。模型能看到的真实 id 只用于描述候选，不构成用户授权。

## 三、用户选择与授权状态设计

- 存储：模块级内存 `Map<proposalId, AlarmSelectionProposal>`，无新增数据库表、无持久化默认授权。
- 提议字段：
  - 展示：`proposalId / entryId / title / remindAt / candidates / expiresAt`
  - 绑定：`requestId / messageId / toolCallId / createdAt`
  - 执行：模型原始 `UpdateEntryArgs`（选择后连同标题、正文等变更一起生效，不会只改时间丢掉其它字段）
  - 防篡改：`fingerprint = 标题 + 全部闹钟 [id, remindAt, mode, method, notified]`
  - 状态机：`pending → executing → done | cancelled | expired | invalid`
- 授权来源：**只有 AssistantPanel 里用户点击候选按钮**才调用 `confirmAlarmSelection`；模型回复、模型参数、普通文本描述都不产生授权。
- 一次性：`claimAlarmSelection` 原子地把 `pending` 置为 `executing`；`done` 后再次点击返回「已执行」，不会二次写入。
- TTL：10 分钟；过期后 `claim` 失败并标记 `expired`。

## 四、授权失效规则

| 事件 | 实现 | 结果 |
| --- | --- | --- |
| 用户取消 | `cancelAlarmSelection` / 卡片「取消」 | `cancelled`，之后点击不写库 |
| 用户开始新任务 | `send()` 开头 `cancelPendingAlarmSelections()` | 旧 pending 全部 `cancelled` |
| 请求被停止 | `stop()` 中 `cancelPendingAlarmSelections()` | 旧 pending 全部 `cancelled` |
| 清空会话 | `clear()` 中 `resetAlarmSelections()` | 注册表清空 |
| 目标提醒被删除 | `confirmAlarmSelection` 复查 entry | 返回 `missing`，不写入 |
| 目标已不是提醒 | 复查 kind | 返回 `kind_changed`，不写入 |
| 选中闹钟不存在 | 复查候选与 alarms | 返回 `alarm_missing`，不写入 |
| 标题或任一闹钟变化 | 快照指纹比对 | 返回 `changed`，不写入 |
| 授权已使用 | `claim` 状态检查 | 返回 `done`，不写入 |
| 时间已过去 | 写入前时间校验 | 返回 `past_time`，不写入 |
| 请求/目标不匹配 | `requestId`/`entryId` 绑定与 `claim` 校验 | 返回 `target_changed`，不写入 |

所有失败分支都**只拒绝，不改选其它闹钟**；写入失败（如仓储异常）释放 claim 允许重试，但过期/作废不释放。

## 五、执行前复查机制

`confirmAlarmSelection` 的顺序（`src/services/alarmSelectionExecution.ts`）：

1. `claim`：状态、过期、`entryId`、候选 `alarmId` 全部匹配才占用；
2. entry 仍存在且仍为 reminder；
3. `reminderSelectionFingerprint(entry)` 与提议快照一致；
4. 选中闹钟仍存在；
5. `proposal.remindAt > now`；
6. 用 `applyReminderTime` 计算预期 alarms（保留未选中闹钟及重复规则）；
7. 调用 `executeAuthorizedAlarmUpdate`：入口再次校验授权 entry/alarm 一致，并强制 `targetAlarmId = authorization.alarmId`；
8. 写入后回读仓储：`JSON.stringify(stored.alarms) === expected.alarms`，否则标记 invalid 并报错；
9. 全部通过才 `done`，并向 UI 返回成功文案（含「其它闹钟与重复规则未改动」）。

## 六、UI 交互说明

- 位置：助手回复气泡内，位于执行记录与回复文本之后；只有存在 `toolSelections` 且消息不在流式输出中时展示。
- 结构：标题「选择要修改的闹钟」+ 状态（等待选择 / 已修改 / 已取消 / 修改失败，可重试 / 已失效）+ 提醒标题 + 说明（目标时间、只改选中项）+ 候选按钮（重复规则、`MM-DD HH:mm`、提醒方式）+「取消」。
- 选择后：按钮显示「修改中…」，成功后卡片切换为绿色成功态并显示真实写入结果；失败可「重新选择」或「取消」。
- 取消：提示「已取消，闹钟没有任何改动」，卡片进入已取消态。
- 复用现有卡片圆角、边框、字段背景与语义色 token；未新增弹窗或页面，与删除确认卡片语义区分（这是目标选择，不是二次确认）。
- 已执行/已取消的 proposal id 写入消息的 `toolSelectionsDone/Cancelled` 并随会话持久化，刷新后不会重新显示为待选择。

### 页面核验（真实页面 `http://127.0.0.1:1424`）

在真实页面上用 Mock SSE 驱动出候选卡片，逐项核验：

| 项目 | 结果 |
| --- | --- |
| 卡片结构、候选顺序、每天/每周与时间/方式文案 | 正常 |
| 点击「每天」候选 | 成功；仅 daily 闹钟时间变化，weekly 与重复规则保持不变 |
| 再次点击同一选择 | 提示已执行/不可重复，不再写入 |
| 「取消」 | 状态变「已取消」，仓储 alarms 无变化 |
| 浅色主题对比度 | 警示文字 5.93:1；次要文字 4.76:1；标题 15.97:1（均 ≥4.5:1） |
| 暗色主题对比度 | 警示文字 7.93:1；次要文字 6.71:1；标题 11.95:1；成功文字 8.47:1（均 ≥4.5:1） |
| 系统主题 | system 解析为 light，随系统生效 |

**限制（必须说明）**：in-app Browser 当前无可见视口（`NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`），无法截图，也无法可靠执行指针点击。上述点击与取消是通过页内 DOM 点击触发真实 React 事件处理器完成的；布局与配色通过 DOM 结构 + 运行时 `getComputedStyle` 对比度计算核验，**未做截图级视觉验收**。建议人工验收时补一次截图确认。

## 七、自动化测试结果

### 单元测试 `pnpm test:agent`

**118 通过 / 0 失败（19 suite）**，新增 `tests/alarmSelection.test.ts`（13 项）：

| 需求 | 用例 |
| --- | --- |
| 1 单闹钟直接执行 | 单闹钟修改直接执行，不需要选择 |
| 2 多闹钟未选择不执行 | 多闹钟未选择：不写库，返回结构化候选并标记等待补充 |
| 3 模型真实 alarmId 无授权仍拒绝 | 模型提供真实 alarm_id 但无用户授权：仍然拒绝，不写入 |
| 4 选 daily 只改 daily | 用户选择 daily：只改 daily，weekly 与重复规则完整保留 |
| 5 选 weekly 只改 weekly | 用户选择 weekly：只改 weekly，daily 保留 |
| 6 取消不修改 | 取消选择：不修改任何数据，之后也不能再执行 |
| 7 停止后授权失效 | 停止请求后授权失效 |
| 8 新任务后旧授权失效 | 开始新任务后旧授权不能复用 |
| 9 删除提醒后旧授权失效 | 目标提醒删除后授权失效 |
| 10 闹钟被改后旧授权失效 | 闹钟被其它操作修改后授权失效 |
| 11 授权不可重复执行 | 同一授权不能重复执行 |
| 12 重复规则完整保留 | 用例 4/5/集成场景共同验证 |
| 13 真实模型连续歧义 | 见第八节场景 4 |

所有断言均读取真实仓储中的 `alarms`（id / remindAt / mode / method），不是只检查提示词或 UI 文案。

### Mock SSE 集成测试 `pnpm test:integration`

**11 通过 / 0 失败**（原 10 项 + 新增「用户选择候选闹钟后只修改选中闹钟，授权不可重复使用」）。场景 4 现在同时断言：`phase=needs_input`、步骤 `needsInput`、生成候选卡片（a1/daily、a2/weekly）、仓储 alarms 不变。

## 八、真实模型验收结果

- 配置：本机已保存的「推理-Doubao-Seed-Evolving」；模型 `VOLCENGINE_ENDPOINT_ID`；端点 `ark.cn-beijing.volces.com`。
- **API Key 只在进程内存中使用，未打印、未写入文件或版本库**。
- 脚本：`pnpm test:real`（真实网络、真实 store/工具/仓储）。

### 完整一轮结果：9/9 通过

| # | 场景 | 结果 |
| --- | --- | --- |
| 1 | 搜索便签并总结 | PASS（1 步 search_notes，无写入） |
| 2 | 搜索后修改指定记录 | PASS（标题真实改为「项目周报（终稿）」） |
| 3 | 创建三个待办 | PASS（3 条待办，无确认卡片） |
| 4 | 连续 3 次歧义提醒任务 | PASS（见下） |
| 5 | 真实模型触发卡片后点击写入 | PASS（见下） |
| 6 | 删除记录 | PASS（确认卡片 1 张，确认前条目保留） |
| 7 | 普通聊天 | PASS（0 工具步骤，无写入） |
| 8 | 工具失败如实反馈 | PASS（阶段 failed，回复含失败说明） |
| 9 | 工具轮次上限 | PASS（8 步后停止并提示未完成项） |

**场景 4 实测证据**：同一会话连续 3 次要求修改含 daily + weekly 两个闹钟的「喝水提醒」：

- 3 次均未写入，仓储始终为 `[r4-m1, daily, 原时间]`、`[r4-m2, weekly, 原时间]`；
- 前两次模型调用 `update_entry`，均被执行层拦截为 `needs_input` 并各生成 1 张候选卡片（共 2 次拦截、2 张卡片）；
- 第 3 次模型在上下文已知需要选择后改为直接询问，未调用工具（同样未写入）。

**场景 5 实测证据**：新会话中模型调用 `update_entry`（未指定或指定了模型自选 alarm_id），执行层生成候选卡片；脚本模拟用户点击 daily 后：

- daily 闹钟时间更新，weekly 时间、两个闹钟的重复规则均保持不变；
- 同一 proposal 再次点击返回 `done`，仓储不再变化。

**模型行为说明**：真实模型在「是否先调用工具」上并不稳定。个别轮次它会直接追问而不产生卡片（这是安全的合规行为，但无法用来验证点击路径）。场景 5 因此最多重试 3 次，并在首次未产生卡片时追加一句带目标指向的追问，以稳定触发执行层拦截；完整一轮运行中一次即触发。该重试是验收脚本行为，不影响产品逻辑。

## 九、TypeScript / Lint / Vite / Tauri 构建结果

| 命令 | 结果 |
| --- | --- |
| `npx tsc -p tsconfig.app.json --noEmit` | 通过，无输出 |
| `pnpm lint` | 0 warning / 0 error（122 文件） |
| `pnpm build` | 通过（47.95s；仅既有 chunk 体积提示） |
| `pnpm tauri:build` | 通过；`src-tauri/target/release/bianqian.exe`；安装包 `MEMORA_0.2.0_x64-setup.exe`（5.10 MiB） |

## 十、遗留问题与未验证项

1. **截图级 UI 验收未完成**：in-app Browser 无视口，无法截图；已用 DOM 结构、真实事件处理器与计算对比度替代。需要人工补看浅色/暗色/系统三种主题下卡片的实际观感。
2. **真实模型行为不稳定**：模型可能直接追问而不调用工具，导致「点击写入」路径并非每次都能在真实模型下触发；本阶段通过脚本重试与 Mock 集成测试双保险覆盖，点击写入逻辑本身是确定性的。
3. **候选选择只支持提醒时间修改**：与 Phase 3.2 目标一致；若未来出现「只改重复规则」等多目标歧义，需要单独设计。
4. **内存注册表**：应用重启后未执行的候选卡片失效（页面刷新仍可通过消息持久化状态显示为待选择，但点击会提示失效并重新发起）。这是有意的安全退化，不新增数据库表。
5. 未完成项：无其他代码层遗留；等待人工验收，**不自动进入 Phase 4**。
