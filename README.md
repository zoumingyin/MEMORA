# 便签（bianqian）

Windows 桌面便签小工具 V0.1：备忘、提醒、待办三类条目，窗口可置顶、背景可调半透明（文字保持不透明）、可吸附屏幕边缘并收纳成窄条。本地优先存储，接口已为多设备同步预留。UI 基于 **Ant Design（antd 6）+ UnoCSS**：交互控件全部走 antd（Segmented 分类筛选、Input/Checkbox/Select/Button/Modal/Empty），主题 token 映射毛玻璃浅色体系与分类主题色（备忘蓝/提醒珊瑚红/待办绿），原子类布局由 UnoCSS 生成，样式层保留自研 CSS 变量。

- **技术栈**：Tauri 2 + React 19 + TypeScript + Vite 8 + Zustand 5 + SQLite（tauri-plugin-sql）+ 系统通知（tauri-plugin-notification）
- **目标平台**：Windows 10 / 11 优先；透明度由前端 CSS 背景 alpha 实现，不依赖平台私有 API

---

## 一、环境要求

开发前请先准备好以下工具链：


| 依赖                        | 版本要求             | 说明                                       |
| ------------------------- | ---------------- | ---------------------------------------- |
| Node.js                   | 22+（实测 v22.23.2） | 前端构建                                     |
| pnpm                      | 11+（实测 11.20.0）  | 包管理器，工程已锁定 `packageManager`              |
| Rust                      | 1.9x（实测 1.96.0）  | Tauri 后端，target `x86_64-pc-windows-msvc` |
| Visual Studio Build Tools | 含「使用 C++ 的桌面开发」  | MSVC 链接器与 Windows SDK                    |
| WebView2 Runtime          | Evergreen 版本     | Win11 自带；Win10 需单独安装                     |


确认环境：

```powershell
node -v
pnpm -v
rustc --version
cargo --version
```



## 二、初始化与运行（按步骤执行）

在工程根目录 `E:\work\bianqian` 下操作：

```powershell
# 1. 安装前端依赖
pnpm install

# 2. 开发模式：自动启动 Vite（端口 1420）并打开桌面便签窗口
pnpm tauri:dev

# 3. 仅前端页面预览（不进入 Tauri 运行时，UI 调试用）
pnpm dev
# 浏览器访问 http://127.0.0.1:1420
# 注意：预览环境数据存浏览器 localStorage，不写 SQLite

# 4. 生产打包：生成 NSIS 安装包
pnpm tauri:build
# 产物目录：src-tauri/target/release/bundle/nsis
```

代码检查命令：

```powershell
pnpm lint      # oxlint，0 error / 0 warning
pnpm build    # tsc -b 类型检查 + vite 生产构建，产物在 dist/
```

> 首次执行 `pnpm tauri:dev` 会全量编译 Rust 依赖，耗时约 3–10 分钟，属正常现象；之后增量编译很快。



## 三、功能清单（V0.1 已实现）



### 条目管理

- **主从布局**：左侧列表展示全部笔记（可按全部 / 备忘 / 提醒 / 待办筛选），点击任一条目，右侧详情面板直接编辑。
- **响应式布局**：窗口 ≥620px 宽时左右双栏（左侧列表 + 右侧详情；日历视图左栏自动放宽至 260px，月历格子不再拥挤）；窗口 <620px 时切换单栏——默认显示列表/日历，点击条目进入详情，详情顶部提供「返回列表」按钮；极窄窗口隐藏标题栏应用名，所有 antd 弹窗在窄窗口下自动限宽不溢出。断点常量与 CSS 媒体查询统一在 `NARROW_BREAKPOINT = 620`（`src/hooks/useViewport.ts`）。
- **备忘**：标题 + **Markdown 编辑器**（工具栏：标题/加粗/斜体/删除线/无序·有序列表/引用/代码块/链接/图片；编辑 / 分屏 / 预览三视图切换；底部实时**字数统计**「X 字 · Y 行」，口径=中文字符 + 英文单词）；预览经 marked 解析、DOMPurify 消毒防注入；按更新时间倒序，详情编辑后自动保存。
- **待办**：标题 + **子任务清单**（一条待办内含多个子任务，可逐项勾选 / 行内改名 / 删除 / 回车或「添加」按钮新增；没有备注文本框，正文就是清单）；全部勾选后整条自动完成并记 `completedAt`，列表行显示「x/y 项」进度；「待办」分类下已完成条目**自动归入下方「已完成」分组**（划线弱化显示），进行中在上。
- **提醒**：标题 + **闹钟清单**（一条提醒内含多个闹钟）；闹钟**先以列表行显示摘要**（如「单次 2026-10-23 12:52 · 弹窗+声音」，已提醒的行带徽标、时间划线弱化），**双击行弹出「设置闹钟」弹窗**编辑详情。提醒模式共 7 种（对齐参考图）：**单次提醒 / 循环提醒（可设每隔 N 天）/ 每天提醒 / 每周提醒 / 每月提醒 / 每年阳历 / 每年农历**；提醒方式：弹窗提醒 / 系统通知 / 弹窗+声音；提醒时间用 **antd DatePicker 日期时间选择组件**，附「设为当前时间」+ 确定/取消。农历换算由 lunar-javascript 提供，每月/每年遇日期溢出（如 31 日、闰日）自动收敛到当月/当年最后一天；「添加闹钟」先创建默认闹钟再打开弹窗，取消则不保留；无备注文本框；未处理且已到期红色高亮（列表与详情均显示相对时间）；可标记已处理、可删除。
- 左侧顶部筛选胶囊（全部 / 备忘 / 提醒 / 待办）带计数徽标，激活填充对应主题色；列表右上角 + 新建一条并自动选中进入详情编辑；详情编辑防抖 400ms 自动保存，切换条目或卸载时兜底落盘。
- 待办完成后自动归入下方「已完成」分组：「待办」分类与「全部」视图均生效（全部视图下已完成待办沉底，其余条目仍按时间混排）。



### 搜索与快速记录

