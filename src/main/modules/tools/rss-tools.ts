import { RSS_SCHEMAS } from './schemas/rss-schemas'
import { zodObjectToParamList } from './zod-param-derivation'
import { RSSQuerySchema, RSSReadArticleSchema } from '../../../shared/rss-workspace'
import type { RSSContentStore } from '../database/rss-content-store'

interface ToolParam {
  name: string
  type: string
  description: string
  required: boolean
  enum?: string[]
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
  getContent?: () => Pick<RSSContentStore, 'query' | 'readArticle'>
  readAccessDenied?: boolean
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
    description: '对指定 RSS 条目运行 copy 或 visual 分析流程。',
    action: 'rss.analyzeItem',
    intent: 'analyze_rss_item',
    executionKind: 'pipeline',
    params: zodObjectToParamList(RSS_SCHEMAS.rss_analyze_item) as ToolParam[],
  },
  {
    name: 'rss_capture_session',
    description: '读取当前 RSS 会话快照、选中条目和最近分析状态。',
    action: 'rss.captureSession',
    intent: 'capture_rss_session',
    executionKind: 'deterministic',
    params: zodObjectToParamList(RSS_SCHEMAS.rss_capture_session) as ToolParam[],
  },
  {
    name: 'rss_query_items',
    description: '查询已保存的 RSS 资讯；支持收件箱/历史底稿、筛选和连续分页，不打开界面、不抓取、不改已读。',
    action: 'rss.queryItems', intent: 'query_rss_items', executionKind: 'deterministic',
    params: zodObjectToParamList(RSS_SCHEMAS.rss_query_items) as ToolParam[],
  },
  {
    name: 'rss_read_article',
    description: '按文章 ID 分段读取已保存正文和来源；沿 nextOffset 与 revision 继续读取。正文缺失会明确返回来源摘要，不冒充全文。',
    action: 'rss.readArticle', intent: 'read_rss_article', executionKind: 'deterministic',
    params: zodObjectToParamList(RSS_SCHEMAS.rss_read_article) as ToolParam[],
  },
]

function toSchemaParam(param: ToolParam): Record<string, unknown> {
  return {
    type: param.type,
    description: param.description,
    ...(param.enum ? { enum: param.enum } : {}),
  }
}

function toStructuredResult(tool: RSSToolDef, message: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({
    ...(extra || {}),
    module: 'rss',
    intent: tool.intent,
    executionKind: tool.executionKind,
    action: tool.action,
    message,
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

  if (toolName === 'rss_query_items' || toolName === 'rss_read_article') {
    if (context?.readAccessDenied || !context?.getContent) {
      return toStructuredResult(tool, '当前会话未获准读取本机 RSS 资料。', { ok: false, error: 'rss_read_not_authorized' })
    }
    try {
      const content = context.getContent()
      const data = toolName === 'rss_query_items'
        ? content.query(RSSQuerySchema.parse(args))
        : content.readArticle(RSSReadArticleSchema.parse(args))
      return toStructuredResult(tool, '已读取保存的 RSS 资料；范围、正文状态及续读位置以 data 为准。', { ok: true, data })
    } catch (error) {
      return toStructuredResult(tool, 'RSS 读取未完成。', { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

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
      if (payload.ok === false || payload.success === false) {
        return toStructuredResult(tool, 'RSS 操作未完成。', { ...payload, ok: false })
      }
      const summary = typeof payload.summary === 'string' && payload.summary.trim()
        ? payload.summary.trim()
        : `${tool.action} 已返回，请以状态和数据为准。`
      return toStructuredResult(tool, summary, payload)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return toStructuredResult(tool, `RSS action failed: ${tool.action} - ${message}`, {
        ok: false,
        error: message,
      })
    }
  }

  return toStructuredResult(tool, 'RSS 界面操作通道不可用，操作尚未执行。', { ok: false, error: 'module_bridge_unavailable' })
}
