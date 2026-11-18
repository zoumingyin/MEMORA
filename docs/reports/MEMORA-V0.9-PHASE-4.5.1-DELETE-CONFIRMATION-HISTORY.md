# MEMORA V0.9 Phase 4.5.1 删除确认历史闭环实施报告

## 一、结论

Phase 4.5.1 已完成。删除确认卡片现在携带真实的 `executionId`、`stepId`、`proposalId`，用户取消、确认成功、确认失败都会回写到生成该卡片的历史步骤与记录；业务删除仍只通过原 `confirmDeleteProposal` 的一次性提议授权执行，历史回写不参与、也不产生任何业务写入或新授权。

最终判定：**CONDITIONAL PASS**。条件为：

1. 本机当前激活模型是 Doubao（`p1793850069851`），不是任务书指定的 `free:pollinations:openai-fast`。按任务书要求，本次**没有执行**真实模型验收，也没有静默切换或修改模型配置。
2. 未在最新安装包内进行人工桌面点击验收；本报告对 12 项桌面验收逐项标注真实状态，未把浏览器预览或集成测试冒称桌面人工结果。

自动化结果：

- 单元测试：**322 通过 / 0 失败**（53 suites，新增 8 个删除确认历史回写测试）
- Mock SSE 集成测试：**66 通过 / 0 失败**（新增 5 个删除确认历史闭环场景）
- `pnpm lint`：**0 warning / 0 error**（154 文件）
- `pnpm build`：通过
- `cargo check`：通过（20.53s）
- `pnpm tauri:build`：通过，产出 `MEMORA_0.2.0_x64-setup.exe`（**5,368,679 字节**，5.12 MiB）
- migration 9 SQL 已在独立内存 SQLite 中验证：旧表可成功新增 `proposal_id` 并更新。

## 二、关联模型

### 2.1 为什么可以可靠关联

现有链路已经具备三个稳定 id，不需要标题模糊匹配：

- `executionId`：本次 Agent 请求的 `requestId`，同时也是 `AgentExecutionRecord.id`。
- `stepId`：执行历史记录器使用确定性格式 `${executionId}:${toolCallId}`。
- `proposalId`：`createDeleteProposal()` 生成的一次性删除提议 id。

`delete_entry` 在生成卡片时由执行器同时拿到 `scope.requestId` 与 `call.id`，因此可以精确写出：

```text
executionId = scope.requestId
stepId      = `${scope.requestId}:${call.id}`
proposalId  = proposal.id
targetId    = entry.id
```

这些字段只用于历史对账，不参与权限判断，也不能让任何旧提议恢复执行。

### 2.2 数据变化

- `AssistantAction` / `ToolConfirmAction` / `AssistantToolStep` 增加可选 `executionId`、`stepId`、`proposalId` 字段。
- `AgentExecutionStep` 增加可选 `proposalId`。
- `agent_execution_steps` 增加 `proposal_id` 列（migration 9，`ALTER TABLE ... ADD COLUMN proposal_id TEXT`）。
- 旧消息 / 旧历史没有这些字段时保持原行为：不关联、不回写、不伪造成功。

### 2.3 确认卡片生成

`agentToolExecutor.deleteEntry()`：

- 仍先校验目标真实存在、来源可信、权限允许；
- 仍只生成 `pending` 删除提议，不调用 `moveToTrash`；
- 在 `confirmAction` 中写入真实 `executionId`、`stepId`、`proposalId`、`targetId`；
- 历史记录器在 `stepFinished()` 时把 `proposalId` 写入同一条真实步骤。

## 三、回写规则

新增 `src/services/deleteConfirmationHistory.ts`，只在 Agent Loop 外被界面调用：

### 3.1 精确匹配

回写前必须同时满足：

1. `executionId`、`stepId`、`proposalId`、`targetId` 都存在；
2. 历史记录存在；
3. 步骤 id 与 `stepId` 完全一致；
4. 步骤工具名是 `delete_entry`；
5. 步骤的 `proposalId` 若存在，必须与卡片一致；
6. 步骤真实目标引用中包含 `targetId`。

