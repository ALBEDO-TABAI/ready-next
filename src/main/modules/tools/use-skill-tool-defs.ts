/**
 * LLM-facing tool defs for the `skill_activation` capability group (P2-2).
 *
 * Single tool: `use_skill` — the model-side explicit activation event for the L1
 * skill catalog. It is deliberately OUTSIDE the skill authorization domain (the
 * name has NO `skill_` prefix, so `filterToolsByAuthorization` never strips it on a
 * mode:'none' turn — same trick as `install_skill` / `ask_user_questions`).
 *
 * Activation ≠ hint: calling use_skill arms the reference-skill hint so the NEXT turn's
 * `resolveSkillAuthorizationForTurn` resolves `selected` for that skill and its tools
 * become available. The security posture is unchanged — hint never opens a primitive by
 * itself; an explicit activation event (mention / use_skill / resume) does.
 */

import {
  normalizeAnthropicToolSchema,
  normalizeOpenAIToolSchema,
} from './tool-schema'

export const USE_SKILL_TOOL_NAMES: readonly string[] = [
  'use_skill',
] as const

const USE_SKILL_DESCRIPTION = [
  '按「可用技能」目录激活一个技能：返回该技能的 SKILL.md 方法论正文，并在下一轮解锁其技能工具（skill_* 原语/typed actions）。',
  '',
  '何时用：目录里某个技能的 description 匹配当前任务，但用户没有用 @[技能id] 显式引用它时——你可以主动调用 `use_skill({ skill_id })` 激活它，然后按返回的方法论执行。',
  'skill_id 必须是「可用技能」目录里列出的技能 id（形如 `ready-human-touch-ppt`）。',
  '',
  '返回：`{ skill_id, doc, activation:"armed_next_turn", note }`。`doc` 是该技能方法论（截断到 12000 字，更多细节让技能自己经 references/ 提供）；`activation:"armed_next_turn"` 表示技能工具将于**下一轮**可用——本轮先读方法论、给出计划，下一轮再调用技能工具。',
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
