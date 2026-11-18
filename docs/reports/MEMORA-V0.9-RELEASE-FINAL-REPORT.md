# MEMORA V0.9 发布收尾最终报告

- 报告日期：2026-11-18
- 分支：`main`
- HEAD：`529a0cfc3d197a5ba7d83f594b203b06783a2cad`
- 目标版本：`0.9.0`
- 制品：`MEMORA_0.9.0_x64-setup.exe`
- 正式 identifier：`com.bianqian.desktop`
- 最终判定：**CONDITIONAL PASS（候选构建）**

> 本报告只记录本轮实际执行和观察到的结果。未执行的项目明确标记为“未执行”，不按通过处理。

---

## 1. 总体结论

本轮完成了版本统一、发布源审计、正式构建配置审计、完整构建验证链、Agent 安全回归和真实模型 A–L 验收，并更新了发布文档。未发现 P0 缺陷，未修改应用业务源码、Agent 执行架构、安全规则、SQLite schema 或主题系统。

已通过：

- 版本在前端、Tauri、Rust 和锁文件中统一为 `0.9.0`；
- 离线依赖安装、330 个 Agent 单元测试、66 个 Mock SSE 集成测试；
- oxlint、TypeScript、Vite、Cargo check、Tauri NSIS 构建；
- 使用当前 Doubao 配置的真实模型 A–L 场景（13/13）；
- 12 项 Agent 安全规则的代码与测试复核；
- 正式 identifier 和安装包元数据校验。

未完成，构成发布条件：

1. 工作区未提交，当前安装包是候选构建；
2. 正式 identifier 安装包未执行安装、覆盖升级、卸载和重装；
3. 原生托盘、系统通知、边缘吸附、开机自启、全局快捷键和多显示器 DPI 未人工验收。

因此不能判定为无条件 PASS。

---

## 2. 版本统一报告

| 文件 | 修改前 | 修改后 | 结果 |
| --- | --- | --- | --- |
| `package.json` | `0.2.0` | `0.9.0` | 已统一 |
| `src-tauri/tauri.conf.json` | `0.2.0` | `0.9.0` | 已统一 |
| `src-tauri/Cargo.toml` | `0.2.0` | `0.9.0` | 已统一 |
| `src-tauri/Cargo.lock`（`bianqian`） | `0.2.0` | `0.9.0` | 已统一 |
| `pnpm-lock.yaml` | 无根包版本字段 | 无需修改 | 与清单一致 |

其他检查：

- 应用内未发现独立硬编码版本号；
- 安装包文件名、`FileVersion`、`ProductVersion` 均为 `0.9.0`；
- 未修改任何第三方依赖版本。

---

## 3. Git 发布源审计报告

### 3.1 状态

- 分支：`main`；
- HEAD：`529a0cf`；
- 39 个已跟踪状态条目；
- 36 个未跟踪目录条目（源码、测试、脚本、文档）；
- 未提交、未打标签、未推送。

### 3.2 本轮处理

- 未执行任何 Git 写操作或破坏性操作；
- 在 `.gitignore` 增加 `.tmp-release`、`.tmp-acceptance`、`.installer-test`，避免临时目录误入发布源；
- 未删除工作区中的任何文件；
- 敏感信息扫描未发现真实密钥；测试中的 `sk-...` 为假值。

### 3.3 发布提交方案

建议一次性提交源码、测试、脚本、配置和文档，提交说明：

```text
chore(release): 发布 MEMORA 0.9.0
```

排除 `.tmp-*`、`.installer-test`、`dist`、`src-tauri/target` 和密钥文件。提交后必须从该提交重新构建并更新哈希。

完整清单：[MEMORA-V0.9-RELEASE-SOURCE-STATUS.md](./MEMORA-V0.9-RELEASE-SOURCE-STATUS.md)

---

## 4. 正式构建报告

### 4.1 构建环境

| 项目 | 值 |
| --- | --- |
| 操作系统 | Windows 10.0.26200 x64 |
| Node.js | `v22.15.1` |
| pnpm | `11.20.0` |
| Rust / Cargo | `1.96.0` |
| 构建命令 | `pnpm tauri:build` |

### 4.2 源码与工作区

| 项目 | 值 |
| --- | --- |
| 源码 HEAD | `529a0cfc3d197a5ba7d83f594b203b06783a2cad` |
| 工作区 | 不干净（未提交改动） |
| 制品性质 | **候选构建**，非从发布提交复现 |
| 构建完成时间 | 2026-11-18 14:28:33 +0800 |

### 4.3 验证链结果

