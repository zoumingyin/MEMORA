# MEMORA V0.9 发布提交清单

- 清单日期：2026-11-18
- 分支：`main`
- 基准 HEAD：`529a0cfc3d197a5ba7d83f594b203b06783a2cad`
- 目标提交说明：`chore(release): 发布 MEMORA 0.9.0`
- 阶段性质：**Task 2 正式提交准备（含文档脱敏）**
- 本轮 Git 操作：**精确逐文件暂存、一次本地 commit、提交后验证；未执行 push/tag/reset/clean/checkout/restore/amend**
- 最终结论：**READY FOR COMMIT**

> 本清单记录 94 个既有工作区变更，并额外包含本清单自身，共 **95 个拟提交文件**。Task 2 开始时暂存区为空，所有文件均按本清单逐项重新核对后提交。

---

## 1. 工作区快照

| 项目 | 实际值 |
| --- | --- |
| 当前分支 | `main` |
| HEAD | `529a0cf refactor(theme): 统一主题系统为全局 ThemeProvider 并引入 MEMORA 品牌` |
| `git status --short` 状态条目 | 95 |
| 已暂存条目 | 0（Task 2 开始时暂存区为空） |
| 未暂存条目 | 19 |
| 未跟踪文件 | 76（按文件展开，不是目录数） |
| 既有变更文件合计 | 94（新增 75 / 修改已有 19 / 删除 0 / 重命名 0） |
| 本清单自身 | 1（新增） |
| 拟提交文件合计 | **95**（新增 76 / 修改已有 19 / 删除 0 / 重命名 0） |

变更规模：

| 范围 | 文件数 | 新增行 | 删除行 |
| --- | --- | --- | --- |
| 未暂存 diff | 19 | 2,544 | 234 |
| 已暂存 diff | 0 | 0 | 0 |
| 未跟踪文件 | 76 | 按文件新增 | 0 |

说明：

- Task 1 的 31 个暂存条目在 Task 2 开始前已全部回到工作区；当前 19 个已跟踪文件为 ` M`，76 个新增文件为 `??`。未发现文件丢失或内容变化。
- 未发现删除（`D`）或重命名（`R`）。
- `git diff --check` 返回 `0`；暂存后已再次执行 `git diff --cached --check`。
- Git 提示部分文件将在下次触碰时执行 LF → CRLF 转换；这是行尾策略提示，不是内容错误。
- Task 1 中 8 个已暂存且无工作区改动的文件，现已回到未跟踪/未暂存状态，并在本次提交中逐文件重新加入：
  - `docs/MEMORA-V0.9-Phase1-分析报告.md`
  - `docs/MEMORA-V0.9-Phase2-实施报告.md`
  - `docs/MEMORA-V0.9-Phase3-实施报告.md`
  - `docs/MEMORA-V0.9-Phase3.1-实施报告.md`
  - `docs/MEMORA-V0.9-Phase3.2-实施报告.md`
  - `scripts/run-agent-tests.mjs`
  - `src/services/agentTools.ts`
  - `src/styles/memora-tokens.css`

审计证据（本地临时日志，不进入提交）：

- `.tmp-release/logs/v090/git-audit/inventory.txt`
- `.tmp-release/logs/v090/git-audit/candidates-unquoted.txt`
- `.tmp-release/logs/v090/git-audit/add-dry-run.txt`
- `.tmp-release/logs/v090/git-audit/add-dry-run-after-manifest.txt`
- `.tmp-release/logs/v090/git-audit/final-files.txt`（95 行，逐文件暂存依据）
- `.tmp-release/logs/v090/git-audit/final-secret-scan.txt`（提交前敏感信息扫描）

---

## 2. 文件归类

状态标记沿用 `git status --short`。以下标记是 Task 1 审计快照；Task 2 开始时暂存区已清空，当前实际状态为：

- 原先的 `M ` / `MM` 文件现在均为 ` M`。
- 原先的 `A ` / `AM` / `??` 文件现在均为 `??`。
- 提交范围与下表 95 个路径一致，不因暂存状态变化而增删。

