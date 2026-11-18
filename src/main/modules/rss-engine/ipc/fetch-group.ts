import type { RSSMembership } from '../../../../shared/rss-organization'
// Stage V V2.2d — rss-engine FetchGroup channel cluster.
//
// Bundles the 5 channels that drive the renderer's RSS update + diagnostic
// surfaces — the multi-source fetch pipeline, the single-source refresh
// path, the route benchmark, and the two read-only status / stats probes:
//
//   rss:fetchAll          (multi-source update under rssUpdateLock; digest
//                          + artifact regeneration; per-
//                          source route diagnostics persisted)
//   rss:refreshSource     (single-source incremental refresh with the same
//                          fetch/diagnostics/artifact stack; in-flight set
//                          guards duplicate clicks per source)
//   rss:benchmarkSources  (per-source latency + capability benchmark; emits
//                          benchmark.latest.{json,md} artifacts and
//                          persists route attempts for the diagnostics tab)
//   rss:status            (pure read of rsshub runtime status + update-lock
//                          status + artifacts directory; never starts rsshub)
//   rss:stats             (totals / unread / platform & category histograms
//                          from the repository — pure read)
//
// Handler bodies are lifted VERBATIM from `ipc-handler.ts` (V2.2d follows
// the V2.2a–c move + thin-wrapper shape). The handlers do NOT import any
// rss-engine internals directly: every collaborator (the repository, the
// update lock, the rsshub manager, the route diagnostics recorder, the
// scrape-with-current-stack pipeline, the artifact generators, the digest
// snapshot, the fetch invocation log, the in-flight set) is injected via
// `FetchGroupDeps` so the group is testable in isolation and so future
// moves out of rss-engine stay mechanical.
//
// The 5 channels live in one group despite mixing two heavy mutations
// (`fetchAll`, `refreshSource`), one mutation-plus-artifact-write
// (`benchmarkSources`), and two pure reads (`status`, `stats`) because
// they share:
//   • the same domain concept (an "RSS fetch / update event" plus the
//     read-side that surfaces its results)
//   • the same dispose lifecycle (renderer's update toolbar wires them
//     as one feature toggle)
//   • the same dep surface (repository + fetch pipeline + diagnostics
//     recorder + artifact generators + the two managers)
// Peeling reads from writes here would create siblings whose deps
// overlap entirely — against the per-group-deps-as-contract intent.
//
// Why FetchGroupDeps is wider than the prior three groups: the three
// large mutations together touch the broadest collaborator surface in
// the host (scrape pipeline, route diagnostics, artifact generation,
// digest snapshot, fetch invocation log, two managers). Each member is
// listed here ONLY because at least one of the 5 handler bodies calls
// it — the contract intent is preserved.
import type { IpcMain } from 'electron'
import type { PlatformType } from '../scrapers/index'
import type { ScrapedItem, ScrapeResult } from '../scrapers/base'
import type { RSSUpdateLock } from '../update-lock'
import type {
  RouteFailureKind,
  RSSSourceBenchmarkEntry,
  SourceBackend,
} from '../source-diagnostics'
import type { buildBenchmarkSummary as BuildBenchmarkSummaryFn } from '../source-diagnostics'
import type { RSSBrowserOpenAction } from '../browser-handoff'
import type { EngineDeps } from './engine-deps'
import type { IpcDisposeHandle } from './types'

/** Mirror of the host's `FetchAllOptions` (kept here so the group is self-describing). */
export interface FetchAllOptions {
  digest?: boolean
  group?: string
  sourceIds?: string[]
  /** Set by the scheduler. A refresh the person asked for leaves it out. */
  trigger?: 'auto'
}

export interface RSSBenchmarkOptions {
  group?: string
  sourceIds?: string[]
}

/** Minimal row shapes the handlers consume — copies of the host's DB row interfaces. */
export interface DBRSSSourceRow {
  id: string
  name: string
  url: string
  group_name: string
  icon: string | null
  last_fetched: number | null
  enabled: number
  created_at: number
  platform: string
  draft_seeded?: number
}

