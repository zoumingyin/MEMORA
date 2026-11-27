# MEMORA（便签 / bianqian）

|  | |
| --- | --- |
| **当前版本** | v1.1.0（`tauri.conf.json` / `package.json` / `Cargo.toml` 三处同步） |
| **平台** | Windows 10 / 11（NSIS 安装包，`x86_64-pc-windows-msvc`） |
| **形态** | 常驻桌面的轻量记录与提醒工具，透明无边框置顶小窗（默认 422×540，可缩放） |
| **技术栈** | Tauri 2 + React 19 + TypeScript + Vite 8 + Zustand 5 + SQLite（tauri-plugin-sql）+ Ant Design 6 + UnoCSS + FullCalendar |
| **数据** | 本地优先（local-first），SQLite 落盘，数据默认不出本机；AI 上下文受隐私开关约束 |

MEMORA 把**备忘（note）、提醒（reminder）、待办（todo）、涂鸦（draw）**四类条目统一存放在本地 SQLite，提供主从编辑、全文搜索、贴纸墙、月/周/日三视图日历（农历 + 节气）、多闹钟提醒调度、番茄钟，以及基于 function calling 的 AI 助手（可自动读写便签、一次生成多闹钟、定时生成日/周总结）。应用内置**签名验签的在线升级**。

> 更细的模块级功能说明见 [FEATURES.md](FEATURES.md)（基于源码逐模块核对）。

---

## 一、功能特性

### 1. 条目管理

- **四类条目统一模型**：备忘 / 提醒 / 待办 / 涂鸦共享同一数据结构（版本号乐观并发、软删除、标签、纸张样式：8 种底色 × 4 种纹理）。
- **主从布局**：宽 ≥620px 左列表 + 右详情双栏；窄窗口切单栏（点击进详情、可返回）。另有**贴纸墙视图**卡片流。
- **备忘**：TipTap Markdown 编辑器（标题/加粗/列表/引用/代码块/链接/图片工具栏，编辑 / 分屏 / 预览三视图），实时字数统计；预览经 `marked` + `DOMPurify` 消毒；`@` 引用其他便签生成可跳转胶囊。
- **涂鸦**：手写画板（PNG data URL 落盘）；备忘正文可插入涂鸦（新画或**选已有涂鸦**缩略图）。
- **待办**：多条子任务独立勾选，全部完成自动归档并记完成时间。
- **独立便签小窗**：便签可拖出为 320×380 置顶小窗，与主窗口双向实时同步，打开状态持久化、重启自动恢复。
- **标签管理**：逐条添加 + 设置页统一重命名 / 合并 / 删除（自动同步所有条目）。
- **废纸篓**：删除移入废纸篓（`deletedAt`），可恢复。

### 2. 提醒与多闹钟

- **多闹钟共享便签**：一条提醒含多个闹钟，各自独立设置时间 / 模式 / 方式 / 名称。
- **闹钟模式 8 种**：单次 / 循环（「X 时 Y 分」复合间隔）/ 每天 / **工作日**（接入 chinese-days 法定节假日与调休，补班周末照常提醒）/ 每周（可选周几）/ 每月（可选几号，短月落月末、下月恢复）/ 每年阳历 / 每年农历（闰月与三十缺失自动回退）。
- **提醒方式 3 种**：弹窗（独立置顶 Webview 弹窗）/ 系统通知（文案 = ⏰ 标题 +【闹钟名】时间 + 正文摘要）/ 弹窗+声音。
- **调度可靠性**：Web Worker 500ms 心跳（主窗口隐藏 / 收纳窄条不被节流）+ 页面 1s 兜底；扫描锁防并发；触达失败 60s 冷却重试、不静默丢弃；确认走乐观并发，**并发编辑冲突时自动重试，不会重复弹送**。
- **稍后提醒**：弹窗内可把闹钟推到新时间并重置状态。

### 3. 日历（月 / 周 / 日）