Task 1 状态标记说明：

- `M ` / ` M` / `MM`：已跟踪文件修改。
- `A `：新增文件，已暂存且工作区无进一步修改。
- `AM`：新增文件已暂存，工作区还有修改。
- `??`：未跟踪新增文件。

### 2.1 A 类：必须提交（74 个，含本清单）

#### A1 版本、构建与忽略规则（7）

```text
MM  .gitignore
 M  .oxlintrc.json
MM  package.json
 M  src-tauri/Cargo.lock
 M  src-tauri/Cargo.toml
 M  src-tauri/src/lib.rs
 M  src-tauri/tauri.conf.json
```

#### A2 Agent 与执行层实现（35）

```text
MM  src/components/AssistantPanel.tsx
 M  src/main.tsx
AM  src/services/agentExecution.ts
MM  src/services/agentToolExecutor.ts
MM  src/services/agentToolSchema.ts
M   src/services/agentTools.ts
 M  src/services/aiClient.ts
AM  src/services/alarmSelectionExecution.ts
AM  src/services/alarmSelections.ts
MM  src/services/assistantContext.ts
 M  src/services/deleteExecution.ts
MM  src/services/reminderAlarms.ts
MM  src/store/useAssistantStore.ts
M   src/styles/memora-tokens.css
MM  src/types/ai.ts
??  src/components/AgentHistoryPanel.tsx
??  src/repository/agentExecutionRepository.ts
??  src/repository/executionRepository.ts
??  src/repository/localExecutionRepository.ts
??  src/repository/sqliteExecutionRepository.ts
??  src/services/agentContinuation.ts
??  src/services/agentFailure.ts
??  src/services/agentProgress.ts
??  src/services/agentRetryLedger.ts
??  src/services/agentTargets.ts
??  src/services/assistantIntent.ts
??  src/services/conversationMemory.ts
??  src/services/conversationReferents.ts
??  src/services/deleteConfirmationHistory.ts
??  src/services/executionHistory.ts
??  src/services/executionHistoryRecovery.ts
??  src/services/executionRecorder.ts
??  src/services/toolNameNormalization.ts
??  src/types/executionHistory.ts
??  src/utils/assistantSelectionLifecycle.ts
```

#### A3 测试（19）

```text
AM  tests/agentExecution.test.ts
AM  tests/agentTools.test.ts
AM  tests/alarmSelection.test.ts
AM  tests/deleteExecution.test.ts
AM  tests/helpers.ts
AM  tests/prompts.test.ts
AM  tests/reminderAlarms.test.ts
??  tests/agentContinuation.test.ts
??  tests/agentPermissionTargets.test.ts
??  tests/agentProgress.test.ts
??  tests/assistantIntent.test.ts
??  tests/assistantSelectionLifecycle.test.ts
??  tests/conversationMemory.test.ts
??  tests/conversationReferents.test.ts
??  tests/conversationSecurity.test.ts
??  tests/deleteConfirmationHistory.test.ts
??  tests/executionHistory.test.ts
??  tests/failureRecovery.test.ts
??  tests/toolNameNormalization.test.ts
```

#### A4 测试与验收脚本（5）

```text
AM  scripts/integration/harness.mjs
AM  scripts/integration/mockSseServer.mjs
A   scripts/run-agent-tests.mjs
AM  scripts/run-integration-tests.mjs
AM  scripts/run-real-model-acceptance.mjs
```

#### A5 发布文档与最终报告（7）

```text
??  docs/releases/MEMORA-V0.9-INSTALLATION-GUIDE.md
??  docs/releases/MEMORA-V0.9-KNOWN-ISSUES.md
??  docs/releases/MEMORA-V0.9-RELEASE-NOTES.md
??  docs/releases/MEMORA-V0.9-UPGRADE-GUIDE.md
??  docs/reports/MEMORA-V0.9-RELEASE-AUDIT.md
??  docs/reports/MEMORA-V0.9-RELEASE-FINAL-REPORT.md
??  docs/reports/MEMORA-V0.9-RELEASE-SOURCE-STATUS.md
```

#### A6 本清单自身（1）

