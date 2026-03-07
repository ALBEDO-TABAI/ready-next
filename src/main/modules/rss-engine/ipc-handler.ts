import { ipcMain, app } from 'electron'
import { join } from 'path'
import { readFile } from 'fs/promises'
import { getDatabase } from '../database'
import type { RSSAnalysisAction, RSSAnalysisJob } from '../database'
import {
  detectPlatform,
  createScraper,
  needsRSSHub,
  platformLabel,
  type PlatformType,
} from './scrapers/index'
import { classifyItem } from './classifier'
import { rsshubManager } from './rsshub-process'
import type { ScrapedItem } from './scrapers/base'
import { generateRSSArtifacts } from './reports'
import { rssUpdateLock } from './update-lock'
import { getRSSItemAnalysisManager } from './item-analysis-manager'

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
  const db = getDatabase()
  const externalRaw = db.getSetting('rsshub_base_url')
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

function getArtifactsRootDir(): string {
  return join(app.getPath('userData'), 'rss-artifacts')
}

function loadDigestSnapshot(): Record<string, string> {
  const db = getDatabase()
  const raw = db.getSetting(DIGEST_SNAPSHOT_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, string>
    return parsed ?? {}
  } catch {
    return {}
  }
}

function saveDigestSnapshot(snapshot: Record<string, string>): void {
  const db = getDatabase()
  db.setSetting(DIGEST_SNAPSHOT_KEY, JSON.stringify(snapshot))
}

function normalizeFetchOptions(options?: FetchAllOptions): { digest: boolean; classification: ClassificationMode } {
  const digest = options?.digest === true
  const classification: ClassificationMode = options?.classification === 'none' ? 'none' : 'simple'
  return { digest, classification }
}

async function ensureArtifactFiles() {
  const db = getDatabase()
  const sources = db.getRSSSources() as DBRSSSource[]
  const allItems = db.getRSSItems() as DBRSSItem[]
  return generateRSSArtifacts({
    sources,
    allItems,
    insertedItems: [],
  })
}

