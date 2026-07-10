/**
 * LLM-facing tool defs for the `agent_interaction` capability group.
 *
 * Schemas are hand-authored to keep the JSONSchema description prose under
 * tight control — derivation via `zodObjectToParamList` would lose the
 * per-property descriptions on nested items and enum constraints we want to
 * surface verbatim to the model.
 *
 * Description is the load-bearing piece: it must instruct the model WHEN
 * to use this tool (and when NOT to). Without strict guidance the model
 * will either over-trigger (asking trivial clarifications) or never use
 * it (because clarifications can also be done in plain prose).
 */

import {
  normalizeAnthropicToolSchema,
  normalizeOpenAIToolSchema,
} from './tool-schema'

export const AGENT_INTERACTION_TOOL_NAMES: readonly string[] = [
  'ask_user_questions',
  'agent_propose_handoff',
  'propose_specialist_blueprint',
  'confirm_specialist_blueprint',
  'rename_specialist_agent',
  'declare_completion_criteria',
] as const

const DECLARE_COMPLETION_CRITERIA_DESCRIPTION = [
  '在规划或执行早期，把你对「这个任务做到什么程度才算完成」的具体判断登记为补充验收标准（1-8 条，每条 ≤120 字符的可验证陈述）。任务承诺交付文件时，同时用 expected_outputs 声明每个最终文件目标。终态裁决时会逐项核对。',
  '',
  '何时使用：结果型任务（多步/研究/媒体/浏览器交易）在开工时就能写出比通用模板更具体的完成判据（如「产物落到 outputs 目录并给出路径」「三个来源交叉验证过再下结论」）。',
  '',
  '使用约束：',
  '- 重复调用是整组替换，不是追加；一次把当前认知下的完整标准列全。',
  '- 每条必须是可验证的一句话，不写抱负式空话（「做到最好」不合格）。',
  '- 系统模板标准不可被覆盖或降低；你的声明只能补充。',
  '',
  '不要使用的场景：direct_answer / 闲聊类回合；标准与系统模板完全重合时（不必重复声明）。',
].join('\n')

const DECLARE_COMPLETION_CRITERIA_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    criteria: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: {
        type: 'string',
        description: '一条可验证的完成标准（≤120 字符），如「产物文件已写入并回报绝对路径」。',
      },
      description: '本任务的补充验收标准，整组替换式登记。',
    },
    expected_outputs: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: '一个具体最终文件目标（≤200 字符），如 /Users/user/V/深读.md；不可只给目录。',
      },
      description: '本任务承诺交付的最终文件目标，整组替换；未承诺文件时省略。',
    },
  },
  required: ['criteria'],
  additionalProperties: false,
} as const

const ASK_USER_QUESTIONS_DESCRIPTION = [
  '向用户弹出一张「结构化问题卡」，最多 5 道题，用户答完后答案会作为 tool result 回灌给你。两种典型触发场景：',
  '',
  '1) **用户明确要求你反问** — 任何形如「反问我」「问我几个问题」「考考我」「采访我」「随便问我点什么」的请求，**必须**用这个工具来响应，而不是在普通回复里写一堆问题。用户已经在主动邀请被结构化提问。',
  '',
  '2) **任务含糊、关键参数缺失** — 用户的指令模糊到你无法直接动手（例："帮我做个东西"、"开始吧"），并且关键参数无法从对话历史 / 附件 / 当前文档推断时，用此工具一次性把关键缺口问清楚，避免一句话一句话拉扯。',
  '',
  '渲染端会把整组问题作为 inline 卡片插入聊天流；用户可用前进 / 后退导航在问题间切换，全部必答题答完后一次性提交，提交后卡片折叠保留在历史里。',
  '',
  '使用约束：',
  '- 每个 turn 最多调用 1 次；同一会话同时只允许 1 张未答完的卡（否则 errorKind=overlapping_card）。',
  '- 一次最多 5 道题，少而精。',
  '- 用户已经给过的信息，禁止再问；先看对话历史和附件。',
  '- 优先 single_choice / multi_choice；只有真正开放的问题用 free_text。',
  '- 不要把多个问题塞进同一条 free_text 让用户用分号分隔——拆成多道结构化题。',
  '',
  '不要使用此工具的场景：你只是想征求一句确认（直接说"我打算 X，对吗？"即可）、任务已经完成后只是问用户要不要继续调整（普通总结里一句话带过即可）、用户的请求本身就是答案、或问题可以通过 web_search / session_search 自行解决。',
].join('\n')