```text
??  docs/reports/MEMORA-V0.9-RELEASE-COMMIT-MANIFEST.md
```

### 2.2 B 类：应该提交，但需用户确认（21 个历史阶段文档）

这些文件是 V0.9 开发过程的阶段记录，不参与运行时，但保留后可支持审计追溯。它们没有删除或覆盖风险。

```text
A   docs/MEMORA-V0.9-Phase1-分析报告.md
A   docs/MEMORA-V0.9-Phase2-实施报告.md
A   docs/MEMORA-V0.9-Phase3-实施报告.md
A   docs/MEMORA-V0.9-Phase3.1-实施报告.md
A   docs/MEMORA-V0.9-Phase3.2-实施报告.md
??  docs/MEMORA-V0.9-Phase4.1-分析报告.md
??  docs/agent/MEMORA_V0.9_Phase3.2.1_Final_Audit_Report.md
??  docs/agent/MEMORA_V0.9_Phase4.1.1_Implementation_Report.md
??  docs/agent/MEMORA_V0.9_Phase4.1.2_Analysis_Report.md
??  docs/agent/MEMORA_V0.9_Phase4.1.2_Implementation_Report.md
??  docs/agent/MEMORA_V0.9_Phase4.1_Analysis_Report.md
??  docs/reports/MEMORA-V0.9-PHASE-4.1.3-IMPLEMENTATION-REPORT.md
??  docs/reports/MEMORA-V0.9-PHASE-4.2-IMPLEMENTATION-REPORT.md
??  docs/reports/MEMORA-V0.9-PHASE-4.3-IMPLEMENTATION-REPORT.md
??  docs/reports/MEMORA-V0.9-PHASE-4.3.1-REAL-MODEL-ACCEPTANCE.md
??  docs/reports/MEMORA-V0.9-PHASE-4.3.2-DELETE-TOOL-COMPATIBILITY.md
??  docs/reports/MEMORA-V0.9-PHASE-4.4-FAILURE-RECOVERY-RELIABILITY.md
??  docs/reports/MEMORA-V0.9-PHASE-4.5-EXECUTION-HISTORY.md
??  docs/reports/MEMORA-V0.9-PHASE-4.5.1-DELETE-CONFIRMATION-HISTORY.md
??  docs/reports/MEMORA-V0.9-PHASE-4.5.2-FINAL-ACCEPTANCE.md
??  docs/reports/MEMORA_V0.9_Phase_4.1.3_Audit_Report.md
```

确认点：

- 前 5 个 Phase 1–3.2 文档已回到未跟踪状态，在本次提交中逐个重新加入。
- 其余 16 个为未跟踪历史文档；`docs/MEMORA-V0.9-Phase4.1-分析报告.md` 与 `docs/agent/MEMORA_V0.9_Phase4.1_Analysis_Report.md` 是两份不同报告（分析版与方案版），不是重复文件。

### 2.3 C 类：必须排除

以下路径不属于拟提交文件。已用 `git check-ignore` 和 `git add --dry-run` 验证不会进入暂存区。

| 路径 / 模式 | 类别 | 排除理由 |
| --- | --- | --- |
| `.tmp-release/` | 临时验证 | 隔离安装目录、独立 Cargo target、测试数据库、日志、截图 |
| `.tmp-acceptance/` | 临时验收 | 验收截图、PID、旧日志、临时数据库 |
| `.installer-test/` | 临时安装 | 已解包/安装的 `bianqian.exe`、`uninstall.exe` |
| `.test-build/` | 临时构建 | 测试构建产物 |
| `.preview/`、`.workbuddy/` | 本地环境 | 非产品源码 |
| `dist/` | 构建产物 | Vite 输出 |
| `src-tauri/target/` | 构建产物 | Cargo 输出，含安装包与二进制 |
| `node_modules/` | 依赖 | 可由锁文件恢复 |
| `logs/`、`*.log` | 日志 | 含运行环境信息 |
| `src-tauri/keys/opencode.key` | 密钥 | 已被 `src-tauri/keys/.gitignore` 忽略，禁止提交 |
| `%APPDATA%\com.bianqian.desktop\bianqian.db` | 用户数据 | 真实数据库，不在仓库内 |
| `%APPDATA%\com.bianqian.desktop\ai-config.json` | 用户配置 | 可能含模型密钥 |
| `bianqian.db-wal` / `bianqian.db-shm` | 数据库附属文件 | 运行时生成 |
| `src-tauri/target/release/bundle/nsis/MEMORA_0.9.0_x64-setup.exe` | 候选制品 | 构建产物；提交后必须重建并更新哈希 |

