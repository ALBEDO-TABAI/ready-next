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
  '不要使用的场景：direct_answer / 闲聊类回合；单次实时查询、简单搜索或只需在对话中给出结果的调研；标准与系统模板完全重合时（不必重复声明）。',
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
  '向用户弹出一张「结构化问题卡」，最多 5 道题，用户答完后答案会作为 tool result 回灌给你。三种典型触发场景：',
  '',
  '1) **用户明确要求你反问** — 任何形如「反问我」「问我几个问题」「考考我」「采访我」「随便问我点什么」的请求，**必须**用这个工具来响应，而不是在普通回复里写一堆问题。用户已经在主动邀请被结构化提问。',
  '',
  '2) **任务含糊、关键参数缺失** — 用户的指令模糊到你无法直接动手（例："帮我做个东西"、"开始吧"），并且关键参数无法从对话历史 / 附件 / 当前文档推断时，用此工具一次性把关键缺口问清楚，避免一句话一句话拉扯。',
  '',
  '3) **多种真实可用方法冲突** — 本轮同时有 Ready 应用内本地日历和飞书日历时：用户只说「查下周安排」且没有点名来源、也没有处在本地日历工作面或引用本地日程，先问「Ready 本地日历 / 飞书日历 / 两边都查」。用户明确说飞书、Lark、飞书 CLI 时直接用飞书，不要问、不要改查本地；明确说 Ready 本地日历，或正在日历工作面 / 引用了本地日程时，直接用本地日历。只有一种来源实际可用时不要问。写入日程且来源不明时，先问写到哪里，再走原有写入确认；不要把选来源和确认写入混成一个问题。答完后继续当前任务，不要等用户再发一条消息。',
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

export function getAgentInteractionAnthropicTools(): Array<Record<string, unknown>> {
  return [
    normalizeAnthropicToolSchema({
      name: 'ask_user_questions',
      description: ASK_USER_QUESTIONS_DESCRIPTION,
      input_schema: ASK_USER_QUESTIONS_INPUT_SCHEMA,
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
        name: 'declare_completion_criteria',
        description: DECLARE_COMPLETION_CRITERIA_DESCRIPTION,
        parameters: DECLARE_COMPLETION_CRITERIA_INPUT_SCHEMA,
      },
    }),
  ]
}