const QUESTION_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    id: {
      type: 'string',
      description: '问题唯一 id（如 q1 / timeline），用于将答案映射回原问题。1-64 字符。',
    },
    question: {
      type: 'string',
      description: '展示给用户的问题文本，1-500 字符。',
    },
    kind: {
      type: 'string',
      enum: ['single_choice', 'multi_choice', 'free_text'],
      description: '问题类型：single_choice = 单选 / multi_choice = 多选 / free_text = 自由文本。',
    },
    options: {
      type: 'array',
      items: { type: 'string' },
      description: '当 kind = single_choice / multi_choice 时必填，提供 2-8 个候选答案；free_text 题不允许出现该字段。',
    },
    placeholder: {
      type: 'string',
      description: '自由文本题的输入框 placeholder（最长 200 字）。',
    },
    required: {
      type: 'boolean',
      description: '是否必答；默认 true。设为 false 用户可跳过。',
    },
  },
  required: ['id', 'question', 'kind'],
  additionalProperties: false,
} as const

const ASK_USER_QUESTIONS_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      description: '要询问用户的 1-5 个问题，按数组顺序展示。',
      items: QUESTION_ITEM_SCHEMA,
    },
  },
  required: ['questions'],
  additionalProperties: false,
} as const

// EP3-A4 — handoff proposal. M4 advisory: proposes only, executes no
// external action; adoption is ALWAYS a user click on the card.
const PROPOSE_HANDOFF_DESCRIPTION = [
  '向用户提议把当前任务转办给一个已存在的专项 agent，弹出一张转办建议卡（采纳当前会话继续/拒绝）。这是建议性工具：你只能提议，采纳永远由用户点击决定，不存在无确认自动转办。',
  '',
  '何时使用：主 agent 会话的注入区列出了可转办的专项 agent，且当前请求明显落在某个专项 agent 的 charter 范围内。',
  '',
  '硬性约束：',
  '- user_request_verbatim 必须是用户原话逐字（从用户消息原文复制），禁止转述、改写或摘要——违反会被结构化拒绝。',
  '- context_refs 只传引用（文件路径/卡片 slug/任务 id），不传转述内容。',
  '- target_agent_id 必须是 agents 表中已存在且 active 的专项 agent。',
  '- 用户拒绝后，本轮不要再次提议。',
].join('\n')

const PROPOSE_HANDOFF_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    target_agent_id: {
      type: 'string',
      description: '目标专项 agent 的 id（来自注入区的专项 agent 列表）。',
    },
    reason: {
      type: 'string',
      description: '一句话理由：为什么这个任务更适合该专项 agent。',
    },
    user_request_verbatim: {
      type: 'string',
      description: '用户原话逐字片段（直接从用户消息复制，禁止转述/摘要）。',
    },
    context_refs: {
      type: 'array',
      items: { type: 'string' },
      description: '可选：执行所需的引用（文件路径/卡片 slug/任务 id），每条 ≤300 字符。',
    },
    task_id: {
      type: 'string',
      description: '可选：要转办的任务卡 id；采纳后该任务的 owner 切换为目标 agent。',
    },
  },
  required: ['target_agent_id', 'reason', 'user_request_verbatim'],
  additionalProperties: false,
} as const

const PROPOSE_SPECIALIST_BLUEPRINT_DESCRIPTION = [
  '把用户「想要某类专项 agent / 智能体」的自然语言请求草拟成一份专项 agent 蓝图，并放入 Agent System Studio 等待用户确认。',
  '',
  '何时使用：用户明确说想创建、新建、需要、准备一个某类型专项 agent，且你能从对话里整理出工作范围、非目标、常见任务、输入、输出、初始规则和风险边界。',
  '',
  '专业访谈纪律：',
  '- 如果用户只给出类型名（例如「我要一个 xxx 类型的专项 agent」），但没有说明稳定工作范围、成功标准、非目标、主/专项分工、输入输出或工具/记忆边界，先调用 ask_user_questions，不要直接编造完整蓝图。',
  '- 访谈一次最多三问：1) 它长期服务的工作对象/场景是什么、一次做好怎样算完成、最重要的输出样式是什么；2) 哪些事不交给它、主 agent 保留什么判断、哪些例子适合或不适合交给它；3) 它需要哪些启动输入、初始知识/证据来源，以及浏览器/写入/外发/长期记忆哪些必须确认或禁止。',
  '- 这三问对应 P8g-9b 专业访谈合同：workScope、boundaryExamples、inputsKnowledgeTools。不要把它们合成一道大作文题。',
  '- 访谈目标不是填字段，而是得到一份能写出 P8g-9c foundation pack 的专业基础设计：charter、RULES、FOUNDATION、role persona、memory/profile policy、tool boundaries、routing triggers 和 lifecycle。',
  '- 用户回答后，再把答案补进本工具字段；原始 user_request_verbatim 仍必须保留用户最初那句话，不能替换成访谈总结。',
  '',
  '硬性约束：',
  '- 这个工具只草拟 blueprint，不创建 agent，不激活路由，不转移任务归属。',
  '- user_request_verbatim 必须逐字复制用户原话中的片段，禁止摘要或改写。',
  '- specialist_id 必须是小写 slug（例 visual-researcher / script-doctor），不要用中文、空格或标题文本。',
  '- routing_triggers 只是候选触发词；确认前不会生效。',
  '- 如果已经有足够上下文但仍缺局部字段，可提交蓝图让 admission 返回 needs_clarification；不要伪造用户没有表达过的硬需求。',
  '- 如果这个工具返回 needs_clarification，并给出 ask_user_questions 参数，下一步先调用 ask_user_questions；用户回答后把答案补回对应字段，再重新调用本工具。',
  '- 如果这个工具返回 staged/admit，下一步不要只告诉用户去设置页；应在对话里调用 ask_user_questions 弹出确认卡，至少提供「确认创建」「不创建」「我想修改」三种选择。用户确认后再调用 confirm_specialist_blueprint。',
  '',
  '不要使用：用户只是问「专项 agent 是什么」、只是讨论架构、或只是把当前任务转给已存在 agent（那应使用 agent_propose_handoff）。',
].join('\n')