### 2.4 D 类：用途不明或需要单独确认

**D 类文件：0 个。**

未发现用途不明、无法确认归属的文件。需用户确认的事项不是文件归属，而是：

1. 8 个原暂存文件已重新核对并逐文件纳入，无需取消暂存（见 2.1 与第 7 节）；
2. 8 份文档中的模型 endpoint ID 是否需要在对外发布前脱敏；
3. 6 份文档中的本机绝对路径是否需要在对外发布前替换为占位符；
4. 是否将本清单自身纳入发布提交（当前方案：纳入）。

---

## 3. Phase 4 完整性核对

### 3.1 阶段与文件映射

| 阶段 | 实现文件 | 测试文件 | 结论 |
| --- | --- | --- | --- |
| Phase 4.1 意图理解 | `src/services/assistantIntent.ts`、`assistantContext.ts`、`agentToolSchema.ts`、`src/store/useAssistantStore.ts`、`src/components/AssistantPanel.tsx` | `tests/assistantIntent.test.ts`、`tests/prompts.test.ts` | 完整 |
| Phase 4.1.1 / 4.1.2 上下文与工具范围 | `src/services/assistantContext.ts`、`agentToolSchema.ts`、`assistantIntent.ts`、`src/store/useAssistantStore.ts` | `tests/assistantIntent.test.ts`、`tests/prompts.test.ts` | 完整 |
| Phase 4.1.3 执行层权限与来源守卫 | `src/services/agentTargets.ts`、`agentRetryLedger.ts`、`agentToolExecutor.ts` | `tests/agentPermissionTargets.test.ts` | 完整 |
| Phase 4.2 上下文与会话记忆 | `src/services/conversationMemory.ts`、`conversationReferents.ts`、`assistantContext.ts`、`src/store/useAssistantStore.ts` | `tests/conversationMemory.test.ts`、`conversationReferents.test.ts`、`conversationSecurity.test.ts` | 完整 |
| Phase 4.3 执行体验 | `src/services/agentProgress.ts`、`agentContinuation.ts`、`src/components/AssistantPanel.tsx`、`src/store/useAssistantStore.ts`、`src/types/ai.ts` | `tests/agentProgress.test.ts`、`agentContinuation.test.ts`、`agentExecution.test.ts` | 完整 |
| Phase 4.3.1 工具名归一化 | `src/services/toolNameNormalization.ts`、`src/services/aiClient.ts` | `tests/toolNameNormalization.test.ts` | 完整 |
| Phase 4.3.2 删除工具兼容性 | `src/services/agentToolSchema.ts`、`assistantContext.ts`、`assistantIntent.ts`、`src/store/useAssistantStore.ts` | `tests/assistantIntent.test.ts`、`tests/prompts.test.ts` | 完整 |
| Phase 4.4 失败恢复与可靠性 | `src/services/agentFailure.ts`、`executionHistoryRecovery.ts`、`agentContinuation.ts`、`agentProgress.ts`、`agentRetryLedger.ts`、`agentToolExecutor.ts`、`src/utils/assistantSelectionLifecycle.ts`、`src/components/AssistantPanel.tsx` | `tests/failureRecovery.test.ts`、`assistantSelectionLifecycle.test.ts`、`agentContinuation.test.ts`、`agentProgress.test.ts` | 完整 |
| Phase 4.5 执行历史与可观测性 | `src/services/executionHistory.ts`、`executionRecorder.ts`、`src/repository/*.ts`、`src/components/AgentHistoryPanel.tsx`、`src/types/executionHistory.ts`、`src-tauri/src/lib.rs`（Migration 8） | `tests/executionHistory.test.ts`、`tests/assistantIntent.test.ts` | 完整 |
| Phase 4.5.1 删除确认历史回写 | `src/services/deleteConfirmationHistory.ts`、`src/repository/sqliteExecutionRepository.ts`、`executionRecorder.ts`、`executionHistory.ts`、`src/types/executionHistory.ts`、`src-tauri/src/lib.rs`（Migration 9） | `tests/deleteConfirmationHistory.test.ts`、`tests/executionHistory.test.ts`、`tests/agentTools.test.ts` | 完整 |
| Phase 4.5.2 proposalId 严格校验 | `src/services/deleteConfirmationHistory.ts`、`src/repository/sqliteExecutionRepository.ts`、`executionHistory.ts`、`agentExecution.ts`、`agentToolExecutor.ts`、`src/components/AssistantPanel.tsx` | `tests/deleteConfirmationHistory.test.ts` | 完整 |

