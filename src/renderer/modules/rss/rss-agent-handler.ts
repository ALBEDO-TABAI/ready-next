import type { RSSRefreshOutcome } from './settings'
import type { RSSQueryResult, RSSQueryInput, RSSArticleExcerpt, RSSReadArticleInput } from '../../../shared/rss-workspace'
import { rssQueryKey, toRSSItem } from './workspace-query'
import type { RSSItem } from '../../components/rss/RSSFeed'
import type { ModuleAgentActionHandler } from '../../utils/moduleAgentBridge'

export type RSSAnalysisStatus =
  | 'queued'
  | 'paused'
  | 'running_script'
  | 'running_subagent'
  | 'success'
  | 'failed'
  | 'skipped'

export interface RSSAnalysisProgressLike {
  sourceWarning?: string | null
  itemId: string
  jobId: string
  action: 'copy' | 'visual'
  status: RSSAnalysisStatus
  progress: number
  message: string | null
  error: string | null
  outputDir: string
  reportPath: string | null
  updatedAt: string
}

interface RSSApi {
  readArticle?: (input: RSSReadArticleInput) => Promise<{ success: boolean; data?: RSSArticleExcerpt; error?: string }>
  queryItems?: (query: RSSQueryInput) => Promise<{ success: boolean; data?: RSSQueryResult; error?: string }>

  addSource?: (payload: { name: string; url: string }) => Promise<{
    success?: boolean
    error?: string
    data?: { warning?: string; itemCount?: number }
  }>
  startItemAnalysis?: (payload: {
    itemId: string
    action: 'copy' | 'visual'
    link: string
    title: string
    targetDir: string
    summary?: string
    source?: string
    force: boolean
  }) => Promise<{
    success?: boolean
    error?: string
    data?: {
      id?: string
      itemId?: string
      status?: RSSAnalysisStatus
      outputDir?: string
      reportPath?: string | null
      updatedAt?: string
    }
  }>
  getItemAnalysisProgress?: (payload: { itemIds: string[] }) => Promise<{
    success?: boolean
    error?: string
    data?: Record<string, RSSAnalysisProgressLike>
  }>
}

interface DocumentApi {
  getHome?: () => Promise<{ path?: string }>
}

export interface RSSAgentHandlerDeps {
  getView(): RSSQueryResult | null
  items: RSSItem[]
  selectedSource: string | null
  selectedItem: RSSItem | null
  loadRSSData: () => Promise<void>
  handleRefresh: () => Promise<RSSRefreshOutcome>
  handleItemClick: (item: RSSItem) => void
  setAnalysisProgressMap: (
    updater: (prev: Record<string, RSSAnalysisProgressLike>) => Record<string, RSSAnalysisProgressLike>,
  ) => void
  getWorkspaceRoot: () => string | null
  rssApi: RSSApi | undefined
  documentApi: DocumentApi | undefined
}

