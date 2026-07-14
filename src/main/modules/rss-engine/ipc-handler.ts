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
import { isLikelyStaleBilibiliResult, resolveBilibiliStaleRouteResult } from './scrapers/rsshub'
import { classifyItem } from './classifier'
import { rsshubManager } from './rsshub-process'
import type { ScrapedItem, ScrapeResult } from './scrapers/base'
import { generateRSSArtifacts, generateRSSBenchmarkArtifacts } from './reports'
import { rssUpdateLock } from './update-lock'
import { getRSSItemAnalysisManager } from './item-analysis-manager'
import {
  fetchFeedViaBrowserSession,
  supportsBrowserSessionAcquisition,
  type BrowserAcquisitionMode,
} from './browser-acquisition'
import {
  buildRSSBrowserOpenAction,
  shouldPauseSilentBrowserRetry,
  type RSSBrowserOpenAction,
} from './browser-handoff'
import { findExistingRSSSourceByUrl } from './source-url'
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
import { sourceGroup } from './ipc/source-group'
import { itemGroup } from './ipc/item-group'
import { analysisGroup } from './ipc/analysis-group'
import {
  fetchGroup,
  type FetchAllOptions as FetchGroupFetchAllOptions,
  type FetchGroupHandle,
  type RSSFetchAllResponse,
} from './ipc/fetch-group'
import { diagnosticsGroup } from './ipc/diagnostics-group'
import { exportGroup } from './ipc/export-group'
import type { AddSourceCoreInput, AddSourceCoreResult } from './ipc/engine-deps'
import type { IpcDisposeHandle } from './ipc/types'
import {
  parseRSSAutoRefreshInterval,
  RSS_AUTO_REFRESH_INTERVAL_KEY,
  RSS_LAST_FETCH_ALL_COMPLETED_AT_KEY,
} from '../../../shared/rss-auto-refresh'

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
  inbox_visible?: number
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
  draft_seeded?: number
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
  inboxVisible: boolean
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

