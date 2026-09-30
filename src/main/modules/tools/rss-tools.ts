import { z } from 'zod'
import { RSSReadExcerptSchema } from '../../../shared/rss-excerpt'
import { RSSDigestReadSchema } from '../../../shared/rss-digests'
import type { RSSDigestStore } from '../database/rss-digest-store'
import { RSSReadReferenceSchema, rssCitationUrl, type RSSReferenceResource } from '../../../shared/rss-reference'
import { RSS_SCHEMAS, type RssToolName } from './schemas/rss-schemas'
import { zodObjectToParamList } from './zod-param-derivation'
import { RSSQuerySchema, RSSReadArticleSchema } from '../../../shared/rss-workspace'
import type { RSSContentStore } from '../database/rss-content-store'
import type { RSSProcessingStore } from '../database/rss-processing-store'
import { RSSProcessingListSchema } from '../../../shared/rss-processing'
import { RSSReadEventsSchema } from '../../../shared/rss-events'
import type { RSSEventStore } from '../database/rss-event-store'
import type { RSSItemAnalysisProgress } from '../rss-engine/item-analysis-manager'

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
  getDigests?: () => Pick<RSSDigestStore, 'read' | 'schedule'>
  getEvents?: () => Pick<RSSEventStore, 'browse'>
  getProcessing?: () => Pick<RSSProcessingStore, 'list' | 'status'>
  hasProcessingModel?: () => boolean
  getContent?: () => Pick<RSSContentStore, 'query' | 'readArticle' | 'readExcerpt'>
  getAnalysisProgress?: (itemIds: string[]) => Record<string, RSSItemAnalysisProgress>
  references?: RSSReferenceResource[]
  readAccessDenied?: boolean
  requestModuleToolAction?: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

const RSS_TOOLS: RSSToolDef[] = [
  { name: 'rss_read_excerpt', description: '读取绑定文章版本的段落或选区；范围原样沿用引用，续读不会越过选区。可用返回的 citationUrl 定位。',
    action: 'rss.readExcerpt', intent: 'read_rss_excerpt', executionKind: 'deterministic', params: zodObjectToParamList(RSS_SCHEMAS.rss_read_excerpt) as ToolParam[] },
  { name: 'rss_read_digests', description: '分页读取已保存日报或范围简报、原文依据与采集覆盖；仅查询，不生成、不重算、不标已读。',
    action: 'rss.readDigests', intent: 'read_rss_digests', executionKind: 'deterministic', params: zodObjectToParamList(RSS_SCHEMAS.rss_read_digests) as ToolParam[] },
  { name: 'rss_read_events', description: '分页读取已保存事件、当前报道或事实进展及历史版本依据。历史摘句不代表当前原文仍有效；只读，不重新归组。',
    action: 'rss.readEvents', intent: 'read_rss_events', executionKind: 'deterministic', params: zodObjectToParamList(RSS_SCHEMAS.rss_read_events) as ToolParam[] },
  {
    name: 'rss_read_processing', description: '读取 RSS 自动分类与精选的设置、当日调用次数及分页任务记录。仅查询，不启动、重试或取消任务。',
    action: 'rss.readProcessing', intent: 'read_rss_processing', executionKind: 'deterministic',
    params: zodObjectToParamList(RSS_SCHEMAS.rss_read_processing) as ToolParam[],
  },
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
    name: 'rss_read_reference',
    description: '读取本轮 RSS 引用：条件和版本由应用绑定，不能改写。查询按 nextCursor 续页，正文按 nextOffset 续读。旧引用已变化或删除时明确失败，不自动抓取或分析。',
    action: 'rss.readReference', intent: 'read_rss_reference', executionKind: 'deterministic',
    params: zodObjectToParamList(RSS_SCHEMAS.rss_read_reference) as ToolParam[],
  },
  {
    name: 'rss_query_items',
    description: '查询已保存的 RSS 资讯；支持收件箱/历史底稿、筛选和连续分页，不打开界面、不抓取、不改已读。',
    action: 'rss.queryItems', intent: 'query_rss_items', executionKind: 'deterministic',
    params: zodObjectToParamList(RSS_SCHEMAS.rss_query_items) as ToolParam[],
  },
  {
    name: 'rss_read_article',
    description: '按文章 ID 分段读取已保存正文和来源，以及最近分析任务、报告路径与原文变化警告；不重新启动分析。沿 nextOffset 与 revision 续读；缺失正文明确返回来源摘要。',
    action: 'rss.readArticle', intent: 'read_rss_article', executionKind: 'deterministic',
    params: zodObjectToParamList(RSS_SCHEMAS.rss_read_article) as ToolParam[],
  },
]

