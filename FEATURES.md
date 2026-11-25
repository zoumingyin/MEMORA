# MEMORA V1.0.0 功能文档

> 本文档基于当前仓库的**实际源码与配置**生成，力求准确反映现有实现，不臆测未出现的功能。
> 凡无法从代码直接确认、或 README 与代码存在分歧的内容，均在文末「七、待确认与差异说明」中显式列出。
> 生成日期：2026-11-20

---

## 一、项目概述

| 项目 | 内容 |
| --- | --- |
| 产品名称 | MEMORA（工程内仍沿用目录名 `bianqian` / 标题「便签」） |
| 版本号 | **1.0.0**（来源 `src-tauri/tauri.conf.json` 的 `version`，Tag `v1.0.0`） |
| 应用标识符 | `com.bianqian.desktop` |
| 产品形态 | Windows 桌面常驻便签小工具，本地优先（local-first）存储 |
| 技术栈 | Tauri 2 + React 19 + TypeScript + Vite 8 + Zustand 5 + SQLite（`tauri-plugin-sql`）+ Ant Design 6 + UnoCSS |
| 目标平台 | Windows 10 / 11（打包目标 NSIS，`x86_64-pc-windows-msvc`）；Linux/macOS 未实测 |
| 数据库位置 | `%APPDATA%\com.bianqian.desktop\bianqian.db`（Schema 版本 **10**） |
| 主窗口 | 透明、无边框、置顶、跳过任务栏，默认 422×540，可缩放 |

MEMORA 是一个常驻桌面的轻量记录与提醒工具。它把**备忘（note）、提醒（reminder）、待办（todo）、涂鸦（draw）**四类条目统一存放在本地 SQLite 中，提供主从编辑、全文搜索、多窗口便签、多闹钟提醒调度，以及基于 function calling 的 AI 助手（可自动读写便签、解析一条内容生成多个共享便签的闹钟）。数据默认不出本机；AI 能力为可选，且受上下文隐私开关约束。

---

## 二、核心功能清单

### 2.1 条目管理（四类条目）

- **统一数据模型**：四类条目共享 `id / kind / title / content / createdAt / updatedAt / version / syncStatus / tags / color / paper / deletedAt` 字段，按 `kind` 区分为 `note | reminder | todo | draw`。
- **主从布局**：窗口 ≥620px 时左侧列表 + 右侧详情双栏；<620px 切单栏，点击条目进详情并可返回。断点常量 `NARROW_BREAKPOINT = 620`（`src/hooks/useViewport.ts`）。
- **备忘（note）**：Markdown 编辑器（标题/加粗/斜体/删除线/列表/引用/代码块/链接/图片工具栏，编辑/分屏/预览三视图），底部实时字数统计（中文字符 + 英文单词）；预览经 `marked` 解析、`DOMPurify` 消毒。
- **待办（todo）**：内含多个可独立勾选的子任务（`TodoItem`），全部勾选后整条自动完成并记 `completedAt`；已完成条目归入「已完成」分组。
- **提醒（reminder）**：内含多个闹钟（`AlarmItem[]`），每个闹钟独立设置时间、模式、提醒方式、名称；列表行显示摘要，双击行弹窗编辑。
- **涂鸦（draw）**：手写画板，`content` 存 PNG data URL。
- **编辑与保存**：详情编辑防抖 400ms 自动保存，切换条目/卸载时兜底落盘；乐观并发用 `version` 字段（`UPDATE ... WHERE version = ?`）。
- **标签体系**：详情标题下标签行，回车/失焦添加，SQLite `tags` 列存 JSON 数组；支持标签筛选与计数。
- **纸张样式**：8 种底色（`plain/yellow/mint/blue/lavender/cream/pink/peach`）+ 4 种纹理（`plain/ruled/grid/dots`）。
- **软删除**：删除移入废纸篓（`deletedAt` 时间戳），可恢复；正常列表不展示已删除项。

### 2.2 提醒与多闹钟