export interface DBRSSItemRow {
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
  classifications: RSSMembership[]
  source_name?: string
}

/**
 * Per-group deps. The group keeps the response-shaping (`ok` / `fail`),
 * the mock-mode dispatch, the verbatim handler bodies, and the channel
 * list. Everything else — repository access, the fetch pipeline, the
 * route diagnostics recorder, the artifact generators, the digest
 * snapshot, the fetch invocation log, the source-refresh-in-flight set,
 * the rsshub manager describe call, the update lock — is injected by
 * the host.
 *
 * The two `mockSources` / `mockItems` fields are reused from
 * `EngineDeps` (rss:stats mock-mode path).
 */
export interface FetchGroupDeps {
  readonly useMock: EngineDeps['useMock']
  readonly mockSources: EngineDeps['mockSources']
  readonly mockItems: EngineDeps['mockItems']

  // --- repository surface (subset used by the 5 handler bodies) ---
  getRSSSources(): DBRSSSourceRow[]
  getRSSItemsByIds(ids: string[]): Array<{ id: string }>
  upsertRSSItems(items: unknown[]): number
  updateRSSSourceLastFetched(id: string): void
  updateRSSSourcePlatform(id: string, platform: PlatformType): void
  setRSSSourceDraftSeeded(id: string, seeded: boolean): void
  getAllRSSItems(): DBRSSItemRow[]
  getLatestPerSource(): Array<{ source_id: string; id: string }>
  getRSSStats(): unknown

  // --- managers + locks ---
  readonly rssUpdateLock: RSSUpdateLock
  describeRsshubStatus(): Promise<unknown>
  isEmbeddedRSSHubRequiredForDiagnostics(): boolean
  getArtifactsRootDir(): string

  // --- fetch pipeline + diagnostics ---
  /**
   * `deferred` means the source's page was not opened this time (not yet due, the person is away, the platform
   * is paused). Such a round is neither a success nor a failure and leaves the last recorded attempt untouched.
   */
  fetchSourceWithCurrentStack(
    source: Pick<DBRSSSourceRow, 'id' | 'name' | 'url' | 'group_name' | 'draft_seeded'>,
    platform: PlatformType,
    options: { trigger: 'auto' | 'manual-all' | 'manual-source' },
  ): Promise<{ result: ScrapeResult; backendUsed: SourceBackend; deferred?: { reason: string } }>
  /** Which of the fetched items are written; a login platform keeps an item as it was first seen. */
  selectItemsToStore<T extends { id: string; published_at: number | null }>(platform: PlatformType, items: T[]): T[]
  recordSourceRouteAttempt(entry: {
    sourceId: string
    sourceName: string
    url: string
    groupName: string | undefined
    platform: PlatformType
    backend: SourceBackend
    durationMs: number
    itemCount: number
    success: boolean
    warning?: string | null
    error?: string | null
  }): void
  persistRouteDiagnosticsSnapshot(): void
  resolveSourceBackend(platform: PlatformType): SourceBackend
  buildSourceDiagnostics(sources: Array<Pick<DBRSSSourceRow, 'id' | 'name' | 'url' | 'group_name'> & { platform: PlatformType }>): Array<{ lastRouteError?: { kind?: RouteFailureKind } | null }>
  buildBrowserActionFromSource(
    source: Pick<DBRSSSourceRow, 'id' | 'name' | 'url' | 'group_name'>,
    platform: PlatformType,
  ): RSSBrowserOpenAction | null
  buildBenchmarkSummary: typeof BuildBenchmarkSummaryFn
  getRouteCapabilityMatrix(): Array<{ platform: PlatformType; chromiumRequired: boolean; scraplingEligible: boolean }>
  generateRSSArtifacts(payload: {
    sources: DBRSSSourceRow[]
    allItems: DBRSSItemRow[]
    insertedItems: DBRSSItemRow[]
  }): Promise<unknown>
  generateRSSBenchmarkArtifacts(payload: {
    startedAt: string
    finishedAt: string
    entries: RSSSourceBenchmarkEntry[]
    summary: ReturnType<typeof BuildBenchmarkSummaryFn>
  }): Promise<{ files: unknown }>

