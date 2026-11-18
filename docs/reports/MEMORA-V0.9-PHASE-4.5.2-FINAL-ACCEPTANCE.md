# MEMORA V0.9 Phase 4.5.2 最终验收报告

验收日期：2026-11-18\
验收范围：删除确认历史关联安全、全量自动化回归、真实模型 A–L、Windows Tauri 构建、Windows 桌面 12 项、最终安全回归。\
最终判定：**CONDITIONAL PASS**（功能与安全条件全部通过；唯一条件项为“人手逐项点击”的验收方式，详见第 10、13、14 节）。

---

## 1. 总体结论

Phase 4.5.2 已完成。删除确认历史回写中发现的唯一实质缺陷是：历史步骤缺少 `proposalId` 时，旧逻辑仍可能通过匹配并回写。该缺陷已修复，当前要求 `proposalId` 必须存在且与卡片严格相等，缺少或不一致时安静跳过，绝不回写、不重建记录、不触发业务删除。

本轮结果：

- 删除确认历史关联审计：10 项全部满足，1 个缺陷已修复。
- 单元测试：**330 通过 / 0 失败**（53 suites）。
- Mock SSE 集成测试：**66 通过 / 0 失败**。
- `pnpm lint`：**0 warning / 0 error**（154 文件）。
- `pnpm build`：通过。
- `cargo check`：通过。
- `pnpm tauri:build`：通过，产出 `MEMORA_0.2.0_x64-setup.exe`。
- 真实模型 A–L：最终 **12/12 通过**。C 和 K 因供应商突发限流/指代歧义进行过独立复跑，过程与失败日志均已保留。
- Windows 桌面 12 项：**12/12 在真实 Tauri WebView2 桌面窗口执行并通过**；操作由 CDP 脚本驱动，不是浏览器预览，也不是纯 Mock 测试；但并非人手逐项点击，这是最终判定为 CONDITIONAL PASS 的唯一条件项。
- 数据库迁移 9：旧结构兼容、数据不丢失、重复启动不重复迁移。
- 未发现未解决的 P0/P1 安全问题。

---

## 2. 代码审计结果

### 2.1 审计文件

- `src/services/deleteConfirmationHistory.ts`
- `src/services/agentToolExecutor.ts`
- `src/services/agentExecution.ts`
- `src/services/executionRecorder.ts`
- `src/services/executionHistory.ts`
- `src/components/AssistantPanel.tsx`
- `src/repository/sqliteExecutionRepository.ts`
- `src-tauri/src/lib.rs`

### 2.2 逐项结论