- **多闹钟共享便签**：一条提醒可含多个闹钟，共享标题与正文，时间/重复规则/提醒方式/名称各自独立。
- **闹钟模式（8 种）**：`once` 单次、`loop` 循环（支持「X 时 Y 分」复合间隔，存 `intervalMs`）、`daily` 每天、`weekly` 每周、`monthly` 每月、`yearly` 每年阳历、`lunar` 每年农历、`workday` 工作日（代码注释标注为旧数据兼容）。农历换算由 `lunar-javascript` 提供；月/年日期溢出自动收敛到当月/当年最后一天。
- **提醒方式（3 种）**：`dialog` 弹窗、`notification` 系统通知、`sound` 弹窗+提示音。
- **闹钟名称**：每个闹钟可选名称（≤40 字），在详情列表、AI 候选卡片、条目卡片、墙卡片/小窗卡片中展示，用于区分多个闹钟。
- **触达调度**：Web Worker 500ms 心跳为主、页面 `setInterval` 1s 兜底；扫描锁避免并发；触达失败 60 秒冷却（`FAILURE_COOLDOWN_MS = 60_000`），失败不标记已通知、保留重试。
- **独立弹窗**：`dialog`/`sound` 走独立置顶弹窗窗口（label `reminder-<条目id>-<闹钟id>`），`sound` 在弹窗内播放提示音；同一到期时刻最多一个置顶弹窗。`notification` 走系统通知，成功后直接确认闹钟。
- **重复推进**：一次性闹钟确认后不再提醒；重复闹钟按规则推进到下一次触发时间。

### 2.3 搜索、快速记录与快捷入口

- **全局搜索（列表区）**：按标题 + 正文全文实时过滤，大小写不敏感，一键清空；支持时间范围（今天/近 7 天/近 30 天）、排序（最近编辑/创建时间）、标签筛选。
- **快速记录**：标题栏闪电按钮或 `Ctrl+Shift+N` 唤起，自动读取剪贴板文本预填，可选创建备忘/提醒/待办，`Ctrl+Enter` 提交。
- **全局快捷搜索（Spotlight）**：`Ctrl+Shift+F` 唤起顶部居中搜索小窗（预热隐藏的独立轻量窗口 `spotlight.html`），输入即搜标题/正文/标签，↑↓ 选择、Enter 打开、Esc 关闭，再按快捷键切换显示/隐藏；数据由主窗口以事件快照下发，搜索窗自身不读写存储。
- **日历视图**：分类下拉中的「日历」视图，月历网格按分类打点，点击日期列出当天条目。

### 2.4 多窗口能力

- **静态窗口**（`tauri.conf.json`）：`main` 主窗口、`splash` 启动图。
- **运行时窗口**：`spotlight` 搜索、`note` 独立便签小窗、`alarm` 提醒弹窗、`ctxmenu` 右键菜单、`imagePreview` 图片预览，各由独立 Vite 入口承载。
- **独立便签小窗**：把便签拖出为 320×380 可调的置顶小窗，展示态与墙卡片一致（共用 `EntryCardBody`），点击进编辑态复用 `DetailPane`，存盘经 `DetailEditGateway` 回传主窗口统一落盘；与主窗口双向同步，打开状态持久化，重启自动重开。

### 2.5 窗口与系统集成（Windows）

- **置顶 / 透明度 / 边缘吸附 / 收纳窄条**：透明度滑条 25%–100%（背景半透明、文字保持不透明，≤55% 自动切暗色玻璃）；左/右/上边缘 16px 内吸附；收纳成 10px 边缘窄条，移入展开、移出收回；无边框圆角 + `data-tauri-drag-region="deep"` 拖拽。
- **系统托盘**：右键菜单「显示/隐藏主窗口、新建便签、AI 助手、开机自启动、退出」；左键单击切换显示/隐藏、双击显示并聚焦。
- **开机自启动**：`tauri-plugin-autostart`（Windows 注册表启动项）。
- **单实例**：`tauri-plugin-single-instance`，二次启动聚焦已有窗口。
- **关闭确认**：关闭走 Rust 拦截，提供「最小化到后台 / 退出应用」选择并持久化（`bianqian.closeBehavior.v1`），设置页可随时改回。
- **异常恢复**：窗口位置/尺寸（`bianqian.window.bounds.v1`）、筛选与选中态（`bianqian.ui.v1`）持久化，重启恢复。
- **番茄钟**：圆环进度 + mm:ss 倒计时，专注/休息轮换与轮次计数，关闭弹窗后台继续走，设置持久化（`bianqian.pomodoro.v1`）。

### 2.6 AI 助手

