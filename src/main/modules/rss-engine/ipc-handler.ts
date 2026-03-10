import { ipcMain, app } from 'electron'
import { join } from 'path'
import { readFile } from 'fs/promises'
import type { BrowserController } from '../browser-engine/ipc-handler'
import type { RSSAnalysisAction, RSSAnalysisJob } from '../database'
import { AppSettingsRepository } from '../repositories/app-settings-repository'
import { RSSRepository } from '../repositories/rss-repository'
import {
  detectPlatform,
  createScraper,
  needsRSSHub,
  platformLabel,
  type PlatformType,
} from './scrapers/index'
import { classifyItem } from './classifier'
import { rsshubManager } from './rsshub-process'
import type { ScrapedItem, ScrapeResult } from './scrapers/base'
import { generateRSSArtifacts, generateRSSBenchmarkArtifacts } from './reports'
import { rssUpdateLock } from './update-lock'
import { getRSSItemAnalysisManager } from './item-analysis-manager'
import { fetchFeedViaBrowserSession, supportsBrowserSessionAcquisition } from './browser-acquisition'
import {
  allowsRSSHubFallbackAfterBrowser,
  buildBenchmarkSummary,
  buildSourceDiagnostics,
  getRouteCapabilityMatrix,
  listRouteAttempts,
  recordSourceRouteAttempt,
  restoreRouteAttempts,
  resolveSourceBackend,
  type RSSSourceBenchmarkEntry,
  type SourceBackend,
  type RouteAttemptSnapshotEntry,
} from './source-diagnostics'

interface RSSResponse<T> {
  success: boolean
  mock: boolean
  data?: T
  error?: string
}

type ClassificationMode = 'simple' | 'none'

interface FetchAllOptions {
  digest?: boolean
  classification?: ClassificationMode
  group?: string
  sourceIds?: string[]
}

interface RSSBenchmarkOptions {
  group?: string
  sourceIds?: string[]
}

interface DBRSSItem {
  id: string
  source_id: string
  guid: string
  title: string
  link: string
  summary: string | null
  cover_image: string | null
  author: string | null
  published_at: number | null
  fetched_at: number
  read: number
  starred: number
  ai_score: number | null
  ai_tags: string | null
  source_name?: string
}

interface DBRSSSource {
  id: string
  name: string
  url: string
  group_name: string
  icon: string | null
  last_fetched: number | null
  fetch_interval: number
  enabled: number
  created_at: number
  platform: string
}

interface MappedRSSItem {
  id: string
  sourceId: string
  title: string
  link: string
  summary: string
  author: string
  source: string
  publishedAt: string
  read: boolean
  starred: boolean
  coverImage: string | null
  aiScore: number | null
  aiTags: string | null
}

interface MappedRSSSource {
  id: string
  name: string
  url: string
  group: string
  enabled: boolean
  platform: string
}

interface MappedRSSAnalysisJob {
  id: string
  itemId: string
  action: RSSAnalysisAction
  sourceUrl: string
  title: string
  targetDir: string
  outputDir: string
  reportPath: string | null
  status: string
  progress: number
  message: string | null
  error: string | null
  meta: Record<string, unknown> | null
  createdAt: string
  startedAt: string | null
  updatedAt: string
  finishedAt: string | null
}

interface RSSAnalysisProgressPayload {
  itemId: string
  jobId: string
  action: RSSAnalysisAction
  status: string
  progress: number
  message: string | null
  error: string | null
  outputDir: string
  reportPath: string | null
  updatedAt: string
}

const DIGEST_SNAPSHOT_KEY = 'rss:last_digest_snapshot'
const ROUTE_DIAGNOSTICS_SNAPSHOT_KEY = 'rss:last_route_diagnostics'
const FETCH_INVOCATION_SNAPSHOT_KEY = 'rss:last_fetch_invocation'
const rssRepository = new RSSRepository()
const appSettingsRepository = new AppSettingsRepository()
let rssBrowserController: BrowserController | null = null
const sourceRefreshInFlight = new Set<string>()

export function setRSSBrowserController(controller: BrowserController | null): void {
  rssBrowserController = controller
}

function createSuccessResponse<T>(data: T, isMock: boolean): RSSResponse<T> {
  return { success: true, mock: isMock, data }
}

function createErrorResponse(error: string): RSSResponse<never> {
  return { success: false, mock: false, error }
}

const mockSources = [
  { id: '1', name: '36氪', url: 'https://36kr.com/feed', group: 'tech', enabled: true, platform: 'rss' },
  { id: '2', name: '虎嗅', url: 'https://www.huxiu.com/rss', group: 'tech', enabled: true, platform: 'rss' },
]

const mockItems = [
  {
    id: '1',
    sourceId: '1',
    title: 'AI 创作工具的下一个十年',
    link: 'https://36kr.com/p/123456',
    summary: '探讨 AI 如何改变内容创作行业...',
    author: '张三',
    source: '36氪',
    publishedAt: new Date(Date.now() - 3600000).toISOString(),
    read: false,
    starred: false,
    coverImage: null,
    aiScore: null,
    aiTags: '科技',
  },
]

function mapDBItemToAPI(item: DBRSSItem): MappedRSSItem {
  return {
    id: item.id,
    sourceId: item.source_id,
    title: item.title,
    link: item.link,
    summary: item.summary ?? '',
    author: item.author ?? '',
    source: item.source_name ?? '',
    publishedAt: item.published_at ? new Date(item.published_at * 1000).toISOString() : '',
    read: item.read === 1,
    starred: item.starred === 1,
    coverImage: item.cover_image ?? null,
    aiScore: item.ai_score ?? null,
    aiTags: item.ai_tags ?? null,
  }
}

function mapDBSourceToAPI(source: DBRSSSource): MappedRSSSource {
  return {
    id: source.id,
    name: source.name,
    url: source.url,
    group: source.group_name ?? 'default',
    enabled: source.enabled === 1,
    platform: source.platform ?? 'rss',
  }
}

function parseMetaJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
}

function mapAnalysisJob(job: RSSAnalysisJob): MappedRSSAnalysisJob {
  return {
    id: job.id,
    itemId: job.item_id,
    action: job.action,
    sourceUrl: job.source_url,
    title: job.title,
    targetDir: job.target_dir,
    outputDir: job.output_dir,
    reportPath: job.report_path,
    status: job.status,
    progress: Number(job.progress) || 0,
    message: job.message,
    error: job.error,
    meta: parseMetaJson(job.meta_json),
    createdAt: job.created_at,
    startedAt: job.started_at,
    updatedAt: job.updated_at,
    finishedAt: job.finished_at,
  }
}

