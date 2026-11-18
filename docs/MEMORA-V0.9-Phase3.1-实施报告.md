# MEMORA V0.9 Phase 3.1 实施报告

> 范围：Agent 稳定性补强与集成验收。未进入新阶段，未改动 Phase 2 安全规则、SQLite 结构、品牌主题体系与工具执行机制。
> 日期：2026-11-13

## 一、改动文件

| 文件 | 改动 |
| --- | --- |
| `src/services/agentExecution.ts` | 修正批次执行语义文档；移除未使用的 `readOnly` 字段 |
| `src/services/agentToolSchema.ts` | 重写提示词规则 12：同批次调用彼此独立、跨轮次才可依赖前一步结果 |
| `tests/agentExecution.test.ts` | 新增 4 个同批次/跨轮次依赖测试，重命名相关用例 |
| `tests/prompts.test.ts` | 新增 2 条提示词断言（同批次独立、需等下一轮） |
| `scripts/integration/mockSseServer.mjs` | 新增本地 OpenAI 兼容 SSE Mock 服务 |
| `scripts/integration/harness.mjs` | 新增 Node 侧运行时：Vite `ssrLoadModule` 加载真实 store + FakeStorage |
| `scripts/run-integration-tests.mjs` | 新增 10 个 Mock SSE 集成场景 |
| `scripts/run-real-model-acceptance.mjs` | 新增 8 个真实模型验收场景（读取本机配置，密钥不落盘） |
| `package.json` | 新增 `test:integration`、`test:real` |
| `.gitignore` | 移除 `tests ` 忽略项，测试目录纳入版本管理 |
| `src/styles/memora-tokens.css` | 新增语义色文字变体 token（浅色/暗色各一套） |
| `src/components/AssistantPanel.tsx` | 徽标、步骤、删除卡片文字/图标改用文字变体 token |
| `docs/MEMORA-V0.9-Phase3-实施报告.md` | 修正同批次/跨轮次描述（§3、§3.1、§8.2） |

Phase 3 的其余源码（执行器、store、上下文、类型）保持原逻辑，未在本阶段改动。

## 二、依赖关系修正

1. **执行器文档与实现对齐**：`executeToolBatch` 严格按模型给出的数组顺序串行；批次内结果只在整批结束后一次性回传，因此**同一批次中的调用互相独立**。文档不再暗示“后一个调用能读到前一个结果”。
2. **移除误导字段**：`ToolBatchResult.readOnly` 无使用方且容易被误读为“批次内具备依赖感知”，已删除。
3. **提示词规则 12**：明确同一轮多个调用彼此独立、模型看不到彼此结果；需要前一步结果时必须等下一轮，且不得猜测 id。
4. **测试固化语义**：新增“猜测 id 直接失败”“同批次先建后改必须用真实 id”“tool_call_id 不串结果”“前置查询失败后依赖操作不成功/不写入”4 个用例，防止后续回归。

## 三、同批次与跨轮次规则

| 场景 | 规则 | 实现/验证 |
| --- | --- | --- |
| 同一批次多个调用 | 按模型给出的顺序串行执行，不并发 | `executeToolBatch` for 循环；测试断言执行顺序 |
| 同批次调用之间 | 互相独立，任何调用都看不到同批其他调用的结果 | 猜测 id 的修改失败；先建后改必须持有真实 id |
| 结果回传 | 整批结束后按 `tool_call_id` 一一对应回传 | 测试断言 4 个结果的 `tool_call_id` 顺序与内容不串 |
| 跨轮次依赖 | 先查询 → 回传真实 id → 下一轮模型调用 → 再修改 | 跨轮次用例：搜索得到的 id 修改同一条 |
| 前置失败 | 失败结果照实回传；依赖它的后续写入不会成功 | “前置查询失败”用例终态为执行失败 |
| 停止 | 每次调用前检查请求作用域，停止后未开始的工具不执行 | 停止用例 + 集成场景 10 |

**边界说明**：同批次的“先查后改”不属于依赖执行；查询结果在整批结束前不可见。跨轮次才具备“读取上一步真实结果”的能力。

## 四、.gitignore 改动

