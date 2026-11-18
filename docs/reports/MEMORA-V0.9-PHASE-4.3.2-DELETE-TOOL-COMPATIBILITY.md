# MEMORA V0.9 Phase 4.3.2 OpenAI Fast 删除工具调用兼容性修复报告

- 日期：2026-11-17
- 对象：Phase 4.3.1 真实模型验收中 `openai-fast` 明确删除请求未调用 `delete_entry`、只输出文本伪确认的问题
- 目标链路：用户明确提出删除 → 识别删除意图 → 模型调用 `delete_entry` → 执行层校验目标与权限 → 生成真实 ActionCard → 用户点击确认 → 执行删除 → 回读验证 → 返回真实结果
- 测试隔离：Vite SSR 加载真实 store / 执行层 / 仓储源码 + FakeStorage + MemoryEntryRepository；未连接、未修改真实 SQLite 用户数据
- 结论：**PASS**（Tool Calling 探测 + A–F 场景通过；详细结果见第 9 节）

---

## 1. 原因分析

### 1.1 失败链路复现

原始失败请求：

```text
删除「阶段7待删除」这条便签。
```

模型回复只有文本伪确认，没有工具调用：

```text
❓**确认删除**
您确定要删除标题为「阶段7待删除」的备忘吗？请回复 **“确认删除”** 或 **“取消”**。
```

该请求没有生成 ActionCard，条目没有删除，也没有进入废纸篓。用户点击文本无法触发任何真实删除。

### 1.2 直接原因一：意图层把标题同位语当成“未解析指代”

`analyzeAssistantIntent` 原先只要看到「这条 / 这条便签」等指代词，就要求当前存在选中项或唯一解析的历史指代；否则返回 `referent_ambiguous` 并强制只读。

但删除句里的「这条」是标题的同位语：

```text
删除「阶段7待删除」这条便签。
```

它并不依赖选中项或历史指代。原逻辑因此把明确的写请求降级为只读，`planAssistantTools` 只下发 `search_notes / list_todos / list_reminders / get_note`，系统提示词也换成 `READ_ONLY_TOOL_PROMPT`。模型在只读工具集下无法调用 `delete_entry`，只能输出文本确认。

真实模型探针直接验证了这一点：

- 下发完整写工具时：`finish_reason=tool_calls`，调用 `delete_entry({"id":"p7-note"})`；
- 只下发查询工具时：`finish_reason=stop`，无工具调用，回复正是上面这段文本伪确认。

所以这不是 `openai-fast` 不支持删除工具，而是本轮工具范围被错误地降成了只读。

### 1.3 直接原因二：取消后重新删除仍被历史指代强制只读

修完意图层后，场景 A–C 暴露出第二处问题：A 的删除卡片被取消后，C 再次发送：

```text
删除「阶段7待删除」这条便签。
```

此时历史里已有上一轮消息和已取消的删除卡片。`collectMemoryEntities` 明确不把 `delete` 效果计入对话记忆实体，因此「这条」无法从记忆解析，`resolveConversationReferent` 返回 `missing`，产生 `referentQuestion`。store 随后以 `forceReadOnly: referentQuestion !== null` 覆盖了本轮的明确目标，模型再次只拿到只读工具。

也就是说：当前消息本身已经唯一命中真实条目，却因为历史指代解析失败被强制只读。

### 1.4 修复原则

- 只在“当前消息已唯一命中真实条目”时，跳过标题同位语 / 历史指代带来的强制只读；
- 不改变“历史 id 不是写授权”的规则；
- 不改变“删除必须先确认”的规则；
- 不增加“检测到删除意图就直接删除”的快捷路径；
- 不通过放宽执行层白名单、目标来源校验或权限校验来让删除通过。

## 2. 真实模型请求和响应证据（脱敏）

### 2.1 配置

| 项目 | 实际值 |
| --- | --- |
| 当前激活配置 | `free:pollinations:openai-fast` |
| 展示名称 | GPT-OSS 20B（匿名） |
| 来源 | Pollinations |
| 模型名 | `openai-fast` |
| Base URL | `https://text.pollinations.ai/openai` |
| 鉴权 | 无需密钥（未读取、未输出任何密钥） |
| 配置来源 | `%APPDATA%/com.bianqian.desktop/ai-config.json` 的 `active_id` |