- **对话**：标题栏 ✨ 打开覆盖式面板，Markdown 回答、流式输出、停止/重试/清空，历史持久化（`bianqian.assistant.v1`，最多 40 条）。
- **上下文**：附带统计 + 最近 15 条条目摘要（约 6000 字上限）+ 正在查看条目；可在「上下文与隐私」关闭，关闭时不下发任何工具（隐私不变量）。
- **Agent function calling（loop 在前端）**：模型可调用 `search_notes / list_todos / list_reminders / get_note / create_entry / update_entry / delete_entry`；检索与写入（create/update）自动执行，删除生成确认卡；最多 8 轮循环，每轮可并行多调用。写目标需显式授权（用户指定 id/唯一标题等），同名歧义拦截，幂等签名防重复；对可疑删除有重试保护。
- **AI 多闹钟生成**：一次 `create_entry` 传入 `alarms` 数组即可生成多个闹钟共享同一条提醒便签；若模型拆成多次单闹钟调用，执行层 `reminderMergeTargetId` + `appendReminderAlarm()` 兜底合并到同一条便签；写入后回读校验数量/时间/模式/名称，防遗漏。单个闹钟可带 `name`。
- **日/周总结**：30 秒心跳检查，按设置在到点时把窗口内条目交给模型生成 Markdown 总结，以「AI 总结」标签保存为新 note；同一角度当天/当周只生成一次，失败冷却 10 分钟，手动「立即生成」仍受隐私开关约束。
- **多模型与免费网关**：多配置卡片管理；内置免费网关 OpenCode Zen（需 Key）、Kilo AI、LLM7.io、Pollinations，模型清单运行时拉 `GET /models`（缓存 6 小时），按类型标签置灰非文本模型；自己的配置排在免费模型前，免费模型不自动选中。
- **运行环境**：桌面版由 Rust 代理请求并保管密钥；浏览器预览前端直连 OpenAI 兼容接口，配置/密钥存 localStorage（CORS 受限时改用桌面版）。

### 2.7 数据管理与数据库安全

- **导入导出**：全部条目导出为 JSON（含版本号/导出时间）；导入按 id 去重合并，不覆盖现有数据。
- **备份/恢复**：桌面版经 Rust `backup_db`/`restore_db` 复制或覆盖 SQLite 文件（恢复后需重启生效）；浏览器预览用导出/导入。
- **数据库安全闸门（`db_safety.rs`）**：启动时只读检查（`PRAGMA quick_check/integrity_check`、entries 表、schema 版本、version 列），迁移前 `VACUUM INTO` 备份，每日自动备份（保留 7 份），恢复前快照，恢复文件限于 `.db` 且 ≤2GB 并校验 SHA256，失败进入只读保护/故障页。

---

## 三、模块职责