### 3.2 新增文件纳入情况

- 20 个新增源码文件全部在 A 类清单中。
- 12 个新增测试文件全部在 A 类清单中。
- 4 个新增发布文档、3 个发布审计/报告文档全部在 A 类清单中。
- 5 个新增脚本/集成脚本全部在 A 类清单中。
- 未发现“实现文件存在但未被 Git 跟踪且未列入清单”的情况。
- 未发现“测试文件存在但未列入清单”的情况。
- 未发现已跟踪文件被误排除。

### 3.3 Migration 8 / Migration 9

`src-tauri/src/lib.rs` 仅新增 Migration 8、Migration 9，没有修改既有 Migration 1–7：

- Migration 8：新增 `agent_executions`、`agent_execution_steps` 及 4 个索引。
- Migration 9：`ALTER TABLE agent_execution_steps ADD COLUMN proposal_id TEXT;`。
- 旧步骤的 `proposal_id` 保持 `NULL`。
- 应用启动时由 SQL 插件按版本执行；重复启动不会重复执行。
- 本轮未修改表结构，未修改迁移逻辑之外的 Rust 代码。

### 3.4 安全不变量抽查

| 不变量 | 代码证据 | 结果 |
| --- | --- | --- |
| 删除确认历史必须精确匹配 | `src/services/deleteConfirmationHistory.ts:95`、`:97`、`:104`、`:105` | 通过 |
| 缺少 `proposalId` 的旧步骤不得回写 | `src/services/deleteConfirmationHistory.ts:94`、`:95` | 通过 |
| 未完成写入不得自动重试 | `src/services/executionHistoryRecovery.ts:18`、`:79`、`:100` | 通过 |
| 未完成只读步骤标记为 cancelled | `src/services/executionHistoryRecovery.ts:19`、`:88` | 通过 |
| 用户停止不得显示为完成 | `src/services/agentExecution.ts:399`、`:411` | 通过 |
| 闹钟选择授权仅存内存 | `src/services/alarmSelections.ts:55`、`:57` | 通过 |
| 迁移 8/9 完整 | `src-tauri/src/lib.rs:685`、`:736`、`:741` | 通过 |

### 3.5 历史报告文件名漂移（不影响实现）

以下 5 个测试文件名在 Phase 4.1 / 4.1.3 历史报告中被引用，但当前工作区不存在：

```text
tests/agentIntent.test.ts
tests/agentTargetAmbiguity.test.ts
tests/agentTargetProvenance.test.ts
tests/agentToolPermission.test.ts
tests/assistantRetry.test.ts
```

核对结果：

- `git log --all -- <path>` 对这些路径没有历史记录，说明它们从未被 Git 跟踪，不是本轮删除的文件。
- 当前测试已按语义合并：
  - `tests/agentPermissionTargets.test.ts` 覆盖“执行层权限守卫、目标 ID 来源守卫、同名与高相似目标拦截、失败重试写入保护”。
  - `tests/assistantIntent.test.ts` 覆盖意图分类、工具范围与纯函数约束。
