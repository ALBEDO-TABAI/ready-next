/**
 * LLM-facing tool defs for the `skill_activation` capability group (P2-2).
 *
 * Single tool: `use_skill` — the model-side explicit activation event for the L1
 * skill catalog. It is deliberately OUTSIDE the skill authorization domain (the
 * name has NO `skill_` prefix, so `filterToolsByAuthorization` never strips it on a
 * mode:'none' turn — same trick as `install_skill` / `ask_user_questions`).
 *
 * Calling use_skill is the explicit activation event. The host consumes the armed hint
 * immediately, refreshes this run's authorization, and lets the SDK's dynamic tool
 * predicates expose only the selected skill on the next model iteration. The hint also
 * preserves ordinary next-turn continuation.
 */

import {
  normalizeAnthropicToolSchema,
  normalizeOpenAIToolSchema,
} from './tool-schema'

export const USE_SKILL_TOOL_NAMES: readonly string[] = [
  'use_skill',
] as const

const USE_SKILL_DESCRIPTION = [
  '按「可用技能」目录激活一个技能：返回该技能的 SKILL.md 方法论正文，并在本次运行的下一次模型迭代解锁其获准技能工具（skill_* 原语/typed actions）。',
  '',
  '何时用：目录里某个技能的 description 匹配当前任务，但用户没有用 @[技能id] 显式引用它时——你可以主动调用 `use_skill({ skill_id })` 激活它，然后按返回的方法论执行。',
  'skill_id 必须是「可用技能」目录里列出的技能 id（形如 `ready-human-touch-ppt`）。',
  '',
  '返回：宿主确认后为 `activation:"active_same_run"`，并给出本次运行已开放的工具名；`doc` 是该技能方法论（截断到 12000 字，更多细节让技能自己经 references/ 提供）。读完后必须在当前运行中继续完成用户任务，不得停下、只给计划或等待用户再次发言。',
  '',
  '不要用于：用户已经用 @[技能id] 引用的技能（那已经在本轮激活）；或你只是想读某个文件（用文档/文件读取工具）。一轮里不要反复激活同一个技能。',
].join('\n')

const USE_SKILL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    skill_id: {
      type: 'string',
      description: '要激活的技能 id，必须来自「可用技能」目录（如 `ready-human-touch-ppt`）。',
    },
  },
  required: ['skill_id'],
  additionalProperties: false,
} as const

export function getUseSkillAnthropicTools(): Array<Record<string, unknown>> {
  return [
    normalizeAnthropicToolSchema({
      name: 'use_skill',
      description: USE_SKILL_DESCRIPTION,
      input_schema: USE_SKILL_INPUT_SCHEMA,
    }),
  ]
}

export function getUseSkillOpenAITools(): Array<Record<string, unknown>> {
  return [
    normalizeOpenAIToolSchema({
      type: 'function',
      function: {
        name: 'use_skill',
        description: USE_SKILL_DESCRIPTION,
        parameters: USE_SKILL_INPUT_SCHEMA,
      },
    }),
  ]
}
