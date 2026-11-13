import type { AiToolDefinition } from '../types/ai'

/**
 * Agent 工具定义与提示词：纯常量，不依赖 store，便于静态校验与测试。
 */

export const AGENT_TOOLS: AiToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'search_notes',
      description:
        '按关键词搜索用户的便签（备忘/待办/提醒），返回标题、类型、id、状态与内容摘要。需要引用具体便签 id 时使用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词，匹配标题、正文与标签（≤100 字）' },
          kind: {
            type: 'string',
            enum: ['note', 'todo', 'reminder'],
            description: '限定便签类型，可选；不传则搜全部类型',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_todos',
      description:
        '列出当前未完成的待办，含每条的子任务完成度与未完成子任务清单。用户问「我有哪些待办/任务」时使用。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_reminders',
      description:
        '列出待触发的提醒（按时间从近到远），含下次提醒时间与闹钟模式。用户问「最近有什么提醒/日程」时使用。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_note',
      description:
        '按 id 读取单条便签的完整内容（正文上限 1500 字）。提醒条目会返回每个闹钟的 alarm_id、模式与时间，修改提醒时间前先用它确认目标闹钟。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '便签 id，来自 search_notes 或上下文摘要' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_entry',
      description:
        '新建一条便签并立即生效（无需用户确认）。kind=reminder 时 remindAt 必填且必须晚于当前时间；「半小时后」「明早」等相对时间先按当前时间换算成具体时刻。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['note', 'todo', 'reminder'], description: '便签类型' },
          title: {
            type: 'string',
            description: '简明标题（1–120 字），不要把时间写进标题',
          },
          content: { type: 'string', description: 'Markdown 正文（≤4000 字），可选' },
          remindAt: {
            type: 'string',
            description: '仅 reminder：提醒时间，格式 YYYY-MM-DDTHH:mm（用户本地时间）',
          },
          items: {
            type: 'array',
            items: { type: 'string' },
            description: '仅 todo：子任务文本数组（最多 20 项），可选',
          },
        },
        required: ['kind', 'title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_entry',
      description:
        '修改已有便签并立即生效（无需用户确认）：改标题、替换或追加正文、勾选或新增待办子任务、修改提醒时间、增减标签。至少提供一个修改字段；不支持的字段会被拒绝。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '便签 id，来自 search_notes 或上下文摘要' },
          title: { type: 'string', description: '新标题（整体替换，1–120 字），可选' },
          content: { type: 'string', description: '新正文（整体替换，≤4000 字），可选' },
          append_content: { type: 'string', description: '追加到现有正文末尾的文本，可选' },
          complete_items: {
            type: 'array',
            items: { type: 'string' },
            description: '仅 todo：要勾选的现有子任务文本（必须与现有文本完全一致），可选',
          },
          add_items: {
            type: 'array',
            items: { type: 'string' },
            description: '仅 todo：新增的子任务文本（不能与已有子任务重复），可选',
          },
          remind_at: {
            type: 'string',
            description:
              '仅 reminder：新的提醒时间，格式 YYYY-MM-DDTHH:mm，必须晚于当前时间。只改动目标闹钟的时间并保留它原有的重复规则（单次/每天/每周/每月/每年/农历/循环），不会把重复提醒降级为单次',
          },
          alarm_id: {
            type: 'string',
            description:
              '仅 reminder：要修改的闹钟 id（先用 get_note 获取）。该提醒有多个待触发闹钟时必须指定；只有一个时可不传',
          },
          add_tags: {
            type: 'array',
            items: { type: 'string' },
            description: '要添加的标签（每个 ≤24 字），可选',
          },
          remove_tags: {
            type: 'array',
            items: { type: 'string' },
            description: '要移除的现有标签，可选',
          },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_entry',
      description:
        '请求删除一条便签。调用后界面会出现删除确认卡片，用户点击确认才移入废纸篓（可恢复）；你不应假设删除已完成，确认结果由用户操作决定。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '要删除的便签 id' },
        },
        required: ['id'],
      },
    },
  },
]

/** system prompt 中追加的工具使用说明（仅在工具可用时附加） */
export const AGENT_TOOL_PROMPT = [
  '你可以通过工具直接操作用户的便签数据，不必再让用户手动确认（删除除外）：',
  '1. 查询：search_notes 关键词搜索、list_todos / list_reminders 列出待办与提醒、get_note 按 id 读全文。直接调用即可。',
  '2. 新增：create_entry 创建备忘 / 待办 / 提醒，调用后立即生效，不要再输出确认卡片或让用户再确认。',
  '3. 修改：update_entry 改标题、替换或追加正文、勾选或新增待办子任务、修改提醒时间、增减标签，调用后立即生效。',
  '4. 删除：delete_entry 只会生成删除确认卡片，用户点击确认后才移入废纸篓。调用后必须如实说明「等待用户确认」，绝不能声称已经删除。',
  '5. 结果以工具返回为准：工具返回什么就向用户反馈什么；工具返回「错误：…」时如实说明失败原因，不要编造成功结果或虚构未返回的数据。',
  '6. 修改提醒时间时先 get_note 读取闹钟：该提醒有多个待触发闹钟而用户没有指明改哪一个时，必须先询问用户，再用 alarm_id 指定；remind_at 会保留该闹钟原有的重复规则（每天 / 每周 / 每月 / 农历等），不要为了改时间而把重复提醒改成单次。',
  '7. 修改只传需要变更的字段，不要传 id / createdAt / deletedAt 之类的受保护字段；参数不符合要求时工具会返回错误，按错误提示修正后重试，不要猜测。',
  '8. 批量任务（如「把这周的提醒整理成待办」「给这几条备忘补充内容」）：先用检索工具确认目标清单，再逐条调用写入工具，全部执行完后再总结结果；一次回复里可以同时发起多个工具调用。',
  '9. 回答中提到具体便签时，用 <note-ref data-id="便签id">便签标题</note-ref> 标记；id 必须来自工具结果或 <notes>，不要虚构。',
  '10. 不要再输出 <action> 块（那会导致重复操作），也不要向用户复述工具调用过程。',
].join('\n')

/** 工具不可用（模型不支持 function calling / 用户关闭上下文）时的降级说明 */
export const NO_TOOL_PROMPT = [
  '当前会话没有可用的便签工具，你只能基于提供的上下文回答问题，不能执行任何新增、修改或删除。',
  '不要输出 <action> 块，也不要声称已经创建、修改或删除任何便签；如需写操作，请说明当前模型或设置不支持，并建议用户更换支持工具调用的模型或手动操作。',
].join('\n')