- **月视图**：FullCalendar 月网格，日期格显示农历 / 节气 / 节日小字，事件按分类色条展示，提醒事件支持**拖拽改期**（保留原时刻）。
- **周 / 日视图**：议程分组列表（周一为一周起点）。
- 与全局搜索、分类筛选联动；日期上「+」新建（提醒落该日 09:00）；点击条目直进详情；标题栏日历按钮带**今日到期徽标**。

### 4. 窗口与系统集成

- 置顶 / 背景透明度滑条（25%–100%，低透明度呈毛玻璃）/ 左右上边缘吸附 / 收纳成 10px 屏幕边缘窄条。
- **系统托盘**：显示/隐藏主窗口、新建便签、AI 助手、开机自启动、退出；左键单击切换显示。
- **全局快捷键**（Rust `global-shortcut`）：快速记录 / Spotlight 搜索 / 显示隐藏主窗口。
- **单实例**：二次启动聚焦已有窗口；**关闭确认**：最小化到托盘 / 退出可选并记忆。
- **番茄钟**：圆环倒计时、专注/休息轮换、与待办联动完成勾选，收纳窄条态自动补弹。
- **启动体验**：启动页 + 窗口斗篷防白屏，位置尺寸与 UI 状态持久化恢复。

### 5. AI 助手（function calling）

- **对话**：覆盖式面板，Markdown 流式输出、停止 / 重试 / 清空，历史持久化（最多 40 条）。
- **Agent 工具**：`search_notes / list_todos / list_reminders / get_note / create_entry / update_entry / delete_entry`，前端驱动循环（最多 8 轮、每轮可并行多调用）；检索与写入自动执行，**删除必须用户确认**（红色确认卡，移入废纸篓可恢复）。
- **多闹钟生成**：一次 `create_entry` 传 `alarms[]` 生成共享便签的多闹钟（最多 12 个）；模型拆成多次调用时执行层自动合并；写入后回读校验。
- **上下文与隐私**：附带统计 + 最近条目摘要 + 正在查看条目；隐私开关关闭时不下发任何工具；不支持 function calling 的模型自动降级为 `<action>` 确认卡协议。
- **多模型**：多配置卡片管理；内置免费网关（OpenCode Zen / Kilo AI / LLM7.io / Pollinations），运行时拉取 `/models`；桌面版由 Rust 代理请求并保管密钥。
- **日 / 周总结**：定时把窗口内条目交给模型生成 Markdown 总结，以「AI 总结」标签保存为新便签。
- **联网搜索**：AI 可调用 web 搜索工具（`web_search.rs`）。

### 6. 数据管理与安全

- 导出 JSON / 按 id 去重合并导入；数据库手动备份与恢复（SHA256 校验、≤2GB、恢复前快照、失败回退）。
- **每日自动备份**（`VACUUM INTO` 一致性快照，保留 7 份）+ 迁移前备份。
- **数据库安全闸门**（`db_safety.rs`）：启动只读完整性检查，失败进入只读保护。
- SQLite 位于 `%APPDATA%\com.bianqian.desktop\bianqian.db`（schema v10）。

### 7. 在线升级（应用内）

