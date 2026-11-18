# MEMORA V0.9 发布源状态报告

- 报告日期：2026-11-18
- 分支：`main`
- HEAD：`529a0cfc3d197a5ba7d83f594b203b06783a2cad`
- 工作区状态：**不干净，未形成发布提交**
- 本轮是否提交：**否**
- 结论：当前制品属于**候选构建**，不能宣称已从正式发布提交复现

> 本报告只记录实际执行 `git status`、`git check-ignore` 和敏感信息扫描的结果。本轮未执行 `git add`、`git commit`、`git tag`、`git push`、`git reset`、`git clean` 或 `git checkout`。

---

## 1. 分支与提交

| 项目 | 实际值 |
| --- | --- |
| 当前分支 | `main` |
| HEAD | `529a0cf refactor(theme): 统一主题系统为全局 ThemeProvider 并引入 MEMORA 品牌` |
| 远程状态 | 未推送、未比较 |
| 标签 | 未创建 |
| 工作区 | 39 个已跟踪状态条目、36 个未跟踪目录条目（临时目录已加入忽略规则） |

`git status` 完整快照：[git-status.txt](../../.tmp-release/logs/v090/git-status.txt)

---

## 2. 文件分类

### 2.1 应纳入发布源的正式源码与测试

| 类别 | 文件 |
| --- | --- |
| 构建与版本 | `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`.oxlintrc.json`、`.gitignore` |
| Rust 主程序 | `src-tauri/src/lib.rs` |
| Agent 执行层 | `src/services/agentExecution.ts`、`agentToolExecutor.ts`、`agentToolSchema.ts`、`agentTools.ts`、`agentProgress.ts`、`agentFailure.ts`、`agentRetryLedger.ts`、`agentContinuation.ts`、`agentTargets.ts`、`toolNameNormalization.ts` |
| 安全与授权 | `src/services/assistantIntent.ts`、`assistantContext.ts`、`conversationMemory.ts`、`conversationReferents.ts`、`alarmSelections.ts`、`alarmSelectionExecution.ts`、`deleteExecution.ts`、`deleteConfirmationHistory.ts` |
| 执行历史 | `src/services/executionHistory.ts`、`executionHistoryRecovery.ts`、`executionRecorder.ts`、`src/repository/agentExecutionRepository.ts`、`executionRepository.ts`、`localExecutionRepository.ts`、`sqliteExecutionRepository.ts`、`src/types/executionHistory.ts` |
| 界面与主题 | `src/components/AssistantPanel.tsx`、`src/components/AgentHistoryPanel.tsx`、`src/main.tsx`、`src/store/useAssistantStore.ts`、`src/types/ai.ts`、`src/styles/memora-tokens.css`、`src/utils/assistantSelectionLifecycle.ts`、`src/services/reminderAlarms.ts`、`src/services/aiClient.ts` |
| 测试 | `tests/*.test.ts`、`tests/helpers.ts`（共 19 个测试文件） |
| 测试与验收脚本 | `scripts/run-agent-tests.mjs`、`scripts/run-integration-tests.mjs`、`scripts/run-real-model-acceptance.mjs`、`scripts/integration/harness.mjs`、`scripts/integration/mockSseServer.mjs` |
| 阶段与发布文档 | `docs/MEMORA-V0.9-Phase*.md`、`docs/agent/*.md`、`docs/reports/*.md`、`docs/releases/*.md` |

### 2.2 必须排除的文件与目录

| 路径 | 类别 | 排除理由 |
| --- | --- | --- |
| `.tmp-release/` | 临时验证 | 含隔离安装目录、独立 Cargo target、测试数据库、日志与截图；体积大且不可复现 |
| `.tmp-acceptance/` | 临时验证 | 含验收截图、PID、旧日志与临时数据库 |
| `.installer-test/` | 临时安装 | 含已解包/安装的程序文件 `bianqian.exe`、`uninstall.exe` |
| `dist/` | 构建产物 | 由 `pnpm build` 生成 |
| `src-tauri/target/` | 构建产物 | 由 Cargo 生成，已由 `src-tauri/.gitignore` 忽略 |
| `.preview/`、`.workbuddy/`、`.test-build/` | 本地临时 | 非产品源码，已忽略 |
| `*.log` | 日志 | 含环境信息，已忽略 |
| `src-tauri/keys/opencode.key` | 密钥 | 已由 `src-tauri/keys/.gitignore` 忽略；不得进入版本库 |

本轮已在根 `.gitignore` 增加 `.tmp-release`、`.tmp-acceptance`、`.installer-test`，避免误加入发布源。该修改只影响忽略规则，不删除任何已有文件。

### 2.3 敏感信息扫描

对 `docs/`、`src/`、`scripts/`、`tests/`、`src-tauri/src/` 执行密钥模式扫描：

- 未发现真实 API Key、Bearer Token 或私钥；
- `tests/executionHistory.test.ts` 中的 `sk-abcdefgh12345678` 是脱敏测试用假值；
- 内置密钥文件仍在本地忽略状态，本轮未打印、复制或写入文档。

---

## 3. 建议的发布提交方案

以下方案**未执行**，需用户确认后由发布负责人执行。

### 3.1 建议提交范围

一次性提交全部源码、测试、脚本、配置和文档：

```text
package.json
pnpm-lock.yaml
.oxlintrc.json
.gitignore
src-tauri/tauri.conf.json
src-tauri/Cargo.toml
src-tauri/Cargo.lock
src-tauri/src/lib.rs
src/**
tests/**
scripts/**
docs/**
```

明确不加入：`.tmp-release/`、`.tmp-acceptance/`、`.installer-test/`、`dist/`、`src-tauri/target/`、密钥文件。

### 3.2 建议提交说明

```text
chore(release): 发布 MEMORA 0.9.0

- 统一 package/Tauri/Cargo 版本为 0.9.0
- 收录 Agent 执行、授权、失败恢复与执行历史最终实现及测试
- 补充发布审计、安装/升级、已知问题与最终报告
- oxlint 忽略本地验证与构建产物目录
```

### 3.3 提交后的必要动作

1. 从该提交重新执行 `pnpm install --frozen-lockfile --offline`；
2. 重新执行完整验证链与 `pnpm tauri:build`；
3. 重新记录安装包大小与 SHA-256；
4. 只有重建后的制品才可以标记为“从正式发布提交复现”。

当前 `MEMORA_0.9.0_x64-setup.exe` 是在未提交工作区构建的，属于候选构建。

---

## 4. 风险与建议

| 项目 | 状态 | 建议 |
| --- | --- | --- |
| 发布源可追溯性 | 未满足 | 执行上述提交后再重建 |
| 临时目录误提交 | 已缓解 | `.gitignore` 已增加忽略规则 |
| 密钥泄露 | 未发现 | 继续禁止提交 `src-tauri/keys/` |
| 大体积二进制 | 仅存在于忽略目录 | 不进入发布源 |
| 文档与源码一致性 | 本轮已更新 | 提交前复核版本号与哈希 |

---

## 5. 结论

发布源内容清晰，未发现敏感信息；但因工作区尚未提交，**正式发布条件未完全满足**。在完成发布提交并从该提交重建之前，本轮制品只能作为发布候选。