| 目录 / 文件 | 职责 |
| --- | --- |
| `src/types/entry.ts` | 核心领域模型与 SQLite 行结构：`EntryKind`、`Entry`、`AlarmInput`、`AlarmItem`、`NewEntryInput`、`EntryRow` 等 |
| `src/types/ai.ts` | AI 共享类型：`AlarmSelectionCandidate`、流式事件、对话消息等 |
| `src/repository/` | `repository.ts`（`EntryRepository` 抽象 + 行映射 + `buildAlarmsFromInput`）、`sqliteRepository.ts`（SQLite 正式实现）、`memoryRepository.ts`（浏览器 localStorage 兜底）、`index.ts`（运行时探测工厂） |
| `src/store/` | Zustand：`useEntryStore`（条目增删改/勾选）、`useWindowStore`、`useUiStore`（跨组件界面态）、`useAssistantStore`（AI 对话/agent loop）、`useAiProfileStore`、`useThemeStore` |
| `src/reminder/` | `scheduler.ts`（到期扫描与触达）、`nextAlarm.ts`（重复规则下次时间）、`tickWorker.ts`（500ms 心跳 Worker） |
| `src/services/` | AI 与 Agent：`aiClient.ts`、`agentToolExecutor.ts`、`agentToolArgs.ts`、`agentToolSchema.ts`、`assistantContext.ts`、`conversationMemory.ts`、`agentTargets.ts`、`alarmSelectionExecution.ts`；日/周总结 `dailySummary.ts`；免费模型 `freeModels.ts`；联网搜索 `webSearch.ts`；标签/删除提案等 |
| `src/window/` | `tauriWindow.ts`（置顶/边界/移动订阅/最小化/关闭）、`edgeDock.ts`（吸附与窄条）、`spotlightWindow.ts`、`ctxMenuWindow.ts`、`splash.ts`、`maximize.ts` |
| `src/theme/` | `ThemeProvider.tsx`、`memora-theme.ts`、`antdTheme.ts`、`themeBridge.ts`：亮/暗令牌与 antd 主题 |
| `src/hooks/` | `useNow.ts`（按间隔刷新的时间戳）、`useViewport.ts`、`usePomodoro.ts` |
| `src/utils/` | `format.ts`、`markdown.ts`（DOMPurify 消毒）、`paper.ts`、`exportEntryImage.ts`、`clipboard.ts`、`pomodoro.ts` 等工具 |
| `src/components/` | 界面组件：`EntryList.tsx`、`DetailPane.tsx`、`AssistantPanel.tsx`、`AlarmEditorDialog.tsx`、`CalendarPane.tsx`、`SpotlightSearch.tsx`、`DoodleBoard.tsx`、`MarkdownEditor.tsx`、`TitleBar.tsx`、`DockBar.tsx` 等 |
| 多页入口 | `main.tsx`（`?reminder=1` 渲染弹窗否则主界面）、`spotlightMain.tsx`、`noteMain.tsx`、`alarmMain.tsx`、`ctxmenuMain.tsx`、`imagePreviewMain.tsx`、`splashMain.ts` |
| `src-tauri/src/lib.rs` | Tauri 命令注册、数据库迁移（v1–v10）、插件注册、托盘、单实例与全局快捷键 |
| `src-tauri/src/db_safety.rs` | 数据库启动闸门、备份/恢复、完整性检查与只读保护 |
| `src-tauri/src/ai.rs` | AI 代理：模型配置、SSE 流式、Channel 推送、取消、密钥管理 |
| `src-tauri/tauri.conf.json` | 窗口、构建、NSIS 打包配置 |

---

## 四、主要业务流程

### 4.1 应用启动

1. Rust `setup`：加载 SQLite 插件 → 数据库安全闸门（只读检查 + 迁移前备份）→ 执行 v1–v10 迁移 → 注册命令/插件/托盘/快捷键。
2. 前端 `App.tsx`：加载条目 → 恢复窗口设置与 UI 状态 → 启动提醒调度 → 根据 `docked` 决定渲染窄条或主界面。
3. 仓库工厂 `getRepository()` 探测 `window.__TAURI_INTERNALS__`：Tauri 内用 SQLite，浏览器预览用 localStorage。

### 4.2 条目新建 / 编辑 / 删除

- **新建**：列表「+」→ 选类型 → 创建条目并自动选中进详情；`NewEntryInput` 经仓储 `create()` 落库。
- **编辑**：详情防抖 400ms 调 `updateEntry` → 仓储按 `kind` 写列并校验 `version` → 合并本地态、刷新 `updatedAt`。
- **删除**：移入废纸篓（`deletedAt`），可从废纸篓恢复；AI 触发的删除需用户在红色确认卡上点击确认。

### 4.3 AI 生成多闹钟（一条便签多个闹钟）

1. 工具 schema 中 `create_entry` 接受 `alarms: AlarmInput[]`（每个含 `name/remindAt/mode/method/interval/...`），`remindAt` 与 `alarms` 互斥。
2. 参数校验 `validateAlarms()`：最多 12 个闹钟、名称 ≤40 字、模式/方式/单位白名单。
3. 执行层 `createEntry()`：一次调用创建共享便签的多个闹钟；回读校验通过后返回小结。
4. 兜底：若模型发出多次单闹钟 `create_entry`，`reminderMergeTargetId` 记录首条提醒，`appendReminderAlarm()` 把后续闹钟追加到同一条便签，避免重复建便签。
5. 持久化：仓储 `buildAlarmsFromInput()` 生成 `AlarmItem[]` 写入 `entries.alarms` JSON；条目级 `remindAt` 取最早未通知闹钟时间。

### 4.4 提醒触达

1. Worker/页面定时器触发 `onTick` → 扫描未通知、未处理且已到点的闹钟（带扫描锁与失败冷却）。
2. `notification`：发系统通知，成功即 `markNotified`。
3. `dialog`/`sound`：创建独立弹窗窗口；`sound` 在弹窗内播放提示音。
4. 用户确认 → 写库 `markAlarmNotified` → `emit('reminder:confirmed')` → 主窗口同步状态，重复模式推进下一次时间。

