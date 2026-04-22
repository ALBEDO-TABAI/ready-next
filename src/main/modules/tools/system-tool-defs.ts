/**
 * Pure tool defs + LLM-facing schema builders for system (Phase 2.5 PR 11).
 *
 * Extracted from system-tools.ts so tests can verify derivation output
 * without dragging in the skills-runtime manager's electron imports.
 * The execution module (system-tools.ts) re-exports the public API from
 * here so existing call sites stay stable.
 *
 * Params are derived from SYSTEM_SCHEMAS via zodObjectToParamList — the
 * schemas file is the single source of truth.
 *
 * Pure module — Zod + schema builders only.
 */

import {
  buildToolParamSchema,
  normalizeAnthropicToolSchema,
  normalizeOpenAIToolSchema,
  type ToolParamSchemaSpec,
} from './tool-schema'
import { SYSTEM_SCHEMAS } from './schemas/system-schemas'
import { zodObjectToParamList } from './zod-param-derivation'

type ToolParam = ToolParamSchemaSpec

export interface SystemToolDef {
  name: string
  description: string
  params: ToolParam[]
}

export const SYSTEM_TOOLS: SystemToolDef[] = [
  {
    name: 'system_run_embedded_python',
    description:
      '使用 Ready 内置的 skills runtime Python 执行代码或脚本。优先用于手动控制 skill 阶段、检查文件或运行辅助 Python 逻辑。',
    params: zodObjectToParamList(SYSTEM_SCHEMAS.system_run_embedded_python) as ToolParam[],
  },
  {
    name: 'system_run_openclaw',
    description:
      '执行本地 openclaw 配对/插件命令。当前仅允许 openclaw pairing 子命令，用于批准飞书等插件配对请求。',
    params: zodObjectToParamList(SYSTEM_SCHEMAS.system_run_openclaw) as ToolParam[],
  },
]

export function getSystemAnthropicTools(): Array<Record<string, unknown>> {
  return SYSTEM_TOOLS.map((tool) => normalizeAnthropicToolSchema({
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(tool.params.map((param) => [param.name, buildToolParamSchema(param)])),
      required: tool.params.filter((param) => param.required).map((param) => param.name),
    },
  }))
}

export function getSystemOpenAITools(): Array<Record<string, unknown>> {
  return SYSTEM_TOOLS.map((tool) => normalizeOpenAIToolSchema({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(tool.params.map((param) => [param.name, buildToolParamSchema(param)])),
        required: tool.params.filter((param) => param.required).map((param) => param.name),
      },
    },
  }))
}
