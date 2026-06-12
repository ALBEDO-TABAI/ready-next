/**
 * LLM-facing tool defs for the `agent_interaction` capability group.
 *
 * Single tool today: `ask_user_questions`. The schema is hand-authored to
 * keep the JSONSchema description prose under tight control — derivation
 * via `zodObjectToParamList` would lose the per-property descriptions on
 * the nested questions[] item and the `kind` enum constraints we want to
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
] as const

const ASK_USER_QUESTIONS_DESCRIPTION = [
  '向用户弹出一张「结构化问题卡」，最多 5 道题，用户答完后答案会作为 tool result 回灌给你。两种典型触发场景：',
  '',
  '1) **用户明确要求你反问** — 任何形如「反问我」「问我几个问题」「考考我」「采访我」「随便问我点什么」的请求，**必须**用这个工具来响应，而不是在普通回复里写一堆问题。用户已经在主动邀请被结构化提问。',
  '',
  '2) **任务含糊、关键参数缺失** — 用户的指令模糊到你无法直接动手（例："帮我做个东西"、"开始吧"），并且关键参数无法从对话历史 / 附件 / 当前文档推断时，用此工具一次性把关键缺口问清楚，避免一句话一句话拉扯。',
  '',
  '渲染端会把整组问题作为 inline 卡片插入聊天流；用户按顺序回答（带前进 / 后退导航），全部答完后卡片折叠保留在历史里。',
  '',
  '使用约束：',
  '- 每个 turn 最多调用 1 次；同一会话同时只允许 1 张未答完的卡（否则 errorKind=overlapping_card）。',
  '- 一次最多 5 道题，少而精。',
  '- 用户已经给过的信息，禁止再问；先看对话历史和附件。',
  '- 优先 single_choice / multi_choice；只有真正开放的问题用 free_text。',
  '- 不要把多个问题塞进同一条 free_text 让用户用分号分隔——拆成多道结构化题。',
  '',
  '不要使用此工具的场景：你只是想征求一句确认（直接说"我打算 X，对吗？"即可）、用户的请求本身就是答案、或问题可以通过 web_search / session_search 自行解决。',
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
  '向用户提议把当前任务转办给一个已存在的专项 agent，弹出一张转办建议卡（采纳/新会话接手/拒绝）。这是建议性工具：你只能提议，采纳永远由用户点击决定，不存在无确认自动转办。',
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
  ]
}