任何一项不满足都安静返回 `false`，不创建记录、不修改业务数据、不影响用户已经完成的删除或取消。没有使用标题、模糊文本或最近记录匹配。

### 3.2 用户取消

- 业务层：`cancelDeleteProposal()` 将提议置为 `cancelled`，之后不能再执行。
- 历史层：对应步骤改为 `cancelled`，失败分类 `execution_cancelled`，输出摘要「用户取消删除，未移入废纸篓，便签没有变化。」
- 记录级状态重新推导；单删除步骤时为 `cancelled`，若同请求还有其他成功步骤则为 `partial`。
- 已成功的历史步骤不会被后来的取消降级。

### 3.3 用户确认成功

- 业务层：`confirmDeleteProposal()` 先 `claim` 一次性提议，再校验目标未变化，调用 `moveToTrash`，并回读确认目标已离开主列表。
- 历史层：对应步骤改为 `success`，输出摘要「用户已在界面确认删除，便签已移入废纸篓（可恢复）。」
- 记录级状态重新推导，成功计数更新；模型回复文字不参与判断。

### 3.4 用户确认失败

- 业务层返回真实 `reason`（`failed`、`missing`、`kind_changed`、`target_mismatch`、`expired`、`not_found` 等）。
- 历史层按真实 reason 写入 `business_execution_failed` / `target_not_found` / `execution_cancelled` 等分类；`failed` 的 `writeState` 为 `failed`。
- 记录级状态为 `failed` 或 `partial`，不会显示成功。
- 若用户重试后成功，同一步骤改为 `success`，旧失败分类被清除，不新增重复步骤。

### 3.5 重复点击与并发

- `busy`：业务层正在执行，历史不回写，避免制造中间结果。
- `done`：业务层已执行过，历史不回写，已有成功结果保持不变。
- 重复取消：步骤保持 `cancelled`，不会创建第二条记录。
- 已成功步骤不会被后来的取消或失败覆盖。

### 3.6 历史不存在 / 被删除

- 回写前 `getById()` 找不到记录时直接返回 `false`；
- 不重建已删除的历史记录；
- 业务删除仍按原提议授权流程执行，不受历史仓储影响。

## 四、安全不变量

1. **历史回写不调用 `moveToTrash`**：服务只依赖历史仓储的 `getById`、`getSteps`、`upsertStep`、`update`。
2. **历史回写不恢复授权**：不读取、不修改删除提议注册表；旧卡片重启失效规则不变。
3. **历史不能触发业务删除**：删除历史只删历史表，不触碰业务表。
4. **模型文字不决定结果**：成功 / 失败只来自 `confirmDeleteProposal` 的真实返回值。
5. **精确关联，不用模糊标题**：完全依赖 `executionId + stepId + proposalId + targetId`。
6. **闹钟候选授权未改动**：仍是一一次性、绑定目标和字段白名单的独立机制。
7. **旧卡片兼容**：缺少关联字段的旧卡片不会回写，历史保持 `needs_input`，绝不伪造成成功。
8. **历史写入失败不影响业务**：回写异常只记录诊断日志，不向界面抛出，不改变已经完成的删除。

## 五、修改文件清单

新增：

- `src/services/deleteConfirmationHistory.ts`
- `tests/deleteConfirmationHistory.test.ts`

修改：