export function createRSSAgentHandler(deps: RSSAgentHandlerDeps): ModuleAgentActionHandler {
  const resolveItem = async (args: Record<string, unknown>): Promise<RSSItem | null> => {
    const itemId = String(args.itemId || '').trim() || (!args.title ? deps.selectedItem?.id : '')
    if (itemId) {
      const response = await deps.rssApi?.readArticle?.({ itemId, length: 1 })
      if (!response?.success || !response.data) throw new Error(response?.error || '无法读取指定文章')
      return toRSSItem(response.data.article)
    }
    const title = String(args.title || '').trim()
    if (!title) return null
    const response = await deps.rssApi?.queryItems?.({ ...deps.getView()?.query, scope: 'library', search: title, searchIn: 'title_summary', filter: 'all', limit: 2 })
    if (!response?.success || !response.data) throw new Error(response?.error || '文章查找失败')
    if (response.data.total > 1) throw new Error('找到多篇匹配资讯，请先查询并使用明确的文章 ID。')
    return response.data.items[0] ? toRSSItem(response.data.items[0]) : null
  }

  const readAnalysisProgress = async (
    itemId: string,
    jobId: string,
  ): Promise<RSSAnalysisProgressLike | null> => {
    const result = await deps.rssApi?.getItemAnalysisProgress?.({ itemIds: [itemId] })
    if (result?.success && result.data) {
      const progress = result.data[itemId]
      if (!progress || progress.jobId !== jobId) return null
      deps.setAnalysisProgressMap((prev) => ({ ...prev, [itemId]: progress }))
      return progress
    }
    return null
  }

  return async ({ action, args }) => {
    if (action === 'rss.captureSession') {
      const view = deps.getView()
      if (!view) return { intent: 'capture_rss_session', available: false, summary: '当前没有可读取的 RSS 视图；请用 rss_query_items 查询保存资料。' }
      const analysisResult = deps.selectedItem
        ? await deps.rssApi?.getItemAnalysisProgress?.({ itemIds: [deps.selectedItem.id] }) : undefined
      const current = deps.getView()
      if (!current || current.revision !== view.revision || rssQueryKey(current.query) !== rssQueryKey(view.query)) throw new Error('RSS 视图已变化，请重新读取。')
      return {
        intent: 'capture_rss_session',
        ownerResourceId: deps.selectedItem?.id || deps.selectedSource,
        summary: deps.selectedItem
          ? `RSS 会话已捕获：当前条目为《${deps.selectedItem.title}》。`
          : deps.selectedSource
            ? `RSS 会话已捕获：当前订阅源 ${deps.selectedSource}。`
            : 'RSS 会话已捕获：当前未选中订阅源或条目。',
        selectedSourceId: deps.selectedSource,
        selectedItemId: deps.selectedItem?.id ?? null,
        available: true,
        query: { ...view.query, expectedRevision: view.revision },
        totalItems: view.total,
        unreadItems: view.unreadTotal,
        loadedItems: view.items.length,
        lastFetchAt: view.lastFetchAt,
        analysis: analysisResult?.success && deps.selectedItem ? analysisResult.data?.[deps.selectedItem.id] ?? null : null,
        analysisError: deps.selectedItem && !analysisResult?.success ? '无法读取最新分析状态，请使用 rss_read_article 回查。' : null,
      }
    }

    if (action === 'rss.addSource') {
      const name = String(args.name || '').trim()
      const url = String(args.url || '').trim()
      if (!name || !url) throw new Error('rss.addSource 缺少 name 或 url')
      const result = await deps.rssApi?.addSource?.({ name, url })
      if (!result?.success) {
        throw new Error(result?.error || '添加 RSS 源失败')
      }
      await deps.loadRSSData()
      const sourceExists = result.data?.warning === 'source_exists'
      return {
        intent: 'add_rss_source',
        ownerResourceId: url,
        status: sourceExists ? 'already_exists' : 'added',
        summary: sourceExists ? `RSS 源已存在：${name}` : `已添加 RSS 源：${name}`,
      }
    }

    if (action === 'rss.fetchUpdates') {
      const outcome = await deps.handleRefresh()
      return {
        ...outcome,
        intent: 'fetch_rss_updates',
      }
    }

    if (action === 'rss.selectItem') {
      const item = await resolveItem(args)
      if (!item) throw new Error('未找到匹配的 RSS 条目')
      deps.handleItemClick(item)
      return {
        intent: 'select_rss_item',
        ownerResourceId: item.id,
        summary: `已选中 RSS 条目：《${item.title}》。`,
      }
    }

    if (action === 'rss.analyzeItem') {
      const item = await resolveItem(args)
      if (!item) throw new Error('未找到可分析的 RSS 条目')
      const analysisType = String(args.analysisType || '').trim().toLowerCase()
      if (analysisType !== 'copy' && analysisType !== 'visual') {
        throw new Error('analysisType 必须为 copy 或 visual')
      }
      const workspaceRoot = deps.getWorkspaceRoot()
      const homeResult = workspaceRoot ? null : await deps.documentApi?.getHome?.()
      const targetDir = workspaceRoot || homeResult?.path || '/tmp'
      const startResult = await deps.rssApi?.startItemAnalysis?.({
        itemId: item.id,
        action: analysisType as 'copy' | 'visual',
        link: item.link,
        title: item.title,
        targetDir,
        summary: item.summary,
        source: item.source,
        force: true,
      })
      if (!startResult?.success || !startResult.data) {
        throw new Error(startResult?.error || '启动 RSS 分析失败')
      }
      const jobId = String(startResult.data.id || '')
      const initialStatus = startResult.data.status || 'queued'
      const initialOutputDir = startResult.data.outputDir || null
      const initialReportPath = startResult.data.reportPath || null
      const currentProgress = jobId ? await readAnalysisProgress(item.id, jobId) : null
      const analysisState = currentProgress || {
        itemId: item.id,
        jobId,
        action: analysisType as 'copy' | 'visual',
        status: initialStatus,
        progress: 5,
        message: null,
        error: null,
        outputDir: initialOutputDir || '',
        reportPath: initialReportPath,
        updatedAt: startResult.data.updatedAt || '',
      } satisfies RSSAnalysisProgressLike
      const reportPath = analysisState.reportPath || null
      const outputDir = analysisState.outputDir || null
      const failed = analysisState.status === 'failed'
      return {
        intent: 'analyze_rss_item',
        ownerResourceId: item.id,
        jobId,
        status: analysisState.status,
        ok: !failed,
        error: failed ? analysisState.error || 'RSS 条目分析失败' : null,
        sourceWarning: analysisState.sourceWarning || null,
        summary: failed
          ? `RSS 条目分析失败：《${item.title}》。`
          : (
              reportPath
                ? `RSS 条目分析完成：《${item.title}》报告已生成。${analysisState.sourceWarning || ''}`
                : `RSS 条目分析已启动：《${item.title}》。`
            ),
        artifactRefs: reportPath
          ? [{
              kind: 'rss-report',
              label: reportPath.split(/[\\/]/).pop() || reportPath,
              path: reportPath,
              mimeType: 'text/markdown',
            }]
          : [],
        outputDir,
      }
    }

    throw new Error(`Unsupported RSS agent action: ${action}`)
  }
}