- **全局搜索**：列表区顶部搜索框，按**标题 + 正文全文**实时过滤（大小写不敏感，备忘 Markdown 原文也可搜到）；支持一键清空。
- **筛选与排序下拉**：时间范围（全部 / 今天 / 近 7 天 / 近 30 天，按更新时间）、排序（最近编辑 / 按创建时间）、**标签筛选**（「全部标签」+ 各标签及使用计数「标签（N）」，选中后列表只留含该标签的条目）。
- **标签体系**：条目详情标题下方标签行，回车 / 失焦添加标签胶囊，点 × 删除；防抖自动保存（SQLite v4 迁移新增 `tags` 列，JSON 数组）；旧数据自动补空数组。
- **快速记录**：标题栏闪电按钮或全局快捷键 **Ctrl+Shift+N**（Rust `global-shortcut` 插件注册，任何应用下唤起；前端另有 keydown 兜底）弹出「快速记录」窗口；打开时自动**读取剪贴板文本预填**（覆盖「选中文字后快速创建」场景——先复制再唤起即可），亦可点「从剪贴板」再贴一次；可选**创建为备忘 / 提醒 / 待办**，一键创建后自动切到对应分类并选中新条目；Ctrl+Enter 快捷提交。



### 窗口能力（Windows）

- **置顶**：标题栏图钉按钮切换，窗口常驻其他程序最上层；状态持久化到本地。
- **背景透明度**：滑条调节面板大背景不透明度 25%–100%；标题栏 / 筛选胶囊等结构层保留 70% 衬底下限，输入框与详情内容区保留 86% 衬底下限，到期提醒文本同样保留文字衬底、红色仅作叠加；所有文字保持实色不透明、**不再叠加任何光晕**（text-shadow 统一 none，避免玻璃感让文字发虚）；**暗色/亮色 CSS 变量统一注入** `:root`**（documentElement）**——仅注入 main 内联变量时标题栏等继承 body 颜色且无显式 color 的文字会取到 :root 默认深色，暗色模式下变糊；标题栏「便签」字号提升至 14px/700；标签类小字号统一上调锐化（分类标签 11.5→13px/600、计数徽标 10→11px/700、列表标题 12→13px/700、闹钟模式 11→12px/700、方式 11→12px、时间 12.5→13px/700、已提醒 10→11px），缓解透明窗口灰度抗锯齿下小字发糊；状态持久化到本地，低于 25% 自动钳制。透明度弹层面板实心化（0.97）并移除 backdrop blur。透明度 ≤55% 自动切换暗色玻璃变体：面板/衬底 RGB 换深色、文字与 antd 控件同步换浅色，**面板大背景透明度跟随滑条（下限 0.4，与亮色一致）**——暗色面板 RGB 本身深色、浅色实心文字对比足够，不再做 0.85 实心钳制，滑条全程可调；暗色下玻璃亮边收敛（`--glass-edge` 0.55→0.12、高光 0.6→0.06，避免深色界面一圈刺眼白线）；「+ 添加闹钟」ghost 按钮暗色下保持主色红字/细红边框，hover 只加深红底、不变白字；**全局去掉 antd primary 按钮默认 box-shadow（antd 6 默认是主色浅底投影 rgb(255,242,240) 类，在深色界面/暗色模式下是按钮下方一条刺眼白色横条；选择器用全局* `button.ant-btn-primary`*，覆盖 Modal portal 内的「确定」等 primary 按钮）；antd 下拉/日期面板默认边框是纯亮色（rgb(240,237,230) 类），深色界面上是刺眼白边 → 统一换* `--border` *低调边框（*`.ant-select-dropdown/.ant-picker-dropdown`*）；**下拉选中项默认 colorPrimaryBg（rgb(255,241,240) 类接近白）在暗色界面发白 → 恢复为主题色系（18% 主色浅底 + 主色文字），并将*** `--kind-accent` ***同步到*** `:root`***（portal 元素在 main 外取不到内联变量，计算逻辑与渲染层 kindClass 一致）****，顶部「+」新建按钮与 primary 按钮不再有白色投影；亮色模式仍保留玻璃质感（下限 40%）；备忘字数统计状态栏字号提升至 12px、亮色加粗清晰显示。
- **边缘吸附**：拖拽窗口贴近左 / 右 / 上边缘（16px 内）自动对齐停靠；图钉旁的磁铁按钮可整体开关吸附。
- **收纳窄条**：标题栏收纳按钮把窗口收成 10px 边缘窄条；鼠标移入窄条展开回原位，移出重新收回；未贴近边缘时默认收纳到右侧。
- **无边框圆角卡片**：根面板与标题栏用 `data-tauri-drag-region="deep"`，标题栏、列表头与表单的空白间隙均可拖拽移动；按钮天然阻断，条目列表保留 `data-tauri-drag-region="false"` 优先保证滚动；支持最小化、关闭，窗口可自由调整大小（默认 760×540，最小 560×420，适配双栏主从布局）。闹钟行同样标记 `data-tauri-drag-region="false"`——此前 deep 拖拽区把闹钟行双击拦截成窗口最大化，补标记后双击只弹编辑窗。



### 系统集成（托盘 / 自启动 / 异常恢复）