### 2.2 写工具集下的真实删除工具调用

请求使用真实 `AGENT_TOOL_PROMPT` 与 `AGENT_TOOLS`，`stream: true`、`tool_choice: auto`，工具列表包含：

```text
search_notes, list_todos, list_reminders, get_note, create_entry, update_entry, delete_entry
```

脱敏后的响应：

```json
{
  "status": 200,
  "elapsedMs": 4810,
  "finish": "tool_calls",
  "toolCalls": [
    {
      "id": "chatcmpl-tool-87d74c3e25e382da",
      "name": "delete_entry",
      "arguments": "{\"id\":\"p7-note\"}"
    }
  ],
  "content": ""
}
```

结论：`openai-fast` 能够流式返回 `delete_entry` 工具调用，名称与参数 JSON 完整。

### 2.3 只读工具集下的文本伪确认

同一提示词、同一模型，仅把工具范围收窄为查询工具后：

```json
{
  "status": 200,
  "elapsedMs": 4117,
  "finish": "stop",
  "toolCalls": [],
  "content": "❓**确认删除**\n您确定要删除标题为「阶段7待删除」的备忘吗？请回复 **“确认删除”** 或 **“取消”**。"
}
```

结论：文本伪确认是只读工具范围下的必然表现，与模型是否支持 Tool Calling 无关。

### 2.4 修复后的真实链路

完整套件中场景 A–C 使用同一个 `openai-fast` 配置，真实 Agent Loop 结果：

```text
PASS A：卡片=1（0）且确认前未删除；B：取消后主列表保留、旧卡片=cancelled；
C：新卡片=1，确认后进入废纸篓，重复确认=done
```

对应的工具步骤均为 `delete_entry:confirm`，未出现确认前 `delete_entry:ok`，也没有绕过确认直接删除。

## 3. 修改文件及修复说明

