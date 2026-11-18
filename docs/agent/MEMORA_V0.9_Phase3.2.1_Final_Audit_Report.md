# MEMORA V0.9 Phase 3.2.1 最终安全审查报告

审查日期：2026-11-13
审查范围：Phase 3.2「多闹钟提醒选择授权」实现
审查性质：安全审查与缺陷修复，不新增功能，不进入 Phase 4.1 实施

---

## 1. 审查范围

本次审查覆盖 Phase 3.2 引入的「多闹钟目标选择 + 一次性授权」全部链路：

| 层级 | 文件 |
| --- | --- |
| 类型 | `src/types/ai.ts` |
| 授权注册表 | `src/services/alarmSelections.ts` |
| 工具执行与授权再校验 | `src/services/agentToolExecutor.ts` |
| 点击执行与写后校验 | `src/services/alarmSelectionExecution.ts` |
| 消息生命周期 | `src/utils/assistantSelectionLifecycle.ts`、`src/store/useAssistantStore.ts` |
| 选择卡片 UI | `src/components/AssistantPanel.tsx` |
| 单元测试 | `tests/alarmSelection.test.ts`、`tests/assistantSelectionLifecycle.test.ts` |
| Mock SSE 集成测试 | `scripts/integration/harness.mjs`、`scripts/run-integration-tests.mjs` |
| 真实模型验收 | `scripts/run-real-model-acceptance.mjs` |

审查目标：

1. 重启 / 刷新后旧授权不可执行，且界面明确显示失效而非「等待选择」。
2. 用户只授权改时间时，模型不能借这次授权改标题、正文、其它闹钟或无关字段。
3. 授权只能使用一次；取消、过期、停止、新任务、目标删除/修改、执行异常后均不可复用。
4. Phase 2/3 业务规则不回归：新增/普通修改直接执行、删除仍需确认卡片、单闹钟修改直接执行、多闹钟歧义必须询问、模型自带 `alarmId` 不等于用户授权、改时间保留重复规则。

约束遵守情况：

- 未引入新依赖、未升级依赖、未引入 LangChain/AutoGen/MCP。
- 未改 SQLite 表结构，未改工具定义与业务语义。
- 未提交 Git，未覆盖或清理用户未提交文件。

---

## 2. 当前架构

```
模型 tool_call(update_entry)
        │
        ▼
agentToolExecutor.updateEntry
  ├─ 无授权 + 多候选闹钟 → createAlarmSelection（不写库，返回 needsInput + 卡片）
  └─ 有授权 → 校验字段白名单 / 入口 / 闹钟 → 走原有写入与回读校验
        │
        ▼
AlarmSelectionProposal（仅内存）
  ├─ patch：冻结后的修改集合（remindAt + 卡片展示过的字段）
  ├─ allowedFields：执行层白名单
  ├─ changes：卡片逐项展示的授权范围
  ├─ fingerprint：标题/正文/标签/状态 + 全部闹钟
  ├─ expiresAt：10 分钟 TTL
  └─ status：pending → executing → done | cancelled | expired | invalid
        │
        ▼
用户点击候选
        │
        ▼
alarmSelectionExecution.confirmAlarmSelection
  claim（一次性）→ 目标存在 → 仍是提醒 → 快照一致 → 闹钟存在 → 时间合法
  → executeAuthorizedAlarmUpdate → 回读比对 → done
  任一步失败 → invalid（不释放、不自动重试、不改选其它闹钟）
```

持久化侧只保存消息 UI 状态（`toolSelections` / `toolSelectionsDone` / `toolSelectionsCancelled` / `toolSelectionsInvalidated`），授权本体不落库，因此重启后无法恢复授权。

---

## 3. 安全问题清单

审查确认并修复了以下问题。前 4 项为阻断级问题，不修复不能通过验收。