- **系统托盘**（tauri `tray-icon` feature，Rust 端 `TrayIconBuilder`）：常驻通知区域，右键菜单「显示主窗口 / 隐藏主窗口 / 新建便签 / 开机自启动（勾选项）/ 退出」；左键**单击**切换显示/隐藏，左键**双击**显示并聚焦；托盘「新建便签」聚焦主窗口并通过 `tray:new-note` 事件让前端新建一条（按当前筛选分类；「全部」时用当前默认分类）。
- **开机自启动**（tauri-plugin-autostart，Windows 注册表启动项）：托盘「开机自启动」勾选即写入启动项、取消勾选移除；菜单勾选状态启动时按插件当前开关初始化、切换后实时同步。
- **单实例**（tauri-plugin-single-instance）：二次启动不新开窗口，聚焦已有主窗口并发 `app:second-instance` 事件兜底聚焦。
- **点 X 关闭确认**：主窗口关闭事件被 Rust 拦截（`CloseRequested.prevent_close` 后发 `window:close-requested` 事件）。默认弹「要关闭便签吗？」——**最小化到后台（隐藏窗口、托盘常驻）** 与 **退出应用（结束进程）** 二选一，勾选「下次不再询问，始终执行以上选择」（默认勾选）后按该选择直接执行，选择即持久化（`bianqian.closeBehavior.v1`）；**标题栏「设置」齿轮入口可随时改回**：每次询问 / 最小化到后台 / 退出应用 三态切换；标题栏 X 与 Alt+F4 均走此流程，托盘菜单「退出」不经确认。
- **设置入口（标题栏齿轮按钮 → 设置弹窗）**：集中管理软件相关设置——**背景透明度**（滑条，文字不透明、≤55% 自动切暗色）、**关闭窗口时**（每次询问/最小化到后台/退出应用）、**开机自启动**（前端直调 tauri-plugin-autostart，登录自启）、**窗口置顶**、**边缘吸附**（后两项与标题栏图钉/磁铁快捷按钮同步同一 store）。
- **异常恢复**：窗口位置/尺寸随移动与缩放实时持久化（`bianqian.window.bounds.v1`），重启自动恢复（收纳窄条态不覆盖）；筛选 / 默认分类 / 选中条目持久化（`bianqian.ui.v1`），启动数据就绪后恢复、选中失效自动回落；条目数据本身在 SQLite，崩溃不丢。



### 提醒调度

- 前端 30 秒轮询一次条目内的每个闹钟；未通知、未处理且已到点的闹钟按**提醒方式**触达：弹窗提醒 → 屏幕居中模态确认窗口（全屏遮罩 + 模拟表盘与当前时间 + 提醒时间 + 大字标题与备注 + 竖排「进入便签」+「我知道了」）；系统通知 → 系统 toast 并直接标记已通知；弹窗+声音 → 弹窗内附带提示音。确认后标记该闹钟 `notified` 并关闭窗口，避免重复弹窗；一次性闹钟不再提醒，每天 / 每周 / 工作日闹钟自动推进到下一次触发时间。
- 弹窗是独立置顶 Webview 窗口（label 为 `reminder-<条目id>`）；同一条目确认前不会重复开窗；确认动作写库后通过 `reminder:confirmed` 事件回传主窗口同步本地状态。浏览器预览环境无法创建独立窗口，兜底使用 Web Notification。
- **循环提醒间隔支持「X 时 Y 分」复合间隔**：「循环提醒」模式编辑区为「[时] 时 [分] 分」两个输入框，存储毫秒（`intervalMs`），调度按毫秒换算下一次触发；详情行显示「循环·每1时30分」式摘要；旧单值数据（`interval+intervalUnit` 秒/分/时/天）自动换算兼容。



### 日历

- 分类下拉新增「日历」视图：月历网格，有条目的日期按分类打点（提醒按闹钟日期、备忘/待办按最近更新时间，同一天多分类最多 3 点）；点击日期在下方列出当天条目（提醒按时间、其余按更新时间排序），点条目右侧详情直接编辑；与搜索/分类视图共用分类下拉切换，视图选择持久化（`bianqian.ui.v1`）。



### 番茄钟

- 标题栏番茄按钮唤起「番茄钟」弹窗：圆环进度 + mm:ss 大字倒计时，专注（默认 25 分钟，可 15/25/45）与休息（默认 5 分钟，可 5/10/15）自动轮换，轮次计数；开始 / 暂停 / 重置 / 再来一轮；每轮结束 Web Audio 短促双音提示。计时器由标题栏常驻持有，**关闭弹窗后台继续走**，标题栏实时显示剩余时间；设置持久化（`bianqian.pomodoro.v1`）。



### AI 助手（标题栏 ✨ → 对话面板）

- **自然语言问答**：标题栏星芒按钮打开覆盖式对话面板，包含消息历史、Markdown 回答、逐字流式输出、Enter 发送 / Shift+Enter 换行、停止生成、清空与重试；输入区是一体化卡片：正文 + 虚线分隔的工具条（新建对话、便签上下文开关、模型选择、发送 / 停止）；对话记录持久化在本机（`bianqian.assistant.v1`，最多 40 条）。
- **基于应用内上下文**：每次提问自动附带当前便签的统计、最近 15 条标题 / 正文摘要与正在查看的条目（剔除图片与废纸篓，最多约 6000 字）；可在设置 → AI 助手 → 上下文与隐私中关闭。
- **多模型配置与切换**：设置 → AI 助手 → 接入配置可添加多条模型配置，新增与编辑均通过弹窗完成（服务商下拉选择，自动填入接口地址与默认模型，「显示名称」默认取所选模型名且可改）；已配置项以卡片列出，可点卡片切换当前使用、编辑或删除。对话输入卡片右侧有模型选择器，收起时显示模型显示名，下拉按「显示名称 + 服务商 · 模型」两行列出全部配置，切换后立即用于后续提问。
- **内置免费模型**：模型列表内置一组公开免费网关（OpenCode Zen / Kilo AI / LLM7.io / Pollinations），均无需注册自己的账号；模型名称与清单**不硬编码**，运行时向各网关的 OpenAI 兼容 `GET /models` 拉取，名称后带「免费」标识，在设置页按来源分组展示接口地址、限速说明与来源状态（实时 / 缓存 / 兜底 / 不可用），并提供「重新获取」。自己的配置始终排在免费模型前面；免费条目只在内存中追加，不写入配置文件，也不能编辑 / 删除；首次使用不会自动选中，需要在对话面板或设置页主动切换——提问内容会直接发送给对应第三方网关，提示词可能被记录，请勿发送敏感内容。
- **兜底提示**：未配置、密钥失效、网络失败、限流、模型空回复等均有稳定错误码与中文提示；未配置时直接给出「去设置」入口；信息不足时模型被约束为明确说明「现有便签里没有相关信息」，而不是编造。
- **两种运行环境都能对话**：桌面版由 Rust 后端代理请求并保管密钥；浏览器预览没有 Rust 后端，改为前端直连 OpenAI 兼容接口，配置与密钥保存在浏览器 localStorage（仅供本地调试，设置页会标注「保存在本浏览器」）。个别服务未开放跨域（CORS）时浏览器直连会被拦截，界面会给出提示，改用桌面版即可。