- 删除 `tests ` 这一行（尾部空格导致测试目录被忽略）。
- 保留 `.test-build`、`.preview`、`.workbuddy`、`*.sw?` 等既有规则，未做其他删除或放宽。
- `git check-ignore -v tests/agentExecution.test.ts` 无输出（退出码 1），确认不再被忽略。

## 五、测试文件纳入版本管理

- 已 `git add` 的测试相关文件：`tests/agentExecution.test.ts`、`agentTools.test.ts`、`deleteExecution.test.ts`、`helpers.ts`、`prompts.test.ts`、`reminderAlarms.test.ts`，以及 `scripts/` 下全部测试脚本。
- `tests/` 目录下无缺失文件；`tsconfig.test.json` 原本已跟踪。
- 干净环境验证：删除 `.test-build` 后执行 `pnpm test:agent`，105 项全部通过（18 个 suite）。
- 当前为已暂存、未提交状态，等待人工验收后统一提交。

## 六、Mock SSE 集成测试结果

设施：本地 Node HTTP 服务按 OpenAI Chat Completions 流式格式返回 SSE；真实 `useAssistantStore.send`、真实工具执行器与真实 `MemoryEntryRepository`（FakeStorage）参与，无浏览器、无第三方依赖。

| # | 场景 | 结果 |
| --- | --- | --- |
| 1 | 搜索便签并总结，无写入 | 通过 |
| 2 | 跨轮次：搜索 → 真实 id → 修改同一条 | 通过 |
| 3 | 同一批创建 3 个待办，不互相覆盖 | 通过 |
| 4 | 提醒多闹钟且目标不明确：不写入，标记等待补充 | 通过 |
| 5 | 删除：只生成确认卡片，数据仍在 | 通过 |
| 6 | 普通聊天：0 次工具调用、0 写入 | 通过 |
| 7 | 工具失败：终态 failed，如实反馈 | 通过 |
| 8 | 轮次上限：9 次请求、8 步、附加未完成提示、终态 partial | 通过 |
| 9 | 同批次猜测 id：修改失败且不写入 | 通过 |
| 10 | 停止：立即清除 loading，后续工具不执行 | 通过 |

**合计：10/10 通过**（`pnpm test:integration`）。

## 七、真实模型验收结果

配置：本机配置「推理-Doubao-Seed-Evolving」，模型 `VOLCENGINE_ENDPOINT_ID`，端点 `ark.cn-beijing.volces.com`。API Key 仅在进程内存使用，未打印、未写入文件或版本库。

> 说明：本节为**脚本驱动的真实模型验收**（真实网络请求、真实 store/工具/仓储），不是 Mock SSE，也不是人工点击 UI 的验收；UI 验收见第八节。

| # | 场景 | 结果 | 实测证据 |
| --- | --- | --- | --- |
| 1 | 搜索便签并总结 | 通过 | 1 步 `search_notes`，阶段 done，2 条数据未写入 |
| 2 | 搜索后修改指定记录 | 通过 | 2 步 `search_notes`、`update_entry`，标题变为「项目周报（终稿）」 |
| 3 | 创建三个待办 | 通过 | 待办=提交报销、整理会议纪要、写周报，无确认卡片 |
| 4 | 修改目标不明确的提醒 | **未通过** | 模型未追问，自行把「每天」闹钟改到次日 10:00；阶段 done，步骤 `get_note:ok,update_entry:ok` |
| 5 | 删除记录 | 通过 | 1 张确认卡片，条目仍在，阶段 done |
| 6 | 普通聊天不产生写操作 | 通过 | 0 个工具步骤，条目数不变 |
| 7 | 工具失败如实反馈 | 通过 | 阶段 failed，步骤 error，回复含失败原因 |
| 8 | 达到轮次上限 | 通过 | 8 个执行步骤，附加未完成提示，阶段 partial |

**合计：7/8 通过**。完整两轮运行结果一致（均为场景 4 失败）；场景 4 单独重跑一次通过，说明是模型行为不稳定而非确定性代码缺陷。