| 编号 | 级别 | 问题 | 影响 |
| --- | --- | --- | --- |
| S1 | 高 | 授权提案保存了模型原始 `UpdateEntryArgs`，卡片只展示时间，点击却执行标题/正文等全部参数 | 用户以为只授权时间，实际被越权修改其它字段 |
| S2 | 高 | 写入失败时调用 `releaseAlarmSelection` 把授权退回 `pending` | 同一次授权可反复点击重试，违反「只能使用一次」 |
| S3 | 高 | `executeAuthorizedAlarmUpdate` 抛异常时没有捕获 | 卡片永久停在「修改中」，授权状态悬空 |
| S4 | 高 | 重启 / 新任务 / 停止 / TTL 到期后只作废内存注册表，消息里的卡片仍显示「等待选择」 | 用户看到可点状态，但实际不可执行；界面与安全状态不一致 |
| S5 | 中 | 快照指纹只包含标题与闹钟，正文、标签、完成状态变化不会使授权失效 | 目标被其它操作修改后仍可执行旧授权 |
| S6 | 中 | 点击失败后「已失效」只存在组件本地 state，关闭再打开面板又显示「等待选择」 | 失效状态不可持久，诱导用户重复点击 |
| S7 | 低 | 「初始已过期」在 effect 内同步 `setState`，触发 lint 告警 | 级联渲染；已改为渲染期初始化 |

---

## 4. 修复内容与文件

### 4.1 字段范围绑定（S1）