### 数据管理（设置 → 数据管理）

- **导出数据**：全部条目导出为 JSON 文件（含版本号与导出时间）；桌面版经保存对话框写文件，浏览器预览直接下载。
- **导入数据**：从导出的 JSON 合并导入，**按 id 去重**（已存在跳过不覆盖，不破坏现有数据），完成后提示新增/跳过条数。
- **备份数据库**：完整复制 SQLite 文件（`%APPDATA%\com.bianqian.app\bianqian.db`）到用户选择的位置（Rust `backup_db`，std::fs 复制）。
- **恢复数据库**：用备份文件覆盖当前数据库，提示重启后生效（Rust `restore_db`；SQLite 连接仍指向旧句柄，需重启读取新库）。备份/恢复仅桌面版可用，预览环境使用导出/导入。



### 数据存储

- 桌面端本地 SQLite，数据库文件：`%APPDATA%\com.bianqian.app\bianqian.db`。
- 窗口设置（置顶、背景透明度、吸附开关）存 localStorage，键 `bianqian.window.v1`。
- AI 对话记录与上下文开关存 localStorage，键 `bianqian.assistant.v1`；桌面端多模型接入配置（含各配置密钥与当前选中项）由 Rust 存于 `%APPDATA%\com.bianqian.app\ai-config.json`，旧版单配置会自动迁移并写回（迁移条目的 id 固定为 `legacy`，保证前端拿到的 id 在保存时仍能命中）；浏览器预览的接入配置存 localStorage，键 `bianqian.assistant.ai.v2`（旧版 `bianqian.assistant.ai.v1` 读取时自动迁移）。免费模型列表本身来自各网关的 `GET /models`（缓存 6 小时，失败重试间隔 10 分钟），桌面端缓存在 `%APPDATA%\com.bianqian.app\ai-free-models.json`，浏览器预览缓存在 localStorage 键 `bianqian.assistant.ai.free.v1`；免费条目只追加到内存列表，不写入接入配置文件。
- 浏览器预览兜底数据存 localStorage，键 `bianqian.entries.v1`。



## 四、目录结构

```
bianqian/
├── index.html                     # 页面入口（lang zh-CN，标题「便签」）
├── package.json                   # 前端脚本与依赖
├── vite.config.ts                 # 固定端口 1420、strictPort，忽略 src-tauri HMR
├── tsconfig.app.json / tsconfig.json / tsconfig.node.json
├── .oxlintrc.json                 # oxlint 规则：react / typescript / oxc
├── public/
│   └── favicon.svg
├── src/
│   ├── main.tsx                   # React 挂载入口：?reminder=1 渲染弹窗，否则渲染主界面
│   ├── App.tsx                    # 根组件：加载条目、启动调度、恢复窗口设置；docked 时渲染窄条
│   ├── index.css                  # 全局样式（毛玻璃浅色系 + 分类主题色、卡片、窄条、滚动条）
│   ├── types/
│   │   ├── entry.ts               # Entry 类型、SQLite 行结构、新建输入载荷
│   │   └── ai.ts                  # AI 助手类型：配置状态 / 流式事件 / 对话消息
│   ├── repository/
│   │   ├── repository.ts          # EntryRepository 抽象接口 + 行映射
│   │   ├── sqliteRepository.ts    # Tauri 环境 SQLite 实现
│   │   ├── memoryRepository.ts    # 浏览器预览 localStorage 兜底实现
│   │   └── index.ts               # 运行时探测 + 仓储单例工厂
│   ├── store/
│   │   ├── useEntryStore.ts       # 条目 Zustand store（分类、加载、增删改、勾选）
│   │   ├── useWindowStore.ts      # 窗口设置 store + localStorage 持久化
│   │   ├── useAssistantStore.ts   # AI 对话 store：流式合并、停止/重试、本机持久化
│   │   └── useUiStore.ts          # 跨组件界面状态（设置弹窗与目标设置页）
│   ├── window/
│   │   ├── tauriWindow.ts         # 置顶 / 位置尺寸 / 工作区 / 移动订阅 / 最小化 / 关闭 / 恢复边界
│   │   └── edgeDock.ts            # 边缘检测、吸附对齐、收纳窄条、自动吸附
│   ├── reminder/
│   │   └── scheduler.ts           # 30 秒到期轮询 + 独立居中弹窗窗口 / 浏览器 Web Notification 兜底
│   ├── services/
│   │   ├── aiClient.ts            # AI 调用封装：Channel 流式对话 / 配置 / 测试 / 取消（浏览器预览直连）
│   │   ├── freeModels.ts          # 免费模型运行时目录：拉取 /models、缓存与兜底（仅浏览器预览使用）
│   │   └── assistantContext.ts    # 由条目构造 system prompt（统计 + 摘要，受隐私开关控制）
│   ├── hooks/
│   │   └── useNow.ts              # 按间隔刷新的当前时间戳（渲染期安全取时）
│   ├── utils/
│   │   └── format.ts              # 短时间戳 / datetime-local 值 / 相对时间格式化
│   └── components/
│       ├── TitleBar.tsx           # 拖拽区、置顶、吸附开关、透明度弹层、收纳、最小化、关闭
│       ├── AssistantPanel.tsx     # AI 助手对话面板：历史、流式、输入框、错误兜底
│       ├── ProviderMark.tsx       # 模型选择器前的服务商标识（品牌 SVG / 通用兜底）
│       ├── FreeBadge.tsx          # 「免费」标识，附在内置免费模型名称后
│       ├── CategoryTabs.tsx         # 左侧竖排分类条：备忘 / 提醒 / 待办与计数
│       ├── EntryList.tsx           # 左侧主从列表：筛选、排序、行展示、选中
│       ├── DetailPane.tsx          # 右侧详情：标题 / 待办子任务清单 / 提醒闹钟清单（时间+模式+方式）/ 备注，防抖自动保存
│       ├── NoteItem.tsx / TodoItem.tsx / ReminderItem.tsx  # 旧卡片式条目（主从布局后未启用）
│       ├── AddForm.tsx             # 旧新增表单（主从布局后未启用）
│       ├── ReminderDialog.tsx      # 到期提醒模态弹窗：遮罩 + 居中卡片 + 确认关闭
│       ├── EntryEditor.tsx         # 条目内联编辑表单：预填标题 / 备注 / 时间，保存与取消
│       └── DockBar.tsx             # 收纳窄条：移入展开、移出收回
└── src-tauri/
    ├── Cargo.toml                  # Tauri 2、sql(sqlite)、notification、reqwest、serde 依赖
    ├── build.rs
    ├── tauri.conf.json             # 主窗口配置、SQLite 预加载、NSIS 打包、图标
    ├── capabilities/
    │   ├── default.json            # 主窗口 core / sql / notification 权限，含窗口命令、SQL 写与创建弹窗窗口放行
    │   └── reminder-dialog.json     # reminder-* 弹窗窗口权限：关闭窗口与 SQL 读写
    ├── icons/                      # 32x32.png / 128x128.png / icon.ico
    └── src/
        ├── main.rs                 # 调用 bianqian_lib::run()
        ├── ai.rs                   # AI 代理：OpenAI 兼容接口、SSE 流式、配置与密钥管理
        └── lib.rs                  # SQLite 迁移、插件注册、窗口与 AI 命令注册
```