- `src/types/ai.ts`：`AssistantAction`、`AssistantToolStep` 增加关联字段。
- `src/types/executionHistory.ts`：`AgentExecutionStep` 增加 `proposalId`。
- `src/services/agentToolExecutor.ts`：`ToolConfirmAction` 增加关联字段；`deleteEntry` 接收 `call.id` 并写出 `executionId` / `stepId`。
- `src/services/agentExecution.ts`：工具步骤携带 `proposalId`。
- `src/services/executionRecorder.ts`：步骤落盘 `proposalId`。
- `src/services/executionHistory.ts`：新增 `deriveStatusFromHistorySteps()`，供确认回写后从真实步骤重新推导状态。
- `src/components/AssistantPanel.tsx`：确认 / 取消后调用历史回写。
- `src/repository/sqliteExecutionRepository.ts`：读写 `proposal_id`。
- `src-tauri/src/lib.rs`：migration 9 增加 `proposal_id` 列。
- `scripts/integration/harness.mjs`：加载回写服务；确认 / 取消后等待历史落盘；增加删除失败注入与提议重置辅助。
- `scripts/run-integration-tests.mjs`：新增 5 个删除确认历史闭环场景。
- `scripts/run-real-model-acceptance.mjs`：删除场景等待取消历史；E 场景增加取消后的历史断言（本次未执行真实模型）。
- `tests/agentTools.test.ts`：断言确认卡片携带真实 `executionId` / `stepId`。
- `tests/executionHistory.test.ts`：增加从历史步骤推导 `needs_input` 的测试。

## 六、新增测试与结果

### 6.1 单元测试

`pnpm test:agent`：**322 pass / 0 fail**。

`tests/deleteConfirmationHistory.test.ts` 新增 8 项：

1. 确认成功后步骤与记录变为成功，并记录真实目标。
2. 用户取消后步骤与记录变为 `cancelled`，不伪造成功。
3. 业务失败记录真实 `business_execution_failed` 分类。
4. 重复确认不制造第二条步骤；失败后重试成功清除旧失败。
5. 已成功的删除不会被后来取消覆盖。
6. `busy` / `done` 不制造新的历史结果。
7. 关联缺失、提议不一致、目标不一致、记录不存在时安静跳过。
8. 历史记录被用户删除后，回写不会重建记录。

### 6.2 Mock SSE 集成测试

`pnpm test:integration`：**66 pass / 0 fail**。

新增 5 个场景：

1. **等待确认后取消**：卡片关联 id 与步骤一致；取消后步骤 / 记录均为 `cancelled`；旧卡片再次确认仍为 `cancelled`；删除历史后再次确认仍不删除。
2. **确认成功**：记录 / 步骤为 `success`，成功计数 1，便签进入废纸篓；重复确认返回 `done`，步骤数仍为 1。
3. **确认失败**：注入 `moveToTrash` 失败，记录为 `failed`，步骤分类 `business_execution_failed`；重试成功后清除失败并变为 `success`。
4. **旧卡片重启失效**：清空内存提议后确认返回 `not_found`，便签保留，历史不写成功。
5. **历史不存在**：先删除历史记录再确认，业务删除仍成功进入废纸篓，历史不会被重建。

## 七、完整回归

| 命令 | 结果 |
| --- | --- |
| `pnpm test:agent` | 322 pass / 0 fail |
| `pnpm test:integration` | 66 pass / 0 fail |
| `pnpm lint` | 0 warning / 0 error |
| `pnpm build` | 通过（`tsc -b && vite build`） |
| `cargo check --manifest-path src-tauri/Cargo.toml` | 通过（20.53s） |
| `pnpm tauri:build` | 通过（release 2m 17s） |
| migration 9 | 内存 SQLite 验证通过 |

安装包：

- 路径：`src-tauri/target/release/bundle/nsis/MEMORA_0.2.0_x64-setup.exe`
- 大小：**5,368,679 字节**（5.12 MiB）
- 构建时间：2026-11-18 09:28

## 八、真实模型验收

执行前检查本机激活配置：

- `activeId`：`p1793850069851`
- 配置：`推理-Doubao-Seed-Evolving`
- 模型：`VOLCENGINE_ENDPOINT_ID`
- 端点：`ark.cn-beijing.volces.com`

任务书要求：只有实际激活 `free:pollinations:openai-fast` 时才执行指定模型验收。当前激活模型不是该免费模型，因此：

- **未执行真实模型验收**；
- 未切换模型；
- 未修改 `ai-config.json`；
- 未为了通过验收改动任何模型配置。

本阶段的删除确认历史闭环已由 322 个单元测试和 66 个 Mock SSE 集成测试覆盖；真实模型行为不在本次验收结论中冒充通过。

