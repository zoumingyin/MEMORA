# MEMORA V0.9 发布审计报告

- 审计日期：2026-11-18
- 目标版本：`0.9.0`
- 目标制品：`MEMORA_0.9.0_x64-setup.exe`
- 分支：`main`
- HEAD：`529a0cf refactor(theme): 统一主题系统为全局 ThemeProvider 并引入 MEMORA 品牌`
- 工作区：存在未提交改动，当前制品为**候选构建**
- 审计结论：**CONDITIONAL PASS**；无 P0 缺陷，存在 2 项 P1 发布条件

> 本报告只记录本轮实际执行、读取和观察到的结果。此前阶段的测试与安装结果仅作背景，不计入本轮结论。

---

## 1. 审计环境

| 项目 | 实际值 |
| --- | --- |
| 操作系统 | Windows 10.0.26200 x64 |
| Shell | Git Bash（`bash.exe`） |
| Node.js | `v22.15.1`（实际执行 `node --version`） |
| pnpm | `11.20.0` |
| Rust | `rustc 1.96.0` / `cargo 1.96.0` |
| 工作目录 | 项目根目录 |

会话上下文声明 Node.js 为 v24.22.1，但实际命令返回 v22.15.1。本报告以实际执行结果为准。

---

## 2. 版本统一

### 2.1 变更结果

| 文件 | 修改前 | 修改后 |
| --- | --- | --- |
| `package.json` | `0.2.0` | `0.9.0` |
| `src-tauri/tauri.conf.json` | `0.2.0` | `0.9.0` |
| `src-tauri/Cargo.toml` | `0.2.0` | `0.9.0` |
| `src-tauri/Cargo.lock`（`bianqian` 包） | `0.2.0` | `0.9.0` |
| `pnpm-lock.yaml` | 无根包版本字段 | 无需修改，与清单保持一致 |

### 2.2 检查结果

- 前端、Tauri、Rust crate 和锁文件版本全部为 `0.9.0`；
- 安装包文件名由构建系统生成为 `MEMORA_0.9.0_x64-setup.exe`；
- 安装包 `FileVersion` 与 `ProductVersion` 均为 `0.9.0`；
- 应用内没有独立硬编码的版本展示，未发现遗漏的 `0.2.0` 常量；
- 未修改任何第三方依赖版本。

---

## 3. Git 发布源审计

### 3.1 状态

- HEAD：`529a0cfc3d197a5ba7d83f594b203b06783a2cad`；
- 39 个已跟踪状态条目（含已暂存与未暂存的源码、测试、配置和文档）；
- 36 个未跟踪目录条目，主要是此前 Phase 新增的源码、测试和文档；
- `.tmp-release/`、`.tmp-acceptance/`、`.installer-test/` 本轮已加入 `.gitignore`，不再出现在待提交列表；
- 未执行任何 Git 写操作或破坏性操作。

### 3.2 敏感信息

- 未发现真实 API Key、Token 或私钥进入源码、测试或文档；
- `src-tauri/keys/opencode.key` 仍被忽略，本轮未打印或复制；
- 测试中的 `sk-...` 为脱敏假值。

### 3.3 结论

发布源内容可区分，但尚未形成提交。完整清单、排除项和提交方案见：

- [MEMORA-V0.9-RELEASE-SOURCE-STATUS.md](./MEMORA-V0.9-RELEASE-SOURCE-STATUS.md)

**P1 条件：** 当前安装包不对应可追溯提交，不能作为正式复现制品。

---

## 4. 正式构建配置审计