## 五、关键实现说明



### 1. 背景透明度：背景半透明、文字保持不透明

- 窗口配置 `transparent: true`、`decorations: false`，WebView2 背景本身透明；**不**叠加 Win32 `WS_EX_LAYERED` 整窗 alpha 混合——整窗 `LWA_ALPHA` 会把文字一并变淡，与需求不符。
- CSS `:root` 定义背景 RGB 分量变量（`--panel-rgb / --panel-soft-rgb / --field-rgb`）与三个 alpha 变量：`--panel-alpha` 为面板大背景值（0.25 ~ 1，跟随滑条），`--chrome-alpha` 为标题栏 / 筛选胶囊 / 弹层 / 窄条结构层衬底，`--surface-alpha` 为输入框 / 详情内容区文字衬底。
- 三个 alpha 在前端按面板值取大后由 `App.tsx` 内联注入：结构层下限 `0.70`、文字衬底下限 `0.86`；不把 `max()` 写进 `rgba()` 的 alpha 位，避免渲染端对函数 alpha 求值回退成不透明。
- 文字颜色固定引用实色变量 `--text / --text-muted`，不随 alpha 变化；弱化色 `--text-muted` 取较深暖棕灰，未激活分类用实色文字、靠字重区分层级；`body` 叠加一层浅色 `text-shadow` 光晕勾勒字形轮廓，文字本身不透明度仍为 1；实色底按钮（提交按钮、关闭悬停、勾选框）显式关闭光晕。到期卡片的红色只作为渐变叠加层，field 文字衬底完整保留，不会出现卡片背景几乎全透明、文字压在透出处的情况。待办归档只靠标题划线与弱化颜色表达，不对整卡降 `opacity`。
- 透明度在前端钳制到 `0.25 ~ 1.0` 并持久化到 localStorage；Rust 侧不注册透明度命令，透明度实现天然不绑定 Windows 私有 API。
- 界面配色走毛玻璃浅色系：面板 / 标题栏 / 卡片为多层半透明表面叠加高光边与双层投影；分类主题色 `--note（蓝）/ --reminder（珊瑚红）/ --todo（绿）` 由外壳 `kind-*` 类注入为 `--kind-accent`，标题栏圆点、激活分类、提交按钮、卡片左侧指示条与输入焦点框统一跟随当前分类；待办勾选框改为圆形，到期提醒卡片保留红色渐变叠加层与文字衬底。



### 2. 仓储抽象与同步预留

- `EntryRepository` 定义统一接口：`listAll / listByKind / create / update / remove / markNotified / listPendingSync / markSynced`。
- 工厂 `getRepository()` 按 `window.__TAURI_INTERNALS__` 探测运行时：Tauri 内用 SQLite，浏览器直开预览用 localStorage。
- 条目表自带 `sync_status`（pending / synced / conflict）字段与 `listPendingSync / markSynced` 接口；后续接入多设备远程仓储时，在工厂内叠加同接口实现即可，store 不感知存储位置。



### 3. 数据库迁移

迁移在 Rust setup 阶段由 `tauri-plugin-sql` 执行：v1 建统一表 `entries`，`kind` 约束为 `note / reminder / todo`，含提醒时间、完成状态、通知标记、创建 / 更新时间、同步状态，并建 `kind`、`updated_at` 两个索引；v2 `ALTER TABLE` 追加 `items` 列（待办子任务清单 JSON），v3 追加 `alarms` 列（提醒闹钟清单 JSON），均为 `TEXT NOT NULL DEFAULT '[]'`，旧库自动升级（提醒无闹钟清单时把旧 remind_at 收敛为一条 legacy 闹钟）。

### 4. 插件权限边界

- `core:default` 展开后的 `core:window:default` 只包含窗口只读查询与 `internal_toggle_maximize`，**不包含** `start_dragging / close / minimize / set_always_on_top / set_position / set_size`；这些命令在 `capabilities/default.json` 中逐项显式放行，否则内置拖拽与窗口操作会被 ACL 静默拒绝。
- `sql:default` 仅放行 `load / close / select`；条目新增、勾选、删除、通知标记等写操作走 `execute`，额外放行 `sql:allow-execute`。
- 主窗口 `default` 条目额外放行 `core:webview:allow-create-webview-window`，用于创建到期提醒弹窗窗口；`capabilities/reminder-dialog.json` 用 glob 标签 `reminder-*` 覆盖所有弹窗窗口，只放行 `core:window:allow-close` 与 SQL 读写，弹窗自身不需要拖拽、位置等主窗口能力。
- `notification:default` 与通知插件：闹钟「系统通知」方式通过 `sendNotification` 发送系统 toast；其余方式走模态弹窗，插件作为触达渠道之一。
- 本工程未注册自定义命令，前端只调用 Tauri 内置 Window / Webview / SQL 插件 API。