const CONFIRM_SPECIALIST_BLUEPRINT_DESCRIPTION = [
  '在用户已经明确确认后，把一份已暂存的专项 agent 蓝图创建成真实 agent；或者按用户选择拒绝这份蓝图。',
  '',
  '何时使用：propose_specialist_blueprint 已返回 staged/admit，随后用户通过 ask_user_questions 卡或当前消息明确选择「确认创建」/「不创建」。',
  '',
  '硬性约束：',
  '- 这是二级确认工具。没有用户确认，不得调用 confirm_create。',
  '- confirmation_source=ask_user_questions_card 时必须传 confirmation_card_id，且 user_confirmation_verbatim 仍必须逐字来自用户当前回答。',
  '- user_confirmation_verbatim 必须逐字来自当前用户消息，并且包含确认或拒绝意图；如果原话同时包含拒绝和创建字样，以拒绝为准。',
  '- action=confirm_create 会创建 agent 并写入 staged 路由卡；action=reject 只拒绝蓝图，不创建 agent。',
  '- 如果用户说「我想改一下」，不要调用本工具；继续用 ask_user_questions 或重新调用 propose_specialist_blueprint 修订蓝图。',
].join('\n')

const CONFIRM_SPECIALIST_BLUEPRINT_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['confirm_create', 'reject'],
      description: 'confirm_create = 用户确认创建；reject = 用户明确不创建。',
    },
    blueprint_id: {
      type: 'string',
      description: '要确认或拒绝的 blueprintId，例如 bp-copywriter。',
    },
    confirmation_source: {
      type: 'string',
      enum: ['direct_user_message', 'ask_user_questions_card'],
      description: '用户确认来源：当前消息原话或结构化反问卡。',
    },
    user_confirmation_verbatim: {
      type: 'string',
      description: '必填，逐字复制用户当前消息里的确认/拒绝片段。',
    },
    confirmation_card_id: {
      type: 'string',
      description: '当 confirmation_source=ask_user_questions_card 时必填，记录回答来源卡片 id。',
    },
    allow_unverified_semantic_review: {
      type: 'boolean',
      description: '仅当用户明确接受 FOUNDATION 尚未完成语义校验时设为 true。',
    },
    migrate_card_rel_paths: {
      type: 'array',
      items: { type: 'string' },
      description: '可选：创建时迁移到该 agent 的知识卡 relPath，最多 8 条。',
    },
  },
  required: ['action', 'blueprint_id', 'confirmation_source', 'user_confirmation_verbatim'],
  additionalProperties: false,
} as const

const RENAME_SPECIALIST_AGENT_DESCRIPTION = [
  '按用户当前消息，把一个已存在的 active 专项 agent 改显示名。',
  '',
  '何时使用：用户明确说「把某个专项 agent 改名为 xxx」或同义表达，并且目标 agent 已存在。',
  '如果用户只说“我要给它起个名字/改个名字”但没有给出新名字，先调用 ask_user_questions 向用户询问名称，不要回答“去设置页手动改”。',
  '',
  '硬性约束：',
  '- 只能改专项 agent，不能改主 agent。',
  '- display_name 必须出现在当前用户消息中。',
  '- user_request_verbatim 必须逐字复制用户当前消息中的改名请求片段，禁止摘要。',
].join('\n')