| 配置 | 实际值 | 评估 |
| --- | --- | --- |
| 产品名 | `MEMORA` | 正式 |
| identifier | `com.bianqian.desktop` | 正式，与用户数据目录一致 |
| 版本 | `0.9.0` | 已统一 |
| 主窗口 | 422×540，透明、无边框、置顶、跳过任务栏 | 符合既有产品行为 |
| 启动窗口 | 560×520，透明、置顶 | 正常 |
| CSP | `null` | 未启用，列为风险 |
| SQL 预加载 | `sqlite:bianqian.db` | 正常 |
| bundle targets | `nsis` | Windows x64 |
| 图标 | `icons/32x32.png`、`128x128.png`、`icon.ico` | 存在 |
| NSIS 安装模式 | 当前用户（`RequestExecutionLevel user`） | 不需要管理员权限 |
| 默认安装目录 | `%LOCALAPPDATA%\MEMORA` | Tauri 默认 |
| 卸载注册键 | `HKCU\...\Uninstall\MEMORA` | 按产品名注册 |
| WebView2 安装模式 | `downloadBootstrapper` | 缺失时需联网下载 |
| 代码签名 | 无，`Get-AuthenticodeSignature` 返回 `NotSigned` | 列为风险 |
| 数据目录 | `%APPDATA%\com.bianqian.desktop\bianqian.db` | 与安装目录分离 |
| 旧数据迁移 | 仅在新库不存在时从 `com.bianqian.app` 复制 | 已存在 |
| 升级兼容 | 迁移 1–9 未变化；NSIS 支持覆盖升级 | 无 schema 变更 |

正式应用标识满足 `com.bianqian.desktop`，未使用 `com.bianqian.releasecheck` 等测试标识。

---

## 5. 构建与静态检查

以下均为 2026-11-18 本轮实际执行结果。

| # | 命令 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | `pnpm install --frozen-lockfile --ignore-scripts --offline` | exit 0，`Already up to date` | [install.log](../../.tmp-release/logs/v090/install.log) |
| 2 | `pnpm test:agent` | 330 pass / 0 fail / 0 skipped，53 suites | [test-agent.log](../../.tmp-release/logs/v090/test-agent.log) |
| 3 | `pnpm test:integration` | 66 pass / 0 fail | [test-integration.log](../../.tmp-release/logs/v090/test-integration.log) |
| 4 | `pnpm lint` | 0 warning / 0 error，154 文件 | [lint.log](../../.tmp-release/logs/v090/lint.log) |
| 5 | `pnpm exec tsc -b --pretty false` | exit 0，无输出 | [tsc.log](../../.tmp-release/logs/v090/tsc.log) |
| 6 | `pnpm build` | 通过，5219 modules，Vite 1.50s | [build.log](../../.tmp-release/logs/v090/build.log) |
| 7 | `cargo check --manifest-path src-tauri/Cargo.toml` | exit 0，18.94s | [cargo-check.log](../../.tmp-release/logs/v090/cargo-check.log) |
| 8 | `pnpm tauri:build` | exit 0，Rust release 2m23s，NSIS 成功 | [tauri-build.log](../../.tmp-release/logs/v090/tauri-build.log) |
| 9 | `MEMORA_SUITE=phase452 MEMORA_MIN_INTERVAL_MS=20000 pnpm test:real` | 13 pass / 0 fail，28 次模型请求 | [test-real.log](../../.tmp-release/logs/v090/test-real.log) |
| 10 | `pnpm audit --json` | **失败**：镜像审计端点不存在 | [pnpm-audit.txt](../../.tmp-release/logs/v090/pnpm-audit.txt) |

### 5.1 Lint 修正说明

首次执行 `pnpm lint` 时，oxlint 扫描了 `.tmp-release/target-acceptance` 下的 Cargo 构建产物并以非 UTF-8 文件报错。源码目录单独检查为 0 warning / 0 error。

处理方式：在 `.oxlintrc.json` 增加 `ignorePatterns`，排除 `.tmp-*`、`.installer-test`、`.test-build`、`dist` 和 `src-tauri/target`。修改后 `pnpm lint` 通过。未关闭任何源码规则。

### 5.2 构建警告

```text
DetailPane-CnijsIL3.js     1,046.13 kB
main-CstVVYQS.js             580.06 kB
ThemeProvider-D6JuJRUS.js    535.24 kB
```

仅有 chunk 体积警告，构建退出码 0。本轮未做分包重构。

---

## 6. 安装与升级验证

### 6.1 已完成的制品级检查