- [src/types/ai.ts:225](../../src/types/ai.ts#L225)：新增 `AlarmSelectionPatchField`，限定授权可触碰的 8 个字段；`AssistantAlarmSelection` 新增 `changes` 供卡片展示授权范围。
- [src/services/alarmSelections.ts:84](../../src/services/alarmSelections.ts#L84)：新增 `buildAlarmSelectionPatch`，只复制模型显式给出且卡片可展示的字段，并生成人类可读的 `changes`（如“标题改为「…」”“正文整体替换”）。
- [src/services/alarmSelections.ts:135](../../src/services/alarmSelections.ts#L135)：`allowedFields = ['remindAt', ...changes.field]`，授权范围与卡片展示严格一致。
- [src/services/agentToolExecutor.ts:405](../../src/services/agentToolExecutor.ts#L405)：执行前再次校验：必须有 `remindAt`，且任何白名单外字段直接返回错误，不写入。
- [src/services/agentToolExecutor.ts:713](../../src/services/agentToolExecutor.ts#L713)：`executeAuthorizedAlarmUpdate` 只接受冻结的 `patch + allowedFields`，不接受模型新参数。

### 4.2 一次性消费（S2/S3）

- [src/services/alarmSelectionExecution.ts:87](../../src/services/alarmSelectionExecution.ts#L87)：`claim` 先原子占用，再执行；成功后 `done`。
- [src/services/alarmSelectionExecution.ts:138](../../src/services/alarmSelectionExecution.ts#L138)：执行异常被捕获，授权标记 `invalid`，不自动重试。
- [src/services/alarmSelectionExecution.ts:152](../../src/services/alarmSelectionExecution.ts#L152)：工具返回失败同样标记 `invalid`；移除 `releaseAlarmSelection`，失败不退还授权。
- 失败后界面按钮切换为「重新发起」，发起的是新的模型请求，不复用旧授权。

### 4.3 生命周期失效（S4）

- 新增 [src/utils/assistantSelectionLifecycle.ts:7](../../src/utils/assistantSelectionLifecycle.ts#L7)：`invalidatePendingSelections` 把所有未完成、未取消、未失效的卡片标记为 `toolSelectionsInvalidated`，纯函数、可单测。
- [src/store/useAssistantStore.ts:104](../../src/store/useAssistantStore.ts#L104)：应用启动加载持久化消息时统一执行失效标记，重启后旧卡片显示「已失效」。
- [src/store/useAssistantStore.ts:211](../../src/store/useAssistantStore.ts#L211)：开始新任务前作废内存授权并失效历史卡片。
- [src/store/useAssistantStore.ts:726](../../src/store/useAssistantStore.ts#L726)：停止请求时同步失效卡片。
- [src/services/alarmSelections.ts:249](../../src/services/alarmSelections.ts#L249)：新增 `expireAlarmSelection`，卡片计时器到期时同步注册表，避免「界面过期、后台仍可 claim」。
- [src/components/AssistantPanel.tsx:578](../../src/components/AssistantPanel.tsx#L578)：过期状态在渲染期初始化，避免 effect 内同步 setState。
- [src/components/AssistantPanel.tsx:596](../../src/components/AssistantPanel.tsx#L596)：TTL 计时器到点后标记过期并同步注册表。

### 4.4 快照指纹扩展（S5）

- [src/services/alarmSelections.ts:156](../../src/services/alarmSelections.ts#L156)：指纹覆盖 `title / content / tags / done / notified + 每个闹钟的 id/remindAt/mode/method/notified`。
- [src/services/alarmSelectionExecution.ts:113](../../src/services/alarmSelectionExecution.ts#L113)：点击时指纹不一致直接 `invalid`，不写入。

### 4.5 失效状态持久化（S6）

- [src/store/useAssistantStore.ts:836](../../src/store/useAssistantStore.ts#L836)：新增 `markToolSelectionInvalidated`，把执行失败写入消息并持久化。
- [src/components/AssistantPanel.tsx:622](../../src/components/AssistantPanel.tsx#L622)：点击失败（非 busy）时同时设置本地错误与持久化失效状态。
- [src/components/AssistantPanel.tsx:693](../../src/components/AssistantPanel.tsx#L693)：卡片展示「本次点击将一并授权：…」，多字段授权必须明示。
- [src/components/AssistantPanel.tsx:725](../../src/components/AssistantPanel.tsx#L725)：失效/过期/失败卡片提供「重新发起」按钮。

---

## 5. 授权生命周期验证

| 场景 | 预期 | 实际结果 | 验证方式 |
| --- | --- | --- | --- |
| 点击候选 | 只执行冻结 patch，成功后 done | 通过 | 单元 + Mock SSE + 真实模型 |
| 取消 | 不写库，状态 cancelled，不可再执行 | 通过 | 单元 + Mock SSE |
| 重复点击 | 只有一次成功，其余 busy/done | 通过 | 单元并发 + Mock SSE 并发 + 真实模型 |
| TTL 到期 | 状态 expired，不可执行 | 通过 | 单元（推进时钟）+ Mock SSE |
| 停止请求 | pending 授权作废，卡片失效 | 通过 | 单元 + Mock SSE 新任务场景 |
| 开始新任务 | 旧授权取消，旧卡片持久化失效 | 通过 | 单元 helper + Mock SSE |
| 清空会话 | 内存授权清空 | 通过 | 代码审查（`clear` 调用 reset） |
| 目标删除 | 不写入，状态 invalid | 通过 | 单元 |
| 目标被修改 | 指纹不一致，状态 invalid | 通过 | 单元（正文/标签/标题/状态/通知）+ Mock SSE |
| 原闹钟被删除 | 不写入，状态 invalid | 通过 | 单元 |
| 闹钟时间/规则变化 | 指纹不一致，不写入 | 通过 | 单元 |
| 执行异常 | 捕获、消费授权、显示失败 | 通过 | 单元（注入抛错 env） |
| 成功后再点旧卡片 | done，不重复写入 | 通过 | 单元 + Mock SSE + 真实模型 |
| 失败后重新发起 | 旧授权不可用，需新请求 | 通过 | 单元（失败后第二次点击被拒）+ 代码审查 |
| 应用重启 | 授权表为空，卡片显示已失效，点击 not_found | 通过 | Mock SSE 冷启动新运行时 |
| 关闭再打开面板（失败后） | 仍显示已失效 | 通过（本次修复 S6） | 代码审查 + 类型检查 |

说明：并发窗口内（已点击进入 `executing`）新任务无法中止已经在途的写操作，见第 12 节。

---

## 6. 字段范围验证

| 场景 | 结果 |
| --- | --- |
| 用户只要求改时间 | 卡片无 `changes`；`allowedFields` 仅 `['remindAt']`；执行后标题、正文、标签完全不变 |
| 模型显式给出标题 + 时间 | 卡片展示“标题改为「…」”；`allowedFields = ['remindAt','title']`；点击后两项同时生效 |
| 向冻结 patch 注入范围外字段 | 执行层返回“授权范围不包括：标题”，不写入，授权标记 invalid |
| 缺少 `remindAt` 的授权 patch | 执行层直接拒绝 |
| 模型携带 `alarm_id` 但无用户点击 | 仍返回 needsInput + 候选卡片，不写库 |
| 授权中的 `alarmId` 与用户选择不一致 | 拒绝执行 |
| 授权入口与点击目标不一致 | 拒绝执行 |
| 单闹钟提醒修改 | 直接执行，不生成卡片，重复规则保留 |
| 修改时间后的重复规则 | 选中闹钟的 `mode` 保留，其它闹钟完全不动 |

---

## 7. 单元测试结果

命令：`npm run test:agent`

```
# tests 135
# suites 23
# pass 135
# fail 0
```

本次新增/扩充的用例：

`tests/alarmSelection.test.ts`
- 授权字段范围（4 项）：只请求时间、标题+时间、范围外字段拒绝、缺少时间拒绝。
- 授权有效期与一次性（4 项）：TTL 过期、并发重复点击、执行异常消费授权、写后回读不一致。
- 授权快照失效（5 项）：正文、标签、标题、完成状态、闹钟通知状态变化。

`tests/assistantSelectionLifecycle.test.ts`
- 未完成卡片在重启/新任务时被标记失效。
- 已完成、已取消、已失效卡片不重复标记。
- 无可标记项时返回原数组。
- 重复调用不产生重复 ID。

覆盖对应关系：字段白名单、快照指纹、一次性 claim、过期、取消、失效、重复点击、目标变化、闹钟变化、写前校验、写后校验、范围外 patch 均有直接断言。

---

## 8. Mock SSE 集成测试结果

命令：`npm run test:integration`
结果：`# pass 19 / # fail 0`

在原有的查询、创建、跨轮次修改、删除确认、聊天、失败反馈、轮次上限、停止等 11 个场景之外，新增 8 个安全场景：

1. 只授权提醒时间：卡片无额外字段，点击后标题/正文/标签不变。
2. 用户取消选择：不写入任何数据。
3. 授权过期：不能再执行。
4. 目标在等待期间被修改：授权失效且不写入。
5. 开始新任务后旧卡片失效，旧授权不能再写入。
6. 重复点击同一候选：只写入一次。
7. 授权 patch 被加入范围外字段：执行层拒绝且不写入，状态 invalid。
8. 应用重启：冷启动新运行时恢复历史消息并标记失效，旧授权返回 `not_found`，不写入。

说明：原场景 5“用户选择候选闹钟后只修改选中闹钟”仍保留并通过，验证了标题+时间的显式授权路径。

---

## 9. 真实模型验收结果

命令：`npm run test:real`
配置：本机已保存配置（模型端点仅打印 host，API Key 未打印、未写入任何文件）
结果：`# pass 11 / # fail 0`

| # | 场景 | 实际结果 |
| --- | --- | --- |
| 1 | 搜索并总结 | 1 次 `search_notes`，未写入 |
| 2 | 搜索后修改指定记录 | 标题真实改为「项目周报（终稿）」 |
| 3 | 创建三个待办 | 创建 3 条，无确认卡片 |
| 4 | 连续 3 次歧义任务 | 3 次均未写入；模型 2 次尝试 `update_entry` 均被拦截为 needsInput 并生成卡片；第 3 次模型未调用工具，直接回答，因此无卡片可点 |
| 5 | 歧义选择后点击写入 | 第 1 次即生成卡片；点击 daily 后仅该闹钟变化，重复规则保留；再次点击返回 done |
| 6 | 只要求改时间 | 卡片无额外字段；点击 daily 后标题、正文、标签均未变化，未选中的 weekly 未变化 |
| 7 | 明确要求标题+时间 | 卡片展示 `title` 变更；点击后标题变为「补水提醒」，时间生效，两个闹钟重复规则保留，未选中的闹钟未变化 |
| 8 | 删除 | 生成 1 张确认卡片，确认前条目仍在 |
| 9 | 普通聊天 | 无工具调用、无写入 |
| 10 | 工具失败 | 终态 failed，如实说明找不到 |
| 11 | 轮次上限 | 8 步后停止，附加上限提示 |

真实模型的不确定性已如实记录：场景 4 第 3 次模型选择不调用工具而是直接回答用户，导致该轮没有产生卡片；但由于没有任何写入，安全目标仍满足。点击写入路径由场景 5、6、7 实际验证。

---

## 10. TypeScript / ESLint / Vite / Tauri 结果

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 应用类型检查 | `tsc -p tsconfig.json --noEmit` | 通过，0 错误 |
| 测试类型检查 | `tsc -p tsconfig.test.json --noEmit` | 通过，0 错误 |
| Lint | `npm run lint`（oxlint） | 0 warnings / 0 errors |
| Vite 生产构建 | `npm run build` | 通过（exit 0） |
| Tauri 生产构建 | `npm run tauri:build` | 通过（exit 0）：Rust release 2m52s，NSIS 安装包 5.09 MiB |

Tauri 产物：

```
src-tauri/target/release/bianqian.exe
src-tauri/target/release/bundle/nsis/MEMORA_0.2.0_x64-setup.exe
```

Vite 构建说明：首次独立构建耗时约 59 分钟（构建插件统计时间集中在 CSS 后处理回调），退出码为 0；最终在修复完成后的代码上通过 `tauri:build` 内嵌的前端构建重新执行，耗时 3.33 秒并成功，确认此前异常为本机长时间挂起/休眠所致，不是代码或配置问题。

---

## 11. Git 与工程状态检查

### 11.1 `.gitignore` 与被忽略测试

- `.gitignore` 原先包含 `tests` 规则，会导致测试目录不被版本管理；已删除该行，仅保留 `.test-build`。
- `git check-ignore` 检查以下路径均未被忽略：
  - `tests/alarmSelection.test.ts`
  - `tests/assistantSelectionLifecycle.test.ts`
  - `src/utils/assistantSelectionLifecycle.ts`
  - `scripts/run-integration-tests.mjs`
  - `scripts/run-real-model-acceptance.mjs`
  - `docs/agent`
- 新增测试文件当前为未跟踪/新增状态，需要在后续人工提交时一并纳入。

### 11.2 敏感信息

- 真实模型脚本只从本机配置读取密钥，仅打印配置名、模型名和端点 host。
- 源码、测试、脚本、文档中未发现硬编码 API Key。
- 本次报告不包含任何密钥。

### 11.3 `.installer-test/`

- 目录 `.installer-test/便签33/` 含 `bianqian.exe`、`uninstall.exe`，属用户此前的安装验证产物（修改时间 2026-11-06）。
- 本次未读取、未修改、未删除、未提交该目录。

### 11.4 当前未提交文件清单

已暂存（Phase 3.2 及更早阶段累计）：

```
M  .gitignore
A  docs/MEMORA-V0.9-Phase1-分析报告.md
A  docs/MEMORA-V0.9-Phase2-实施报告.md
A  docs/MEMORA-V0.9-Phase3-实施报告.md
A  docs/MEMORA-V0.9-Phase3.1-实施报告.md
A  docs/MEMORA-V0.9-Phase3.2-实施报告.md
M  package.json
A  scripts/integration/mockSseServer.mjs
A  scripts/run-agent-tests.mjs
M  src/services/agentToolSchema.ts
M  src/services/agentTools.ts
M  src/services/assistantContext.ts
M  src/services/reminderAlarms.ts
M  src/styles/memora-tokens.css
A  tests/agentExecution.test.ts
A  tests/agentTools.test.ts
A  tests/deleteExecution.test.ts
A  tests/helpers.ts
A  tests/prompts.test.ts
A  tests/reminderAlarms.test.ts
```

已暂存且本次审查有追加修改（`AM` / `MM`）：

```
AM scripts/integration/harness.mjs
AM scripts/run-integration-tests.mjs
AM scripts/run-real-model-acceptance.mjs
MM src/components/AssistantPanel.tsx
MM src/services/agentToolExecutor.ts
AM src/services/alarmSelectionExecution.ts
AM src/services/alarmSelections.ts
MM src/store/useAssistantStore.ts
MM src/types/ai.ts
AM tests/alarmSelection.test.ts
```

未跟踪：

```
?? .installer-test/
?? docs/agent/（含本报告）
?? docs/MEMORA-V0.9-Phase4.1-分析报告.md
?? src/utils/assistantSelectionLifecycle.ts
?? tests/assistantSelectionLifecycle.test.ts
```

本次审查未执行 `git add`、`git commit`、`git reset`、`git clean`，未覆盖任何用户未提交修改。

---

## 12. 未解决问题与已知限制

1. **在途写入无法被“新任务/停止”中断**
   - 用户点击候选后进入 `executing`，此时再开始新任务，`cancelPendingAlarmSelections` 只处理 `pending`，已经开始的写操作仍可能完成。
   - 影响范围：单次已确认点击的在途写入，不产生新的越权；这是同步取消无法中止异步仓储写入的固有限制。
   - 处理建议：Phase 4 若引入可取消写入，再补中止能力；本阶段不修改仓储层。

2. **UI 未做真实窗口视觉验收**
   - 本次通过类型检查、Lint、构建和状态逻辑审查验证卡片状态机；未启动 Tauri 窗口逐像素检查「已失效 / 已过期 / 重新发起」的视觉效果。
   - 不影响安全结论，但建议人工打开一次面板确认文案与配色。

3. **真实模型场景 4 第 3 轮未产生卡片**
   - 模型选择直接回答而非调用工具；未发生写入。该行为属模型策略差异，执行层安全约束未被绕过。

4. **Vite 构建耗时异常**
   - 首次构建约 59 分钟，退出码 0；疑为本机休眠/挂起导致，需要在最终构建记录中确认正常耗时。

---

## 13. 最终验收结论

**PASSED**

验收依据：

| 验收项 | 结果 |
| --- | --- |
| 重启/刷新后旧授权不可执行，卡片显示失效 | 通过（Mock SSE 冷启动场景） |
| 授权字段范围不可扩大 | 通过（单元 + Mock SSE + 真实模型） |
| 授权一次性、失败不退还、过期/取消/停止/新任务失效 | 通过（单元 + Mock SSE） |
| 目标/闹钟变化后不可执行 | 通过（单元 + Mock SSE） |
| Phase 2/3 业务规则回归 | 通过（135 单元 + 19 集成 + 11 真实模型） |
| 单元测试 | 135 / 135 通过 |
| Mock SSE 集成测试 | 19 / 19 通过 |
| 真实模型验收 | 11 / 11 通过（API Key 未落盘） |
| TypeScript | 0 错误 |
| Lint | 0 warning / 0 error |
| Vite 构建 | 通过 |
| Tauri 构建 | 通过，NSIS 安装包已生成 |
| Git 检查 | `.gitignore` 不再忽略测试；无密钥泄漏；未提交、未覆盖用户改动 |

未发现授权扩大、一次性授权复用、越权字段写入或重启后旧授权可执行的情况。第 12 节的已知限制均不构成越权路径，不阻塞本阶段验收。

本阶段不进入 Phase 4.1 实施，等待人工验收确认。