interface MappedRSSDraftStoreSource {
  sourceId: string
  sourceName: string
  sourceUrl: string
  platform: string
  storedCount: number
  inboxCount: number
  starredCount: number
  refreshMode: BrowserAcquisitionMode
  lastFetchedAt: string | null
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
let fetchAllCompletedListener: ((completedAt: string, result: RSSFetchAllResponse) => void) | null = null
const sourceRefreshInFlight = new Set<string>()

/**
 * Stage V V2.2a — dispose handle returned by `sourceGroup.register`. The 4
 * source channels live in `ipc/source-group.ts`; the host keeps the dispose
 * handle so a re-entrant `setupRSSIPC` (dev-reload) can drop the prior
 * registration before the next one binds. A future `cleanupRSSEngine` hook
 * will drain this on shutdown.
 */
let sourceGroupDispose: IpcDisposeHandle | null = null

/**
 * Stage V V2.2b — dispose handle returned by `itemGroup.register`. The 6
 * item channels live in `ipc/item-group.ts`; mirror of the SourceGroup
 * dispose slot above so dev-reload re-entry into `setupRSSIPC` releases
 * both groups before the next registration binds.
 */
let itemGroupDispose: IpcDisposeHandle | null = null

/**
 * Stage V V2.2c — dispose handle returned by `analysisGroup.register`. The
 * 6 analysis channels (start / progress / list / pause / resume / delete)
 * live in `ipc/analysis-group.ts`; mirror of the SourceGroup / ItemGroup
 * dispose slots so dev-reload re-entry into `setupRSSIPC` releases all
 * three groups before the next registration binds.
 */
let analysisGroupDispose: IpcDisposeHandle | null = null

/**
 * Stage V V2.2d — dispose handle returned by `fetchGroup.register`. The 5
 * fetch / status channels (`rss:fetchAll`, `rss:refreshSource`,
 * `rss:benchmarkSources`, `rss:status`, `rss:stats`) live in
 * `ipc/fetch-group.ts`; mirror of the prior three dispose slots so dev-
 * reload re-entry into `setupRSSIPC` releases every group before the next
 * registration binds.
 */
let fetchGroupDispose: FetchGroupHandle | null = null

/**
 * Stage V V2.2e — dispose handle returned by `diagnosticsGroup.register`.
 * The 2 runtime-health channels (`rss:repairRuntime`, `rss:diagnostics`)
 * live in `ipc/diagnostics-group.ts`; mirror of the prior four dispose
 * slots so dev-reload re-entry into `setupRSSIPC` releases every group
 * before the next registration binds.
 */
let diagnosticsGroupDispose: IpcDisposeHandle | null = null

/**
 * Stage V V2.2f — dispose handle returned by `exportGroup.register`. The 2
 * artifact-export channels (`rss:exportOpml`, `rss:exportFeed`) live in
 * `ipc/export-group.ts`; mirror of the prior five dispose slots so
 * dev-reload re-entry into `setupRSSIPC` releases every group before the
 * next registration binds. V2.2f is the final rss-engine group — the split
 * (source / item / analysis / fetch / diagnostics / export) is now complete.
 */
let exportGroupDispose: IpcDisposeHandle | null = null

export function setRSSBrowserController(controller: BrowserController | null): void {
  rssBrowserController = controller
}

export function setRSSFetchAllCompletedListener(
  listener: ((completedAt: string, result: RSSFetchAllResponse) => void) | null,
): void {
  fetchAllCompletedListener = listener
}

export function readRSSAutoRefreshInterval(): number {
  return parseRSSAutoRefreshInterval(appSettingsRepository.getSetting(RSS_AUTO_REFRESH_INTERVAL_KEY))
}

export function readLastRSSFetchAllCompletedAt(): number | null {
  const raw = appSettingsRepository.getSetting(RSS_LAST_FETCH_ALL_COMPLETED_AT_KEY)
  if (!raw) return null
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : null
}

export function fetchAllRSSFeeds(options?: FetchGroupFetchAllOptions): Promise<RSSFetchAllResponse> {
  if (!fetchGroupDispose) {
    return Promise.resolve({ success: false, mock: false, error: 'RSS fetch runtime is not initialized' })
  }
  return fetchGroupDispose.fetchAll(options)
}

function createSuccessResponse<T>(data: T, isMock: boolean): RSSResponse<T> {
  return { success: true, mock: isMock, data }
}

function createErrorResponse<T = never>(error: string, data?: T): RSSResponse<T> {
  return data === undefined ? { success: false, mock: false, error } : { success: false, mock: false, error, data }
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
    inboxVisible: item.inbox_visible !== 0,
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

function mapDraftStoreSourceToAPI(
  source: import('../database').RSSDraftStoreSourceSummary,
): MappedRSSDraftStoreSource {
  return {
    sourceId: source.source_id,
    sourceName: source.source_name,
    sourceUrl: source.source_url,
    platform: source.platform || 'rss',
    storedCount: Number(source.stored_count) || 0,
    inboxCount: Number(source.inbox_count) || 0,
    starredCount: Number(source.starred_count) || 0,
    refreshMode: source.draft_seeded === 1 ? 'incremental' : 'full',
    lastFetchedAt: source.last_fetched ? new Date(source.last_fetched * 1000).toISOString() : null,
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

function resolveBrowserAcquisitionMode(
  source: Pick<DBRSSSource, 'draft_seeded'> | Pick<{ draft_seeded?: number }, 'draft_seeded'>,
  platform: PlatformType,
): BrowserAcquisitionMode {
  if (platform !== 'xiaohongshu') return 'full'
  return source.draft_seeded === 1 ? 'incremental' : 'full'
}

function canSaveSourceWithoutInitialItems(platform: PlatformType, result: ScrapeResult): boolean {
  return result.items.length === 0 && Boolean(result.error) && (
    platform === 'bilibili' || platform === 'xiaohongshu'
  )
}

function buildInitialFetchWarning(platform: PlatformType, error: string | undefined): string | undefined {
  if (!error) return undefined
  if (platform === 'bilibili') {
    return `Bilibili 源已添加，但首次抓取失败：${error}`
  }
  if (platform === 'xiaohongshu') {
    return `小红书源已添加，但首次抓取失败；可稍后刷新或配置可用 RSSHub/Cookie：${error}`
  }
  return error
}

function resolveRSSItemGuid(item: ScrapedItem): string {
  const rssGuid = typeof item.metadata.rssGuid === 'string' ? item.metadata.rssGuid.trim() : ''
  return rssGuid || item.link || item.itemId
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
  const allItems = rssRepository.getAllRSSItems() as DBRSSItem[]
  return generateRSSArtifacts({
    sources,
    allItems,
    insertedItems: [],
  })
}

async function fetchSourceWithCurrentStack(
  source: Pick<DBRSSSource, 'id' | 'name' | 'url' | 'group_name' | 'draft_seeded'>,
  platform: PlatformType,
  rsshubBase?: string,
): Promise<{ result: ScrapeResult; backendUsed: SourceBackend }> {
  const allowRSSHubFallback = allowsRSSHubFallbackAfterBrowser(platform)

  if (supportsBrowserSessionAcquisition(platform)) {
    if (!rssBrowserController) {
      return {
        result: {
          items: [],
          feedTitle: '',
          platform,
          error: `${platformLabel(platform)} 当前需要 Ready 应用内浏览器运行态，请稍后重试。`,
        },
        backendUsed: 'browser',
      }
    }

    if (shouldPauseSilentBrowserFetch(source, platform)) {
      return {
        result: {
          items: [],
          feedTitle: '',
          platform,
          error: `${platformLabel(platform)} 最近刚触发验证码/风控，已暂停后台静默刷新。请先在 Ready 浏览器中打开该主页并完成验证后再重试。`,
        },
        backendUsed: 'browser',
      }
    }

    try {
      const browserResult = await fetchFeedViaBrowserSession(rssBrowserController, platform, source.url, {
        mode: resolveBrowserAcquisitionMode(source, platform),
      })
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

      const scraper = createScraper(platform, rsshubBase)
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

      const scraper = createScraper(platform, rsshubBase)
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

  const scraper = createScraper(platform, rsshubBase)
  const result = await scraper.fetchItems(source.url)
  if (platform === 'bilibili' && rssBrowserController && isLikelyStaleBilibiliResult(result)) {
    const browserResult = await fetchFeedViaBrowserSession(rssBrowserController, platform, source.url, {
      mode: 'full',
    })
    const resolved = resolveBilibiliStaleRouteResult(result, browserResult)
    return {
      result: resolved.result,
      backendUsed: resolved.backend,
    }
  }
  return {
    result,
    backendUsed: resolveSourceBackend(platform),
  }
}

function buildBrowserActionFromSource(
  source: Pick<DBRSSSource, 'id' | 'name' | 'url' | 'group_name'>,
  platform: PlatformType,
): RSSBrowserOpenAction | null {
  if (!supportsBrowserSessionAcquisition(platform)) return null
  const [entry] = buildSourceDiagnostics([
    {
      id: source.id,
      name: source.name,
      url: source.url,
      group_name: source.group_name,
      platform,
    },
  ])
  return buildRSSBrowserOpenAction(platform, source.url, entry?.lastRouteError?.kind)
}

function shouldPauseSilentBrowserFetch(
  source: Pick<DBRSSSource, 'id' | 'name' | 'url' | 'group_name'>,
  platform: PlatformType,
): boolean {
  if (!supportsBrowserSessionAcquisition(platform)) return false
  const [entry] = buildSourceDiagnostics([
    {
      id: source.id,
      name: source.name,
      url: source.url,
      group_name: source.group_name,
      platform,
    },
  ])
  const hasReusablePage =
    rssBrowserController && typeof rssBrowserController.hasReusableCaptureTarget === 'function'
      ? rssBrowserController.hasReusableCaptureTarget(source.url)
      : false
  return shouldPauseSilentBrowserRetry(entry?.lastRouteError?.kind, entry?.lastAttemptAt, hasReusablePage)
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

/**
 * Stage V V2.2a — `rss:addSource` initial-fetch pipeline lifted verbatim
 * from the inline handler so `sourceGroup` can stay focused on response
 * shaping + mock dispatch. Semantics follow the pre-extraction handler body:
 * validate URL → detect existing source → detect platform → warm
 * RSSHub (with bilibili fallback) → scrape → persist → record route
 * diagnostics → return shaped result. Mock-mode short-circuits in the
 * group itself before this runs, so this function is only invoked in
 * real-mode.
 */
async function runAddSourceCore(input: AddSourceCoreInput): Promise<AddSourceCoreResult> {
  const startedAt = Date.now()
  let feedUrl: string
  try {
    feedUrl = new URL(input.url).href
  } catch {
    return { ok: false, error: `Invalid URL: ${input.url}` }
  }

  const existingSource = findExistingRSSSourceByUrl(rssRepository.getRSSSources() as DBRSSSource[], feedUrl)
  if (existingSource) {
    return {
      ok: true,
      data: {
        id: existingSource.id,
        platform: normalizeSourcePlatform(existingSource),
        name: existingSource.name,
        itemCount: rssRepository.getAllRSSItems(existingSource.id).length,
        warning: 'source_exists',
      },
    }
  }

  const platform = detectPlatform(feedUrl)
  // resolveSourceBackend is called for parity with the pre-extraction handler
  // (kept the side-effect-free call in case future diagnostics rely on
  // backend resolution happening here).
  void resolveSourceBackend(platform)
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
      name: input.name?.trim() || feedUrl,
      url: feedUrl,
      group_name: input.group || 'default',
      draft_seeded: 0,
    },
    platform,
    rsshubBase,
  )

  const allowSourceWithoutInitialItems = canSaveSourceWithoutInitialItems(platform, result)

  const sourceName = input.name?.trim() || result.feedTitle || feedUrl
  const id = rssRepository.addRSSSource({
    name: sourceName,
    url: feedUrl,
    group: input.group,
    platform,
  })

  let itemCount = 0
  if (result.items.length > 0) {
    const dbItems = result.items.map((item) => ({
      id: item.itemId,
      source_id: id,
      guid: resolveRSSItemGuid(item),
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
    rssRepository.setRSSSourceDraftSeeded(id, true)
  }

  if (result.error && result.items.length === 0 && !allowSourceWithoutInitialItems) {
    recordSourceRouteAttempt({
      sourceId: `pending:${feedUrl}`,
      sourceName,
      url: feedUrl,
      groupName: input.group,
      platform,
      backend: backendUsed,
      durationMs: Date.now() - startedAt,
      itemCount: 0,
      success: false,
      error: result.error,
    })
    persistRouteDiagnosticsSnapshot()
    rssRepository.removeRSSSource(id)
    return { ok: false, error: `Cannot fetch feed: ${result.error}` }
  }

  recordSourceRouteAttempt({
    sourceId: id,
    sourceName,
    url: feedUrl,
    groupName: input.group,
    platform,
    backend: backendUsed,
    durationMs: Date.now() - startedAt,
    itemCount: result.items.length,
    success: true,
    warning: result.error ?? null,
  })
  persistRouteDiagnosticsSnapshot()

  return {
    ok: true,
    data: {
      id,
      platform,
      name: sourceName,
      itemCount,
      warning:
        allowSourceWithoutInitialItems
          ? buildInitialFetchWarning(platform, result.error)
          : result.error
            ? result.error
            : undefined,
    },
  }
}

export function setupRSSIPC(useMock = false): void {
  const analysisManager = getRSSItemAnalysisManager()
  if (!useMock) {
    loadRouteDiagnosticsSnapshot()
    queueMicrotask(() => {
      if (isRSSHubRequiredForCurrentSources()) {
        // fire-and-forget: warm-up health probe; real fetches go through rsshubManager.fetch which retries and surfaces failures via the standard rss error pipeline.
        void rsshubManager.ensureHealthy().catch(() => {
          // best-effort warm only
        })
      }
    })
  }

  // Stage V V2.2a — 4 source channels (`rss:getSources`, `rss:addSource`,
  // `rss:removeSource`, `rss:getDraftStoreSources`) moved into
  // `sourceGroup`. The group handles dev-reload removeHandler pre-clear
  // internally; we hold the dispose handle so a future cleanup hook (or
  // the next setupRSSIPC entry) can drop them on shutdown. Re-binding on
  // dev reload first calls `dispose()` on the prior handle so listener
  // slots stay clean.
  if (sourceGroupDispose) {
    try { sourceGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    sourceGroupDispose = null
  }
  sourceGroupDispose = sourceGroup.register(ipcMain, {
    useMock,
    getRSSRepository: () => rssRepository,
    mapSourceToAPI: (source) => mapDBSourceToAPI(source as DBRSSSource),
    mapDraftStoreSourceToAPI: (source) =>
      mapDraftStoreSourceToAPI(source as import('../database').RSSDraftStoreSourceSummary),
    addSourceCore: (input) => runAddSourceCore(input),
    mockSources,
  })

  // Stage V V2.2b — 6 item channels (`rss:getItems`, `rss:markRead`,
  // `rss:markReadBatch`, `rss:deleteItems`, `rss:toggleStarred`,
  // `rss:clearDraftStore`) moved into `itemGroup`. Dev-reload re-entry
  // disposes the prior handle first so listener slots stay clean — same
  // pattern as SourceGroup above.
  if (itemGroupDispose) {
    try { itemGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    itemGroupDispose = null
  }
  itemGroupDispose = itemGroup.register(ipcMain, {
    useMock,
    getRSSRepository: () => rssRepository,
    mapItemToAPI: (item) => mapDBItemToAPI(item as DBRSSItem),
    mockItems,
  })

  // Stage V V2.2c — the 6 analysis channels (`rss:startItemAnalysis`,
  // `rss:getItemAnalysisProgress`, `rss:listItemAnalysisJobs`,
  // `rss:pauseAnalysisJob`, `rss:resumeAnalysisJob`,
  // `rss:deleteAnalysisJob`) moved into `analysisGroup`. Dev-reload
  // re-entry safety matches the SourceGroup / ItemGroup pattern above.
  if (analysisGroupDispose) {
    try { analysisGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    analysisGroupDispose = null
  }
  analysisGroupDispose = analysisGroup.register(ipcMain, {
    useMock,
    getAnalysisManager: () => analysisManager,
    mapAnalysisJob,
  })

  // Stage V V2.2d — the 5 fetch / status channels (`rss:fetchAll`,
  // `rss:refreshSource`, `rss:benchmarkSources`, `rss:status`,
  // `rss:stats`) moved into `fetchGroup`. The group owns mock-mode
  // dispatch and response shaping; every collaborator (repository
  // surface, update lock, rsshub manager describe call, route
  // diagnostics recorder, artifact generators, fetch invocation log,
  // digest snapshot, in-flight set, helpers) is injected via deps so
  // the group never imports the scraper / rsshub / browser chain
  // directly. Dev-reload re-entry disposes the prior handle first so
  // listener slots stay clean — same pattern as SourceGroup /
  // ItemGroup / AnalysisGroup above.
  if (fetchGroupDispose) {
    try { fetchGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    fetchGroupDispose = null
  }
  fetchGroupDispose = fetchGroup.register(ipcMain, {
    useMock,
    mockSources,
    mockItems,
    getRSSSources: () => rssRepository.getRSSSources() as DBRSSSource[],
    getRSSItemsByIds: (ids) => rssRepository.getRSSItemsByIds(ids),
    upsertRSSItems: (items) => rssRepository.upsertRSSItems(items as Parameters<typeof rssRepository.upsertRSSItems>[0]),
    updateRSSSourceLastFetched: (id) => rssRepository.updateRSSSourceLastFetched(id),
    updateRSSSourcePlatform: (id, platform) => rssRepository.updateRSSSourcePlatform(id, platform),
    setRSSSourceDraftSeeded: (id, seeded) => rssRepository.setRSSSourceDraftSeeded(id, seeded),
    getAllRSSItems: () => rssRepository.getAllRSSItems() as DBRSSItem[],
    getLatestPerSource: () => rssRepository.getLatestPerSource(),
    getRSSStats: () => rssRepository.getRSSStats(),
    rssUpdateLock,
    describeRsshubStatus: () => rsshubManager.describeStatus(),
    warmEmbeddedRSSHubForDiagnostics,
    getArtifactsRootDir,
    fetchSourceWithCurrentStack,
    resolveRSSHubBase,
    requiresRSSHubWarmup,
    requiresStrictRSSHubAvailability,
    recordSourceRouteAttempt,
    persistRouteDiagnosticsSnapshot,
    resolveSourceBackend,
    buildSourceDiagnostics: (sources) =>
      buildSourceDiagnostics(sources.map((entry) => ({
        id: entry.id,
        name: entry.name,
        url: entry.url,
        group_name: entry.group_name,
        platform: entry.platform,
      }))),
    buildBrowserActionFromSource,
    buildBenchmarkSummary,
    getRouteCapabilityMatrix,
    generateRSSArtifacts: (payload) => generateRSSArtifacts(payload),
    generateRSSBenchmarkArtifacts: (payload) => generateRSSBenchmarkArtifacts(payload),
    classifyItem,
    detectPlatform,
    normalizeSourcePlatform,
    classifyBackend,
    resolveRSSItemGuid,
    filterSelectedSources,
    normalizeFetchOptions,
    persistFetchInvocation,
    recordFetchAllCompletedAt: (completedAt, result) => {
      appSettingsRepository.setSetting(RSS_LAST_FETCH_ALL_COMPLETED_AT_KEY, completedAt)
      try {
        fetchAllCompletedListener?.(completedAt, result)
      } catch (error) {
        console.warn('[rss:auto-refresh] completion listener failed:', error instanceof Error ? error.message : String(error))
      }
    },
    loadDigestSnapshot,
    saveDigestSnapshot,
    limitConcurrency,
    sourceRefreshInFlight,
  })

  // Stage V V2.2f — artifact-export channels (`rss:exportOpml`,
  // `rss:exportFeed`) moved into `exportGroup`. The group owns mock-mode
  // dispatch and response shaping; the artifact-bundle generator
  // (`ensureArtifactFiles`), the artifacts root accessor
  // (`getArtifactsRootDir`), and the path-join helper are injected via
  // deps so the group never imports the repository / report-generator
  // chain directly. Dev-reload re-entry disposes the prior handle first
  // so listener slots stay clean — same pattern as SourceGroup / ItemGroup
  // / AnalysisGroup / FetchGroup / DiagnosticsGroup above. V2.2f closes
  // out the rss-engine split (6 groups: source / item / analysis / fetch
  // / diagnostics / export).
  if (exportGroupDispose) {
    try { exportGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    exportGroupDispose = null
  }
  exportGroupDispose = exportGroup.register(ipcMain, {
    useMock,
    ensureArtifactFiles,
    getArtifactsRootDir,
    joinPath: (...parts) => join(...parts),
  })

  // Stage V V2.2e — runtime-health channels (`rss:repairRuntime`,
  // `rss:diagnostics`) moved into `diagnosticsGroup`. The group owns
  // mock-mode dispatch and response shaping; every collaborator (rsshub
  // manager stop/ensure-healthy/describe, update lock, repository
  // `getRSSSources`, the diagnostics helpers, fetch-invocation snapshot
  // loader, benchmark snapshot loader, artifacts directory probe, the
  // file-read existence probe) is injected via deps so the group never
  // imports the rsshub / repository / fs chain directly. Dev-reload
  // re-entry disposes the prior handle first so listener slots stay
  // clean — same pattern as SourceGroup / ItemGroup / AnalysisGroup /
  // FetchGroup above.
  if (diagnosticsGroupDispose) {
    try { diagnosticsGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    diagnosticsGroupDispose = null
  }
  diagnosticsGroupDispose = diagnosticsGroup.register(ipcMain, {
    useMock,
    getRSSSources: () => rssRepository.getRSSSources() as DBRSSSource[],
    rssUpdateLock,
    rsshubStop: () => rsshubManager.stop(),
    rsshubEnsureHealthy: () => rsshubManager.ensureHealthy(),
    describeRsshubStatus: () => rsshubManager.describeStatus(),
    warmEmbeddedRSSHubForDiagnostics,
    buildSourceDiagnostics: (sources) =>
      buildSourceDiagnostics(sources.map((entry) => ({
        id: entry.id,
        name: entry.name,
        url: entry.url,
        group_name: entry.group_name,
        platform: entry.platform,
      }))),
    getRouteCapabilityMatrix,
    loadFetchInvocationSnapshot,
    loadLatestBenchmarkSnapshot,
    getArtifactsRootDir,
    readFileUtf8: (path) => readFile(path, 'utf8'),
    joinPath: (...parts) => join(...parts),
  })
}