### 4.5 数据库备份 / 恢复

- 每日自动备份（`VACUUM INTO` 一致性快照，保留 7 份）；迁移前额外备份。
- 手动备份经 `backup_db` 复制数据库文件；恢复经 `restore_db`，校验扩展名/大小/SHA256，恢复前快照、失败回退。

---

## 五、输入输出说明

### 5.1 核心数据类型（`src/types/entry.ts`）

| 类型 | 关键字段 |
| --- | --- |
| `NewEntryInput` | `title`、`content`、`remindAt?`、`alarmName?`、`alarms?: AlarmInput[]`、`items?`、`tags?` |
| `AlarmInput` | `name?`、`remindAt`、`mode?`、`method?`、`interval?`、`intervalUnit?`、`intervalMs?` |
| `AlarmItem` | `id`、`name?`、`remindAt`、`mode`、`method`、`notified`、`interval?`、`intervalUnit?`、`intervalMs?`、`lastAttemptAt?`、`lastDeliveryStatus?`、`lastDeliveryError?`、`occurrenceKey?`、`presentationCount?` |
| `ReminderEntry` | 继承 `BaseEntry` + `remindAt`、`notified`、`done`、`alarms: AlarmItem[]` |
| `EntryRow` | SQLite snake_case 行：`id, kind, title, content, remind_at, done, completed_at, notified, created_at, updated_at, version, sync_status, items, alarms, tags, color, paper, deleted_at` |

### 5.2 AI 工具输入 / 输出（摘要）

| 工具 | 输入要点 | 行为 / 输出 |
| --- | --- | --- |
| `search_notes` / `list_todos` / `list_reminders` / `get_note` | 关键词 / id | 返回条目摘要或全文（自动执行） |
| `create_entry` | `kind`、`title`、`content`、`alarms[]` 或 `remindAt`、`items[]` | 自动写入；多闹钟回读校验并返回小结（名称/时间/模式） |
| `update_entry` | 目标 id + 变更字段（含 `remindAt`） | 自动写入；改提醒时间时**保留**目标闹钟的重复规则 |
| `delete_entry` | 目标 id | 生成红色确认卡，用户确认后移入废纸篓 |

### 5.3 用户可见输入 / 输出

- 输入：标题/正文（Markdown）、待办子任务、闹钟时间/模式/方式/名称、标签、纸张样式、透明度、模型配置、导入 JSON。
- 输出：主从列表与详情、条目卡片/墙卡片（含闹钟名称）、提醒弹窗/系统通知、AI 回答与确认卡、导出的 JSON、数据库备份文件。

---

## 六、关键配置与依赖关系

### 6.1 构建与运行配置

| 文件 | 要点 |
| --- | --- |
| `package.json` | 脚本：`dev`（Vite 1420）、`build`（`tsc -b && vite build`）、`lint`（oxlint）、`test:agent`、`test:integration`、`tauri:dev`、`tauri:build` |
| `vite.config.ts` | 多页入口（index/alarm/ctxmenu/imagePreview/note/splash/spotlight）；固定端口 1420、strictPort；编译期注入 `__BUILTIN_OPENCODE_KEY__`（读 `src-tauri/keys/opencode.key`，缺失置空） |
| `src-tauri/tauri.conf.json` | `productName: MEMORA`、`version: 1.0.0`、`identifier: com.bianqian.desktop`、`frontendDist: ../dist`、静态窗口 main/splash、bundle 目标 nsis |
| `src-tauri/Cargo.toml` | tauri 2、tauri-plugin-sql/notification/autostart/single-instance/global-shortcut/clipboard-manager/dialog/opener、`sqlx`（sqlite, runtime-tokio）、`chrono`、`sha2`、`reqwest`、`lunar-javascript`（前端）等 |
| `src-tauri/capabilities/` | `default.json`（主窗口 core/sql/notification 权限，`sql:allow-execute`、窗口操作、创建 webview window）、`reminder-dialog.json`（`reminder-*` glob，仅关闭窗口与 SQL 读写） |
| `tsconfig` | `tsconfig.json`（`files: []` + references）、`tsconfig.app.json`、`tsconfig.node.json` |

### 6.2 存储键与配置文件