### 5. 到期提醒模态弹窗

- 调度器 `reminder/scheduler.ts` 30 秒轮询每条提醒的每个闹钟；Tauri 环境对到期末通知闹钟调用 `WebviewWindow.getByLabel` 去重后创建独立弹窗窗口：尺寸取当前显示器工作区（排除任务栏），`decorations: false`、`transparent: true`、`alwaysOnTop: true`、`skipTaskbar: true`、`focus: true`，URL 参数携带条目 id、闹钟 id、标题、备注、提醒时间、模式与方式。
- 同一份前端包按 `?reminder=1` 参数在 `main.tsx` 双分支渲染：主窗口渲染 `App`，弹窗窗口渲染 `ReminderDialog`；弹窗内是全屏 `rgba(24,18,12,0.42)` 遮罩 + 屏幕居中圆角卡片（头部「弹窗提醒」、实时走动的模拟表盘与当前时间、提醒时间、大字标题与备注、右侧竖排「进入便签」、底部全宽「我知道了」按钮）。
- 点击「我知道了」：弹窗仓储 `markAlarmNotified` 写库 → `emit('reminder:confirmed', { entryId, alarmId })` → 主窗口事件订阅解除弹窗登记、同步本地状态，重复模式按 nextAlarmAt 推进该闹钟 → 当前弹窗窗口关闭；「进入便签」额外 emit `reminder:open-note` 让主窗口聚焦并选中该条目。浏览器预览环境无法创建独立窗口，兜底 Web Notification 且由调度器直接标记已通知。
- 弹窗窗口 label 为 `reminder-<条目id>-<闹钟id>`，多条提醒、多个闹钟可各自独立弹出，互不阻断。



### 6. 条目内联编辑

- 每张未归档条目卡片头部带铅笔按钮，点击后卡片切换为 `EntryEditor` 内联表单：预填现有标题、备注；提醒条目同时预填到期时间；标题为空或提醒时间无效时保存按钮禁用，Enter 保存、Esc 取消、点「取消」丢弃改动。
- 保存走 store `updateEntry` → 仓储 `update` 写库（仓储按 `kind` 判别写列，store 补全条目自身类型）→ 本地状态合并并刷新 `updatedAt`；提醒条目保存时重置 `notified`，重新设定时间后重新纳入到期调度；归档后的待办与已处理提醒隐藏编辑按钮，保持只读，删除按钮不受影响。



### 7. 左侧主从布局

- 标题栏下方为双栏：左侧 `note-list-pane`（筛选胶囊 `filter-chips` + 列表头 + `entry-list` 行列表），右侧 `detail-pane` 详情编辑。
- 筛选胶囊（全部 / 备忘 / 提醒 / 待办）各带计数徽标，激活填充对应主题色；「全部」时列表混排按更新时间倒序，单分类时按各自规则排序（备忘按更新时间、提醒按到期升序未处理在前、待办按子任务完成度未完成在前）。
- 点击列表行右侧详情随之切换，详情编辑防抖自动保存（输入停止 400ms 落库，切换条目 / 关闭时兜底保存）；删除选中条目后自动回落列表第一条；新建条目自动选中进入详情编辑。
- 左侧栏固定 210px（此前 252px 偏宽，已按用户反馈收窄），窄窗（最小 560px）下右栏自动收窄，不横向溢出。**分类筛选由 antd Segmented 改为下拉（Select）**：左栏顶部一个下拉框显示「全部 · N」，展开列出 全部/备忘/提醒/待办 四项并各带计数徽标，选中项为主题色系（18% 主色底 + 主色文字），切换即筛选列表并联动新建分类，**切换后自动选中结果列表第一条**（高亮 + 详情同步）；**展开/聚焦态去掉 antd 的主色边框与 focus ring（antd 6 Select 边框在根元素上，根与 selector 均覆盖为透明）**；随后**全部输入控件统一**：antd Input（含 affix 包裹）、DatePicker（antd 6 激活态走 `:focus-within`，边框在 `.ant-picker` 根）、自定义标题 / Markdown / 待办 / 时间输入、**数字输入框（InputNumber）**，聚焦/激活态一律去主色边框与 focus ring，hover 回退为 `--border` 低调边框；**控件样式收敛到 antd 主题（ConfigProvider）**：此前散落的 CSS !important 覆盖全部改为主题控制——暗色模式用 `theme.darkAlgorithm`（所有 antd 控件自动切深色背景 + 浅色文字），全局 token 统一 `colorBorder=--control-border`（暗色 rgba(236,230,220,0.3) / 亮色 rgba(96,84,64,0.28)）、`controlOutline=transparent`（去 focus ring）、`colorBgElevated` 暗色实底；组件级：Select 选中项主题色浅底+主色文字、Input/InputNumber/DatePicker 聚焦/hover 边框色、Button 去 primary 浅底投影、Modal 弹窗背景；仅非 antd 的自定义输入（详情标题 / Markdown / 待办 / 时间输入）保留 CSS 聚焦边框控制。



### 8. 拖拽区域（deep 模式）与边缘吸附时机

