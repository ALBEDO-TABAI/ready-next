import { RSS_SCHEMAS } from './schemas/rss-schemas'
import { zodObjectToParamList } from './zod-param-derivation'

interface ToolParam {
  name: string
  type: string
  description: string
  required: boolean
}

interface RSSToolDef {
  name: string
  description: string
  action: string
  intent: string
  executionKind: 'deterministic' | 'pipeline'
  params: ToolParam[]
}

interface RSSToolContext {
  emitToolAction?: (tool: string, args: Record<string, unknown>) => void
  requestModuleToolAction?: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

const RSS_TOOLS: RSSToolDef[] = [
  {
    name: 'rss_add_source',
    description: '添加一个 RSS 订阅源。',
    action: 'rss.addSource',
    intent: 'add_rss_source',
    executionKind: 'deterministic',
    params: zodObjectToParamList(RSS_SCHEMAS.rss_add_source) as ToolParam[],
  },
  {
    name: 'rss_fetch_updates',
    description: '刷新当前 RSS 订阅，拉取最新内容。',
    action: 'rss.fetchUpdates',
    intent: 'fetch_rss_updates',
    executionKind: 'deterministic',
    params: zodObjectToParamList(RSS_SCHEMAS.rss_fetch_updates) as ToolParam[],
  },
  {
    name: 'rss_select_item',
    description: '在 RSS 列表中按 itemId 或标题定位一个条目。',
    action: 'rss.selectItem',
    intent: 'select_rss_item',
    executionKind: 'deterministic',
    params: zodObjectToParamList(RSS_SCHEMAS.rss_select_item) as ToolParam[],
  },
  {
    name: 'rss_analyze_item',
    description: '启动指定 RSS 条目的 copy 或 visual 分析任务。',
    action: 'rss.analyzeItem',
    intent: 'analyze_rss_item',
    executionKind: 'pipeline',
    params: zodObjectToParamList(RSS_SCHEMAS.rss_analyze_item) as ToolParam[],
  },
  {
    name: 'rss_get_analysis_result',
    description: '等待 RSS 分析任务结束并返回报告路径与校验值。',
    action: 'rss.getAnalysisResult',
    intent: 'get_rss_analysis_result',
    executionKind: 'pipeline',
    params: zodObjectToParamList(RSS_SCHEMAS.rss_get_analysis_result) as ToolParam[],
  },
  {
    name: 'rss_capture_session',
    description: '读取当前 RSS 会话快照、选中条目和最近分析状态。',
    action: 'rss.captureSession',
    intent: 'capture_rss_session',
    executionKind: 'deterministic',
    params: zodObjectToParamList(RSS_SCHEMAS.rss_capture_session) as ToolParam[],
  },
]

function toSchemaParam(param: ToolParam): Record<string, unknown> {
  return {
    type: param.type,
    description: param.description,
  }
}

function toStructuredResult(tool: RSSToolDef, message: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({
    module: 'rss',
    intent: tool.intent,
    executionKind: tool.executionKind,
    action: tool.action,
    message,
    ...(extra || {}),
  })
}

export function getRSSAnthropicTools(): Array<Record<string, unknown>> {
  return RSS_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(tool.params.map((param) => [param.name, toSchemaParam(param)])),
      required: tool.params.filter((param) => param.required).map((param) => param.name),
    },
  }))
}

export function getRSSOpenAITools(): Array<Record<string, unknown>> {
  return RSS_TOOLS.map((tool) => ({
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
  }))
}

export async function executeRSSTool(
  toolName: string,
  args: Record<string, unknown>,
  context?: RSSToolContext,
): Promise<string> {
  const tool = RSS_TOOLS.find((item) => item.name === toolName)
  if (!tool) return `Unknown RSS tool: ${toolName}`

  if (toolName === 'rss_add_source') {
    const name = String(args.name || '').trim()
    const url = String(args.url || '').trim()
    if (!name || !url) return 'Error: name and url are required'
  }

  if (toolName === 'rss_analyze_item') {
    const analysisType = String(args.analysisType || '').trim().toLowerCase()
    if (analysisType !== 'copy' && analysisType !== 'visual') return 'Error: analysisType must be copy or visual'
  }

  if (context?.requestModuleToolAction) {
    try {
      const payload = await context.requestModuleToolAction(tool.action, args)
      if (payload.ok === false) {
        return toStructuredResult(tool, typeof payload.summary === 'string' ? payload.summary : `${tool.action} 失败`, {
          ...payload,
          ok: false,
        })
      }
      const summary = typeof payload.summary === 'string' && payload.summary.trim()
        ? payload.summary.trim()
        : `${tool.action} 已完成。`
      return toStructuredResult(tool, summary, payload)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return toStructuredResult(tool, `RSS action failed: ${tool.action} - ${message}`, {
        ok: false,
        error: message,
      })
    }
  }

  return toStructuredResult(tool, `${tool.action} 缺少产品动作桥。`, {
    ok: false,
    errorKind: 'product_action_bridge_missing',
    ownerResourceId: typeof args.itemId === 'string' ? args.itemId : null,
  })
}