| # | 命令 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | `pnpm install --frozen-lockfile --ignore-scripts --offline` | exit 0 | [install.log](../../.tmp-release/logs/v090/install.log) |
| 2 | `pnpm test:agent` | 330 pass / 0 fail，53 suites | [test-agent.log](../../.tmp-release/logs/v090/test-agent.log) |
| 3 | `pnpm test:integration` | 66 pass / 0 fail | [test-integration.log](../../.tmp-release/logs/v090/test-integration.log) |
| 4 | `pnpm lint` | 0 warning / 0 error，154 文件 | [lint.log](../../.tmp-release/logs/v090/lint.log) |
| 5 | `pnpm exec tsc -b --pretty false` | exit 0 | [tsc.log](../../.tmp-release/logs/v090/tsc.log) |
| 6 | `pnpm build` | 通过，5219 modules，1.50s | [build.log](../../.tmp-release/logs/v090/build.log) |
| 7 | `cargo check --manifest-path src-tauri/Cargo.toml` | exit 0，18.94s | [cargo-check.log](../../.tmp-release/logs/v090/cargo-check.log) |
| 8 | `pnpm tauri:build` | exit 0，Rust 2m23s，NSIS 成功 | [tauri-build.log](../../.tmp-release/logs/v090/tauri-build.log) |

### 4.4 制品元数据

```text
路径：src-tauri/target/release/bundle/nsis/MEMORA_0.9.0_x64-setup.exe
大小：5,375,916 字节
SHA-256：C15F82619A52FA21B3C0D422E3C5724BB55FF37CA9EB4789DE213D167599D39E
FileVersion：0.9.0
ProductVersion：0.9.0
ProductName：MEMORA
identifier：com.bianqian.desktop
架构：x64
签名：NotSigned
```

构建仅出现大于 500 kB 的 chunk 警告：

```text
DetailPane-CnijsIL3.js     1,046.13 kB
main-CstVVYQS.js             580.06 kB
ThemeProvider-D6JuJRUS.js    535.24 kB
```

### 4.5 构建过程中的修正

首次 `pnpm lint` 因扫描 `.tmp-release/target-acceptance` 下的 Cargo 产物而失败。源码目录检查为 0 问题。已在 `.oxlintrc.json` 增加临时目录和构建产物忽略规则，未关闭任何源码规则；修正后 lint 通过。

---

## 5. 安装与升级验证报告

### 5.1 已完成

| 检查项 | 结果 |
| --- | --- |
| 安装包存在 | 是 |
| 大小与 SHA-256 | 已记录 |
| 文件版本 / 产品版本 | `0.9.0` / `0.9.0` |
| 产品名 | `MEMORA` |
| identifier | `com.bianqian.desktop` |
| 架构 | x64 |
| NSIS 目标 | 通过 |
| 签名状态 | 未签名 |
| 数据路径 | `%APPDATA%\com.bianqian.desktop\bianqian.db` |
| 安装目录与数据目录分离 | 是 |
| 卸载注册键 | `HKCU\...\Uninstall\MEMORA` |
| WebView2 模式 | `downloadBootstrapper` |

### 5.2 未执行

正式 0.9.0 安装包的以下验证**未执行**：

- 全新安装；
- 安装后启动；
- 覆盖升级；
- 升级前后数据保留比对；
- 卸载、保留数据、重新安装。

原因：

1. 本机正式应用正在运行（`src-tauri/target/debug/bianqian.exe`），使用正式 identifier 和真实数据库；
2. 正式安装包与现有安装共用 `MEMORA` 卸载注册键和 `%APPDATA%\com.bianqian.desktop` 数据目录，直接安装/卸载会改动用户现有环境；
3. 本机未安装 Windows Sandbox，无法提供同 identifier 的隔离桌面。

此前阶段使用 `com.bianqian.releasecheck` 的等价构建验证过安装、覆盖升级、卸载和重装，但**不能替代正式 identifier 的最终验收**。

---

## 6. Agent 安全回归报告

### 6.1 安全规则复核

