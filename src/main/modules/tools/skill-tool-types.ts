/**
 * Pure types + LLM-schema converters for skill tool definitions.
 *
 * Extracted from the retired `skill-execution-tool-defs.ts` (B Phase 4 PR2)
 * so that the 6 execution-control tools can be deleted without dragging
 * the type surface every skill-action and primitive tool still needs.
 *
 * No electron imports, no side effects — callers that need the actual tool
 * definitions import from the primitive / skill-action modules.
 */

import type { SkillParamDefinition } from '../../../shared/skill-execution-types'

export type SkillToolKind = 'skill_action' | 'primitive'

export type ToolParam = SkillParamDefinition

export interface SkillToolDef {
  name: string
  description: string
  kind: SkillToolKind
  skillId?: string
  action?: string
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
