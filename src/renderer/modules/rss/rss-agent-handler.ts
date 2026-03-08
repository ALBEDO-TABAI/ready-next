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
  addSource?: (payload: { name: string; url: string }) => Promise<{ success?: boolean; error?: string }>
  startItemAnalysis?: (payload: {
    itemId: string
    action: 'copy' | 'visual'
    link: string
    title: string
    targetDir: string
    summary?: string
    source?: string
    force: boolean
  }) => Promise<{ success?: boolean; error?: string; data?: { id?: string } }>
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
  items: RSSItem[]
  selectedSource: string | null
  selectedItem: RSSItem | null
  loadRSSData: () => Promise<void>
  handleRefresh: () => Promise<void>
  handleItemClick: (item: RSSItem) => void
  setLastAnalysis: (payload: {
    jobId?: string | null
    itemId?: string | null
    status?: string | null
    reportPath?: string | null
    manifestPath?: string | null
  }) => void
  setAnalysisProgressMap: (
    updater: (prev: Record<string, RSSAnalysisProgressLike>) => Record<string, RSSAnalysisProgressLike>,
  ) => void
  getWorkspaceRoot: () => string | null
  rssApi: RSSApi | undefined
  documentApi: DocumentApi | undefined
  sleep?: (ms: number) => Promise<void>
}

export function createRSSAgentHandler(deps: RSSAgentHandlerDeps): ModuleAgentActionHandler {
  const resolveItem = (args: Record<string, unknown>): RSSItem | null => {
    const itemId = String(args.itemId || '').trim()
    const title = String(args.title || '').trim().toLowerCase()
    if (itemId) {
      return deps.items.find((item) => item.id === itemId) || null
    }
    if (title) {
      return deps.items.find((item) => item.title.toLowerCase().includes(title)) || null
    }
    return deps.selectedItem
  }

  const sleep = deps.sleep || ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))

  const waitForAnalysisCompletion = async (
    itemId: string,
    jobId: string,
  ): Promise<RSSAnalysisProgressLike | null> => {
    const startedAt = Date.now()
    while (Date.now() - startedAt < 45_000) {
      const result = await deps.rssApi?.getItemAnalysisProgress?.({ itemIds: [itemId] })
      if (result?.success && result.data) {
        const progress = result.data[itemId]
        if (!progress) return null
        deps.setAnalysisProgressMap((prev) => ({ ...prev, [itemId]: progress }))
        if (progress.jobId === jobId && ['success', 'failed', 'skipped'].includes(progress.status)) {
          return progress
        }
      }
      await sleep(1500)
    }
    return null
  }

  return async ({ action, args }) => {
    if (action === 'rss.captureSession') {
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
        totalItems: deps.items.length,
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
      return {
        intent: 'add_rss_source',
        ownerResourceId: url,
        summary: `已添加 RSS 源：${name}`,
      }
    }

    if (action === 'rss.fetchUpdates') {
      await deps.handleRefresh()
      return {
        intent: 'fetch_rss_updates',
        summary: `RSS 更新已刷新，共加载 ${deps.items.length} 条内容。`,
      }
    }

    if (action === 'rss.selectItem') {
      const item = resolveItem(args)
      if (!item) throw new Error('未找到匹配的 RSS 条目')
      deps.handleItemClick(item)
      return {
        intent: 'select_rss_item',
        ownerResourceId: item.id,
        summary: `已选中 RSS 条目：《${item.title}》。`,
      }
    }

    if (action === 'rss.analyzeItem') {
      const item = resolveItem(args)
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
      deps.setLastAnalysis({
        jobId,
        itemId: item.id,
        status: 'queued',
        reportPath: null,
        manifestPath: null,
      })
      const finalProgress = jobId ? await waitForAnalysisCompletion(item.id, jobId) : null
      if (finalProgress) {
        deps.setLastAnalysis({
          jobId: finalProgress.jobId,
          itemId: finalProgress.itemId,
          status: finalProgress.status,
          reportPath: finalProgress.reportPath,
          manifestPath: finalProgress.outputDir ? `${finalProgress.outputDir}/manifest.json` : null,
        })
      }
      const reportPath = finalProgress?.reportPath || null
      const outputDir = finalProgress?.outputDir || null
      return {
        intent: 'analyze_rss_item',
        ownerResourceId: item.id,
        jobId,
        summary: reportPath
          ? `RSS 条目分析完成：《${item.title}》报告已生成。`
          : `RSS 条目分析已启动：《${item.title}》。`,
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
