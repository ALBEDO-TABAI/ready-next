/**
 * Stage R — pure tool defs + LLM-facing schema builders for the
 * `general_research` capability group.
 *
 * Mirrors `system-tool-defs.ts`: params derived from the Zod schemas via
 * `zodObjectToParamList` so the LLM-facing JSONSchema and the dispatch
 * validator share one source of truth. No electron / runtime imports.
 */

import { GENERAL_RESEARCH_SCHEMAS } from './schemas/general-research-schemas'
import {
  buildToolParamSchema,
  normalizeAnthropicToolSchema,
  normalizeOpenAIToolSchema,
  type ToolParamSchemaSpec,
} from './tool-schema'
import { zodObjectToParamList } from './zod-param-derivation'

type ToolParam = ToolParamSchemaSpec

export interface GeneralResearchToolDef {
  name: string
  description: string
  params: ToolParam[]
}

export const GENERAL_RESEARCH_TOOL_NAMES: readonly string[] = [
  'web_search',
  'web_fetch',
  'present_file',
] as const

export const GENERAL_RESEARCH_TOOLS: GeneralResearchToolDef[] = [
  {
    name: 'web_search',
    description:
      '在公开互联网上检索资料，返回标题/链接/摘要列表。优先使用 Tavily API；网络受限时自动回退到 DuckDuckGo HTML。引用结果时请标明 source。',
    params: zodObjectToParamList(GENERAL_RESEARCH_SCHEMAS.web_search!) as ToolParam[],
  },
  {
    name: 'web_fetch',
    description:
      '抓取指定 URL 并返回纯文本正文（最多 4096 字符）。优先走 Jina reader，失败时回退到 Tavily Extract。仅用于公开 http/https 页面。',
    params: zodObjectToParamList(GENERAL_RESEARCH_SCHEMAS.web_fetch!) as ToolParam[],
  },
  {
    name: 'present_file',
    description:
      '把 outputs 目录内的文件作为附件呈现给用户。路径必须落在沙箱根 `<outputsRoot>` 之下，否则会被拒绝。',
    params: zodObjectToParamList(GENERAL_RESEARCH_SCHEMAS.present_file!) as ToolParam[],
  },
]

export function getGeneralResearchAnthropicTools(): Array<Record<string, unknown>> {
  return GENERAL_RESEARCH_TOOLS.map((tool) => normalizeAnthropicToolSchema({
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(tool.params.map((param) => [param.name, buildToolParamSchema(param)])),
      required: tool.params.filter((param) => param.required).map((param) => param.name),
    },
  }))
}

export function getGeneralResearchOpenAITools(): Array<Record<string, unknown>> {
  return GENERAL_RESEARCH_TOOLS.map((tool) => normalizeOpenAIToolSchema({
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