- 未发现实现文件缺失或测试覆盖缺失。
- 这是历史报告与当前测试文件名的文档漂移，建议后续单独更新报告；本轮不修改。

---

## 4. 版本与构建配置核对

| 项目 | 实际值 | 结果 |
| --- | --- | --- |
| `package.json` version | `0.9.0` | 通过 |
| `src-tauri/tauri.conf.json` version | `0.9.0` | 通过 |
| `src-tauri/Cargo.toml` version | `0.9.0` | 通过 |
| `src-tauri/Cargo.lock` 中 `bianqian` | `0.9.0`，仅该行变化 | 通过 |
| identifier | `com.bianqian.desktop` | 通过 |
| productName | `MEMORA` | 通过 |
| bundle target | `nsis` | 通过 |
| 安装包命名 | `MEMORA_0.9.0_x64-setup.exe` | 通过（候选制品已构建记录） |
| `pnpm-lock.yaml` | 无变更 | 通过 |
| 依赖变更 | 无新增/删除依赖 | 通过 |
| `pnpm install --frozen-lockfile --offline` | `Already up to date`，exit `0` | 通过 |
| `.gitignore` 忽略临时目录/密钥 | 已验证 | 通过 |
| `.oxlintrc.json` 忽略构建产物 | 已验证 | 通过 |
| 源码/测试/文档未被忽略 | 已验证 | 通过 |
| `git diff --check` | exit `0` | 通过 |

补充说明：

- `.gitignore` 结尾缺少换行符；仅影响文本整洁，不影响忽略规则。本轮未修改。
- `src/styles/memora-tokens.css` 新增的是语义色“文字变体”token，Phase 3.1 报告已记录为浅色对比度修复；品牌色 token 未替换，不属于 V0.8 品牌视觉改版。
- `src/main.tsx` 仅新增启动时执行历史恢复调用，没有改变渲染入口或主题结构。
- `src-tauri/src/lib.rs` 仅新增 Migration 8/9，没有修改既有迁移 SQL。

---

## 5. 敏感信息检查与脱敏

扫描范围：95 个拟提交文件中的文本文件。扫描只记录位置和风险类型，不输出密钥内容。

| 检查项 | 结果 |
| --- | --- |
| 真实 API Key（`sk-` 长串） | 未发现 |
| GitHub / AWS Token | 未发现 |
| Bearer Token 长串 | 未发现 |
| JWT 长串 | 未发现 |
| 私钥 / 证书 PEM | 未发现 |
| 密码 / secret 字面量 | 未发现真实值；`tests/executionHistory.test.ts` 中是明确的脱敏测试假值 |
| `.env` / `.pem` / `.key` / `.p12` / `.pfx` / `.crt` 候选文件 | 未发现 |
| 真实 SQLite 数据库 | 不在候选集中 |
| `ai-config.json` | 不在候选集中 |
| 内置密钥文件 | `src-tauri/keys/opencode.key` 存在但已被忽略；未打印、未复制、不会提交 |
| 本机绝对路径 | **已处理**：6 份文档中的绝对路径已替换为相对路径或占位符 |
| 模型 endpoint ID | **已处理**：8 份文档中的 endpoint ID 已替换为 `VOLCENGINE_ENDPOINT_ID` |

### 5.1 脱敏执行记录