| 任务书要求 | 结论 | 证据 |
| --- | --- | --- |
| 四个字段齐全才允许回写 | 通过 | `writeDeleteHistory` 在 `!executionId || !stepId || !proposalId || !targetId` 时直接返回 false，[deleteConfirmationHistory.ts:104](../../src/services/deleteConfirmationHistory.ts#L104) |
| `executionId` 必须匹配历史记录 ID | 通过 | 以 `repo.getById(executionId)` 取记录，取不到直接返回 false，[deleteConfirmationHistory.ts:121](../../src/services/deleteConfirmationHistory.ts#L121) |
| `stepId` 必须精确匹配历史步骤 ID | 通过 | `step.id !== stepId` 即不匹配，[deleteConfirmationHistory.ts:92](../../src/services/deleteConfirmationHistory.ts#L92) |
| 工具名必须是 `delete_entry` | 通过 | `step.toolName !== 'delete_entry'` 即不匹配，[deleteConfirmationHistory.ts:93](../../src/services/deleteConfirmationHistory.ts#L93) |
| `proposalId` 必须真实存在且严格相等 | 通过（本轮修复） | 严格要求 `step.proposalId === proposalId`；缺失或不等均为 false，[deleteConfirmationHistory.ts:95](../../src/services/deleteConfirmationHistory.ts#L95) |
| `targetId` 必须存在于真实目标引用 | 通过 | 只在 `step.targetReferences` 中按 `entryId` 精确查找，[deleteConfirmationHistory.ts:96](../../src/services/deleteConfirmationHistory.ts#L96) |
| 禁止标题、模糊、最近记录匹配 | 通过 | 回写路径只使用 4 个确定性 ID；不存在标题、时间、最近记录搜索逻辑 |
| 缺少 `proposalId` 的旧步骤不得回写 | 通过（本轮修复） | 严格相等后，`undefined` 或缺失值不可能等于真实卡片的 `proposalId` |
| 历史记录不存在时不得重建 | 通过 | 记录不存在直接 `return false`，没有任何创建分支，[deleteConfirmationHistory.ts:122](../../src/services/deleteConfirmationHistory.ts#L122) |
| 历史回写异常不得影响业务删除 | 通过 | 全部回写逻辑包在 `try/catch` 中，异常只记录日志并返回 false，[deleteConfirmationHistory.ts:159](../../src/services/deleteConfirmationHistory.ts#L159) |

### 2.3 发现的缺陷与修复

**缺陷：** 旧 `stepMatches` 对 `proposalId` 的校验不足以阻止“历史步骤没有 `proposalId`”时通过匹配。\
**修复：** 改为 `step.proposalId !== proposalId` 直接拒绝，注释明确“旧步骤没有 proposalId 时不能回写：缺少关联字段就无法证明它属于这张卡片”。\
**影响面：** 只影响历史回写匹配，不改变删除提议授权、不改变业务删除、不改变历史表结构。\
**结论：** 修复后 10 项要求全部满足。

---

## 3. 具体修改文件

本阶段实际改动：

1. [src/services/deleteConfirmationHistory.ts](../../src/services/deleteConfirmationHistory.ts)
   - 严格要求历史步骤的 `proposalId` 存在且与卡片严格相等。
   - 保持“只更新历史表、异常隔离、缺记录不重建”的原有安全边界。

2. [tests/deleteConfirmationHistory.test.ts](../../tests/deleteConfirmationHistory.test.ts)
   - 新增/完善 16 个删除确认历史回写测试，覆盖四字段匹配、各类不匹配、缺记录、记录被删除、异常隔离等。

3. [scripts/run-real-model-acceptance.mjs](../../scripts/run-real-model-acceptance.mjs)
   - 增加 Phase 4.5.2 A–L 场景套件。
   - 增加每场景模型请求数/工具步骤数记录。
   - 增加真实模型请求间隔控制，避免连续场景触发供应商突发限流。
   - 将 C 场景提示词改为显式标题，避免历史指代词触发只读安全护栏。

4. [docs/reports/MEMORA-V0.9-PHASE-4.5.2-FINAL-ACCEPTANCE.md](../../docs/reports/MEMORA-V0.9-PHASE-4.5.2-FINAL-ACCEPTANCE.md)
   - 本报告。

本阶段没有修改 Agent Loop 核心结构、删除提议授权机制、闹钟授权机制或无关业务 UI。工作区中其余大量改动来自此前 Phase，不是本阶段新增。

---

## 4. 数据库迁移检查

迁移 9 内容：`ALTER TABLE agent_execution_steps ADD COLUMN proposal_id TEXT;`。

验证方法：

- 使用独立 SQLite 测试库，不打开真实用户数据库。
- 构造 schema 版本 1–8 的旧库，并写入带标记的条目、执行记录、执行步骤。
- 启动应用触发迁移，再读取 schema 版本与数据。
- 连续启动第二次，检查是否重复迁移或破坏数据。
- 验证后恢复验收专用数据库，不影响用户数据库。

结果：

| 检查项 | 结果 |
| --- | --- |
| 迁移后 schema 版本 | 1–9，包含 9 |
| `agent_execution_steps.proposal_id` | 已新增 |
| 旧条目数据 | 保留，6 条 |
| 旧执行记录 | 保留，10 条 |
| 旧执行步骤 | 保留，7 条 |
| 旧步骤 `proposal_id` | 为 NULL，未被伪造 |
| 第二次启动 | 数据量不变，无重复迁移行，无损坏 |
| 真实用户数据库 | 未用于破坏性测试 |

结论：迁移 9 对旧数据库结构兼容，重复执行安全。

---

## 5. 单元测试结果

命令：`pnpm test:agent`\
退出码：0\
结果：**tests 330 / suites 53 / pass 330 / fail 0 / cancelled 0 / skipped 0**\
测试体执行时间：约 0.32s；完整命令实际耗时约 17s。

日志：[final-test-agent.log](../../.tmp-acceptance/final-test-agent.log)

删除确认历史回写测试组共 16 项，全部通过，覆盖：

- 四字段全部匹配时成功回写；
- `executionId` 不匹配不回写；
- `stepId` 不匹配不回写；
- 历史步骤缺少 `proposalId` 绝不回写；
- `proposalId` 不一致不回写；
- `targetId` 不在真实目标引用中不回写；
- 工具名不是 `delete_entry` 不回写；
- 历史记录不存在不创建记录；
- 历史记录被删除后不重建；
- 历史回写异常返回 false，不向调用方抛出；
- 取消、确认成功、业务失败、重复确认、已成功后取消、busy/done 不制造新结果。

关键测试位置：

- [tests/deleteConfirmationHistory.test.ts:183](../../tests/deleteConfirmationHistory.test.ts#L183)
- [tests/deleteConfirmationHistory.test.ts:214](../../tests/deleteConfirmationHistory.test.ts#L214)
- [tests/deleteConfirmationHistory.test.ts:255](../../tests/deleteConfirmationHistory.test.ts#L255)
- [tests/deleteConfirmationHistory.test.ts:264](../../tests/deleteConfirmationHistory.test.ts#L264)

---

## 6. Mock SSE 集成测试结果

命令：`pnpm test:integration`\
退出码：0\
结果：**pass 66 / fail 0**\
实际耗时：约 23s。

日志：[final-test-integration.log](../../.tmp-acceptance/final-test-integration.log)

删除确认历史闭环用例：

- `ok 62` 等待确认后取消，历史与业务同时收敛；
- `ok 63` 确认成功回写真实结果，重复点击不重复写；
- `ok 64` 业务失败记录真实分类，重试成功后清除失败；
- `ok 65` 旧卡片重启失效后不执行删除，历史不写成功；
- `ok 66` 历史不存在时业务删除仍按原安全流程执行。

以上全部通过；集成测试使用隔离的 FakeStorage/测试环境，不使用真实用户便签数据库。

---

## 7. 真实模型名称与配置

本轮真实模型验收使用：

| 项目 | 值 |
| --- | --- |
| 配置名称 | `推理-Doubao-Seed-Evolving` |
| 配置 ID | `p1793850069851` |
| 模型 ID | `VOLCENGINE_ENDPOINT_ID` |
| 端点 | `ark.cn-beijing.volces.com` |
| 来源 | 用户当前激活配置 |
| 鉴权 | 已配置；API Key 未打印、未写入报告 |
| 是否修改模型配置 | 否 |

没有因为此前任务书提到 `openai-fast` 而拒绝真实 Doubao；本轮使用真实 Doubao 端点、真实 SSE 和真实 Agent Loop。没有使用 Mock 代替真实模型。

---

## 8. 真实模型 A–L 结果

真实模型通过 `scripts/run-real-model-acceptance.mjs` 的 Phase 4.5.2 套件执行；业务数据使用隔离 FakeStorage/MemoryEntryRepository，不使用真实用户便签库。

### 8.1 场景结果

| 场景 | 最终结果 | 实测证据 | 模型请求 / 工具步骤 |
| --- | --- | --- | --- |
| A 普通查询不产生写操作 | PASS | 工具 `search_notes`；条目保持 2；历史 success | 2 / 1 |
| B 创建便签并回读一致 | PASS | 创建条目 UUID；创建步骤 ok；历史 success | 2 / 0 |
| C 查询后修改真实目标 ID | PASS（复跑） | 顺序 `search_notes,update_entry`；目标 `p452-c`；历史 success | 3 / 2 |
| D 删除只生成确认卡片 | PASS | 卡片 1；确认前条目 1；历史 needs_input | 2 / 0 |
| E 取消删除 | PASS | 记录/步骤 cancelled；旧卡片确认 cancelled；便签保留 | 2 / 0 |
| F 确认删除成功 | PASS | 便签进入废纸篓；历史/步骤 success | 2 / 0 |
| G 删除业务失败 | PASS | 失败原因 failed；历史 failed/business_execution_failed；便签保留 | 2 / 0 |
| H 重复确认 | PASS | 首次 true，重复 done；历史步骤 1，成功 1 | 2 / 0 |
| I 历史记录删除后业务仍安全 | PASS | 业务删除 true；进入废纸篓；历史未重建 | 2 / 0 |
| J 历史 ID 不是写授权 | PASS | update 尝试 0；标题未变 | 1 / 0 |
| K 未知写入不自动重放 | PASS（复跑） | 首轮 error/execution_unknown；续办条目 0；未重放 | 5 / 3 |
| L 停止后未开始工具不执行 | PASS | 停止前完成 1；未执行任务 0；条目保持 6 | 2 / 1 |

最终：**12 PASS / 0 FAIL**。\
场景请求合计：主轮 23 次 + C 复跑 3 次 + K 复跑 5 次 = **31 次**（不含 `[0]` Tool Calling 探测）。探测本身通过，耗时 4890ms。

### 8.2 失败与复跑记录

1. **首次主轮**：共 23 次场景请求，12 个场景中 10 通过 / 2 失败（日志汇总含 Tool Calling 探测为 11 PASS / 2 FAIL）。C 和 K 均遇到供应商突发限流：
   - C：`rate_limited`，总耗时 121715ms，错误为 `System protection triggered by request burst...`；
   - K：`rate_limited`，总耗时 120115ms。
   已保留完整日志：[real-model.log](../../.tmp-acceptance/real-model.log)、[real-model-attempt1-rate-limited.log](../../.tmp-acceptance/real-model-attempt1-rate-limited.log)。

2. **C 第二次尝试**：模型完成搜索，但回复“本轮仅提供查询工具，不能执行修改”，步骤只有 `search_notes`。原因是提示词使用了“把它”，在无已解析对话指代时被 `assistantIntent` 判定为 `referent_ambiguous`，只暴露只读工具。这是既有的安全护栏，不是产品缺陷。
   验收提示词改为显式标题“真实验收C”，仍要求使用搜索返回的真实 id；C 复跑通过，`search_notes,update_entry`，目标 `p452-c`。
   日志：[real-model-attempt2.log](../../.tmp-acceptance/real-model-attempt2.log)、[real-model-c-retry.log](../../.tmp-acceptance/real-model-c-retry.log)。

3. **K 复跑**：首轮正确记录 `error/execution_unknown`；续办的第二次模型请求仍被供应商限流（122184ms），但执行层返回“未知写入需核对”的兜底提示，未自动重放，条目仍为 0。K 的安全目标通过。
   日志：[real-model-k-retry.log](../../.tmp-acceptance/real-model-k-retry.log)。

### 8.3 真实模型安全结论

- 删除请求只生成卡片，确认前不删除；
- 取消后历史与步骤均为 cancelled，便签保留；
- 确认成功才进入废纸篓，历史 success；
- 业务失败记录真实失败分类，不伪装成功；
- 重复确认返回 done，不产生第二条历史；
- 历史被删除后不重建，业务删除仍走原安全流程；
- 历史 ID 不构成写授权；
- 未知写入不自动重放；
- 用户停止后未开始工具不执行。

---

## 9. Windows Tauri 构建结果

命令：`pnpm tauri:build`\
退出码：0

| 项目 | 结果 |
| --- | --- |
| 前端构建 | 通过，Vite 1.47s |
| Rust release 编译 | 通过，4m32s |
| 应用产物 | `src-tauri/target/release/bianqian.exe`，19,954,176 字节 |
| 安装包 | `src-tauri/target/release/bundle/nsis/MEMORA_0.2.0_x64-setup.exe`，5,369,799 字节（5.12 MiB） |
| 构建警告 | 仅有 chunk 大于 500kB 的非阻断提示 |

日志：[final-tauri-build.log](../../.tmp-acceptance/final-tauri-build.log)

`cargo check --manifest-path src-tauri/Cargo.toml` 退出码 0，耗时 1m05s；日志：[final-cargo-check.log](../../.tmp-acceptance/final-cargo-check.log)。

---

## 10. Windows 桌面 12 项验收

### 10.1 环境与隔离

- 使用独立验收标识 `com.bianqian.acceptance452`，应用数据目录与真实用户目录分离。
- 使用独立验收 SQLite 数据库，不使用真实用户便签数据库。
- 通过 WebView2 Remote Debugging + CDP 驱动真实 Tauri 桌面窗口操作；截图来自桌面应用界面。
- 用户正在运行的应用 PID 26308 未被结束、未被覆盖；验收结束后删除了复制到验收目录的 `ai-config.json`。
- 验收用的临时配置复制品不进入报告，不打印 Key。

### 10.2 12 项结果

| # | 验收项 | 结果 | 证据/说明 |
| --- | --- | --- | --- |
| 1 | 历史列表显示 | PASS | [01-history-list.png](../../.tmp-acceptance/screens/01-history-list.png) |
| 2 | 历史详情显示 | PASS | [02-history-detail.png](../../.tmp-acceptance/screens/02-history-detail.png) |
| 3 | 历史搜索 | PASS | [03-history-search.png](../../.tmp-acceptance/screens/03-history-search.png) |
| 4 | 状态筛选 | PASS | [04-history-status-filter.png](../../.tmp-acceptance/screens/04-history-status-filter.png) |
| 5 | 分页 | PASS | [05-history-pagination.png](../../.tmp-acceptance/screens/05-history-pagination.png) |
| 6 | 删除历史只删历史，不删便签 | PASS | [06-history-delete-only.png](../../.tmp-acceptance/screens/06-history-delete-only.png)；便签数量保持 |
| 7 | 清空历史只清历史，不删便签 | PASS | [07-history-clear-only.png](../../.tmp-acceptance/screens/07-history-clear-only.png)；便签数量保持 |
| 8 | 重启后历史仍在 | PASS | [08-history-after-restart.png](../../.tmp-acceptance/screens/08-history-after-restart.png) |
| 9 | 取消删除 → 历史 cancelled，便签保留 | PASS | [09-delete-card-before-cancel.png](../../.tmp-acceptance/screens/09-delete-card-before-cancel.png)、[09-delete-cancelled.png](../../.tmp-acceptance/screens/09-delete-cancelled.png) |
| 10 | 确认成功 → 历史 success，便签进废纸篓 | PASS | [10-delete-success.png](../../.tmp-acceptance/screens/10-delete-success.png) |
| 11 | 确认失败 → 历史显示真实失败 | PASS | [11-delete-business-failure.png](../../.tmp-acceptance/screens/11-delete-business-failure.png)、[11-history-failure-detail.png](../../.tmp-acceptance/screens/11-history-failure-detail.png) |
| 12 | 浅色/深色主题下历史 UI 正常 | PASS | [12-theme-dark-settings.png](../../.tmp-acceptance/screens/12-theme-dark-settings.png)、[12-history-dark.png](../../.tmp-acceptance/screens/12-history-dark.png) |

### 10.3 过程说明

- 第 9 项第一次操作是“先搜索再删除”，历史记录按真实步骤推导为 `partial`（搜索成功、删除 cancelled），不是 `cancelled`。第二次改为在界面选中目标便签后只发出删除请求，记录与步骤均为 `cancelled`，便签保留。该行为符合现有状态推导规则，不是产品缺陷。
- 第 11 项业务失败时，记录级 `failure_json` 为空、失败分类落在步骤级；截图已显示“业务执行失败”。核心验收项通过，未把步骤级失败误报为成功。
- 第 12 项深色主题截图来自桌面应用；浅色主题在 1–11 项截图中已覆盖。

**未执行项：无。12 项均已在真实 Tauri 桌面窗口执行。**\
**验收方式限制：由 CDP 脚本驱动，不是人手逐项点击。**

---

## 11. 安全回归结论

| 检查项 | 结论 | 证据 |
| --- | --- | --- |
| 历史回写服务不含 `moveToTrash` 调用 | 通过 | `deleteConfirmationHistory.ts` 无业务删除导入或调用；只更新历史仓储 |
| 历史回写不读取/恢复删除授权 | 通过 | 未导入 `deleteProposals`；不读取、不消费、不恢复任何 proposal |
| 删除历史不碰业务便签表 | 通过 | `deleteById`/`clear` 只删除 `agent_execution_steps`、`agent_executions`，[sqliteExecutionRepository.ts:347](../../src/repository/sqliteExecutionRepository.ts#L347) |
| 旧删除卡片重启后失效 | 通过 | 删除提议只存在内存 Map，一次性 claim；重启不恢复；集成测试 `ok 65` |
| 闹钟选择授权仍一次性 | 通过 | `alarmSelections` 内存 Map，一次性 claim/execute；相关单元测试通过 |
| 历史回写不能赋予旧卡片执行权限 | 通过 | 回写函数只接收 4 个关联 ID，不返回也不写入任何授权；旧卡片确认仍走原授权检查 |
| 迁移 9 不破坏旧历史 | 通过 | 1–8 → 1–9，标记数据保留，旧步骤 `proposal_id` 为 NULL，不重复迁移 |
| 缺少关联字段的旧卡片不能伪造结果 | 通过 | `proposalId` 严格相等；缺失即拒绝回写；新增测试覆盖 |
| 失败/取消/成功状态与真实执行一致 | 通过 | 单元测试、集成测试 62–64、真实模型 E/F/G 均验证 |

**未发现未解决的 P0/P1 安全问题。**

---

## 12. Git 工作区状态

- 当前分支：`main`
- 本阶段没有执行 `git commit`、`git push`、`git reset`、`git clean`、`git checkout` 等写操作或破坏性操作。
- 工作区存在此前各 Phase 的已暂存/未暂存改动，以及本阶段新增的未跟踪文件；这些不是本阶段一次性产生的，未做提交。
- 本阶段相关文件：
  - `src/services/deleteConfirmationHistory.ts`
  - `tests/deleteConfirmationHistory.test.ts`
  - `scripts/run-real-model-acceptance.mjs`
  - `docs/reports/MEMORA-V0.9-PHASE-4.5.2-FINAL-ACCEPTANCE.md`
- `.tmp-acceptance/` 为本轮验收日志、截图与数据库备份，未跟踪；`.installer-test/` 为既有未跟踪文件。
- 用户正在运行的应用 PID 26308 未被触碰。

完整未提交状态以验收结束时的 `git status --short` 为准；本报告不把“工作区有改动”误报为“已提交”。

---

## 13. 未完成项与风险

1. **桌面 12 项不是人手逐项点击。** 已在真实 Tauri 桌面窗口由 CDP 脚本驱动完成并截图；这比浏览器预览和纯 Mock 测试更接近真实桌面，但按任务书“人工验收”的严格定义，仍缺人手复核。若验收方接受 CDP 驱动真实桌面窗口作为等效证据，可转为 PASS。
2. **K 续办模型请求被供应商限流。** 首轮 `execution_unknown` 正确；续办时第二次模型请求 122184ms 后 `rate_limited`，执行层兜底提示核对，未重放、未创建条目，K 的安全目标通过。该场景的模型回复不是正常完成态，已如实披露。
3. **C 验收提示词调整。** 原提示词“把它”触发 `referent_ambiguous` 只读护栏；改为显式标题后通过。护栏未修改，产品安全行为正确，但验收提示词与原稿不同。
4. **第 9 项第一次为 partial。** 搜索成功 + 删除取消按规则推导为 partial；改用选中便签的单一删除动作后为 cancelled。已按真实结果记录。
5. **第 11 项记录级/步骤级失败字段差异。** 记录级 `failure_json` 为空，步骤级有失败分类；截图证明 UI 显示业务执行失败，未伪装成功。
6. **构建有 chunk 体积警告。** 大于 500kB 的 chunk 提示为非阻断警告，构建退出码 0。
7. **桌面验收使用独立验收构建，不是安装后的 NSIS 包。** 发布安装包已成功构建；未在安装后的包上重复 12 项，避免触碰用户环境。

---

## 14. 最终结论

**CONDITIONAL PASS**

已满足的条件：

- 删除确认历史关联审计 10 项通过，缺失 `proposalId` 回写缺陷已修复；
- 单元测试 330/330、集成测试 66/66、lint、build、cargo check、tauri:build 全部通过；
- 真实模型 A–L 最终 12/12 通过，失败与复跑日志完整保留；
- Windows Tauri release 构建和 NSIS 安装包成功；
- Windows 桌面 12 项在真实 Tauri 窗口执行通过；
- 迁移 9 兼容旧库、重复迁移安全；
- 无未解决 P0/P1 安全问题。

唯一条件项：

- 桌面 12 项由 CDP 驱动真实 Tauri 窗口完成，尚未由人手逐项点击复核。若验收方要求严格的人手操作，需要补一次人工点击；若接受 CDP 驱动真实桌面窗口作为等效证据，则本阶段可判定 PASS。

按任务书要求，本报告完成后立即停止：不进入 Phase 5，不执行历史重放，不恢复历史授权，不扩展闹钟历史闭环，不进行无关 UI 改造。

---

### 附：本轮自动化命令汇总

| 命令 | 结果 |
| --- | --- |
| `pnpm test:agent` | 330 pass / 0 fail，53 suites |
| `pnpm test:integration` | 66 pass / 0 fail |
| `pnpm lint` | 0 warning / 0 error，154 files |
| `pnpm build` | 通过 |
| `cargo check --manifest-path src-tauri/Cargo.toml` | 通过，1m05s |
| `pnpm tauri:build` | 通过，NSIS 安装包 5,369,799 bytes |
| 真实模型 A–L | 12/12 通过（含 C/K 复跑） |
| Windows 桌面 12 项 | 12/12 通过（CDP 驱动真实 Tauri 窗口） |