## 九、桌面人工验收结果

未在最新安装包内进行人工点击。原因是：

1. 直接启动安装包会使用用户真实 `%APPDATA%\com.bianqian.desktop` 数据目录并执行 migration 9；为遵守“不覆盖用户已有数据、不使用真实 SQLite 做验收”的约束，本次没有启动真实用户数据环境。
2. 当前没有可用的隔离 Tauri 桌面测试账户 / 测试数据目录。
3. 浏览器预览只能验证 Web 层渲染，不能替代 Windows 安装包内的人工操作，因此没有把浏览器结果记作桌面人工通过。

逐项状态：

| # | 验收项 | 状态 | 说明 |
| --- | --- | --- | --- |
| 1 | 历史列表 | 未执行（桌面） | Phase 4.5 浏览器预览已复核渲染；本次未在安装包内点击 |
| 2 | 历史详情 | 未执行（桌面） | 同上 |
| 3 | 搜索 | 未执行（桌面） | 同上 |
| 4 | 状态筛选 | 未执行（桌面） | 同上 |
| 5 | 分页 | 未执行（桌面） | 同上 |
| 6 | 删除历史 | 未执行（桌面） | 集成测试验证只删历史、不动便签 |
| 7 | 清空历史 | 未执行（桌面） | 集成测试验证清空历史、不动便签 |
| 8 | 重启后历史持久化 | 未执行（桌面） | 本地仓储与 SQLite 代码路径已实现；未启动安装包 |
| 9 | 删除确认取消 | 未执行（桌面） | 集成测试验证 `cancelled` 回写与业务保留 |
| 10 | 删除确认成功 | 未执行（桌面） | 集成测试验证 `success` 回写与进入废纸篓 |
| 11 | 删除确认失败 | 未执行（桌面） | 集成测试验证失败分类与重试成功 |
| 12 | Light / Dark 主题 | 未执行（桌面） | 本阶段未修改主题系统 |

建议在隔离 Windows 用户或隔离测试数据目录中安装最新包后补做以上 12 项，再决定是否升级为无条件 PASS。

## 十、已知限制

1. **Phase 4.5 及更早生成的卡片没有关联字段**：历史仍保持 `needs_input`，不会回写成成功；新生成的卡片具备闭环。
2. **闹钟选择未纳入本次历史闭环**：本阶段只处理删除确认；闹钟候选仍保持原一次性授权机制，未改变。
3. **回写是“更新同一步骤”而非追加新工具步骤**：用户确认不是 Agent 工具调用，追加一个虚假工具步骤会破坏“只有真实进入执行链路的工具才形成步骤”的规则；因此用同一步骤的真实终态 + 记录摘要追加结果表达，不增加 `toolCount`。
4. **桌面人工验收未完成**：见第九节。
5. **指定免费模型未激活**：见第八节。

## 十一、Git 工作区状态

工作区包含 Phase 1–4.5.1 的既有未提交改动，本阶段未执行提交、未执行 reset / clean / checkout 等破坏性操作。

Phase 4.5.1 相关文件：

- 新增：`src/services/deleteConfirmationHistory.ts`、`tests/deleteConfirmationHistory.test.ts`
- 修改：`src/types/ai.ts`、`src/types/executionHistory.ts`、`src/services/agentToolExecutor.ts`、`src/services/agentExecution.ts`、`src/services/executionRecorder.ts`、`src/services/executionHistory.ts`、`src/components/AssistantPanel.tsx`、`src/repository/sqliteExecutionRepository.ts`、`src-tauri/src/lib.rs`、`scripts/integration/harness.mjs`、`scripts/run-integration-tests.mjs`、`scripts/run-real-model-acceptance.mjs`、`tests/agentTools.test.ts`、`tests/executionHistory.test.ts`

未连接用户真实 SQLite 数据；自动化测试与集成验收使用隔离仓储。

## 十二、停止声明

Phase 4.5.1 到此停止。未进入 Phase 5，未新增历史重放、历史授权恢复、闹钟选择历史闭环等超出本阶段范围的能力。