| 文档 | 处理内容 |
| --- | --- |
| `docs/MEMORA-V0.9-Phase3.1-实施报告.md` | Endpoint ID → `VOLCENGINE_ENDPOINT_ID` |
| `docs/MEMORA-V0.9-Phase3.2-实施报告.md` | Endpoint ID → `VOLCENGINE_ENDPOINT_ID` |
| `docs/releases/MEMORA-V0.9-KNOWN-ISSUES.md` | Endpoint ID → 占位符；用户安装目录绝对路径 → `<用户安装目录>` |
| `docs/releases/MEMORA-V0.9-RELEASE-NOTES.md` | Endpoint ID → `VOLCENGINE_ENDPOINT_ID` |
| `docs/reports/MEMORA-V0.9-PHASE-4.5-EXECUTION-HISTORY.md` | Endpoint ID → `VOLCENGINE_ENDPOINT_ID` |
| `docs/reports/MEMORA-V0.9-PHASE-4.5.1-DELETE-CONFIRMATION-HISTORY.md` | Endpoint ID → `VOLCENGINE_ENDPOINT_ID` |
| `docs/reports/MEMORA-V0.9-PHASE-4.5.2-FINAL-ACCEPTANCE.md` | Endpoint ID → 占位符；41 处本地 file URL 绝对链接 → `../../` 相对链接 |
| `docs/reports/MEMORA-V0.9-RELEASE-FINAL-REPORT.md` | Endpoint ID → 占位符；安装包与进程绝对路径 → 仓库相对路径 |
| `docs/agent/MEMORA_V0.9_Phase3.2.1_Final_Audit_Report.md` | 21 处本地 file URL 绝对链接 → `../../` 相对链接；2 处构建产物绝对路径 → 仓库相对路径 |
| `docs/reports/MEMORA-V0.9-PHASE-4.3.2-DELETE-TOOL-COMPATIBILITY.md` | 9 处本地 file URL 绝对链接 → `../../` 相对链接 |
| `docs/reports/MEMORA-V0.9-RELEASE-AUDIT.md` | Shell 路径 → `bash.exe`；工作目录 → “项目根目录”；进程路径 → 仓库相对路径；用户安装目录 → `<用户安装目录>` |

脱敏原则：

- 只替换账号相关标识和本机绝对路径。
- 模型名称、测试步骤、测试结果、技术结论和验收事实保持不变。
- 未修改源码、测试数据、真实配置、Agent 执行逻辑、数据库迁移或 V0.8 视觉系统。
- 未删除任何测试结果或改变报告结论。

### 5.2 残留扫描

| 检查项 | 结果 |
| --- | --- |
| Endpoint ID 字面量 | 0 |
| 盘符绝对路径（`C:` / `D:` / `E:`） | 0 |
| 本地 file URL 绝对链接 | 0 |
| 真实 API Key / Token / 密码 / 私钥 / 证书 | 0 |
| `src-tauri/keys/opencode.key` 进入候选集 | 否 |
| 真实数据库 / `ai-config.json` 进入候选集 | 否 |

### 5.3 仍需注意

- 历史报告中的 5 个测试文件名漂移（见 3.5）仍未修改，属于 P3 文档问题。
- `.gitignore` 结尾缺少换行符仍未修改，属于 P3 文本问题。
- 未发现需要停止提交的敏感信息。

---

## 6. 提交命令预览（未执行）

### 6.1 精确逐文件暂存

最终文件列表已写入 `.tmp-release/logs/v090/git-audit/final-files.txt`（95 行，不含临时文件、数据库或密钥）。在仓库根目录执行：

```bash
cd <repo-root>

test "$(wc -l < .tmp-release/logs/v090/git-audit/final-files.txt)" -eq 95

while IFS= read -r f; do
  git add -- "$f"
done < .tmp-release/logs/v090/git-audit/final-files.txt

git status --short
git diff --cached --check
git diff --cached --stat
git diff --cached --name-status
git diff --cached --name-only
```

不使用 `git add src tests scripts docs` 这类宽泛路径；每一行都是最终清单中的完整文件路径。`pnpm-lock.yaml` 本轮无变更，不在 95 个文件内。

### 6.2 提交前范围守卫

```bash
git diff --cached --name-only | grep -E '^(\.tmp-release/|\.tmp-acceptance/|\.installer-test/|\.test-build/|\.preview/|\.workbuddy/|dist/|src-tauri/target/|node_modules/|logs/)|\.(db|db-wal|db-shm|key|pem|p12|pfx|env)$'
```

- 如果输出非空：**立即停止，不要提交**。
- 如果输出为空：继续。

建议同时核对文件数：

```bash
test "$(git diff --cached --name-only | wc -l)" -eq 95 && echo "scope count OK" || echo "scope count MISMATCH"
```

### 6.3 提交

```bash
git commit -m "chore(release): 发布 MEMORA 0.9.0"
```

