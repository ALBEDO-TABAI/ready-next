import type { ConversationSourceKind } from '../database'
import type { ToolContext } from './tool-executor'
import { buildToolParamSchema, normalizeAnthropicToolSchema, normalizeOpenAIToolSchema, type ToolParamSchemaSpec } from './tool-schema'
import { SESSION_SCHEMAS } from './schemas/session-schemas'
import { zodObjectToParamList } from './zod-param-derivation'

interface SessionRecallToolDef {
  name: string
  description: string
  params: ToolParamSchemaSpec[]
}

const SESSION_RECALL_TOOLS: SessionRecallToolDef[] = [
  {
    name: 'session_search',
    description: '搜索历史会话或列出最近会话。无 query 时返回最近历史；有 query 时按会话消息、标题、任务摘要、附件名搜索。默认排除当前会话谱系。',
    params: zodObjectToParamList(SESSION_SCHEMAS.session_search) as ToolParamSchemaSpec[],
  },
]

export function getSessionRecallAnthropicTools(): Array<Record<string, unknown>> {
  return SESSION_RECALL_TOOLS.map((tool) => normalizeAnthropicToolSchema({
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(tool.params.map((param) => [param.name, buildToolParamSchema(param)])),
      required: tool.params.filter((param) => param.required).map((param) => param.name),
    },
  }))
}

export function getSessionRecallOpenAITools(): Array<Record<string, unknown>> {
  return SESSION_RECALL_TOOLS.map((tool) => normalizeOpenAIToolSchema({
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

export async function executeSessionRecallTool(
  toolName: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<string> {
  if (!context.runtime || !context.scope) {
    return JSON.stringify({ success: false, error: 'Runtime or scope not available' })
  }
  if (toolName !== 'session_search') {
    return JSON.stringify({ success: false, error: `Unknown session recall tool: ${toolName}` })
  }
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  const sourceKind: ConversationSourceKind | undefined = args.sourceKind === 'local' || args.sourceKind === 'channel'
    ? args.sourceKind
    : undefined
  const limit = Number.isFinite(Number(args.limit)) ? Number(args.limit) : undefined
  const payload = {
    query,
    channelKey: typeof args.channelKey === 'string' ? args.channelKey : undefined,
    sourceKind,
    hasAttachments: args.hasAttachments === true,
    currentScopeId: context.scope.id,
    limit,
  }
  const hits = query
    ? context.runtime.searchSessionRecall(payload)
    : context.runtime.listRecentSessions(payload)
  return JSON.stringify({
    success: true,
    query: query || null,
    count: hits.length,
    sessions: hits,
  })
}