export function setupRSSIPC(useMock = false): void {
  const analysisManager = getRSSItemAnalysisManager()

  ipcMain.handle('rss:getSources', async () => {
    if (useMock) return createSuccessResponse(mockSources, true)

    try {
      const db = getDatabase()
      const sources = db.getRSSSources() as DBRSSSource[]
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
      let feedUrl: string
      try {
        feedUrl = new URL(source.url).href
      } catch {
        return createErrorResponse(`Invalid URL: ${source.url}`)
      }

      const platform = detectPlatform(feedUrl)
      let rsshubBase: string | undefined

      if (needsRSSHub(platform)) {
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
      const scraper = createScraper(platform, rsshubBase)
      const result = await scraper.fetchItems(feedUrl)

      const allowSourceWithoutInitialItems =
        platform === 'bilibili' && result.items.length === 0 && !!result.error

      const sourceName = source.name?.trim() || result.feedTitle || feedUrl
      const db = getDatabase()
      const id = db.addRSSSource({
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
        itemCount = db.upsertRSSItems(dbItems)
        db.updateRSSSourceLastFetched(id)
      }

      if (result.error && result.items.length === 0 && !allowSourceWithoutInitialItems) {
        db.removeRSSSource(id)
        return createErrorResponse(`Cannot fetch feed: ${result.error}`)
      }

      return createSuccessResponse(
        {
          id,
          platform,
          name: sourceName,
          itemCount,
          warning:
            allowSourceWithoutInitialItems
              ? `Bilibili 源已添加，但首次抓取失败：${result.error}`
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
      const db = getDatabase()
      db.removeRSSSource(id)
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
      const db = getDatabase()
      const rawItems = db.getRSSItemsWithSource(sourceId) as DBRSSItem[]
      return createSuccessResponse(rawItems.map(mapDBItemToAPI), false)
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error))
    }
  })

  ipcMain.handle('rss:markRead', async (_, itemId: string) => {
    if (useMock) return createSuccessResponse({ marked: true }, true)

    try {
      const db = getDatabase()
      db.markRSSRead(itemId)
      return createSuccessResponse({ marked: true }, false)
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error))
    }
  })

  ipcMain.handle('rss:markReadBatch', async (_, itemIds: string[]) => {
    if (useMock) return createSuccessResponse({ marked: itemIds.length }, true)

    try {
      const db = getDatabase()
      const marked = db.markRSSReadMany(itemIds)
      console.log(`[rss:batch] markReadBatch size=${itemIds.length} marked=${marked}`)
      return createSuccessResponse({ marked }, false)
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error))
    }
  })

  ipcMain.handle('rss:deleteItems', async (_, itemIds: string[]) => {
    if (useMock) return createSuccessResponse({ deleted: itemIds.length }, true)

    try {
      const db = getDatabase()
      const deleted = db.deleteRSSItems(itemIds)
      console.log(`[rss:batch] deleteItems size=${itemIds.length} deleted=${deleted}`)
      return createSuccessResponse({ deleted }, false)
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error))
    }
  })

  ipcMain.handle('rss:toggleStarred', async (_, itemId: string) => {
    if (useMock) return createSuccessResponse({ toggled: true }, true)

    try {
      const db = getDatabase()
      db.toggleRSSStarred(itemId)
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
          rsshub: { state: 'mock', running: false, port: 0, baseUrl: null },
          update: rssUpdateLock.getStatus(),
          artifactsDir: getArtifactsRootDir(),
        },
        true,
      )
    }

    try {
      const status = rssUpdateLock.getStatus()
      return createSuccessResponse(
        {
          rsshub: rsshubManager.getStatus(),
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
      const db = getDatabase()
      const stats = db.getRSSStats()
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
      const lockResult = await rssUpdateLock.run(normalized, async () => {
        const db = getDatabase()
        const sources = db.getRSSSources() as DBRSSSource[]

        if (sources.length === 0) {
          return {
            insertedCount: 0,
            errors: [],
            sourceCount: 0,
            message: 'No RSS sources configured',
          }
        }

        const hasRSSHubSource = sources.some((source) =>
          needsRSSHub(((source.platform as PlatformType) || 'rss') as PlatformType),
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
          const storedPlatform = (source.platform as PlatformType) || 'rss'
          const detectedPlatform = detectPlatform(source.url)
          const platform =
            storedPlatform === 'rss' && detectedPlatform !== 'rss' ? detectedPlatform : storedPlatform

          if (platform !== storedPlatform) {
            db.updateRSSSourcePlatform(source.id, platform)
            console.log(
              `[rss:fetchAll] migrated source platform ${source.name}: ${storedPlatform} -> ${platform}`,
            )
          }

          if (needsRSSHub(platform) && platform !== 'bilibili' && !rsshubBase) {
            throw new Error(
              `[${source.name}] RSSHub unavailable: ${rsshubResolveError || 'unknown error'}`,
            )
          }
          const scraper = createScraper(platform, rsshubBase)
          const result = await scraper.fetchItems(source.url)

          if (result.error && result.items.length === 0) {
            throw new Error(`[${source.name}] ${result.error}`)
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
          const existingIds = new Set(db.getRSSItemsByIds(candidateIds).map((item) => item.id))
          const newIds = candidateIds.filter((id) => !existingIds.has(id))

          const inserted = db.upsertRSSItems(dbItems)
          db.updateRSSSourceLastFetched(source.id)
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

        const allItems = db.getRSSItems() as DBRSSItem[]
        const insertedItems = db.getRSSItemsByIds(insertedItemIds) as DBRSSItem[]

        await generateRSSArtifacts({
          sources,
          allItems,
          insertedItems,
        })

        if (normalized.digest) {
          const previous = loadDigestSnapshot()
          const latestPerSource = db.getLatestPerSource()
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

  ipcMain.handle('rss:diagnostics', async () => {
    if (useMock) {
      return createSuccessResponse({ status: 'mock' }, true)
    }

    try {
      const opmlPath = join(getArtifactsRootDir(), 'subscriptions.opml')
      let hasOpml = false
      try {
        await readFile(opmlPath, 'utf8')
        hasOpml = true
      } catch {
        hasOpml = false
      }

      return createSuccessResponse(
        {
          rsshub: rsshubManager.getStatus(),
          update: rssUpdateLock.getStatus(),
          artifacts: {
            root: getArtifactsRootDir(),
            hasOpml,
          },
        },
        false,
      )
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error))
    }
  })
}