async function limitConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length)
  let index = 0

  async function runNext(): Promise<void> {
    while (index < tasks.length) {
      const current = index++
      try {
        const value = await tasks[current]()
        results[current] = { status: 'fulfilled', value }
      } catch (reason) {
        results[current] = { status: 'rejected', reason }
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => runNext())
  await Promise.all(workers)
  return results
}

function normalizeRSSHubBase(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

async function isRSSHubReachable(baseUrl: string): Promise<boolean> {
  const base = normalizeRSSHubBase(baseUrl)
  if (!base) return false

  try {
    const health = await fetchWithTimeout(`${base}/healthz`, 2500)
    if (health.ok) return true
  } catch {
    // fall through
  }

  try {
    const root = await fetchWithTimeout(base, 3000)
    if (!root.ok) return false
    const text = (await root.text()).toLowerCase()
    const contentType = (root.headers.get('content-type') || '').toLowerCase()
    return text.includes('rsshub') || contentType.includes('xml') || contentType.includes('html')
  } catch {
    return false
  }
}

async function resolveRSSHubBase(): Promise<string> {
  const externalRaw = rssRepository.getSetting('rsshub_base_url')
  const external = externalRaw ? normalizeRSSHubBase(externalRaw) : ''

  const embeddedHealthy = await rsshubManager.ensureHealthy()
  if (embeddedHealthy) {
    return rsshubManager.getBaseUrl()
  }

  if (external && (await isRSSHubReachable(external))) {
    return external
  }

  const publicFallback = 'https://rsshub.app'
  if (await isRSSHubReachable(publicFallback)) {
    return publicFallback
  }

  const candidate = external || publicFallback
  throw new Error(
    `RSSHub 不可用。内嵌 RSSHub 启动失败，且外部地址 ${candidate} 不可达。请稍后重试或在设置中配置可用 RSSHub 地址。`,
  )
}

function isRSSHubRequiredForCurrentSources(): boolean {
  const sources = rssRepository.getRSSSources() as DBRSSSource[]
  return sources.some((source) =>
    needsRSSHub(((source.platform as PlatformType) || 'rss') as PlatformType),
  )
}

async function warmEmbeddedRSSHubForDiagnostics(): Promise<boolean> {
  const required = isRSSHubRequiredForCurrentSources()
  if (!required) return false
  const current = rsshubManager.getStatus()
  if (current.running) return true
  await rsshubManager.ensureHealthy().catch(() => false)
  return true
}

function getArtifactsRootDir(): string {
  return join(app.getPath('userData'), 'rss-artifacts')
}

function loadDigestSnapshot(): Record<string, string> {
  const raw = rssRepository.getSetting(DIGEST_SNAPSHOT_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, string>
    return parsed ?? {}
  } catch {
    return {}
  }
}

function saveDigestSnapshot(snapshot: Record<string, string>): void {
  rssRepository.setSetting(DIGEST_SNAPSHOT_KEY, JSON.stringify(snapshot))
}

function normalizeFetchOptions(options?: FetchAllOptions): {
  digest: boolean
  classification: ClassificationMode
  group?: string
  sourceIds?: string[]
} {
  const digest = options?.digest === true
  const classification: ClassificationMode = options?.classification === 'none' ? 'none' : 'simple'
  const group = options?.group?.trim()
  const sourceIds = Array.isArray(options?.sourceIds)
    ? options?.sourceIds.filter((id) => typeof id === 'string' && id.trim().length > 0)
    : undefined
  return {
    digest,
    classification,
    group: group || undefined,
    sourceIds: sourceIds && sourceIds.length > 0 ? sourceIds : undefined,
  }
}

function loadRouteDiagnosticsSnapshot(): void {
  const raw = rssRepository.getSetting(ROUTE_DIAGNOSTICS_SNAPSHOT_KEY)
  if (!raw) return
  try {
    const parsed = JSON.parse(raw) as RouteAttemptSnapshotEntry[]
    if (Array.isArray(parsed)) {
      restoreRouteAttempts(parsed)
    }
  } catch {
    // ignore invalid persisted snapshot
  }
}

function persistRouteDiagnosticsSnapshot(): void {
  appSettingsRepository.setSetting(ROUTE_DIAGNOSTICS_SNAPSHOT_KEY, JSON.stringify(listRouteAttempts()))
}

function persistFetchInvocation(payload: Record<string, unknown>): void {
  appSettingsRepository.setSetting(
    FETCH_INVOCATION_SNAPSHOT_KEY,
    JSON.stringify({
      recordedAt: new Date().toISOString(),
      ...payload,
    }),
  )
}

function loadFetchInvocationSnapshot(): {
  recordedAt: string | null
  mode: 'refreshSource' | 'fetchAll' | null
  sourceId: string | null
  sourceIds: string[]
  group: string | null
  digest: boolean | null
  classification: 'simple' | 'none' | null
} | null {
  const raw = appSettingsRepository.getSetting(FETCH_INVOCATION_SNAPSHOT_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      recordedAt: typeof parsed.recordedAt === 'string' ? parsed.recordedAt : null,
      mode: parsed.mode === 'refreshSource' || parsed.mode === 'fetchAll' ? parsed.mode : null,
      sourceId: typeof parsed.sourceId === 'string' ? parsed.sourceId : null,
      sourceIds: Array.isArray(parsed.sourceIds)
        ? parsed.sourceIds.filter((value): value is string => typeof value === 'string')
        : [],
      group: typeof parsed.group === 'string' ? parsed.group : null,
      digest: typeof parsed.digest === 'boolean' ? parsed.digest : null,
      classification:
        parsed.classification === 'simple' || parsed.classification === 'none'
          ? parsed.classification
          : null,
    }
  } catch {
    return null
  }
}

function normalizeSourcePlatform(source: DBRSSSource): PlatformType {
  const storedPlatform = (source.platform as PlatformType) || 'rss'
  const detectedPlatform = detectPlatform(source.url)
  return storedPlatform === 'rss' && detectedPlatform !== 'rss' ? detectedPlatform : storedPlatform
}

function classifyBackend(source: DBRSSSource): SourceBackend {
  return resolveSourceBackend(normalizeSourcePlatform(source))
}

function requiresRSSHubWarmup(platform: PlatformType): boolean {
  return (
    allowsRSSHubFallbackAfterBrowser(platform) ||
    (needsRSSHub(platform) && !(rssBrowserController && supportsBrowserSessionAcquisition(platform)))
  )
}

function requiresStrictRSSHubAvailability(platform: PlatformType): boolean {
  return needsRSSHub(platform) && !(rssBrowserController && supportsBrowserSessionAcquisition(platform))
}

function filterSelectedSources(
  sources: DBRSSSource[],
  options?: { group?: string; sourceIds?: string[] },
): DBRSSSource[] {
  const wantedIds = new Set((options?.sourceIds || []).filter((id) => typeof id === 'string' && id.trim().length > 0))
  const group = options?.group?.trim()

  if (wantedIds.size > 0) {
    return sources.filter((source) => wantedIds.has(source.id))
  }

  if (group) {
    const grouped = sources.filter((source) => (source.group_name || 'default') === group)
    if (grouped.length > 0) return grouped
  }

  return sources.filter((source) => source.enabled !== 0)
}

async function ensureArtifactFiles() {
  const sources = rssRepository.getRSSSources() as DBRSSSource[]
  const allItems = rssRepository.getRSSItems() as DBRSSItem[]
  return generateRSSArtifacts({
    sources,
    allItems,
    insertedItems: [],
  })
}

async function fetchSourceWithCurrentStack(
  source: Pick<DBRSSSource, 'id' | 'name' | 'url' | 'group_name'>,
  platform: PlatformType,
  rsshubBase?: string,
): Promise<{ result: ScrapeResult; backendUsed: SourceBackend }> {
  const scraper = createScraper(platform, rsshubBase)
  const allowRSSHubFallback = allowsRSSHubFallbackAfterBrowser(platform)

  if (rssBrowserController && supportsBrowserSessionAcquisition(platform)) {
    try {
      const browserResult = await fetchFeedViaBrowserSession(rssBrowserController, platform, source.url)
      if (browserResult.items.length > 0 || !browserResult.error) {
        return {
          result: browserResult,
          backendUsed: 'browser',
        }
      }

      if (!rsshubBase || !allowRSSHubFallback) {
        return {
          result: browserResult,
          backendUsed: 'browser',
        }
      }

      const rsshubResult = await scraper.fetchItems(source.url)
      if (rsshubResult.items.length > 0 || !rsshubResult.error) {
        return {
          result: {
            ...rsshubResult,
            error: browserResult.error
              ? `应用内浏览器主链失败，已回退 RSSHub：${browserResult.error}`
              : undefined,
          },
          backendUsed: 'rsshub',
        }
      }

      return {
        result: {
          ...browserResult,
          error: [browserResult.error, rsshubResult.error].filter(Boolean).join(' | RSSHub 回退失败：'),
        },
        backendUsed: 'browser',
      }
    } catch (error) {
      const browserMessage = error instanceof Error ? error.message : String(error)
      if (!rsshubBase || !allowRSSHubFallback) {
        return {
          result: {
            items: [],
            feedTitle: '',
            platform,
            error: `应用内浏览器抓取异常：${browserMessage}`,
          },
          backendUsed: 'browser',
        }
      }

      const rsshubResult = await scraper.fetchItems(source.url)
      if (rsshubResult.items.length > 0 || !rsshubResult.error) {
        return {
          result: {
            ...rsshubResult,
            error: `应用内浏览器抓取异常，已回退 RSSHub：${browserMessage}`,
          },
          backendUsed: 'rsshub',
        }
      }

      return {
        result: {
          items: [],
          feedTitle: '',
          platform,
          error: `应用内浏览器抓取异常：${browserMessage}${rsshubResult.error ? ` | RSSHub 回退失败：${rsshubResult.error}` : ''}`,
        },
        backendUsed: 'browser',
      }
    }
  }

  const result = await scraper.fetchItems(source.url)
  return {
    result,
    backendUsed: resolveSourceBackend(platform),
  }
}

async function loadLatestBenchmarkSnapshot(): Promise<{
  startedAt: string
  finishedAt: string
  sourceCount: number
  entries: RSSSourceBenchmarkEntry[]
  summary: ReturnType<typeof buildBenchmarkSummary>
  artifacts: {
    benchmarkJson: string
    benchmarkMarkdown: string
  }
} | null> {
  const benchmarkJsonPath = join(getArtifactsRootDir(), 'benchmark.latest.json')
  const benchmarkMarkdownPath = join(getArtifactsRootDir(), 'benchmark.latest.md')
  try {
    const raw = await readFile(benchmarkJsonPath, 'utf8')
    const parsed = JSON.parse(raw) as {
      startedAt: string
      finishedAt: string
      sourceCount: number
      entries: RSSSourceBenchmarkEntry[]
      summary: ReturnType<typeof buildBenchmarkSummary>
    }
    return {
      ...parsed,
      artifacts: {
        benchmarkJson: benchmarkJsonPath,
        benchmarkMarkdown: benchmarkMarkdownPath,
      },
    }
  } catch {
    return null
  }
}

export function setupRSSIPC(useMock = false): void {
  const analysisManager = getRSSItemAnalysisManager()
  if (!useMock) {
    loadRouteDiagnosticsSnapshot()
    queueMicrotask(() => {
      if (isRSSHubRequiredForCurrentSources()) {
        void rsshubManager.ensureHealthy().catch(() => {
          // best-effort warm only
        })
      }
    })
  }

  ipcMain.handle('rss:getSources', async () => {
    if (useMock) return createSuccessResponse(mockSources, true)

    try {
      const sources = rssRepository.getRSSSources() as DBRSSSource[]
      return createSuccessResponse(sources.map(mapDBSourceToAPI), false)
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error))
    }
  })

  ipcMain.handle('rss:addSource', async (_, source: { name?: string; url: string; group?: string }) => {
    if (useMock) {
      return createSuccessResponse({ id: `source-${Date.now()}`, platform: 'rss', itemCount: 0 }, true)
    }

    try {
      const startedAt = Date.now()
      let feedUrl: string
      try {
        feedUrl = new URL(source.url).href
      } catch {
        return createErrorResponse(`Invalid URL: ${source.url}`)
      }

      const platform = detectPlatform(feedUrl)
      const backend = resolveSourceBackend(platform)
      let rsshubBase: string | undefined

      if (requiresRSSHubWarmup(platform)) {
        try {
          rsshubBase = await resolveRSSHubBase()
        } catch (error) {
          if (platform !== 'bilibili') {
            throw error
          }
          console.warn(
            `[rss:add] rsshub unavailable for bilibili, will fallback to official API: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
        }
      }

      console.log(`[rss:add] url=${feedUrl} platform=${platform} hub=${rsshubBase || 'none'}`)
      const { result, backendUsed } = await fetchSourceWithCurrentStack(
        {
          id: `pending:${feedUrl}`,
          name: source.name?.trim() || feedUrl,
          url: feedUrl,
          group_name: source.group || 'default',
        },
        platform,
        rsshubBase,
      )

      const allowSourceWithoutInitialItems =
        platform === 'bilibili' && result.items.length === 0 && !!result.error

      const sourceName = source.name?.trim() || result.feedTitle || feedUrl
      const id = rssRepository.addRSSSource({
        name: sourceName,
        url: feedUrl,
        group: source.group,
        platform,
      })

      let itemCount = 0
      if (result.items.length > 0) {
        const dbItems = result.items.map((item) => ({
          id: item.itemId,
          source_id: id,
          guid: item.link || item.itemId,
          title: item.title,
          link: item.link,
          summary: item.description || null,
          cover_image: item.coverImage || null,
          author: item.author || null,
          published_at: item.pubDate ? Math.floor(new Date(item.pubDate).getTime() / 1000) : null,
          ai_tags: classifyItem(item.title, item.description),
        }))
        itemCount = rssRepository.upsertRSSItems(dbItems)
        rssRepository.updateRSSSourceLastFetched(id)
      }

      if (result.error && result.items.length === 0 && !allowSourceWithoutInitialItems) {
        recordSourceRouteAttempt({
          sourceId: `pending:${feedUrl}`,
          sourceName: sourceName,
          url: feedUrl,
          groupName: source.group,
          platform,
          backend: backendUsed,
          durationMs: Date.now() - startedAt,
          itemCount: 0,
          success: false,
          error: result.error,
        })
        persistRouteDiagnosticsSnapshot()
        rssRepository.removeRSSSource(id)
        return createErrorResponse(`Cannot fetch feed: ${result.error}`)
      }

      recordSourceRouteAttempt({
        sourceId: id,
        sourceName,
        url: feedUrl,
        groupName: source.group,
        platform,
        backend: backendUsed,
        durationMs: Date.now() - startedAt,
        itemCount: result.items.length,
        success: true,
        warning: result.error ?? null,
      })
      persistRouteDiagnosticsSnapshot()

      return createSuccessResponse(
        {
          id,
          platform,
          name: sourceName,
          itemCount,
          warning:
            allowSourceWithoutInitialItems
              ? `Bilibili 源已添加，但首次抓取失败：${result.error}`
              : result.error
                ? result.error
              : undefined,
        },
        false,
      )
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error))
    }
  })

  ipcMain.handle('rss:removeSource', async (_, id: string) => {
    if (useMock) return createSuccessResponse({ removed: true }, true)

    try {
      rssRepository.removeRSSSource(id)
      return createSuccessResponse({ removed: true }, false)
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error))
    }
  })

  ipcMain.handle('rss:getItems', async (_, sourceId?: string) => {
    if (useMock) {
      const items = sourceId ? mockItems.filter((item) => item.sourceId === sourceId) : mockItems
      return createSuccessResponse(items, true)
    }

    try {
      const rawItems = rssRepository.getRSSItemsWithSource(sourceId) as DBRSSItem[]
      return createSuccessResponse(rawItems.map(mapDBItemToAPI), false)
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error))
    }
  })

  ipcMain.handle('rss:markRead', async (_, itemId: string) => {
    if (useMock) return createSuccessResponse({ marked: true }, true)

    try {
      rssRepository.markRSSRead(itemId)
      return createSuccessResponse({ marked: true }, false)
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error))
    }
  })

  ipcMain.handle('rss:markReadBatch', async (_, itemIds: string[]) => {
    if (useMock) return createSuccessResponse({ marked: itemIds.length }, true)

    try {
      const marked = rssRepository.markRSSReadMany(itemIds)
      console.log(`[rss:batch] markReadBatch size=${itemIds.length} marked=${marked}`)
      return createSuccessResponse({ marked }, false)
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error))
    }
  })

  ipcMain.handle('rss:deleteItems', async (_, itemIds: string[]) => {
    if (useMock) return createSuccessResponse({ deleted: itemIds.length }, true)

    try {
      const deleted = rssRepository.deleteRSSItems(itemIds)
      console.log(`[rss:batch] deleteItems size=${itemIds.length} deleted=${deleted}`)
      return createSuccessResponse({ deleted }, false)
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error))
    }
  })

  ipcMain.handle('rss:toggleStarred', async (_, itemId: string) => {
    if (useMock) return createSuccessResponse({ toggled: true }, true)

    try {
      rssRepository.toggleRSSStarred(itemId)
      return createSuccessResponse({ toggled: true }, false)
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error))
    }
  })

  ipcMain.handle(
    'rss:startItemAnalysis',
    async (
      _,
      payload: {
        itemId: string
        action: RSSAnalysisAction
        link: string
        title: string
        targetDir: string
        source?: string
        summary?: string
        publishedAt?: string
        force?: boolean
      },
    ) => {
      if (useMock) {
        const now = new Date().toISOString()
        return createSuccessResponse(
          {
            id: `mock-analysis-${Date.now()}`,
            itemId: payload.itemId,
            action: payload.action,
            sourceUrl: payload.link,
            title: payload.title,
            targetDir: payload.targetDir,
            outputDir: payload.targetDir,
            reportPath: null,
            status: 'queued',
            progress: 5,
            message: 'mock queued',
            error: null,
            meta: null,
            createdAt: now,
            startedAt: null,
            updatedAt: now,
            finishedAt: null,
          } satisfies MappedRSSAnalysisJob,
          true,
        )
      }

      try {
        if (!payload?.itemId || !payload?.link || !payload?.title || !payload?.targetDir) {
          return createErrorResponse('Missing required fields: itemId, link, title, targetDir')
        }
        if (payload.action !== 'copy' && payload.action !== 'visual') {
          return createErrorResponse(`Unsupported analysis action: ${String(payload.action)}`)
        }
        const job = await analysisManager.startItemAnalysis({
          itemId: payload.itemId,
          action: payload.action,
          link: payload.link,
          title: payload.title,
          targetDir: payload.targetDir,
          source: payload.source,
          summary: payload.summary,
          publishedAt: payload.publishedAt,
          force: payload.force,
        })
        return createSuccessResponse(mapAnalysisJob(job), false)
      } catch (error) {
        return createErrorResponse(error instanceof Error ? error.message : String(error))
      }
    },
  )

  ipcMain.handle('rss:getItemAnalysisProgress', async (_, payload?: { itemIds?: string[] }) => {
    if (useMock) return createSuccessResponse({} as Record<string, RSSAnalysisProgressPayload>, true)

    try {
      const itemIds = Array.isArray(payload?.itemIds)
        ? payload!.itemIds.filter((id) => typeof id === 'string' && id.trim().length > 0)
        : undefined
      const progress = analysisManager.getItemProgress(itemIds)
      return createSuccessResponse(progress as Record<string, RSSAnalysisProgressPayload>, false)
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error))
    }
  })

  ipcMain.handle('rss:listItemAnalysisJobs', async (_, payload?: { itemId?: string; limit?: number }) => {
    if (useMock) return createSuccessResponse([] as MappedRSSAnalysisJob[], true)

    try {
      const jobs = analysisManager
        .listJobs(payload?.itemId, payload?.limit)
        .map((job) => mapAnalysisJob(job))
      return createSuccessResponse(jobs, false)
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error))
    }
  })

  ipcMain.handle('rss:pauseAnalysisJob', async (_, payload?: { jobId?: string }) => {
    if (useMock) return createSuccessResponse({ paused: false }, true)
    try {
      if (!payload?.jobId) return createErrorResponse('Missing jobId')
      const job = analysisManager.pauseJob(payload.jobId)
      return createSuccessResponse({ paused: true, job: mapAnalysisJob(job) }, false)
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error))
    }
  })

  ipcMain.handle('rss:resumeAnalysisJob', async (_, payload?: { jobId?: string }) => {
    if (useMock) return createSuccessResponse({ resumed: false }, true)
    try {
      if (!payload?.jobId) return createErrorResponse('Missing jobId')
      const job = analysisManager.resumeJob(payload.jobId)
      return createSuccessResponse({ resumed: true, job: mapAnalysisJob(job) }, false)
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error))
    }
  })

  ipcMain.handle('rss:deleteAnalysisJob', async (_, payload?: { jobId?: string }) => {
    if (useMock) return createSuccessResponse({ deleted: false }, true)
    try {
      if (!payload?.jobId) return createErrorResponse('Missing jobId')
      const result = analysisManager.deleteJob(payload.jobId)
      return createSuccessResponse(result, false)
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error))
    }
  })

  ipcMain.handle('rss:status', async () => {
    if (useMock) {
      return createSuccessResponse(
        {
          rsshub: {
            state: 'mock',
            running: false,
            port: 0,
            baseUrl: null,
            restartCount: 0,
            lastError: null,
            lastStartupError: null,
            lastRuntimeError: null,
            lastRuntimeErrorAt: null,
            startedAt: null,
            exitedAt: null,
            chromium: {
              ready: false,
              executablePath: null,
              source: 'none',
              cacheDir: '',
              buildId: '',
              downloadSupported: null,
              lastCheckedAt: null,
              lastError: null,
            },
          },
          update: rssUpdateLock.getStatus(),
          artifactsDir: getArtifactsRootDir(),
        },
        true,
      )
    }

    try {
      const rsshubRequired = await warmEmbeddedRSSHubForDiagnostics()
      const status = rssUpdateLock.getStatus()
      const rsshubStatus = await rsshubManager.describeStatus()
      return createSuccessResponse(
        {
          rsshub: rsshubStatus,
          rsshubRequired,
          update: status,
          artifactsDir: getArtifactsRootDir(),
        },
        false,
      )
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error))
    }
  })

  ipcMain.handle('rss:stats', async () => {
    if (useMock) {
      return createSuccessResponse(
        {
          totalSources: mockSources.length,
          totalItems: mockItems.length,
          unreadItems: mockItems.filter((item) => !item.read).length,
          platformDistribution: { rss: mockSources.length },
          categoryDistribution: { 科技: mockItems.length },
        },
        true,
      )
    }

    try {
      const stats = rssRepository.getRSSStats()
      return createSuccessResponse(stats, false)
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error))
    }
  })

  ipcMain.handle('rss:exportOpml', async () => {
    if (useMock) {
      return createSuccessResponse({ path: join(getArtifactsRootDir(), 'subscriptions.opml') }, true)
    }

    try {
      const artifacts = await ensureArtifactFiles()
      return createSuccessResponse({ path: artifacts.files.subscriptionsOpml }, false)
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error))
    }
  })

  ipcMain.handle(
    'rss:exportFeed',
    async (_, type: 'master' | 'tech' | 'humanities' | 'design' | 'entertainment' | 'others' = 'master') => {
      if (useMock) {
        return createSuccessResponse({ path: join(getArtifactsRootDir(), 'feed.xml') }, true)
      }

      try {
        const artifacts = await ensureArtifactFiles()
        const path =
          type === 'master'
            ? artifacts.files.masterFeed
            : artifacts.files.categoryFeeds[type] || artifacts.files.masterFeed
        return createSuccessResponse({ path }, false)
      } catch (error) {
        return createErrorResponse(error instanceof Error ? error.message : String(error))
      }
    },
  )

  ipcMain.handle('rss:fetchAll', async (_, options?: FetchAllOptions) => {
    if (useMock) {
      return createSuccessResponse(
        { message: 'RSS fetch simulated (mock mode)', fetched: 0, digest: false, errors: [] as string[] },
        true,
      )
    }

    try {
      const normalized = normalizeFetchOptions(options)
      persistFetchInvocation({
        mode: 'fetchAll',
        sourceIds: normalized.sourceIds ?? [],
        group: normalized.group ?? null,
        digest: normalized.digest,
        classification: normalized.classification,
      })
      const lockResult = await rssUpdateLock.run(normalized, async () => {
        const allSources = rssRepository.getRSSSources() as DBRSSSource[]
        const sources = filterSelectedSources(allSources, normalized)

        if (sources.length === 0) {
          return {
            insertedCount: 0,
            errors: [],
            sourceCount: 0,
            message:
              normalized.sourceIds?.length || normalized.group
                ? 'No RSS sources matched the current selection'
                : 'No RSS sources configured',
          }
        }

        const hasRSSHubSource = sources.some((source) =>
          requiresRSSHubWarmup((((source.platform as PlatformType) || 'rss') as PlatformType)),
        )
        let rsshubBase: string | undefined
        let rsshubResolveError: string | null = null
        if (hasRSSHubSource) {
          try {
            rsshubBase = await resolveRSSHubBase()
          } catch (error) {
            rsshubResolveError = error instanceof Error ? error.message : String(error)
            console.warn(`[rss:fetchAll] rsshub unavailable: ${rsshubResolveError}`)
          }
        }

        console.log(
          `[rss:fetchAll] sources=${sources.length} digest=${normalized.digest} classification=${normalized.classification} rsshub=${rsshubBase || 'none'}`,
        )

        const insertedItemIds: string[] = []
        const errors: string[] = []
        let totalInserted = 0

        const tasks = sources.map((source) => async () => {
          const startedAt = Date.now()
          const storedPlatform = (source.platform as PlatformType) || 'rss'
          const detectedPlatform = detectPlatform(source.url)
          const platform =
            storedPlatform === 'rss' && detectedPlatform !== 'rss' ? detectedPlatform : storedPlatform
          const backend = resolveSourceBackend(platform)

          if (platform !== storedPlatform) {
            rssRepository.updateRSSSourcePlatform(source.id, platform)
            console.log(
              `[rss:fetchAll] migrated source platform ${source.name}: ${storedPlatform} -> ${platform}`,
            )
          }

          if (requiresStrictRSSHubAvailability(platform) && platform !== 'bilibili' && !rsshubBase) {
            const message = `[${source.name}] RSSHub unavailable: ${rsshubResolveError || 'unknown error'}`
            recordSourceRouteAttempt({
              sourceId: source.id,
              sourceName: source.name,
              url: source.url,
              groupName: source.group_name,
              platform,
              backend,
              durationMs: Date.now() - startedAt,
              itemCount: 0,
              success: false,
              error: message,
            })
            persistRouteDiagnosticsSnapshot()
            throw new Error(message)
          }
          const { result, backendUsed } = await fetchSourceWithCurrentStack(source, platform, rsshubBase)

          if (result.error && result.items.length === 0) {
            const message = `[${source.name}] ${result.error}`
            recordSourceRouteAttempt({
              sourceId: source.id,
              sourceName: source.name,
              url: source.url,
              groupName: source.group_name,
              platform,
              backend: backendUsed,
              durationMs: Date.now() - startedAt,
              itemCount: 0,
              success: false,
              error: message,
            })
            persistRouteDiagnosticsSnapshot()
            throw new Error(message)
          }

          const dbItems = result.items.map((item: ScrapedItem) => ({
            id: item.itemId,
            source_id: source.id,
            guid: item.link || item.itemId,
            title: item.title,
            link: item.link,
            summary: item.description || null,
            cover_image: item.coverImage || null,
            author: item.author || null,
            published_at: item.pubDate ? Math.floor(new Date(item.pubDate).getTime() / 1000) : null,
            ai_tags:
              normalized.classification === 'simple' ? classifyItem(item.title, item.description) : null,
          }))

          const candidateIds = dbItems.map((item) => item.id)
          const existingIds = new Set(rssRepository.getRSSItemsByIds(candidateIds).map((item) => item.id))
          const newIds = candidateIds.filter((id) => !existingIds.has(id))

          const inserted = rssRepository.upsertRSSItems(dbItems)
          rssRepository.updateRSSSourceLastFetched(source.id)
          recordSourceRouteAttempt({
            sourceId: source.id,
            sourceName: source.name,
            url: source.url,
            groupName: source.group_name,
            platform,
            backend: backendUsed,
            durationMs: Date.now() - startedAt,
            itemCount: result.items.length,
            success: true,
            warning: result.error ?? null,
          })
          persistRouteDiagnosticsSnapshot()
          return {
            sourceId: source.id,
            inserted,
            insertedIds: newIds,
          }
        })

        const settled = await limitConcurrency(tasks, 5)
        for (const result of settled) {
          if (result.status === 'fulfilled') {
            totalInserted += result.value.inserted
            insertedItemIds.push(...result.value.insertedIds)
          } else {
            const message =
              result.reason instanceof Error ? result.reason.message : String(result.reason)
            errors.push(message)
            console.error('[rss:fetchAll]', message)
          }
        }

        const allItems = rssRepository.getRSSItems() as DBRSSItem[]
        const insertedItems = rssRepository.getRSSItemsByIds(insertedItemIds) as DBRSSItem[]

        await generateRSSArtifacts({
          sources,
          allItems,
          insertedItems,
        })

        if (normalized.digest) {
          const previous = loadDigestSnapshot()
          const latestPerSource = rssRepository.getLatestPerSource()
          const current: Record<string, string> = {}
          for (const item of latestPerSource) {
            current[item.source_id] = item.id
          }
          saveDigestSnapshot(current)

          const changedSources = Object.keys(current).filter((sourceId) => previous[sourceId] !== current[sourceId])
          return {
            insertedCount: totalInserted,
            errors,
            sourceCount: sources.length,
            message: `Fetched ${sources.length} sources, ${totalInserted} new items, digest changed ${changedSources.length} sources`,
          }
        }

        return {
          insertedCount: totalInserted,
          errors,
          sourceCount: sources.length,
          message: `Fetched ${sources.length} sources, ${totalInserted} new items`,
        }
      })

      if (lockResult.skipped) {
        return createSuccessResponse(
          {
            message: 'RSS update already running',
            fetched: lockResult.status.insertedCount,
            running: true,
            status: lockResult.status,
          },
          false,
        )
      }

      return createSuccessResponse(
        {
          message: lockResult.message,
          fetched: lockResult.insertedCount,
          digest: normalized.digest,
          errors: lockResult.errors.length > 0 ? lockResult.errors : undefined,
          status: lockResult.status,
        },
        false,
      )
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error))
    }
  })

  ipcMain.handle('rss:refreshSource', async (_, payload?: { sourceId?: string }) => {
    if (useMock) {
      return createSuccessResponse(
        { message: 'RSS source refresh simulated (mock mode)', fetched: 0, sourceId: payload?.sourceId || '' },
        true,
      )
    }

    const sourceId = payload?.sourceId?.trim()
    if (!sourceId) return createErrorResponse('Missing sourceId')

    if (sourceRefreshInFlight.has(sourceId)) {
      return createSuccessResponse(
        {
          message: 'Current source refresh already running',
          sourceId,
          running: true,
          fetched: 0,
        },
        false,
      )
    }

    sourceRefreshInFlight.add(sourceId)
    persistFetchInvocation({
      mode: 'refreshSource',
      sourceId,
      sourceIds: [sourceId],
    })

    try {
      const source = (rssRepository.getRSSSources() as DBRSSSource[]).find((entry) => entry.id === sourceId)
      if (!source) return createErrorResponse('RSS source not found')

      const storedPlatform = (source.platform as PlatformType) || 'rss'
      const detectedPlatform = detectPlatform(source.url)
      const platform =
        storedPlatform === 'rss' && detectedPlatform !== 'rss' ? detectedPlatform : storedPlatform
      const backend = resolveSourceBackend(platform)
      const startedAt = Date.now()

      if (platform !== storedPlatform) {
        rssRepository.updateRSSSourcePlatform(source.id, platform)
      }

      let rsshubBase: string | undefined
      let rsshubResolveError: string | null = null
      if (requiresRSSHubWarmup(platform)) {
        try {
          rsshubBase = await resolveRSSHubBase()
        } catch (error) {
          rsshubResolveError = error instanceof Error ? error.message : String(error)
        }
      }

      if (requiresStrictRSSHubAvailability(platform) && platform !== 'bilibili' && !rsshubBase) {
        const message = `[${source.name}] RSSHub unavailable: ${rsshubResolveError || 'unknown error'}`
        recordSourceRouteAttempt({
          sourceId: source.id,
          sourceName: source.name,
          url: source.url,
          groupName: source.group_name,
          platform,
          backend,
          durationMs: Date.now() - startedAt,
          itemCount: 0,
          success: false,
          error: message,
        })
        persistRouteDiagnosticsSnapshot()
        return createErrorResponse(message)
      }

      const { result, backendUsed } = await fetchSourceWithCurrentStack(source, platform, rsshubBase)
      if (result.error && result.items.length === 0) {
        const message = `[${source.name}] ${result.error}`
        recordSourceRouteAttempt({
          sourceId: source.id,
          sourceName: source.name,
          url: source.url,
          groupName: source.group_name,
          platform,
          backend: backendUsed,
          durationMs: Date.now() - startedAt,
          itemCount: 0,
          success: false,
          error: message,
        })
        persistRouteDiagnosticsSnapshot()
        return createErrorResponse(message)
      }

      const dbItems = result.items.map((item: ScrapedItem) => ({
        id: item.itemId,
        source_id: source.id,
        guid: item.link || item.itemId,
        title: item.title,
        link: item.link,
        summary: item.description || null,
        cover_image: item.coverImage || null,
        author: item.author || null,
        published_at: item.pubDate ? Math.floor(new Date(item.pubDate).getTime() / 1000) : null,
        ai_tags: null,
      }))
      if (supportsBrowserSessionAcquisition(platform) && backendUsed === 'browser' && dbItems.length > 0) {
        rssRepository.deleteRSSItemsBySource(source.id)
      }
      const candidateIds = dbItems.map((item) => item.id)
      const existingIds = new Set(rssRepository.getRSSItemsByIds(candidateIds).map((item) => item.id))
      const newIds = candidateIds.filter((id) => !existingIds.has(id))
      const inserted = rssRepository.upsertRSSItems(dbItems)
      rssRepository.updateRSSSourceLastFetched(source.id)
      recordSourceRouteAttempt({
        sourceId: source.id,
        sourceName: source.name,
        url: source.url,
        groupName: source.group_name,
        platform,
        backend: backendUsed,
        durationMs: Date.now() - startedAt,
        itemCount: result.items.length,
        success: true,
        warning: result.error ?? null,
      })
      persistRouteDiagnosticsSnapshot()

      await generateRSSArtifacts({
        sources: rssRepository.getRSSSources() as DBRSSSource[],
        allItems: rssRepository.getRSSItems() as DBRSSItem[],
        insertedItems: rssRepository.getRSSItemsByIds(newIds) as DBRSSItem[],
      })

      return createSuccessResponse(
        {
          message: `Refreshed 1 source via ${backendUsed}, ${result.items.length} items, ${inserted} written`,
          fetched: inserted,
          sourceId,
          sourceName: source.name,
          backend: backendUsed,
          itemCount: result.items.length,
          errors: result.error ? [result.error] : undefined,
        },
        false,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const source = (rssRepository.getRSSSources() as DBRSSSource[]).find((entry) => entry.id === sourceId)
      if (source) {
        const storedPlatform = (source.platform as PlatformType) || 'rss'
        const detectedPlatform = detectPlatform(source.url)
        const platform =
          storedPlatform === 'rss' && detectedPlatform !== 'rss' ? detectedPlatform : storedPlatform
        recordSourceRouteAttempt({
          sourceId: source.id,
          sourceName: source.name,
          url: source.url,
          groupName: source.group_name,
          platform,
          backend: resolveSourceBackend(platform),
          durationMs: 0,
          itemCount: 0,
          success: false,
          error: message,
        })
        persistRouteDiagnosticsSnapshot()
      }
      return createErrorResponse(message)
    } finally {
      sourceRefreshInFlight.delete(sourceId)
    }
  })

  ipcMain.handle('rss:benchmarkSources', async (_, options?: RSSBenchmarkOptions) => {
    if (useMock) {
      return createSuccessResponse(
        {
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          sourceCount: 0,
          entries: [] as RSSSourceBenchmarkEntry[],
          summary: buildBenchmarkSummary([]),
        },
        true,
      )
    }

    try {
      const allSources = rssRepository.getRSSSources() as DBRSSSource[]
      const sources = filterSelectedSources(allSources, options)
      const startedAt = new Date().toISOString()

      if (sources.length === 0) {
        return createSuccessResponse(
          {
            startedAt,
            finishedAt: new Date().toISOString(),
            sourceCount: 0,
            entries: [] as RSSSourceBenchmarkEntry[],
            summary: buildBenchmarkSummary([]),
          },
          false,
        )
      }

      const hasRSSHubSource = sources.some((source) =>
        requiresRSSHubWarmup(normalizeSourcePlatform(source)),
      )
      let rsshubBase: string | undefined
      let rsshubResolveError: string | null = null
      if (hasRSSHubSource) {
        try {
          rsshubBase = await resolveRSSHubBase()
        } catch (error) {
          rsshubResolveError = error instanceof Error ? error.message : String(error)
        }
      }

      const tasks = sources.map((source) => async (): Promise<RSSSourceBenchmarkEntry> => {
        const platform = normalizeSourcePlatform(source)
        const backend = classifyBackend(source)
        const started = Date.now()

        try {
          if (requiresStrictRSSHubAvailability(platform) && platform !== 'bilibili' && !rsshubBase) {
            throw new Error(`RSSHub unavailable: ${rsshubResolveError || 'unknown error'}`)
          }

          const { result, backendUsed } = await fetchSourceWithCurrentStack(source, platform, rsshubBase)
          const success = result.items.length > 0 || !result.error
          const errorMessage = success ? null : result.error || 'Unknown fetch error'
          const durationMs = Date.now() - started

          recordSourceRouteAttempt({
            sourceId: source.id,
            sourceName: source.name,
            url: source.url,
            groupName: source.group_name,
            platform,
            backend: backendUsed,
            durationMs,
            itemCount: result.items.length,
            success,
            warning: success ? result.error ?? null : null,
            error: errorMessage,
          })

          return {
            sourceId: source.id,
            sourceName: source.name,
            platform,
            backend: backendUsed,
            chromiumRequired: getRouteCapabilityMatrix().find((entry) => entry.platform === platform)?.chromiumRequired ?? false,
            scraplingEligible: getRouteCapabilityMatrix().find((entry) => entry.platform === platform)?.scraplingEligible ?? false,
            success,
            durationMs,
            itemCount: result.items.length,
            error: errorMessage,
            failureKind: errorMessage ? buildSourceDiagnostics([source])[0]?.lastRouteError?.kind ?? 'unknown' : null,
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const durationMs = Date.now() - started
          recordSourceRouteAttempt({
            sourceId: source.id,
            sourceName: source.name,
            url: source.url,
            groupName: source.group_name,
            platform,
            backend,
            durationMs,
            itemCount: 0,
            success: false,
            error: message,
          })
          return {
            sourceId: source.id,
            sourceName: source.name,
            platform,
            backend,
            chromiumRequired: getRouteCapabilityMatrix().find((entry) => entry.platform === platform)?.chromiumRequired ?? false,
            scraplingEligible: getRouteCapabilityMatrix().find((entry) => entry.platform === platform)?.scraplingEligible ?? false,
            success: false,
            durationMs,
            itemCount: 0,
            error: message,
            failureKind: buildSourceDiagnostics([source])[0]?.lastRouteError?.kind ?? 'unknown',
          }
        }
      })

      const settled = await limitConcurrency(tasks, 4)
      const entries = settled
        .filter((result): result is PromiseFulfilledResult<RSSSourceBenchmarkEntry> => result.status === 'fulfilled')
        .map((result) => result.value)
      persistRouteDiagnosticsSnapshot()
      const finishedAt = new Date().toISOString()
      const summary = buildBenchmarkSummary(entries)
      const artifacts = await generateRSSBenchmarkArtifacts({
        startedAt,
        finishedAt,
        entries,
        summary,
      })

      return createSuccessResponse(
        {
          startedAt,
          finishedAt,
          sourceCount: sources.length,
          entries,
          summary,
          artifacts: artifacts.files,
        },
        false,
      )
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error))
    }
  })

  ipcMain.handle('rss:repairRuntime', async () => {
    if (useMock) {
      return createSuccessResponse({ repaired: false, mock: true }, true)
    }

    try {
      await rsshubManager.stop().catch(() => {
        // ignore stop failures during repair
      })
      const healthy = await rsshubManager.ensureHealthy()
      const rsshubStatus = await rsshubManager.describeStatus()
      return createSuccessResponse(
        {
          repaired: healthy,
          rsshub: rsshubStatus,
        },
        false,
      )
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error))
    }
  })

  ipcMain.handle('rss:diagnostics', async () => {
    if (useMock) {
      return createSuccessResponse(
        {
          rsshubRequired: false,
          rsshub: {
            state: 'mock',
            running: false,
            port: 0,
            baseUrl: null,
            restartCount: 0,
            lastError: null,
            lastStartupError: null,
            lastRuntimeError: null,
            lastRuntimeErrorAt: null,
            startedAt: null,
            exitedAt: null,
            chromium: {
              ready: false,
              executablePath: null,
              source: 'none',
              cacheDir: '',
              buildId: '',
              downloadSupported: null,
              lastCheckedAt: null,
              lastError: null,
            },
          },
          update: rssUpdateLock.getStatus(),
          lastFetchInvocation: loadFetchInvocationSnapshot(),
          artifacts: {
            root: getArtifactsRootDir(),
            hasOpml: false,
            benchmarkJson: null,
            benchmarkMarkdown: null,
          },
          benchmark: null,
          sources: [],
          capabilityMatrix: getRouteCapabilityMatrix(),
        },
        true,
      )
    }

    try {
      const rsshubRequired = await warmEmbeddedRSSHubForDiagnostics()
      const opmlPath = join(getArtifactsRootDir(), 'subscriptions.opml')
      const benchmarkJsonPath = join(getArtifactsRootDir(), 'benchmark.latest.json')
      const benchmarkMarkdownPath = join(getArtifactsRootDir(), 'benchmark.latest.md')
      const latestBenchmark = await loadLatestBenchmarkSnapshot()
      let hasOpml = false
      try {
        await readFile(opmlPath, 'utf8')
        hasOpml = true
      } catch {
        hasOpml = false
      }

      const rsshubStatus = await rsshubManager.describeStatus()
      const sources = rssRepository.getRSSSources() as DBRSSSource[]
      return createSuccessResponse(
        {
          rsshub: rsshubStatus,
          rsshubRequired,
          update: rssUpdateLock.getStatus(),
          lastFetchInvocation: loadFetchInvocationSnapshot(),
          artifacts: {
            root: getArtifactsRootDir(),
            hasOpml,
            benchmarkJson: await readFile(benchmarkJsonPath, 'utf8').then(() => benchmarkJsonPath).catch(() => null),
            benchmarkMarkdown: await readFile(benchmarkMarkdownPath, 'utf8').then(() => benchmarkMarkdownPath).catch(() => null),
          },
          benchmark: latestBenchmark,
          sources: buildSourceDiagnostics(sources),
          capabilityMatrix: getRouteCapabilityMatrix(),
        },
        false,
      )
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error))
    }
  })
}