| 文件 | 修改 |
| --- | --- |
| [src/services/assistantIntent.ts](../../src/services/assistantIntent.ts#L246) | 新增 `IntentContext.hasExplicitTarget`；当前消息唯一命中真实条目时，不再把「这条」当作未解析的选中项 / 历史指代，删除意图回到 `explicit_write` |
| [src/store/useAssistantStore.ts](../../src/store/useAssistantStore.ts#L299) | 在指代解析前计算显式目标；`selectedReferentWrite || hasExplicitTarget` 时跳过 `resolveConversationReferent`，避免取消卡片后的历史 `missing` 把本轮强制降为只读；并把 `hasExplicitTarget` 传入意图分析 |
| [src/services/agentToolSchema.ts](../../src/services/agentToolSchema.ts#L147) | 强化 `delete_entry` 描述与第 4 条提示：明确要求立即调用、不要输出文本按钮、取消后再次明确要求时重新调用、调用后只能等待用户确认 |
| [src/services/assistantContext.ts](../../src/services/assistantContext.ts#L179) | 基础系统提示明确：新增和普通修改直接执行；删除必须通过 `delete_entry` 生成确认卡片并由用户点击后执行 |
| [tests/assistantIntent.test.ts](../../tests/assistantIntent.test.ts#L160) | 新增标题同位语、显式目标优先、无显式目标“删除这条”仍只读的单元测试 |
| [tests/prompts.test.ts](../../tests/prompts.test.ts#L50) | 补充删除工具描述、完整提示词与只读提示词的新约束断言 |
| [scripts/integration/harness.mjs](../../scripts/integration/harness.mjs#L184) | 新增 `cancelDelete` 模拟用户取消；`reset()` 同步清空 `entries.trash`，修复场景间测试状态泄漏 |
| [scripts/run-integration-tests.mjs](../../scripts/run-integration-tests.mjs#L544) | 新增“显式标题中的‘这条’是同位语：取消后重新删除仍下发写工具”的 Mock SSE 集成测试 |
| [scripts/run-real-model-acceptance.mjs](../../scripts/run-real-model-acceptance.mjs#L641) | 新增 Phase 4.3.2 删除场景 A–F；输出实际配置 ID；场景套件可独立选择 |

未修改：

- Agent Loop 主流程；
- `delete_entry` 的执行路径与 `confirmDeleteProposal` / `cancelDeleteProposal`；
- 执行层权限、目标来源、同名歧义、重试签名与已执行调用校验；
- SQLite schema；
- Rust SSE 代理；
- 创建与普通修改直接执行的规则；
- 模型配置、Base URL、API Key；
- 依赖与 Agent 框架。

## 4. 工具调用兼容性结果

| 检查项 | 结果 |
| --- | --- |
| 当前工具列表包含 `delete_entry` | 是（写意图下 7 个工具全部下发） |
| 删除 JSON Schema | `{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}`，模型可直接生成 |
| `tool_choice` | 未强制，保持上游支持的 `auto`；真实探测与场景均能正常返回工具调用 |
| 流式 `tool_calls` 聚合 | 按 `index` 拼接 `id / name / arguments`，跨 chunk 参数完整 |
| 工具名归一化 | 仅精确命中本轮白名单时归一化；未放宽未注册名称的拦截 |
| 参数 JSON | 场景中 `delete_entry` 参数完整，解析后目标 id 与真实条目一致 |
| 多轮状态交接 | A/C 均为“工具调用轮 + 结果总结轮”；A 的确认结果不会被 C 当作已删除 |
| 只读范围 | 无显式目标或指代歧义时仍只下发 4 个查询工具，`delete_entry` 不可见 |

## 5. ActionCard 生成结果

`delete_entry` 执行路径保持原安全边界：

- 先按当前权限、目标来源与同名歧义校验目标；
- 通过后调用 `createDeleteProposal`，返回 `status: 'confirm'` 与 `confirmAction`；
- 不调用 `moveToTrash`，不修改仓储；
- 卡片绑定真实 `targetId` 与 `kind`。

真实场景结果：

- A：生成 1 张卡片，`targetId = p432-target`，确认前主列表仍为 1 条、废纸篓 0；
- C：取消后重新请求，生成新的 1 张卡片，目标仍为 `p432-target`；
- D / E / F：卡片数均为 0。

## 6. 用户确认和取消结果

| 操作 | 结果 |
| --- | --- |
| B 取消 | 主列表保留目标，废纸篓为 0；旧卡片再次确认返回 `cancelled`，不会删除 |
| C 确认 | 目标离开主列表并进入废纸篓；再次确认同一卡片返回 `done`，不会重复删除 |
| 确认前 | 不存在 `delete_entry:ok` 步骤，仓储未发生删除 |
| 历史卡片 | 已取消 / 已完成的卡片不能恢复为可执行状态 |

## 7. 删除前后真实仓储状态

测试使用 `FakeStorage + MemoryEntryRepository`，每个场景重新导入隔离数据，未触达真实用户数据。

| 阶段 | 主列表 | 废纸篓 | 说明 |
| --- | --- | --- | --- |
| A 初始 | 1 | 0 | `p432-target` 存在 |
| A 生成卡片后 | 1 | 0 | 未删除 |
| B 取消后 | 1 | 0 | 旧卡片不可再执行 |
| C 确认后 | 0 | 1 | 目标进入废纸篓 |
| C 重复确认 | 0 | 1 | 返回 `done`，数量不变 |
| D 模糊删除后 | 2 | 0 | 不猜测、不生成卡片 |
| E 历史目标后 | 1 | 0 | 历史 id 未触发删除 |
| F 普通咨询后 | 3 | 0 | 无写入、无卡片 |

## 8. 单元测试与集成测试结果

```text
pnpm test:agent        # 279 pass / 0 fail（42 suites）
pnpm test:integration  # 40 pass / 0 fail（Mock SSE）
pnpm lint              # 0 warnings / 0 errors（140 files）
pnpm build             # 成功（47.71s；仅有既存 chunk > 500kB 警告）
```

新增 / 更新的确定性测试：

- `tests/assistantIntent.test.ts`：标题同位语不再被降为只读；显式目标优先于选中项；无显式目标时仍要求澄清并保持只读。
- `tests/prompts.test.ts`：删除工具描述、完整提示词、只读提示词的新约束。
- `scripts/run-integration-tests.mjs`：取消后以“标题 + 这条”重新删除时，仍下发完整写工具并生成真实确认卡片，且确认前不落库。

## 9. 真实模型测试结果

真实模型调用与 Mock SSE 分开统计。真实调用统一使用 `free:pollinations:openai-fast`（模型 `openai-fast`，Pollinations）。

| # | 场景 | 结果 | 关键证据 |
| --- | --- | --- | --- |
| 0 | Tool Calling 探测 | PASS | `finish=tool_calls`，`search_notes({"query":"周报"})` |
| A | 明确删除生成真实卡片 | PASS | `delete_entry:confirm`；卡片 1 张；确认前未删除、未进废纸篓 |
| B | 取消不删除 | PASS | 主列表保留；废纸篓 0；旧卡片确认返回 `cancelled` |
| C | 取消后重新请求并确认 | PASS | 新卡片 1 张；确认后主列表 0、废纸篓 1；重复确认 `done` |
| D | 模糊删除 | PASS | 不猜测目标；卡片 0；删除工具 0；询问具体目标 |
| E | 历史目标 | PASS | 历史 id 不构成授权；条目保持 1；卡片 0；删除工具 0 |
| F | 普通咨询 | PASS | 只查询 / 建议；条目保持 3；卡片 0；无成功写入 |

本次完整套件实际输出（`pnpm test:real`，默认 `delete` 套件，探测未跳过）：

```text
[0] Tool Calling 兼容性探测 ...
  PASS openai-fast 支持 Tool Calling（search_notes，finish=tool_calls，参数={"query":"周报"}，1272ms）

[1/4] 场景A-C 删除确认链路：取消不删，确认只删一次 ...
  PASS A：卡片=1（0）且确认前未删除；B：取消后主列表保留、旧卡片=cancelled；C：新卡片=1，确认后进入废纸篓，重复确认=done
[2/4] 场景D 模糊删除：不猜测目标，不生成错误提案 ...
  PASS 条目保持 2；卡片=0；删除工具=0；询问=请问您想删除哪一条便签？…（指出旧笔记甲 / 旧笔记乙）
[3/4] 场景E 历史目标：历史中的 id 不能直接触发删除 ...
  PASS 条目保持 1；废纸篓=0；卡片=0；删除工具=0
[4/4] 场景F 普通咨询：只查询或建议，不生成删除卡片 ...
  PASS 条目保持 3；卡片=0；写入=0；步骤=无

# pass 5
# fail 0
```

真实请求耗时（首字 / 总耗时）：

| 请求 | 首字 | 总耗时 |
| --- | --- | --- |
| Probe | — | 1.3s |
| A 明确删除 | 48.2s | 48.7s |
| C 取消后重新删除 | 5.5s | 5.7s |
| D 模糊删除 | 3.0s | 4.5s |
| E 历史目标 | 48.4s | 48.9s |
| F 普通咨询 | 5.4s | 7.0s |

以上 6 次请求均为真实 `openai-fast` SSE 调用；第 8 节的 40 项集成测试全部使用本地 Mock SSE，不混入本节统计。场景 B 的取消和场景 C 的确认是 harness 对 ActionCard 回调的真实调用，不额外消耗模型请求。

## 10. 已知限制与 Git 状态

### 10.1 已知限制

- Pollinations 匿名层延迟波动明显：本次真实运行中曾出现首字 137.7s、70.1s、48.7s、3.0s 等不同量级；场景超时设置为 900s。
- 免费匿名额度与并发受限；一次完整套件被中途停止后，残留 node 子进程仍占用端口并继续请求，已手动终止该子进程。该问题只影响本地验收，不影响业务代码。
- 场景 D 的首轮完整套件失败源于测试夹具 `reset()` 未清空 `entries.trash`，造成上一场景废纸篓状态泄漏；已在 harness 修复并重跑，业务代码未因此改动。
- 真实验收通过 harness 调用 `confirmDeleteProposal` / `cancelDeleteProposal` 模拟用户点击 ActionCard，未驱动桌面端真实鼠标点击；React UI 渲染与点击绑定另由既有集成测试覆盖。
- `pnpm build` 存在既存的 chunk 体积警告，本阶段未做代码拆分。

### 10.2 Git 状态

- 未提交、未推送、未执行 reset / clean / checkout 等破坏性 Git 操作。
- 工作区包含 Phase 4.3.2 修改以及此前阶段尚未提交的改动；`.preview/` 为本地忽略目录，未纳入版本库。
- 未进入 Phase 4.4。