function toSchemaParam(param: ToolParam, toolName: string): Record<string, unknown> {
  if (param.type === 'object') {
    const { $schema: _dialect, ...shape } = z.toJSONSchema(RSS_SCHEMAS[toolName as RssToolName].shape[param.name], { io: 'input' })
    return shape
  }
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
      properties: Object.fromEntries(tool.params.map((param) => [param.name, toSchemaParam(param, tool.name)])),
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
        properties: Object.fromEntries(tool.params.map((param) => [param.name, toSchemaParam(param, tool.name)])),
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

  if (toolName === 'rss_read_digests') {
    if (context?.readAccessDenied || !context?.getDigests) return toStructuredResult(tool, '当前会话未获准读取本机 RSS 资料。', { ok: false, error: 'rss_read_not_authorized' })
    try { return toStructuredResult(tool, '已读取保存的刊物；原文摘句和精选判断分开标识，needsUpdate 表示发布后依据变化，未修改原刊。', { ok: true, data: context.getDigests().read(RSSDigestReadSchema.parse(args)), schedule: context.getDigests().schedule() }) }
    catch (error) { return toStructuredResult(tool, '刊物读取失败。', { ok: false, error: error instanceof Error ? error.message : String(error) }) }
  }

  if (toolName === 'rss_read_events') {
    if (context?.readAccessDenied || !context?.getEvents) return toStructuredResult(tool, '当前会话未获准读取本机 RSS 资料。', { ok: false, error: 'rss_read_not_authorized' })
    try { return toStructuredResult(tool, '事件数据以 data 为准，历史依据保留对应文章版本；待更新的关联不当作已重新验证。', { ok: true, data: context.getEvents().browse(RSSReadEventsSchema.parse(args)) }) }
    catch (error) { return toStructuredResult(tool, '事件读取失败。', { ok: false, error: error instanceof Error ? error.message : String(error) }) }
  }

  if (toolName === 'rss_read_processing') {
    if (context?.readAccessDenied || !context?.getProcessing || !context.hasProcessingModel) return toStructuredResult(tool, '当前会话未获准读取本机 RSS 资料。', { ok: false, error: 'rss_read_not_authorized' })
    try {
      const store = context.getProcessing()
      return toStructuredResult(tool, '整理状态以 data 为准；等待和请求结果未知不表示已完成。', { ok: true, data: { ...store.list(RSSProcessingListSchema.parse(args)), status: store.status(Date.now(), context.hasProcessingModel()) } })
    } catch (error) { return toStructuredResult(tool, '整理状态读取失败。', { ok: false, error: error instanceof Error ? error.message : String(error) }) }
  }

  if (toolName === 'rss_read_excerpt' || toolName === 'rss_query_items' || toolName === 'rss_read_article' || toolName === 'rss_read_reference') {
    if (context?.readAccessDenied || !context?.getContent) {
      return toStructuredResult(tool, '当前会话未获准读取本机 RSS 资料。', { ok: false, error: 'rss_read_not_authorized' })
    }
    try {
      let readKind = toolName
      let referenceId: string | undefined
      if (toolName === 'rss_read_reference') {
        const input = RSSReadReferenceSchema.parse(args)
        const matches = context.references?.filter((resource) => resource.id === input.referenceId) || []
        if (matches.length !== 1) throw new Error('rss_reference_unavailable')
        const reference = matches[0].reference
        referenceId = input.referenceId
        if (reference.kind === 'digest') {
          if (input.cursor !== undefined || !context.getDigests) throw new Error('rss_reference_wrong_cursor')
          return toStructuredResult(tool, '已读取引用绑定的刊物版本；使用 nextOffset 续读，引用来源通过 rss_read_digests 的 sources 视图读取。', {
            ok: true, referenceId, data: context.getDigests().read({ ...reference.read, view: 'entries', offset: input.offset ?? reference.read.offset }),
          })
        }
        if (reference.kind === 'query') {
          if (input.offset !== undefined) throw new Error('rss_reference_wrong_cursor')
          args = { ...reference.query, cursor: input.cursor }
          readKind = 'rss_query_items'
        } else {
          if (input.cursor !== undefined) throw new Error('rss_reference_wrong_cursor')
          args = { ...reference.read, offset: input.offset ?? reference.read.offset }
          readKind = reference.kind === 'excerpt' ? 'rss_read_excerpt' : 'rss_read_article'
        }
      }
      const content = context.getContent()
      const data = readKind === 'rss_query_items'
        ? content.query(RSSQuerySchema.parse(args))
        : readKind === 'rss_read_excerpt' ? content.readExcerpt(RSSReadExcerptSchema.parse(args)) : content.readArticle(RSSReadArticleSchema.parse(args))
      const citationUrl = readKind === 'rss_read_excerpt' ? rssCitationUrl({ kind: 'excerpt', read: RSSReadExcerptSchema.parse(args) }) : undefined
      const analysis = readKind === 'rss_read_article'
        ? context.getAnalysisProgress?.([String(args.itemId)])[String(args.itemId)] ?? null : undefined
      return toStructuredResult(tool, '已读取保存的 RSS 资料；范围、正文状态及续读位置以 data 为准，analysis 为最近分析的当前状态。', { ok: true, data, ...(citationUrl ? { citationUrl } : {}), ...(referenceId ? { referenceId } : {}), ...(analysis !== undefined ? { analysis } : {}) })
    } catch (error) {
      // silent-catch: the structured failed result is returned to the Agent, never treated as read success.
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