- SQLite：`%APPDATA%\com.bianqian.desktop\bianqian.db`
- AI 配置：`%APPDATA%\com.bianqian.desktop\ai-config.json`；免费模型缓存 `ai-free-models.json`
- localStorage：`bianqian.window.v1`、`bianqian.window.bounds.v1`、`bianqian.ui.v1`、`bianqian.closeBehavior.v1`、`bianqian.pomodoro.v1`、`bianqian.assistant.v1`、`bianqian.aiSummary.v1`、`bianqian.aiSummary.lastRun.v1`、`bianqian.assistant.ai.v2`（浏览器 AI 配置）、`bianqian.assistant.ai.free.v3`（免费模型缓存）、`bianqian.entries.v1`（预览数据）

### 6.3 环境变量

- `BIANQIAN_AI_API_KEY` / `BIANQIAN_AI_BASE_URL` / `BIANQIAN_AI_MODEL` / `BIANQIAN_AI_TEMPERATURE` / `BIANQIAN_AI_MAX_TOKENS`：AI 接入覆盖。
- `BIANQIAN_OPENCODE_API_KEY`：OpenCode Zen 免费模型密钥（也可用编译期内置 `src-tauri/keys/opencode.key`）。

### 6.4 测试体系

- Agent 单测：`scripts/run-agent-tests.mjs`（编译到 `.test-build`，当前 352/352 通过）；多闹钟回归测试在 `tests/multiAlarmCreation.test.ts`。
- Mock SSE 集成测试：`scripts/run-integration-tests.mjs`（当前环境有 10 项失败，经干净 HEAD 基线对比确认为历史遗留，非多闹钟改动引入）。
- Rust：`cargo test --lib`（27/27）、`cargo check`。

---

## 七、适用场景及限制

### 7.1 适用场景

- 个人在 Windows 桌面上快速记录备忘、管理待办、设置一次性或周期性提醒。
- 需要本地优先、数据不出本机的小工具；AI 能力按需开启。
- 借助 AI 自然语言批量创建便签与多个闹钟（如「明天 8 点吃药、下午 6 点复诊、每周一 9 点开会」共享同一条提醒）。

### 7.2 限制与边界

- **平台**：仅 Windows 实测；Linux/macOS 的窗口/置顶/窄条未验证。
- **同步**：`syncStatus` 字段与仓储抽象为多设备同步预留，V1 无远程同步后端。
- **闹钟模式**：`workday` 仅跳过周末，不处理法定节假日；农历换算依赖 `lunar-javascript`。
- **触达语义**：崩溃恢复下 `presentationCount` 仅作观测，不承诺 exactly-once。
- **提醒调度与 README 不一致**：README 写「30 秒轮询」，实际为 Worker 500ms + 页面 1s 兜底（以代码为准，见 7.3）。
- **免费模型**：依赖联网拉 `/models`，离线回退兜底名但对话会报网络错误；第三方网关可能记录提示词，请勿发送敏感内容。
- **内置密钥**：编进 exe 的 OpenCode 密钥可被从二进制提取，仅适合个人自用。

### 7.3 待确认与差异说明（无法从代码单点确认 / README 与代码分歧）

1. **README 头部版本**：README 首段仍写「V0.1」，但 `tauri.conf.json` 为 `1.0.0` 且已有 `v1.0.0` Tag——实际发布版本以配置为 1.0.0。
2. **提醒轮询间隔**：README「30 秒轮询」为旧描述；代码为 Worker 500ms + 页面 1s 兜底，失败冷却 60s。
3. **update_entry 改提醒时间**：README 称「整体替换为单次提醒」；当前代码（`agentToolExecutor.ts` 第 1072–1107 行）改为**保留重复规则**，README 描述已过时。
4. **V1.0 验收 30 项 AC**：既有验收记录为 16 PASS / 0 FAIL / 3 BLOCKED / 11 NOT RUN，未达「30 项全 PASS」（发布经用户显式授权继续）。
5. **远程发布**：仓库当前无 remote，仅完成本地 commit `96ba5fb` 与本地 annotated tag `v1.0.0`；未推送远程、未创建 Release，安装包 SHA256 需以实际产物为准。
6. **未提交的工作区改动**：快捷键说明、多闹钟功能、红框布局调整、卡片闹钟名称显示等改动已在工作区，用户尚未要求提交。
7. **安装包**：NSIS 安装包需 `pnpm tauri:build` 生成，本仓库未附带成品；README「未覆盖范围」等章节中的历史描述以本节说明为准。