const RENAME_SPECIALIST_AGENT_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    specialist_id: {
      type: 'string',
      description: '要改名的专项 agent id，例如 copywriter。',
    },
    display_name: {
      type: 'string',
      description: '新的显示名，必须来自用户当前消息。',
    },
    user_request_verbatim: {
      type: 'string',
      description: '用户原话逐字片段，必须直接复制当前用户消息里的改名请求。',
    },
  },
  required: ['specialist_id', 'display_name', 'user_request_verbatim'],
  additionalProperties: false,
} as const

const KNOWLEDGE_SEED_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: '知识种子标题，1-120 字符。',
    },
    body: {
      type: 'string',
      description: '可迁移进该专项 agent 的初始知识、偏好或经验，1-2000 字符。',
    },
    evidence_refs: {
      type: 'array',
      items: { type: 'string' },
      description: '可选引用，只放路径、消息 id、卡片 slug 等引用，不转述长内容。',
    },
  },
  required: ['title', 'body'],
  additionalProperties: false,
} as const

const TOOL_BOUNDARY_SCHEMA = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: ['allow', 'deny', 'confirm'],
      description: '该工具类别的默认边界：allow = 可直接用；deny = 禁用；confirm = 使用前需要用户确认。',
    },
    notes: {
      type: 'string',
      description: '该边界的具体说明，写清楚什么情况下允许、拒绝或需要确认。',
    },
  },
  required: ['mode', 'notes'],
  additionalProperties: false,
} as const

const PROPOSE_SPECIALIST_BLUEPRINT_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    specialist_id: {
      type: 'string',
      description: '拟创建专项 agent 的小写 slug，例如 visual-researcher；代码会再次归一化。',
    },
    display_name: {
      type: 'string',
      description: '展示名，例如「视觉研究专项 Agent」。',
    },
    charter: {
      type: 'string',
      description: '职责范围说明，必须具体到能判断什么该交给它、什么不该交给它。',
    },
    intended_domain: {
      type: 'string',
      description: '聚焦领域，例如「视觉参考研究」「短视频脚本诊断」。',
    },
    role_persona: {
      type: 'string',
      description: '该专项 agent 的角色、判断风格和工作姿态，避免只是空泛职责名。',
    },
    non_goals: {
      type: 'array',
      items: { type: 'string' },
      description: '明确非目标，避免变成全能 agent。',
    },
    recurring_tasks: {
      type: 'array',
      items: { type: 'string' },
      description: '该专项 agent 会反复处理的任务类型。',
    },
    required_inputs: {
      type: 'array',
      items: { type: 'string' },
      description: '启动工作前需要用户或上下文提供的输入。',
    },
    expected_outputs: {
      type: 'array',
      items: { type: 'string' },
      description: '它应该产出的具体交付物。',
    },
    suitable_task_examples: {
      type: 'array',
      items: { type: 'string' },
      description: '适合交给该专项 agent 的任务例子，用来帮助主 agent 和用户判断边界。',
    },
    unsuitable_task_examples: {
      type: 'array',
      items: { type: 'string' },
      description: '不适合交给该专项 agent 的任务例子，避免职责外扩。',
    },
    main_vs_specialist_split: {
      type: 'string',
      description: '主 agent 与该专项 agent 的分工：主 agent 保留什么，该专项 agent 接什么。',
    },
    routing_triggers: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 8,
      description: '候选触发词，最多 8 个；确认前不参与路由。',
    },
    seed_rules_text: {
      type: 'string',
      description: '初始 RULES 文档草稿，包含行为规则、工作流、边界。',
    },
    knowledge_seeds: {
      type: 'array',
      items: KNOWLEDGE_SEED_ITEM_SCHEMA,
      description: '可选：初始知识种子。',
    },
    tool_boundaries: {
      type: 'object',
      properties: {
        browser: TOOL_BOUNDARY_SCHEMA,
        write: TOOL_BOUNDARY_SCHEMA,
        external_send: TOOL_BOUNDARY_SCHEMA,
        long_memory: TOOL_BOUNDARY_SCHEMA,
      },
      required: ['browser', 'write', 'external_send', 'long_memory'],
      additionalProperties: false,
      description: '浏览器、写入、外发和长期记忆的工具边界。',
    },
    tool_safety_notes: {
      type: 'string',
      description: '工具、浏览器、外发、隐私、权限等安全边界说明。',
    },
    memory_profile_policy: {
      type: 'string',
      description: '该专项 agent 能记住什么、不能记住什么，以及写入长期画像前需要什么确认。',
    },
    lifecycle_notes: {
      type: 'string',
      description: '该专项 agent 何时需要更新、合并、退休或重新确认职责。',
    },
    user_request_verbatim: {
      type: 'string',
      description: '用户原话逐字片段，必须直接复制，禁止转述。',
    },
  },
  required: [
    'specialist_id',
    'display_name',
    'charter',
    'intended_domain',
    'role_persona',
    'non_goals',
    'recurring_tasks',
    'required_inputs',
    'expected_outputs',
    'suitable_task_examples',
    'unsuitable_task_examples',
    'main_vs_specialist_split',
    'routing_triggers',
    'seed_rules_text',
    'tool_boundaries',
    'tool_safety_notes',
    'memory_profile_policy',
    'lifecycle_notes',
    'user_request_verbatim',
  ],
  additionalProperties: false,
} as const