| 项目 | 结果 |
| --- | --- |
| 安装包生成 | `MEMORA_0.9.0_x64-setup.exe` |
| 大小 | 5,375,916 字节 |
| SHA-256 | `C15F82619A52FA21B3C0D422E3C5724BB55FF37CA9EB4789DE213D167599D39E` |
| 文件版本 | `0.9.0` |
| 产品版本 | `0.9.0` |
| 产品名 | `MEMORA` |
| 架构 | x64 |
| 签名 | `NotSigned` |

### 6.2 未执行：正式包安装与覆盖升级

**未执行。** 原因：

- 本机存在用户正在运行的正式应用进程（`src-tauri/target/debug/bianqian.exe`，identifier 为 `com.bianqian.desktop`），并使用真实数据库 `%APPDATA%\com.bianqian.desktop\bianqian.db`（约 2.1 MB）；
- 正式 NSIS 安装包按产品名 `MEMORA` 注册卸载键并创建开始菜单/桌面快捷方式；在同一用户环境安装或卸载会改动用户现有安装（`<用户安装目录>`）的注册信息，并可能与真实数据目录交互；
- 本机没有 Windows Sandbox（未找到 `WindowsSandbox.exe`），无法提供同 identifier 的隔离桌面环境。

因此，本轮没有对正式 0.9.0 安装包执行全新安装、覆盖升级、卸载或重装。此前阶段使用 `com.bianqian.releasecheck` 的等价构建结果只作为参考，不能替代正式标识验收。

---

## 7. 审计发现

| ID | 级别 | 发现 | 影响 | 处置 |
| --- | --- | --- | --- | --- |
| F-01 | 已解决 | 里程碑 V0.9 与制品 0.2.0 不一致 | 命名与升级判断混淆 | 已统一为 0.9.0 并重建 |
| F-02 | P1 | 工作区未提交，未形成发布提交或标签 | 制品不可从 Git 复现 | 按发布源报告完成提交后重建 |
| F-03 | P2 | 安装包未签名 | SmartScreen 提示未知发布者 | 发布说明提示；正式分发前决定签名 |
| F-04 | P2 | CSP 为 `null`，内置密钥进入产物 | 前端安全边界较弱；密钥可被提取 | 既有设计，保留提示 |
| F-05 | P2 | 迁移冲突时应用退出 101，无自动恢复 | 极端状态需人工恢复 | 已知问题；保留数据与备份 |
| F-06 | 已解决 | 本轮真实模型未验证 | 无供应商侧证据 | 已执行 A–L，13/13 通过 |
| F-07 | P1 | 正式 identifier 安装包未安装验证 | 安装/升级证据缺口 | 需在隔离机或用户授权后补做 |
| F-08 | P2 | 原生托盘、通知、边缘拖拽未人工操作 | 自动化不能完全覆盖 | 列入人工验收 |
| F-09 | P3 | chunk 超过 500 kB | 首次加载体积偏大 | 非阻断 |
| F-10 | P3 | `pnpm audit` 不可用 | 无依赖漏洞扫描结果 | npmmirror 端点不存在 |
| F-11 | P3 | 无 ESLint，仅 oxlint | 与外部检查清单名称不一致 | 实际检查通过 |
| F-12 | P3 | `@types/turndown` 位于生产依赖 | 影响很小 | 发布阶段不调整 |
| F-13 | P3 | 交互式卸载可删除应用数据 | 误勾选不可恢复 | 安装指南明确提示 |
| F-14 | 已解决 | lint 误扫临时构建产物 | 导致假失败 | 已增加 ignorePatterns |

**P0 缺陷：无。**

---

## 8. 结论

项目具备构建正式 Windows NSIS 安装包的条件，版本已统一，自动化、集成、静态检查、前端构建、Cargo 检查和真实模型验收全部通过。

发布前仍需解决或明确接受：

1. **发布提交**：完成发布源提交并从该提交重建制品；
2. **正式包安装验收**：在隔离环境安装 `com.bianqian.desktop` 正式包，完成全新安装、覆盖升级、数据保留、卸载与重装；
3. **人工原生验收**：托盘、系统通知、边缘吸附、开机自启、全局快捷键、多显示器 DPI；
4. **分发风险**：代码签名、CSP、内置密钥、WebView2 依赖和依赖漏洞审计。

在上述条件完成前，最终判定保持 **CONDITIONAL PASS**。