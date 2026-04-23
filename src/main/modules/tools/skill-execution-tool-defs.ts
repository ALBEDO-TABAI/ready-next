/**
 * Pure data + pure renderers for the 6 skill "execution_control" tools.
 *
 * Extracted from skills-tools.ts so:
 *   - Tests can import these without pulling in skills-runtime/database/electron.
 *   - Phase 2 derivation (EXECUTION_TOOL_DEFS params ← Zod) lives in one file.
 *
 * No electron imports. No side effects.
 */

import type { SkillParamDefinition } from '../../../shared/skill-execution-types'
import { SKILL_CONTROL_SCHEMAS } from './schemas/skill-control-schemas'
import { zodObjectToParamList } from './zod-param-derivation'

export type SkillToolKind = 'skill_action' | 'execution_control'

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

/**
 * Params for the 6 execution-control tools are DERIVED from
 * SKILL_CONTROL_SCHEMAS (the Zod source of truth). The byte-for-byte shape of
 * the resulting LLM-facing Anthropic/OpenAI schemas is locked by
 * src/__tests__/skill-zod-golden-snapshot.test.ts. Update the Zod schema
 * when changing a param; never hand-edit a params array here.
 */
// Hardened prefix prepended to every submit/restart/cancel tool description:
// stops models from fabricating an `executionId: "new"` after they have only
// seen a reference-skill guidance payload (B plan Phase 0 — P0-T2).
const EXECUTION_CONTROL_ONLY_PREFIX =
  'ONLY call this if a previous skill_* tool returned an explicit executionId. Never fabricate an id like "new" or "0". '

export const EXECUTION_TOOL_DEFS: SkillToolDef[] = [
  {
    name: 'skill_get_state',
    description: '读取当前 skill execution 状态、当前 blocker、已完成步骤和最近产物。若不提供 executionId，会优先读取当前会话最近的活跃 execution。',
    kind: 'execution_control',
    params: zodObjectToParamList(SKILL_CONTROL_SCHEMAS.skill_get_state),
  },
  {
    name: 'skill_submit_input',
    description: `${EXECUTION_CONTROL_ONLY_PREFIX}向一个被 need_input 阻塞的 execution 提交输入并继续推进。`,
    kind: 'execution_control',
    params: zodObjectToParamList(SKILL_CONTROL_SCHEMAS.skill_submit_input),
  },
  {
    name: 'skill_submit_confirmation',
    description: `${EXECUTION_CONTROL_ONLY_PREFIX}提交 confirmation 结果并继续执行 skill workflow。`,
    kind: 'execution_control',
    params: zodObjectToParamList(SKILL_CONTROL_SCHEMAS.skill_submit_confirmation),
  },
  {
    name: 'skill_submit_agent_result',
    description: `${EXECUTION_CONTROL_ONLY_PREFIX}向 need_agent_result 阶段提交 Claude 生成的正文和结构化输出，并继续推进 workflow。`,
    kind: 'execution_control',
    params: zodObjectToParamList(SKILL_CONTROL_SCHEMAS.skill_submit_agent_result),
  },
  {
    name: 'skill_restart_from_step',
    description: `${EXECUTION_CONTROL_ONLY_PREFIX}从指定 step 重新开始 skill execution，并删除该步及后续步骤的状态与产物。`,
    kind: 'execution_control',
    params: zodObjectToParamList(SKILL_CONTROL_SCHEMAS.skill_restart_from_step),
  },
  {
    name: 'skill_cancel_execution',
    description: `${EXECUTION_CONTROL_ONLY_PREFIX}取消一个正在进行的 skill execution。`,
    kind: 'execution_control',
    params: zodObjectToParamList(SKILL_CONTROL_SCHEMAS.skill_cancel_execution),
  },
]

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