export function getAgentInteractionAnthropicTools(): Array<Record<string, unknown>> {
  return [
    normalizeAnthropicToolSchema({
      name: 'ask_user_questions',
      description: ASK_USER_QUESTIONS_DESCRIPTION,
      input_schema: ASK_USER_QUESTIONS_INPUT_SCHEMA,
    }),
    normalizeAnthropicToolSchema({
      name: 'agent_propose_handoff',
      description: PROPOSE_HANDOFF_DESCRIPTION,
      input_schema: PROPOSE_HANDOFF_INPUT_SCHEMA,
    }),
    normalizeAnthropicToolSchema({
      name: 'propose_specialist_blueprint',
      description: PROPOSE_SPECIALIST_BLUEPRINT_DESCRIPTION,
      input_schema: PROPOSE_SPECIALIST_BLUEPRINT_INPUT_SCHEMA,
    }),
    normalizeAnthropicToolSchema({
      name: 'confirm_specialist_blueprint',
      description: CONFIRM_SPECIALIST_BLUEPRINT_DESCRIPTION,
      input_schema: CONFIRM_SPECIALIST_BLUEPRINT_INPUT_SCHEMA,
    }),
    normalizeAnthropicToolSchema({
      name: 'rename_specialist_agent',
      description: RENAME_SPECIALIST_AGENT_DESCRIPTION,
      input_schema: RENAME_SPECIALIST_AGENT_INPUT_SCHEMA,
    }),
    normalizeAnthropicToolSchema({
      name: 'declare_completion_criteria',
      description: DECLARE_COMPLETION_CRITERIA_DESCRIPTION,
      input_schema: DECLARE_COMPLETION_CRITERIA_INPUT_SCHEMA,
    }),
  ]
}

export function getAgentInteractionOpenAITools(): Array<Record<string, unknown>> {
  return [
    normalizeOpenAIToolSchema({
      type: 'function',
      function: {
        name: 'ask_user_questions',
        description: ASK_USER_QUESTIONS_DESCRIPTION,
        parameters: ASK_USER_QUESTIONS_INPUT_SCHEMA,
      },
    }),
    normalizeOpenAIToolSchema({
      type: 'function',
      function: {
        name: 'agent_propose_handoff',
        description: PROPOSE_HANDOFF_DESCRIPTION,
        parameters: PROPOSE_HANDOFF_INPUT_SCHEMA,
      },
    }),
    normalizeOpenAIToolSchema({
      type: 'function',
      function: {
        name: 'propose_specialist_blueprint',
        description: PROPOSE_SPECIALIST_BLUEPRINT_DESCRIPTION,
        parameters: PROPOSE_SPECIALIST_BLUEPRINT_INPUT_SCHEMA,
      },
    }),
    normalizeOpenAIToolSchema({
      type: 'function',
      function: {
        name: 'confirm_specialist_blueprint',
        description: CONFIRM_SPECIALIST_BLUEPRINT_DESCRIPTION,
        parameters: CONFIRM_SPECIALIST_BLUEPRINT_INPUT_SCHEMA,
      },
    }),
    normalizeOpenAIToolSchema({
      type: 'function',
      function: {
        name: 'rename_specialist_agent',
        description: RENAME_SPECIALIST_AGENT_DESCRIPTION,
        parameters: RENAME_SPECIALIST_AGENT_INPUT_SCHEMA,
      },
    }),
    normalizeOpenAIToolSchema({
      type: 'function',
      function: {
        name: 'declare_completion_criteria',
        description: DECLARE_COMPLETION_CRITERIA_DESCRIPTION,
        parameters: DECLARE_COMPLETION_CRITERIA_INPUT_SCHEMA,
      },
    }),
  ]
}
