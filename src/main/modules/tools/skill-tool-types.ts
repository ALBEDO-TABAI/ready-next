/**
 * Shared LLM-facing tool shape for all skill_* tools (skill_action +
 * primitives). Originally lived in `skill-execution-tool-defs.ts` alongside
 * the 6 execution-control defs; that file is retired in B-plan Phase 4
 * because the skill_executions state machine is gone, but the tool-def shape
 * + the Anthropic/OpenAI renderers are still needed by:
 *
 *   - `skills-tools.ts`              (builds skill_action defs)
 *   - `skill-primitives/tool-defs.ts` (primitive defs)
 *
 * The renderers are pure — no electron / runtime-manager imports — so this
 * file stays safe to pull in from isolated unit tests.
 */

import type { SkillParamDefinition } from '../../../shared/skill-execution-types'

// `execution_control` stays in the union only so that old tests (which only
// check the absence of the 6 retired tool names) still type-check. No def
// currently carries that kind after Phase 4.
export type SkillToolKind = 'skill_action' | 'execution_control' | 'primitive'

export type ToolParam = SkillParamDefinition

export interface SkillToolDef {
  name: string
  description: string
  kind: SkillToolKind
  skillId?: string
  action?: string
  visibility?: string
  timeoutMs?: number
  params: ToolParam[]
}

export function toSchemaParam(param: ToolParam): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    type: param.type,
    description: param.description,
  }
  if (param.type === 'array') {
    schema.items = { type: 'string' }
  }
  if (param.type === 'object') {
    schema.additionalProperties = true
  }
  if (param.enum) schema.enum = param.enum
  return schema
}

export function toAnthropicTool(tool: SkillToolDef): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(tool.params.map((param) => [param.name, toSchemaParam(param)])),
      required: tool.params.filter((param) => param.required).map((param) => param.name),
    },
  }
}

export function toOpenAITool(tool: SkillToolDef): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(tool.params.map((param) => [param.name, toSchemaParam(param)])),
        required: tool.params.filter((param) => param.required).map((param) => param.name),
      },
    },
  }
}