- 设置 → 关于 → **软件更新**：检查更新（10s 超时）→ 新版本说明 → 下载（MB 进度条）→ minisign 验签 → NSIS 静默安装 → 自动重启。
- 双端点按序回退：**Gitee 优先**（国内快，tag=`latest` 滚动发行版）→ GitHub 兜底。
- 详见[第四节「发布与在线升级」](#四发布与在线升级)。

---

## 二、安装与运行

### 1. 环境要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | 22+ | 前端构建 |
| pnpm | 11+ | 包管理器（`packageManager` 已锁定） |
| Rust | 1.9x | target `x86_64-pc-windows-msvc` |
| Visual Studio Build Tools | 含 C++ 桌面开发 | MSVC 链接器与 Windows SDK |
| WebView2 Runtime | Evergreen | Win11 自带；Win10 需单独安装 |

### 2. 初始化

```bash
pnpm install          # 依赖安装（根目录统一 node_modules）
cargo fetch           # Rust 依赖（可选，cargo check/build 会自动拉取）
```

### 3. 开发调试

```bash
pnpm tauri:dev        # 桌面版开发（Vite 1420 端口 + Rust 侧热编译）
pnpm dev              # 仅前端：浏览器打开 http://127.0.0.1:1420 预览
```

- **浏览器预览模式**自动降级：localStorage 仓储替代 SQLite、Web Notification 替代系统通知/弹窗窗口、无全局快捷键与在线升级（设置页相应禁用）。适合快速验证 UI 与交互。
- 应用源码类型检查用 **`npx tsc -p tsconfig.app.json --noEmit`**（根 tsconfig 是 references 结构，裸 `tsc --noEmit` 不检查任何文件）。

### 4. 打包

```bash
pnpm tauri:build      # 产出 NSIS 安装包（release 编译约 5–10 分钟）
```

产物位于 `src-tauri/target/release/bundle/nsis/`。发布与在线升级流程见第四节。

### 5. 测试

```bash
pnpm test:agent        # AI Agent 工具链单测（编译到 .test-build 运行，352 用例）
pnpm test:integration  # Mock SSE 集成测试
cargo test --lib       # Rust 侧单测（27 用例）
npx oxlint             # Lint
```

---

## 三、使用说明

### 1. 界面速览

- **主窗口**：标题栏（品牌、搜索、日历、快速记录、番茄钟、AI 助手、设置）→ 分类 Tab（全部/备忘/提醒/待办/涂鸦）→ 列表；宽屏右侧为详情编辑区。
- **详情区**：标题、标签行、纸张样式、正文编辑器（备忘 Markdown / 待办子任务 / 提醒闹钟列表 / 涂鸦画板），防抖 400ms 自动保存。
- **收纳窄条**：拖到屏幕边缘自动停靠；点「收起」变成 10px 窄条，移入展开。

### 2. 新建与编辑

- 列表右上 **＋** → 选类型（备忘/提醒/待办/涂鸦）→ 自动进入详情。
- **提醒**：详情下方闹钟列表「添加 / 双击行」打开闹钟编辑弹窗——名称（可选）、模式、方式、提醒时间（DatePicker 带农历）、「设为当前时间」。
- 正文里输入 `@` 可引用其他便签（点击胶囊跳转）；涂鸦弹窗可「画新涂鸦」或「选已有涂鸦」。

### 3. 快速入口

- **快速记录**：标题栏闪电按钮或 `Ctrl+Shift+N`——自动读取剪贴板文本预填，选类型后 `Ctrl+Enter` 提交。
- **Spotlight 搜索**：`Ctrl+Shift+F`——顶部居中搜索小窗，输入即搜标题/正文/标签，↑↓ 选择、Enter 打开。
- **系统托盘**：左键切换显示/隐藏；右键菜单含新建便签与 AI 助手。

### 4. 快捷键一览

全局快捷键（任何应用下生效，桌面版）：

| 快捷键 | 说明 |
| --- | --- |
| `Ctrl + Shift + N` | 快速记录（读剪贴板预填） |
| `Ctrl + Shift + F` | Spotlight 全局搜索（再按切换显隐） |
| `Ctrl + Shift + Space` | 显示 / 隐藏主窗口（收纳态下展开） |

应用内快捷键（焦点在对应输入框/面板时）：

| 快捷键 | 场景 | 说明 |
| --- | --- | --- |
| `↑ / ↓`、`Enter` | 标题栏搜索框 | 切换筛选结果、打开详情 |
| `↑ / ↓`、`Enter`、`Esc` | Spotlight 窗 | 切换、打开、关闭 |
| `Ctrl + Enter` | 快速记录 | 提交创建 |
| `Enter` / `Shift + Enter` / `Esc` | AI 对话面板 | 发送 / 换行 / 关闭 |
| `Esc` | 到期提醒弹窗 | 等同「我知道了」 |

> 浏览器预览下全局快捷键不生效（仅 `Ctrl+Shift+N` 有前端 keydown 兜底）。

### 5. 设置项（标题栏齿轮）

外观（主题/透明度）、窗口行为（置顶/吸附/收纳/全局快捷键）、启动与后台（开机自启动/关闭行为）、AI 助手（接入配置/隐私/日周总结）、数据管理（导出/导入/备份/恢复/标签/自动备份）、关于（**软件更新**/友链）。

---

## 四、发布与在线升级

更新包托管双平台：**Gitee（tag=`latest` 滚动发行版，国内快）优先，GitHub Releases 兜底**。两平台上传同一个安装包——签名串通用，仅 latest.json 中的下载 url 不同。

```bash
# 1. 签名构建（私钥在本机 C:/Users/zmy/.tauri/memora-updater.key，丢失则无法再签发更新）
TAURI_SIGNING_PRIVATE_KEY=C:/Users/zmy/.tauri/memora-updater.key pnpm tauri:build

# 2. 生成更新清单（build-release/latest.json + latest-gitee.json，含签名串与 SHA256）
node scripts/release-update.mjs [版本号]

# 3. 上传（脚本会打印完整清单）
#    GitHub：Releases → tag v版本号 → latest.json + *-setup.exe + .sig
#    Gitee ：发行版 tag「latest」→ 替换 latest-gitee.json（改名 latest.json）+ 安装包 + .sig
```

版本号发布前需同步修改三处：`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`（`Cargo.lock` 由 `cargo check` 自动同步）。

⚠️ Gitee 端点读取 tag「latest」发行版的附件——**每次发版必须替换该发行版附件**，否则国内用户会拿到旧版本。

---

## 五、目录结构说明

```
bianqian/
├── package.json                 # 脚本与依赖（根目录统一 node_modules）
├── index.html                   # 主窗口入口（?reminder=1 渲染闹钟弹窗内容）
├── spotlight.html / note.html / alarm.html /
│  ctxmenu.html / imagePreview.html / splash.html   # 独立轻量窗口入口（各自独立打包）
├── src/
│   ├── main.tsx                 # 主窗口 bootstrap（antd 主题令牌）
│   ├── App.tsx                  # 主界面编排：布局分支 / 窗口事件 / 创建流程 / 托盘联动
│   ├── components/              # 界面组件（40+）
│   │   ├── EntryList.tsx        # 列表（搜索/排序/筛选/贴纸墙/缩略图）
│   │   ├── DetailPane.tsx       # 详情编辑区（含便签小窗编辑网关）
│   │   ├── CalendarPane.tsx     # 日历三视图（FullCalendar 月 + 周/日议程）
│   │   ├── AlarmEditorDialog.tsx# 闹钟编辑弹窗（8 模式 + 农历时间选择 + 动态说明）
│   │   ├── AssistantPanel.tsx   # AI 对话面板（流式 / 工具卡 / 确认卡）
│   │   ├── SettingsDialog.tsx   # 设置弹窗（树形分组，含软件更新）
│   │   ├── SpotlightSearch.tsx  # 全局搜索小窗
│   │   ├── NoteWindow.tsx       # 独立便签小窗
│   │   ├── DockBar.tsx          # 收纳窄条
│   │   └── …                    # TitleBar / QuickCapture / MarkdownEditor / DoodleBoard 等
│   ├── editor/                  # TipTap 编辑器扩展（@ 引用胶囊等）
│   ├── reminder/                # 提醒调度：scheduler（心跳/触达）、nextAlarm（8 模式推进）、tickWorker（500ms 心跳）、events（跨窗口事件）
│   ├── services/                # 业务服务（30+）
│   │   ├── agentTools.ts        # AI 工具定义（前端 loop）
│   │   ├── agentToolExecutor.ts # 工具执行器（检索/写入自动执行、删除确认、多闹钟合并）
│   │   ├── aiClient.ts          # 模型调用（Rust 代理 / 浏览器直连、免费网关）
│   │   ├── dailySummary.ts      # AI 日/周总结调度
│   │   ├── updater.ts           # 在线升级（检查/下载进度/安装重启）
│   │   └── …                    # 联网搜索 / 会话记忆 / 执行历史等
│   ├── store/                   # Zustand：entries / ui / window / assistant / aiProfile / theme
│   ├── repository/              # 仓储抽象：SQLite 实现 + localStorage 兜底 + 运行时探测工厂
│   ├── window/                  # Tauri 窗口能力：置顶/边界/吸附窄条/各小窗生命周期/关闭行为
│   ├── theme/                   # 亮暗主题令牌与 antd 主题桥接
│   ├── utils/                   # 格式化 / 农历 / 剪贴板 / Markdown 消毒 / 导出图片等
│   └── hooks/                   # useNow / useViewport / usePomodoro
├── src-tauri/
│   ├── src/lib.rs               # 命令注册、v1–v10 迁移、托盘、单实例、全局快捷键
│   ├── src/ai.rs                # AI 代理：SSE 流式、密钥保管、Channel 推送
│   ├── src/db_safety.rs         # 数据库安全闸门：完整性检查 / 备份恢复 / 只读保护
│   ├── src/web_search.rs        # AI 联网搜索后端
│   ├── tauri.conf.json          # 窗口、打包、updater 端点与公钥
│   ├── capabilities/            # 权限清单（default + reminder-dialog）
│   └── keys/                    # 内置 OpenCode 免费网关密钥（可选）
├── scripts/
│   ├── release-update.mjs       # 生成 latest.json（GitHub + Gitee 双份）
│   └── run-agent-tests.mjs      # Agent 工具链单测运行器
├── tests/                       # Agent / 闹钟 / 仓储并发等单测（21 个文件）
├── docs/                        # 历史设计文档
└── FEATURES.md                  # 模块级功能说明（基于源码核对）
```

---

## 六、数据与配置存储

| 位置 | 内容 |
| --- | --- |
| `%APPDATA%\com.bianqian.desktop\bianqian.db` | 全部条目（SQLite，schema v10） |
| `%APPDATA%\com.bianqian.desktop\ai-config.json` | AI 模型配置与密钥（Rust 保管） |
| `%APPDATA%\com.bianqian.desktop\*.db.bak` | 每日自动备份（保留 7 份） |
| localStorage `bianqian.window.v1` / `.bounds.v1` / `.ui.v1` | 窗口状态与 UI 偏好 |
| localStorage `bianqian.assistant.v1` / `bianqian.pomodoro.v1` 等 | 对话历史、番茄钟、日历视图等 |

环境变量覆盖（可选）：`BIANQIAN_AI_API_KEY` / `BIANQIAN_AI_BASE_URL` / `BIANQIAN_AI_MODEL` / `BIANQIAN_AI_TEMPERATURE` / `BIANQIAN_AI_MAX_TOKENS`。

---

## 七、已知限制

- 仅 Windows 实测；Linux / macOS 未验证（透明度为纯 CSS 实现，理论上可用）。
- 无多设备同步（仓储抽象与 `sync_status` 字段已预留，尚无后端）。
- 触达语义不承诺 exactly-once（崩溃恢复下保证「不静默丢弃、失败可追踪」）。
- 免费模型网关可能记录提示词，勿发送敏感内容；内置密钥可从二进制提取，仅适合个人自用。
- 签名私钥（`C:/Users/zmy/.tauri/memora-updater.key`）丢失后无法再向已安装用户推送更新，请备份。