- 根面板 `main` 与标题栏 `header` 均标记 `data-tauri-drag-region="deep"`：子树内非可点击元素的点击均可拖动窗口；按钮、输入框、链接、选择框等可点击元素未显式标记时天然阻断拖拽。
- 分类侧栏与表单容器不再整体 `false`，由 deep 判定放行其空白间隙；条目列表 `entry-list` 保留 `data-tauri-drag-region="false"`，保证列表内按住拖动优先触发滚动而不是移动窗口；透明度弹层与标题栏按钮组保持 `false`。
- 边缘吸附不绑在鼠标抬起事件上：`App.tsx` 订阅窗口 `onMoved` 事件，停止移动 160ms 防抖后再读取当前边界与工作区，贴近 16px 内才对齐停靠；已贴边时坐标差小于 2px 直接短路，避免拖拽结束瞬间读到移动中的旧坐标把窗口强行回拉。**窗口处于最大化状态时跳过吸附**——最大化窗口若被 `setPosition` 移动会被 Windows 立即还原，此前双击标题栏最大化后马上变回即由此路径引发（最大化瞬间移动事件触发吸附，读到过渡坐标后移动窗口导致还原）。
- 收纳窄条展开/收回流畅性：`DockBar` 鼠标移入立即切回全窗口界面、尺寸与位置并行恢复（不再串行等 IPC）；移出经 200ms 防抖后再收窄（吸收边缘像素抖动），并用交互令牌防止「展开途中的旧收起」把已展开的窗口又切成窄条；显示器工作区查询 5 秒缓存，减少弹出/收回时的 IPC 往返。
- 内置拖拽触发已放行的 `start_dragging` 命令；权限未放行时表现为窗口完全拖不动。



### 9. AI 助手：后端代理、接入配置与密钥管理

- **双路径实现**：桌面端前端只把消息数组通过 `invoke('ai_chat')` 交给 Rust；API Key 由 Rust 读取后仅用于向上游发请求，**从不回传 WebView**，不会进入前端 bundle、localStorage 或对话记录。浏览器预览没有该命令，`aiClient.ts` 走 `fetch + SSE` 直连同一套 OpenAI 兼容接口，配置与密钥存浏览器 localStorage（键 `bianqian.assistant.ai.v2`），仅用于本地预览/调试。
- **多模型配置**：`ai-config.json` 为 `{ version: 2, activeId, profiles: [...] }`，每条配置包含 `id / name / provider / baseUrl / model / apiKey / temperature / maxTokens`；`name` 为对话模型选择器中展示的名称，留空时自动取模型名。Rust 命令：`ai_get_status`（返回列表与当前项，密钥只返回掩码）、`ai_save_profile`（按 id 新增或更新，新增后自动设为当前）、`ai_activate_profile`、`ai_delete_profile`（删除当前项时自动切换到剩余第一条）、`ai_clear_key`（按配置清除密钥）、`ai_list_models` / `ai_test`（可带配置 id，密钥留空时沿用已保存值）、`ai_chat`（`profileId` 指定使用哪条配置）。前端共享 `useAiProfileStore`，设置页与对话面板状态一致。
- **接口规范**：兼容 OpenAI Chat Completions（`POST {baseUrl}/chat/completions`，`stream: true`），可对接 DeepSeek / Moonshot / 通义千问兼容模式 / 火山引擎方舟 / 智谱 GLM / OpenAI / Ollama 等。设置页「接入配置」为「概览 + 已配置卡片列表」，新增与编辑都在独立弹窗中完成：服务商为下拉选择（选中预设自动填入 Base URL 与默认模型，也可选「自定义服务」）；「显示名称」默认取所选模型名，手动改过后不再跟随模型变化，留空则回落到模型名；模型字段是「下拉建议 + 手动输入」组合框，**候选优先来自服务端官方** `GET {baseUrl}/models` **接口**（桌面端经 Rust 命令 `ai_list_models` 代理，浏览器预览直连），获取失败时自动回落到预设内置列表，仍可手动输入任意模型名或方舟推理接入点 ID（`ep-xxx`）。保存前校验接口地址格式、模型名与密钥（本机服务可留空）。
- **流式与取消**：`reqwest` 读取 SSE，逐帧解析 `choices[0].delta.content`，通过 `tauri::ipc::Channel` 推送 `delta / done / error` 事件；前端按 50ms 合并增量渲染，避免逐 token 重渲染。「停止生成」调用 `ai_cancel`，后端在下一个数据块到达时丢弃并正常收尾。
- **配置优先级**：每条配置自身的接口地址 / 模型 / 采样参数优先；环境变量 `BIANQIAN_AI_API_KEY` 若存在，会覆盖所有配置的密钥（适合部署时统一注入）；`BIANQIAN_AI_BASE_URL` + `BIANQIAN_AI_MODEL` 同时存在时，额外生成一条只读的「环境变量」配置供切换；`BIANQIAN_AI_TEMPERATURE` / `BIANQIAN_AI_MAX_TOKENS` 覆盖采样参数。未填写时使用内置默认（temperature 0.7 / max_tokens 1200）。
  - 本地配置文件：`%APPDATA%\com.bianqian.app\ai-config.json`（Unix 下写入后 `chmod 600`；Windows 依赖应用数据目录的用户 ACL）。