| # | 规则 | 证据 | 结果 |
| --- | --- | --- | --- |
| 1 | 查询可以直接执行 | `agentToolExecutor` 权限作用域；集成测试查询场景 | 通过 |
| 2 | 创建和普通修改不需要确认卡片 | `tests/agentTools.test.ts` 新建/更新直接生效 | 通过 |
| 3 | 删除必须用户确认 | `tests/agentExecution.test.ts` 单次删除只生成卡片；`agentPermissionTargets` 删除唯一标题仍需卡片 | 通过 |
| 4 | 模糊目标不得直接写入 | `agentPermissionTargets` 多候选、高相似标题拦截；`conversationSecurity` | 通过 |
| 5 | 多闹钟目标不明确必须询问 | `agentExecution.test.ts` 多闹钟未指定 `alarm_id` 不执行；`alarmSelection` 场景 | 通过 |
| 6 | Stop 后未开始工具不执行 | `agentExecution.test.ts` 中途停止后续工具不执行；`agentProgress` 取消收尾 | 通过 |
| 7 | 重复调用不会重复创建 | `agentTools.test.ts` 同 `tool_call_id`、同参数去重；`agentExecution` 重复调用跳过 | 通过 |
| 8 | 未知写入状态不会自动重试 | `failureRecovery.test.ts` 写入异常标记 `execution_unknown`；`executionHistory` 失败建议不提供重放 | 通过 |
| 9 | 重启不会自动重放未完成写操作 | `executionHistory.test.ts` 重启恢复：写入转 `execution_unknown`，只读转 `cancelled`；`agentContinuation` 重启残留不续办 | 通过 |
| 10 | 历史记录不能成为写入授权 | `conversationSecurity.test.ts` 历史 ID、历史查询结果均不授权；`agentContinuation` | 通过 |
| 11 | 删除确认历史回写必须校验关联 ID | `deleteConfirmationHistory.test.ts` 要求 `executionId + stepId + proposalId + targetId`，缺失或不一致不回写 | 通过 |
| 12 | 旧删除卡片和旧闹钟授权重启后失效 | 删除卡片不持久化；`alarmSelections` 使用进程内 `Map`，重启清空；集成测试 65 旧卡片失效 | 通过 |

本轮未修改 Agent Loop、安全规则或执行层架构。

### 6.2 真实模型验收

使用当前激活配置执行 Phase 4.5.2 A–L：

```text
配置：推理-Doubao-Seed-Evolving
配置 ID：p1793850069851
模型：VOLCENGINE_ENDPOINT_ID
端点：ark.cn-beijing.volces.com
鉴权：已配置（未打印）
选择方式：当前激活配置
请求间隔：20000ms

[0] Tool Calling 兼容性探测
# pass 13
# fail 0
# model requests 28
```

覆盖场景：

| 场景 | 内容 | 结果 |
| --- | --- | --- |
| A | 普通查询不产生写操作 | PASS |
| B | 创建便签，真实写入并回读一致 | PASS |
| C | 查询后修改，使用真实目标 ID | PASS |
| D | 删除请求只生成确认卡片，确认前不删除 | PASS |
| E | 用户取消删除后，历史更新为 cancelled | PASS |
| F | 用户确认删除后，便签进入废纸篓 | PASS |
| G | 删除业务失败后，历史显示真实失败 | PASS |
| H | 重复确认不产生重复删除或重复历史步骤 | PASS |
| I | 历史记录被删除后，业务删除仍安全 | PASS |
| J | 历史 ID 不构成新的写授权 | PASS |
| K | 未知写入状态不自动重放 | PASS |
| L | 用户停止后，未开始工具不执行 | PASS |

证据：[test-real.log](../../.tmp-release/logs/v090/test-real.log)

本轮未遇到供应商限流。真实模型调用使用测试运行时和内存仓储，未连接或修改用户正式数据库。

---

## 7. 人工验收清单及结果

### 7.1 Task 5 要求项目

| # | 项目 | 结果 | 说明 |
| --- | --- | --- | --- |
| 1 | 全新安装 | **未执行** | 无隔离环境，正式应用运行中 |
| 2 | 启动应用 | **未执行（0.9.0）** | 同上 |
| 3 | 便签创建/修改/删除 | **未执行（0.9.0）** | 历史等价构建结果不计入 |
| 4 | 待办创建/修改/删除 | **未执行（0.9.0）** | 同上 |
| 5 | 提醒创建/修改 | **未执行（0.9.0）** | 同上 |
| 6 | 提醒触发和系统通知 | **未执行** | 需人工设置 1 分钟提醒 |
| 7 | 托盘菜单和退出行为 | **未执行（0.9.0）** | 仅此前观察到关闭窗口后进程存活 |
| 8 | Light / Dark / System 主题 | **未执行（0.9.0）** | 主题代码本轮未改 |
| 9 | 窗口拖拽和边缘吸附 | **未执行** | 需真实鼠标操作 |
| 10 | 覆盖升级 | **未执行** | 正式包未安装 |
| 11 | 升级前后数据保留 | **未执行** | 同上 |
| 12 | 卸载保留数据和重新安装 | **未执行** | 同上 |

### 7.2 补充项目

| 项目 | 结果 |
| --- | --- |
| 多显示器 DPI | **未执行** |
| 开机自启 | **未执行** |
| 全局快捷键 | **未执行** |
| 代码签名校验 | 已检查：未签名 |
| 正式包 SHA-256 校验 | 已执行 |

以上人工项目不能用普通构建验证替代。需要人工签收后，才能把对应项标记为 PASS。

---

## 8. 发布风险清单