  // --- helpers + persistence ---
  detectPlatform(url: string): PlatformType
  normalizeSourcePlatform(source: DBRSSSourceRow): PlatformType
  classifyBackend(source: DBRSSSourceRow): SourceBackend
  resolveRSSItemGuid(item: ScrapedItem): string
  filterSelectedSources(
    sources: DBRSSSourceRow[],
    options?: { group?: string; sourceIds?: string[] },
  ): DBRSSSourceRow[]
  normalizeFetchOptions(options?: FetchAllOptions): {
    digest: boolean
    group?: string
    sourceIds?: string[]
    trigger: 'auto' | 'manual-all'
  }
  persistFetchInvocation(payload: Record<string, unknown>): void
  recordFetchAllCompletedAt(completedAt: string, result: RSSFetchAllResponse): void
  schedulePicturesWarm(): void
  loadDigestSnapshot(): Record<string, string>
  saveDigestSnapshot(snapshot: Record<string, string>): void
  limitConcurrency<T>(
    tasks: Array<() => Promise<T>>,
    limit: number,
  ): Promise<PromiseSettledResult<T>[]>
  yieldToEventLoop(): Promise<void>
  readonly sourceRefreshInFlight: Set<string>
}

const CHANNELS = [
  'rss:fetchAll',
  'rss:refreshSource',
  'rss:benchmarkSources',
  'rss:status',
  'rss:stats',
] as const

interface RSSResponse<T> {
  success: boolean
  mock: boolean
  data?: T
  error?: string
}

export type RSSFetchAllResponse = RSSResponse<{
  message: string
  fetched: number
  digest?: boolean
  running?: boolean
  errors?: string[]
  status?: unknown
}>

export interface FetchGroupHandle extends IpcDisposeHandle {
  fetchAll(options?: FetchAllOptions): Promise<RSSFetchAllResponse>
}

function ok<T>(data: T, isMock: boolean): RSSResponse<T> {
  return { success: true, mock: isMock, data }
}

function fail<T = never>(error: string, data?: T): RSSResponse<T> {
  return data === undefined
    ? { success: false, mock: false, error }
    : { success: false, mock: false, error, data }
}

/** Sources whose page was not opened this round are named in the summary, never listed as errors. */
function deferredNote(count: number): string {
  return count > 0 ? `, ${count} waiting for their next turn` : ''
}