- **内置免费模型（免密钥网关，运行时发现）**：列表顺序固定为「环境变量 → 用户配置 → 内置免费模型」，自己的模型始终排在前面。代码里只登记网关（来源、接口地址、鉴权方式、说明与兜底模型），**模型名称与清单不硬编码**：每次读取状态时向后端确认目录是否新鲜，过期就并发请求各网关的 `GET {baseUrl}/models` 并解析 `data[]`。条目在读取时追加到内存，**不写入 `ai-config.json`**，`readOnly` 标记使其不能编辑 / 删除，`ResolvedConfig.keyless` 让它们跳过「必须有 API Key」校验。未手动选择过时不会被自动选中，避免在用户不知情的情况下把内容发给第三方。调用方式均为 `POST {baseUrl}/chat/completions`；需要鉴权的网关由 `bearer` 字段注入固定公开令牌（用户密钥存在时优先用用户密钥）。

  | 来源 | 接口地址（OpenAI 兼容） | 模型来源 | 鉴权 / 限制 |
  | --- | --- | --- | --- |
  | OpenCode Zen（主上游） | `https://opencode.ai/inference/v1` | `GET /models` 实时拉取 | 固定 `Authorization: Bearer public`；IP 限速与地区拦截，高峰 429；提示词可能被上游记录 |
  | Kilo AI | `https://api.kilo.ai/api/gateway` | `GET /models` 实时拉取 | 匿名，无 Authorization 头；约 200 次/小时；提示词可能被上游记录 |
  | LLM7.io | `https://api.llm7.io/v1` | `GET /models` 实时拉取 | 匿名约 60 次/分钟、250 次/小时；可选填 Key 提升额度 |
  | Pollinations | `https://text.pollinations.ai/openai` | `GET /models` 实时拉取 | 匿名层，无 Authorization 头 |

  **错误处理与降级**：每个来源独立处理——成功时取接口返回的模型（只保留 `type == "chat"`，若返回 `cost.text.output.price > 0` 则视为付费并跳过，单源最多 40 条）；失败时若有本地缓存则沿用（标记「缓存」），否则回退到每个来源内置的一条兜底模型（标记「兜底」）；没有兜底且无缓存时该来源不展示（标记「不可用」）。成功结果缓存 6 小时，失败后 10 分钟再重试；设置页可点「重新获取」强制刷新。桌面端缓存文件为 `%APPDATA%\com.bianqian.app\ai-free-models.json`，浏览器预览缓存在 localStorage 键 `bianqian.assistant.ai.free.v1`。前端在列表中找不到某个免费模型时，仍按 `free:{source}:{modelId}` 还原请求目标，用户先前选中的模型不会因上游下线而变成「配置不存在」。失败的对话请求会按 `rate_limited / endpoint_not_found / server_error` 等错误码提示。OpenCode Zen 使用其公开的 `Bearer public` 通道，不涉及伪造客户端指纹或预置会话 id。
- **密钥管理建议**：
  1. 个人使用：设置 → AI 助手 → 接入配置逐条填写，密钥只保存在本机；编辑某条配置时可「清除已保存密钥」。使用本机 Ollama / LM Studio 等无需鉴权的服务时可留空密钥（仅限 `localhost / 127.0.0.1 / ::1` 地址）。
  2. 部署 / CI：只注入环境变量，密钥不落盘；对应配置会标注「环境变量」且不可编辑 / 删除。
  3. 不要把密钥硬编码进源码或打包产物。桌面端密钥不进入 localStorage；浏览器预览为本地调试会把配置存 localStorage，请避免在公共设备填写正式密钥。若后续做多用户 / 云同步，应改为服务端持有密钥并增加鉴权与配额，而不是把密钥下发到每个客户端。
- **上下文与隐私**：发送前剔除 base64 图片、压缩空白并截断（约 6000 字）；可在「上下文与隐私」一键关闭；对话历史仅保存在本机 localStorage。
- **错误兜底**：Rust 将上游错误归类为 `not_configured / unauthorized / endpoint_not_found / rate_limited / server_error / network_error / empty_response` 等稳定错误码，前端渲染对应标题与「去设置 / 重试」操作；上游错误正文中的 message 会截断后附带，便于定位。



## 六、V0.1 未覆盖范围（后续迭代）

以下需求本次未点名，工程内未实现，避免超出当前范围：

- 屏幕底部边缘吸附（当前仅左 / 右 / 上）；
- 搜索结果的键盘快速跳转、按创建时间范围过滤（当前时间范围按更新时间）、标签重命名 / 合并；
- 提醒优先级、拖拽排序、富文本 / 附件；
- 多设备同步后端（仅有仓储抽象与 `sync_status` 字段预留）；
- Linux / macOS 窗口表现（置顶、位置、吸附窄条走 Tauri 内置 Window API，未在这两个平台实测；背景透明度为纯 CSS 实现，不受平台限制）；
- NSIS 安装包需执行 `pnpm tauri:build` 后生成，本仓库未附带成品安装包。



## 七、已知平台边界与排障

- **桌面端拖不动窗口 / 点添加没反应 / 置顶最小化关闭无效**：多为 ACL 权限未放行。先核对 `capabilities/default.json` 是否包含 `core:window:allow-start-dragging`、`core:window:allow-minimize`、`core:window:allow-close`、`core:window:allow-set-always-on-top`、`core:window:allow-set-position`、`core:window:allow-set-size` 与 `sql:allow-execute`；权限清单改动后必须重启 `pnpm tauri:dev` 生效。浏览器预览走 localStorage 兜底，不经过 Tauri ACL，出现上述问题时表现不相同。
- **到期弹窗不弹出**：先核对 `capabilities/default.json` 含 `core:webview:allow-create-webview-window`、`capabilities/reminder-dialog.json` 的 glob 为 `reminder-`* 且含 `core:window:allow-close` 与 `sql:allow-execute`；权限清单改动后必须重启 `pnpm tauri:dev` 生效。弹窗确认后写库失败会在控制台打印「确认提醒失败」；列表到期红色高亮作为兜底提示。
- **预览与桌面数据不通**：浏览器 `pnpm dev` 的数据与桌面 SQLite 相互独立，属设计内兜底行为；浏览器环境不创建独立弹窗窗口，只走 Web Notification 兜底。
- **端口占用**：Vite 固定 `1420` 且 `strictPort`；被占用时先关闭其他开发实例。
- **AI 助手报「密钥无效 / 接口或模型不存在」**：先确认 Base URL 与模型名匹配（多数服务需要 `/v1` 前缀，火山方舟为 `/api/v3`），再检查密钥是否过期、余额是否充足；设置页「测试连接」会发一条最小请求验证。若使用 Ollama，确认本地服务已启动且地址为 `http://127.0.0.1:11434/v1`。
- **浏览器预览里 AI 报「无法连接到 AI 服务」**：浏览器直连受同源策略限制，若服务商未返回跨域头（CORS），控制台会出现 `blocked by CORS policy`。这不是密钥问题，改用桌面版（Rust 代理不受 CORS 限制）即可；也可选择支持浏览器直连的服务，或在本机启动一个带跨域头的转发服务。
- **Rust 编译慢**：首次构建需下载并编译全部依赖；`src-tauri/target` 可被 `.gitignore` 忽略，删除后下次构建会重装。