| 风险 | 当前状态 | 实际影响 | 是否阻断 | 建议 |
| --- | --- | --- | --- | --- |
| 安装包未签名 | `NotSigned` | SmartScreen 未知发布者，企业终端可能拦截 | 内部验收不阻断；公开分发建议阻断 | 正式分发前签名，或明确接受 |
| CSP 为 `null` | 未启用 | 缺少内容安全策略防线 | 不阻断本轮 | 接受并延期到 V1.0 安全加固 |
| 内置模型密钥进入产物 | 已确认存在于 JS 和 exe | 可从安装包提取 | 不阻断 | 接受；后续评估配额与代理 |
| `pnpm audit` 不可用 | 镜像端点不存在 | 无依赖漏洞报告 | 不阻断 | 延期到可用审计环境 |
| WebView2 依赖 | `downloadBootstrapper` | 离线或精简系统首次安装需联网 | 不阻断 | 离线分发附带 Runtime |
| 卸载数据行为 | 交互式可删、静默保留 | 误勾选会删除本地数据 | 不阻断 | 安装指南提示 |
| chunk 体积警告 | 最大 1,046 kB | 首次加载偏大 | 不阻断 | 延期性能优化 |
| 迁移失败 fail-fast | 退出 101，数据保留 | 需人工恢复 | 不阻断 | 保留为已知问题 |
| 发布源未提交 | 工作区不干净 | 制品不可追溯 | **阻断正式发布** | 完成发布提交并重建 |
| 正式包未安装验证 | 未执行 | 安装/升级证据缺失 | **阻断正式发布** | 隔离环境补验 |
| 原生交互未人工验收 | 未执行 | 托盘、通知、吸附等未签收 | **阻断正式发布** | 人工验收 |

---

## 9. 安装包 SHA-256

```text
MEMORA_0.9.0_x64-setup.exe
SHA-256: C15F82619A52FA21B3C0D422E3C5724BB55FF37CA9EB4789DE213D167599D39E
```

PowerShell 校验：

```powershell
Get-FileHash .\MEMORA_0.9.0_x64-setup.exe -Algorithm SHA256
```

这是候选构建的哈希。完成发布提交并重建后必须重新记录，不得沿用。

---

## 10. 发布文档变更清单

本轮更新：

- `docs/reports/MEMORA-V0.9-RELEASE-AUDIT.md`
- `docs/reports/MEMORA-V0.9-RELEASE-FINAL-REPORT.md`
- `docs/releases/MEMORA-V0.9-RELEASE-NOTES.md`
- `docs/releases/MEMORA-V0.9-INSTALLATION-GUIDE.md`
- `docs/releases/MEMORA-V0.9-UPGRADE-GUIDE.md`
- `docs/releases/MEMORA-V0.9-KNOWN-ISSUES.md`
- `docs/reports/MEMORA-V0.9-RELEASE-SOURCE-STATUS.md`（新增）

本轮修改的配置/构建文件：

- `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`：版本统一为 `0.9.0`；
- `.oxlintrc.json`：增加临时目录和构建产物忽略规则；
- `.gitignore`：忽略本地验证与临时安装目录。

未修改应用业务源码、Agent 执行架构、安全规则、SQLite schema、迁移和主题系统。

---

## 11. 最终判定

### CONDITIONAL PASS

**PASS 部分：**

- 版本已在所有正式位置统一为 `0.9.0`；
- 正式 identifier 为 `com.bianqian.desktop`，产品名 `MEMORA`；
- 离线安装、单元测试、集成测试、lint、TypeScript、Vite、Cargo、NSIS 构建全部通过；
- 真实模型 A–L 13/13 通过；
- 12 项 Agent 安全规则复核通过；
- 安装包已构建并记录大小、版本元数据和 SHA-256；
- 发布文档已与实际版本、identifier 和制品哈希对齐。

**阻断正式发布的 P1 条件：**

1. 发布源未提交，当前制品为候选构建，不是从发布提交复现；
2. 正式 identifier 安装包未执行全新安装、覆盖升级、数据保留、卸载和重装验证；
3. 托盘、系统通知、边缘吸附、开机自启、全局快捷键、多显示器 DPI 未人工验收。

**已接受或延期的非阻断风险：**

- 代码签名、CSP、内置密钥、`pnpm audit`、WebView2 离线依赖、chunk 体积、迁移失败恢复。

在上述 P1 条件完成前，不应对外发布安装包或宣称正式稳定版。

---

## 12. 停止声明

按任务书要求，本报告完成后停止：

- 未自动提交 Git；
- 未创建标签或推送；
- 未发布安装包；
- 未修改用户当前 AI 配置；
- 未清理用户真实数据；
- 未对用户实际安装执行覆盖或卸载。

等待用户审核最终报告并明确授权后，再执行发布提交、正式包安装验收或对外发布。