### 6.4 严格禁止

- 不要使用 `git add -A`、`git add .` 或宽泛目录 `git add src tests scripts docs`。
- 不要提交 `.tmp-release/`、`.tmp-acceptance/`、`.installer-test/`、`dist/`、`src-tauri/target/`、`src-tauri/keys/opencode.key`。
- 必须通过 `final-files.txt` 逐文件暂存，并在提交前核对 95 个文件。
- 不要在本任务中执行 `git push`、`git tag` 或正式发布。

### 6.5 提交后的必要动作

1. 从该提交重新执行 `pnpm install --frozen-lockfile --offline`；
2. 重新执行完整验证链；
3. 重新执行 `pnpm tauri:build`；
4. 重新记录安装包大小与 SHA-256；
5. 只有从该提交重建的制品，才能更新 `MEMORA-V0.9-RELEASE-NOTES.md` 与安装指南中的候选哈希；
6. 重新执行正式 identifier 的安装/升级验收，关闭 KI-01、KI-02、KI-21。

---

## 7. 未执行项与风险

### 7.1 本轮未执行

- 已执行精确逐文件暂存；`git commit` 只在最终守卫通过后执行一次。
- 未执行 `git push`、`git tag`。
- 未执行 `git reset`、`git clean`、`git checkout --`、`git restore`、`git commit --amend`。
- 未修改任何业务源码、Agent Loop、安全机制、SQLite schema 或 V0.8 品牌主题。
- 仅对 11 份发布/阶段文档执行脱敏，未修改源码、测试数据或真实配置。
- 未删除任何文件。
- 未安装、覆盖升级或卸载正式 0.9.0 安装包。
- 未重建安装包。

### 7.2 风险与待办

| 编号 | 级别 | 事项 | 建议 |
| --- | --- | --- | --- |
| M-01 | P3 | Phase 4.1 / 4.1.3 历史报告引用了 5 个当前不存在的测试文件名 | 后续更新历史报告；当前实现与测试覆盖已核实 |
| M-02 | P3 | 8 份文档含账号相关 endpoint ID | **已处理**：替换为 `VOLCENGINE_ENDPOINT_ID` |
| M-03 | P3 | 6 份文档含本机绝对路径 | **已处理**：替换为相对路径或占位符 |
| M-04 | P3 | `.gitignore` 结尾缺少换行符 | 可后续整理，不影响功能 |
| M-05 | P1 | 当前安装包是从未提交工作区构建的候选制品 | 提交后必须重建并更新哈希（对应 KI-01、KI-21） |
| M-06 | P1 | 正式 identifier 安装包尚未安装/升级验收 | 隔离环境补做（对应 KI-02） |

### 7.3 未发现的问题

- 未发现误删除、误重命名或整文件覆盖。
- 未发现临时目录、构建产物、数据库或密钥进入候选集。
- 未发现新增依赖或锁文件漂移。
- 未发现 Phase 4 实现文件或测试文件遗漏。
- 未发现真实 API Key、Token、密码、私钥或证书。

---

## 8. 最终结论

**READY FOR COMMIT**

理由：

- 95 个拟提交文件已完成文件级归类和重新审计，未发现遗漏或误排除。
- 21 份历史阶段报告全部纳入，8 个原暂存文件已逐文件重新核对。
- Phase 4.1–4.5.2 的实现、测试、脚本与文档均在提交范围中。
- Migration 8/9 完整，安全不变量代码仍在。
- 版本号统一为 `0.9.0`，锁文件一致。
- 8 份文档的 endpoint ID 与 6 份文档的本机绝对路径已完成脱敏。
- 未发现真实密钥、数据库或构建产物进入提交范围。

提交前最终守卫：

1. 暂存文件数必须为 95；
2. `git diff --cached --name-only` 必须与 `final-files.txt` 逐项一致；
3. `git diff --cached --check` 必须通过；
4. 临时目录、数据库、密钥、构建产物必须为 0；
5. `git diff --cached --name-status` 不得出现删除或重命名。

全部通过后执行一次本地提交；不 push、不打 tag、不发布。