场景 4 失败详情：初始数据为一条「喝水提醒」，含 `daily` 与 `weekly` 两个闹钟。提示词规则 6/13 已要求“目标不唯一时先询问”，但模型直接选择 `daily` 闹钟并调用 `update_entry`。修改通过 Phase 2 的参数校验（真实 id、真实 alarm_id），因此**不是安全绕过**，而是模型未遵守歧义追问规则。

未执行项：无。场景 4 明确标记为未通过，未计为通过。

## 八、UI 人工验收结果

在 `http://127.0.0.1:1424` 的真实页面上逐项检查（未重新设计 UI）：

| 项目 | 结果 |
| --- | --- |
| 8 个阶段徽标（understanding/searching/executing/composing/done/partial/failed/needs_input） | 正常显示，进行中带动态点，配色与文案正确 |
| 执行记录展开/收起 | 正常，显示「执行记录 · N 步」与真实 effect 小结 |
| 新建/修改 | 不出现额外确认卡片，直接执行 |
| 删除 | 仍只出现删除确认卡片，未确认前数据保留 |
| 部分成功 | 徽标为「部分完成」，失败的步骤单独标记 |
| 停止 | 点击后 loading 立即清除，后续工具不再执行 |
| 浅色主题 | 正常；修复了语义色对比度不足（见下） |
| 暗色主题 | 正常 |
| 系统主题 | 正常，随系统解析为浅色/暗色（本机 system → light） |

**实际发现并修复的问题**：浅色纸面上警示文字 `#F5B942` 对比度仅 1.58:1，成功/危险色亦低于 4.5:1，小字号徽标不可读。修复方式为新增**文字专用** token（`--memora-warning-text` / `--memora-success-text` / `--memora-danger-text`），原品牌色 token 保持不变，仅 `AssistantPanel` 的文字与小图标引用新 token。

| 主题 | warning | success | danger |
| --- | --- | --- | --- |
| Light | 5.66:1 | 6.17:1 | 5.83:1 |
| Dark | 10.05:1 | 8.47:1 | 7.26:1 |

（同一容器背景实测；徽标 12% 染色底上 Light warning 实测 5.32:1，均 ≥4.5:1。）

## 九、测试与构建结果

| 项目 | 结果 |
| --- | --- |
| `pnpm test:agent` | **105 通过 / 0 失败**（18 suite，105 项；本阶段新增 4 个依赖用例 + 2 条提示词断言） |
| `pnpm test:integration` | **10 通过 / 0 失败**（本阶段新增） |
| `tsc -p tsconfig.app.json --noEmit` | 通过，无输出 |
| `pnpm lint` | 0 warning / 0 error（119 文件） |
| `pnpm build` | 通过（45.84s；仅已有 chunk 体积提示） |
| `pnpm tauri:build` | 通过；`target/release/bianqian.exe`；安装包 `MEMORA_0.2.0_x64-setup.exe`（5.09 MiB） |

自动化测试总量：105 单元 + 10 集成 = **115**；Phase 3 结束时为 101，本阶段净增 14 项。

## 十、遗留问题

1. **场景 4 模型不稳定**：同一条歧义提示词下，模型时而追问、时而自行选择闹钟。提示词规则 6/13 已明确要求追问；执行器无法从参数区分“用户指定”与“模型猜测”，因此未增加硬性拦截（否则会误伤合法的指定修改）。建议后续通过加强提示词或前端二次确认解决，需产品决策。
2. **`.installer-test/`** 仍为未跟踪的安装验证产物，未纳入本次改动。
3. 当前改动已暂存但未提交，等待人工验收。
4. 真实模型验收结果受模型随机性影响，本轮记录为两轮完整运行 + 一次单独重跑。

## 验收状态

- 同批次串行执行与跨轮次依赖已区分并有测试锁定。
- 查询结果只通过 `role:'tool'` 消息在下一轮传给模型；后续工具使用真实 id。
- 测试文件已纳入 Git，可在干净环境重复运行。
- 真实模型结果与 Mock/单元测试分开记录，密钥未落盘。
- Phase 2 安全规则保持不变：创建/修改无额外确认，删除仅生成卡片，猜 id 失败，停止后不再执行。
- 未自动进入下一阶段，等待人工验收。