export const fetchGroup: {
  readonly namespace: string
  register(ipcMain: IpcMain, deps: FetchGroupDeps): FetchGroupHandle
} = {
  namespace: 'rss:fetch',

  register(ipcMain: IpcMain, deps: FetchGroupDeps): FetchGroupHandle {
    // Defensive pre-clear — `setupRSSIPC` may be re-entered on dev reload;
    // strip any prior handler so `ipcMain.handle` does not throw on the
    // second registration. Mirrors SourceGroup / ItemGroup / AnalysisGroup.
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore — handler may not exist */ }
    }

    ipcMain.handle('rss:status', async () => {
      if (deps.useMock) {
        return ok(
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
            update: deps.rssUpdateLock.getStatus(),
            artifactsDir: deps.getArtifactsRootDir(),
          },
          true,
        )
      }

      try {
        const rsshubRequired = deps.isEmbeddedRSSHubRequiredForDiagnostics()
        const status = deps.rssUpdateLock.getStatus()
        const rsshubStatus = await deps.describeRsshubStatus()
        return ok(
          {
            rsshub: rsshubStatus,
            rsshubRequired,
            update: status,
            artifactsDir: deps.getArtifactsRootDir(),
          },
          false,
        )
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
    })

    ipcMain.handle('rss:stats', async () => {
      if (deps.useMock) {
        return ok(
          {
            totalSources: deps.mockSources.length,
            totalItems: deps.mockItems.length,
            unreadItems: deps.mockItems.filter((item) => !(item as { read?: boolean }).read).length,
            platformDistribution: { rss: deps.mockSources.length },
            categories: [],
          },
          true,
        )
      }

      try {
        const stats = deps.getRSSStats()
        return ok(stats, false)
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
    })

    const fetchAll = async (options?: FetchAllOptions): Promise<RSSFetchAllResponse> => {
      if (deps.useMock) {
        return ok(
          { message: 'RSS fetch simulated (mock mode)', fetched: 0, digest: false, errors: [] as string[] },
          true,
        )
      }

      let fetchAttemptStarted = false
      let completedResult: RSSFetchAllResponse | null = null
      try {
        const normalized = deps.normalizeFetchOptions(options)
        deps.persistFetchInvocation({
          mode: 'fetchAll',
          sourceIds: normalized.sourceIds ?? [],
          group: normalized.group ?? null,
          digest: normalized.digest,
        })
        const lockResult = await deps.rssUpdateLock.run(normalized, async () => {
          fetchAttemptStarted = true
          const allSources = deps.getRSSSources()
          const sources = deps.filterSelectedSources(allSources, normalized)

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

          console.log(
            `[rss:fetchAll] sources=${sources.length} digest=${normalized.digest} trigger=${normalized.trigger}`,
          )

          const insertedItemIds: string[] = []
          const errors: string[] = []
          let totalInserted = 0

          // Sources read through the browser session take turns one page at a time, with pauses in between.
          // They go last so that ordinary feeds are never left waiting behind them.
          const usesBrowserSession = (source: DBRSSSourceRow): boolean =>
            deps.resolveSourceBackend(deps.normalizeSourcePlatform(source)) === 'browser'
          const ordered = [
            ...sources.filter((source) => !usesBrowserSession(source)),
            ...sources.filter((source) => usesBrowserSession(source)),
          ]
          const tasks = ordered.map((source) => async () => {
            const startedAt = Date.now()
            const storedPlatform = (source.platform as PlatformType) || 'rss'
            const detectedPlatform = deps.detectPlatform(source.url)
            const platform =
              storedPlatform === 'rss' && detectedPlatform !== 'rss' ? detectedPlatform : storedPlatform
            if (platform !== storedPlatform) {
              deps.updateRSSSourcePlatform(source.id, platform)
              console.log(
                `[rss:fetchAll] migrated source platform ${source.name}: ${storedPlatform} -> ${platform}`,
              )
            }

            const { result, backendUsed, deferred } = await deps.fetchSourceWithCurrentStack(source, platform, {
              trigger: normalized.trigger,
            })
            if (deferred) {
              return { sourceId: source.id, inserted: 0, insertedIds: [] as string[], deferred: true }
            }

            if (result.error && result.items.length === 0) {
              const message = `[${source.name}] ${result.error}`
              deps.recordSourceRouteAttempt({
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
              deps.persistRouteDiagnosticsSnapshot()
              throw new Error(message)
            }

            const dbItems = result.items.map((item: ScrapedItem) => ({
              id: item.itemId,
              source_id: source.id,
              guid: deps.resolveRSSItemGuid(item),
              title: item.title,
              link: item.link,
              summary: item.description || null,
              cover_image: item.coverImage || null,
              author: item.author || null,
              published_at: item.pubDate ? Math.floor(new Date(item.pubDate).getTime() / 1000) : null,
            }))

            let newIds: string[]
            try {
              const candidateIds = dbItems.map((item) => item.id)
              const existingIds = new Set(deps.getRSSItemsByIds(candidateIds).map((item) => item.id))
              newIds = candidateIds.filter((id) => !existingIds.has(id))

              deps.upsertRSSItems(deps.selectItemsToStore(platform, dbItems))
              deps.updateRSSSourceLastFetched(source.id)
              if (result.items.length > 0) {
                deps.setRSSSourceDraftSeeded(source.id, true)
              }
            } catch (error) {
              // The source was fetched; what failed is saving it. Recorded as an attempt so that the next round
              // does not fetch it again as if it had never been tried.
              const message = `[${source.name}] ${error instanceof Error ? error.message : String(error)}`
              deps.recordSourceRouteAttempt({
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
              deps.persistRouteDiagnosticsSnapshot()
              throw new Error(message)
            }
            deps.recordSourceRouteAttempt({
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
            deps.persistRouteDiagnosticsSnapshot()
            return {
              sourceId: source.id,
              inserted: newIds.length,
              insertedIds: newIds,
              deferred: false,
            }
          })

          const settled = await deps.limitConcurrency(tasks, 5)
          let deferredCount = 0
          for (const result of settled) {
            if (result.status === 'fulfilled') {
              if (result.value.deferred) deferredCount += 1
              totalInserted += result.value.inserted
              insertedItemIds.push(...result.value.insertedIds)
            } else {
              const message =
                result.reason instanceof Error ? result.reason.message : String(result.reason)
              errors.push(message)
              console.error('[rss:fetchAll]', message)
            }
          }

          const allItems = deps.getAllRSSItems()
          const insertedItems = deps.getRSSItemsByIds(insertedItemIds) as DBRSSItemRow[]

          await deps.generateRSSArtifacts({
            sources,
            allItems,
            insertedItems,
          })

          if (normalized.digest) {
            const previous = deps.loadDigestSnapshot()
            const latestPerSource = deps.getLatestPerSource()
            const current: Record<string, string> = {}
            for (const item of latestPerSource) {
              current[item.source_id] = item.id
            }
            deps.saveDigestSnapshot(current)

            const changedSources = Object.keys(current).filter((sourceId) => previous[sourceId] !== current[sourceId])
            return {
              insertedCount: totalInserted,
              errors,
              sourceCount: sources.length,
              message: `Fetched ${sources.length - deferredCount} sources, ${totalInserted} new items, digest changed ${changedSources.length} sources${deferredNote(deferredCount)}`,
            }
          }

          return {
            insertedCount: totalInserted,
            errors,
            sourceCount: sources.length,
            message: `Fetched ${sources.length - deferredCount} sources, ${totalInserted} new items${deferredNote(deferredCount)}`,
          }
        })

        if (lockResult.skipped) {
          return ok(
            {
              message: 'RSS update already running',
              fetched: lockResult.status.insertedCount,
              running: true,
              status: lockResult.status,
            },
            false,
          )
        }

        completedResult = ok(
          {
            message: lockResult.message,
            fetched: lockResult.insertedCount,
            digest: normalized.digest,
            errors: lockResult.errors.length > 0 ? lockResult.errors : undefined,
            status: lockResult.status,
          },
          false,
        )
        return completedResult
      } catch (error) {
        completedResult = fail(error instanceof Error ? error.message : String(error))
        return completedResult
      } finally {
        if (fetchAttemptStarted && completedResult) {
          deps.recordFetchAllCompletedAt(new Date().toISOString(), completedResult)
          deps.schedulePicturesWarm()
        }
      }
    }
    ipcMain.handle('rss:fetchAll', async (_, options?: FetchAllOptions) => fetchAll(options))

    ipcMain.handle('rss:refreshSource', async (_, payload?: { sourceId?: string }) => {
      if (deps.useMock) {
        return ok(
          { message: 'RSS source refresh simulated (mock mode)', fetched: 0, sourceId: payload?.sourceId || '' },
          true,
        )
      }

      const sourceId = payload?.sourceId?.trim()
      if (!sourceId) return fail('Missing sourceId')

      if (deps.sourceRefreshInFlight.has(sourceId)) {
        return ok(
          {
            message: 'Current source refresh already running',
            sourceId,
            running: true,
            fetched: 0,
          },
          false,
        )
      }

      deps.sourceRefreshInFlight.add(sourceId)
      deps.persistFetchInvocation({
        mode: 'refreshSource',
        sourceId,
        sourceIds: [sourceId],
      })

      try {
        const source = deps.getRSSSources().find((entry) => entry.id === sourceId)
        if (!source) return fail('RSS source not found')

        const storedPlatform = (source.platform as PlatformType) || 'rss'
        const detectedPlatform = deps.detectPlatform(source.url)
        const platform =
          storedPlatform === 'rss' && detectedPlatform !== 'rss' ? detectedPlatform : storedPlatform
        const startedAt = Date.now()

        if (platform !== storedPlatform) {
          deps.updateRSSSourcePlatform(source.id, platform)
        }

        const { result, backendUsed, deferred } = await deps.fetchSourceWithCurrentStack(source, platform, {
          trigger: 'manual-source',
        })
        if (deferred) {
          // The page was not opened (the platform is paused after a verification page): say so and offer the
          // way to deal with it, without recording an attempt that never happened.
          const message = `[${source.name}] ${result.error || '这个订阅暂时不能刷新'}`
          const browserAction = deps.buildBrowserActionFromSource(source, platform)
          return fail(message, {
            message,
            fetched: 0,
            sourceId,
            sourceName: source.name,
            backend: backendUsed,
            errors: [result.error || message],
            browserAction: browserAction ?? undefined,
          })
        }
        if (result.error && result.items.length === 0) {
          const message = `[${source.name}] ${result.error}`
          deps.recordSourceRouteAttempt({
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
          deps.persistRouteDiagnosticsSnapshot()
          const browserAction = deps.buildBrowserActionFromSource(source, platform)
          return fail(message, {
            message,
            fetched: 0,
            sourceId,
            sourceName: source.name,
            backend: backendUsed,
            errors: [result.error],
            browserAction: browserAction ?? undefined,
          })
        }

        const dbItems = result.items.map((item: ScrapedItem) => ({
          id: item.itemId,
          source_id: source.id,
          guid: deps.resolveRSSItemGuid(item),
          title: item.title,
          link: item.link,
          summary: item.description || null,
          cover_image: item.coverImage || null,
          author: item.author || null,
          published_at: item.pubDate ? Math.floor(new Date(item.pubDate).getTime() / 1000) : null,
        }))
        const candidateIds = dbItems.map((item) => item.id)
        const existingIds = new Set(deps.getRSSItemsByIds(candidateIds).map((item) => item.id))
        const newIds = candidateIds.filter((id) => !existingIds.has(id))
        deps.upsertRSSItems(deps.selectItemsToStore(platform, dbItems))
        deps.updateRSSSourceLastFetched(source.id)
        if (result.items.length > 0) {
          deps.setRSSSourceDraftSeeded(source.id, true)
        }
        deps.recordSourceRouteAttempt({
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
        deps.persistRouteDiagnosticsSnapshot()

        await deps.generateRSSArtifacts({
          sources: deps.getRSSSources(),
          allItems: deps.getAllRSSItems(),
          insertedItems: deps.getRSSItemsByIds(newIds) as DBRSSItemRow[],
        })
        deps.schedulePicturesWarm()

        return ok(
          {
            message: `Refreshed 1 source via ${backendUsed}, ${result.items.length} items, ${newIds.length} written`,
            fetched: newIds.length,
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
        const source = deps.getRSSSources().find((entry) => entry.id === sourceId)
        if (source) {
          const storedPlatform = (source.platform as PlatformType) || 'rss'
          const detectedPlatform = deps.detectPlatform(source.url)
          const platform =
            storedPlatform === 'rss' && detectedPlatform !== 'rss' ? detectedPlatform : storedPlatform
          deps.recordSourceRouteAttempt({
            sourceId: source.id,
            sourceName: source.name,
            url: source.url,
            groupName: source.group_name,
            platform,
            backend: deps.resolveSourceBackend(platform),
            durationMs: 0,
            itemCount: 0,
            success: false,
            error: message,
          })
          deps.persistRouteDiagnosticsSnapshot()
          const browserAction = deps.buildBrowserActionFromSource(source, platform)
          return fail(message, {
            message,
            fetched: 0,
            sourceId,
            sourceName: source.name,
            backend: deps.resolveSourceBackend(platform),
            errors: [message],
            browserAction: browserAction ?? undefined,
          })
        }
        return fail(message, {
          message,
          fetched: 0,
          sourceId,
          errors: [message],
        })
      } finally {
        deps.sourceRefreshInFlight.delete(sourceId)
        await deps.yieldToEventLoop()
      }
    })

    ipcMain.handle('rss:benchmarkSources', async (_, options?: RSSBenchmarkOptions) => {
      if (deps.useMock) {
        return ok(
          {
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            sourceCount: 0,
            entries: [] as RSSSourceBenchmarkEntry[],
            summary: deps.buildBenchmarkSummary([]),
          },
          true,
        )
      }

      try {
        const allSources = deps.getRSSSources()
        const sources = deps.filterSelectedSources(allSources, options)
        const startedAt = new Date().toISOString()

        if (sources.length === 0) {
          return ok(
            {
              startedAt,
              finishedAt: new Date().toISOString(),
              sourceCount: 0,
              entries: [] as RSSSourceBenchmarkEntry[],
              summary: deps.buildBenchmarkSummary([]),
            },
            false,
          )
        }

        const tasks = sources.map((source) => async (): Promise<RSSSourceBenchmarkEntry> => {
          const platform = deps.normalizeSourcePlatform(source)
          const backend = deps.classifyBackend(source)
          const started = Date.now()

          try {
            const { result, backendUsed, deferred } = await deps.fetchSourceWithCurrentStack(source, platform, {
              trigger: 'manual-all',
            })
            const success = result.items.length > 0 || !result.error
            const errorMessage = success ? null : result.error || 'Unknown fetch error'
            const durationMs = Date.now() - started

            // A source whose page was not opened has no new attempt to record.
            if (!deferred) deps.recordSourceRouteAttempt({
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
              chromiumRequired: deps.getRouteCapabilityMatrix().find((entry) => entry.platform === platform)?.chromiumRequired ?? false,
              scraplingEligible: deps.getRouteCapabilityMatrix().find((entry) => entry.platform === platform)?.scraplingEligible ?? false,
              success,
              durationMs,
              itemCount: result.items.length,
              error: errorMessage,
              failureKind: errorMessage && !deferred
                ? deps.buildSourceDiagnostics([{ ...source, platform }])[0]?.lastRouteError?.kind ?? 'unknown'
                : null,
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            const durationMs = Date.now() - started
            deps.recordSourceRouteAttempt({
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
              chromiumRequired: deps.getRouteCapabilityMatrix().find((entry) => entry.platform === platform)?.chromiumRequired ?? false,
              scraplingEligible: deps.getRouteCapabilityMatrix().find((entry) => entry.platform === platform)?.scraplingEligible ?? false,
              success: false,
              durationMs,
              itemCount: 0,
              error: message,
              failureKind: deps.buildSourceDiagnostics([{ ...source, platform }])[0]?.lastRouteError?.kind ?? 'unknown',
            }
          }
        })

        const settled = await deps.limitConcurrency(tasks, 4)
        const entries = settled
          .filter((result): result is PromiseFulfilledResult<RSSSourceBenchmarkEntry> => result.status === 'fulfilled')
          .map((result) => result.value)
        deps.persistRouteDiagnosticsSnapshot()
        const finishedAt = new Date().toISOString()
        const summary = deps.buildBenchmarkSummary(entries)
        const artifacts = await deps.generateRSSBenchmarkArtifacts({
          startedAt,
          finishedAt,
          entries,
          summary,
        })

        return ok(
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
        return fail(error instanceof Error ? error.message : String(error))
      }
    })

    return {
      fetchAll,
      dispose(): void {
        for (const channel of CHANNELS) {
          try { ipcMain.removeHandler(channel) } catch { /* ignore — already removed */ }
        }
      },
    }
  },
}

/** Exposed for the registration-behavior test (channels list assertion). */
export const _fetchGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
