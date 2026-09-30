// Stage V V2.2e — rss-engine DiagnosticsGroup channel cluster.
//
// Bundles the 2 channels that drive the renderer's "RSS runtime health"
// surface — the diagnostics tab + the one-click runtime repair action:
//
//   rss:repairRuntime  (stop + ensure-healthy + re-describe the embedded
//                       rsshub process; surfaces the post-repair status
//                       so the UI can flip the badge without a follow-up
//                       `rss:status` round-trip)
//   rss:diagnostics    (read-only snapshot of every runtime probe the UI
//                       displays: rsshub status + warmup requirement,
//                       update lock state, last fetch invocation, opml +
//                       benchmark artifact presence, latest benchmark
//                       run, per-source route diagnostics, capability
//                       matrix)
//
// Handler bodies are lifted VERBATIM from `ipc-handler.ts` (V2.2e follows
// the V2.2a–d move + thin-wrapper shape). The handlers do NOT import any
// rss-engine internals directly: every collaborator (the repository
// surface, the update lock, the rsshub manager, the diagnostics + capability
// helpers, the fetch invocation snapshot loader, the benchmark snapshot
// loader, the artifacts directory probe, the rsshub warmup probe) is
// injected via `DiagnosticsGroupDeps` so the group is testable in isolation
// and so future moves out of rss-engine stay mechanical.
//
// The 2 channels live in one group despite mixing one mutation
// (`repairRuntime` — stops + restarts the embedded rsshub process) and
// one pure read (`diagnostics`) because they share:
//   • the same domain concept (an "RSS runtime health snapshot" plus the
//     write-side that restores that health)
//   • the same dispose lifecycle (renderer's diagnostics tab binds them
//     together — refresh after repair without re-binding)
//   • the same dep surface (rsshub manager + update lock + diagnostics
//     helpers + the two file-system probes)
// Peeling the repair from the read here would create siblings whose deps
// overlap entirely — against the per-group-deps-as-contract intent.
import type { IpcMain } from 'electron'
import type { PlatformType } from '../scrapers/index'
import type { RSSUpdateLock } from '../update-lock'
import type {
  RSSSourceBenchmarkEntry,
} from '../source-diagnostics'
import type { buildBenchmarkSummary as BuildBenchmarkSummaryFn } from '../source-diagnostics'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'

/** Mirror of the host's `DBRSSSource` row (kept here so the group is self-describing). */
export interface DBRSSSourceRow {
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

/** Shape returned by the host's fetch-invocation snapshot loader. */
export interface FetchInvocationSnapshot {
  recordedAt: string | null
  mode: 'refreshSource' | 'fetchAll' | null
  sourceId: string | null
  sourceIds: string[]
  group: string | null
  digest: boolean | null
}

/** Shape returned by the host's latest-benchmark snapshot loader. */
export interface LatestBenchmarkSnapshot {
  startedAt: string
  finishedAt: string
  sourceCount: number
  entries: RSSSourceBenchmarkEntry[]
  summary: ReturnType<typeof BuildBenchmarkSummaryFn>
  artifacts: {
    benchmarkJson: string
    benchmarkMarkdown: string
  }
}

/**
 * Per-group deps. The group keeps the response-shaping (`ok` / `fail`),
 * the mock-mode dispatch, the verbatim handler bodies, and the channel
 * list. Everything else — repository access, the update lock, the rsshub
 * manager (stop + ensure-healthy + describe), the diagnostics helpers
 * (`buildSourceDiagnostics`, `getRouteCapabilityMatrix`), the warmup
 * probe, the fetch invocation + benchmark snapshot loaders, the
 * artifacts directory accessor — is injected by the host.
 *
 * `readFile` is passed in so the group can probe the opml +
 * benchmark file existence without importing `node:fs/promises`
 * directly; tests stub it with an in-memory faker.
 */
export interface DiagnosticsGroupDeps {
  /** Whether the engine is running in mock mode (no SQLite, no rsshub). */
  readonly useMock: boolean

  // --- repository surface ---
  getRSSSources(): DBRSSSourceRow[]

  // --- managers + locks ---
  readonly rssUpdateLock: RSSUpdateLock
  rsshubStop(): Promise<void>
  rsshubEnsureHealthy(): Promise<boolean>
  describeRsshubStatus(): Promise<unknown>
  warmEmbeddedRSSHubForDiagnostics(): Promise<boolean>

  // --- diagnostics helpers ---
  buildSourceDiagnostics(
    sources: Array<Pick<DBRSSSourceRow, 'id' | 'name' | 'url' | 'group_name'> & { platform: PlatformType }>,
  ): unknown[]
  getRouteCapabilityMatrix(): Array<{ platform: PlatformType; chromiumRequired: boolean; scraplingEligible: boolean }>

  // --- snapshots + artifacts ---
  loadFetchInvocationSnapshot(): FetchInvocationSnapshot | null
  loadLatestBenchmarkSnapshot(): Promise<LatestBenchmarkSnapshot | null>
  getArtifactsRootDir(): string
  /** Inject the file-read probe so tests don't need `node:fs/promises`. */
  readFileUtf8(path: string): Promise<string>
  /** Path-join helper (host passes `node:path`'s `join`) so artifact path composition stays a pure dep. */
  joinPath(...parts: string[]): string
}

const CHANNELS = [
  'rss:repairRuntime',
  'rss:diagnostics',
] as const

interface RSSResponse<T> {
  success: boolean
  mock: boolean
  data?: T
  error?: string
}

function ok<T>(data: T, isMock: boolean): RSSResponse<T> {
  return { success: true, mock: isMock, data }
}

function fail<T = never>(error: string, data?: T): RSSResponse<T> {
  return data === undefined
    ? { success: false, mock: false, error }
    : { success: false, mock: false, error, data }
}

export const diagnosticsGroup: IpcChannelGroup<DiagnosticsGroupDeps> = {
  namespace: 'rss:diagnostics',

  register(ipcMain: IpcMain, deps: DiagnosticsGroupDeps): IpcDisposeHandle {
    // Defensive pre-clear — `setupRSSIPC` may be re-entered on dev reload;
    // strip any prior handler so `ipcMain.handle` does not throw on the
    // second registration. Mirrors SourceGroup / ItemGroup / AnalysisGroup
    // / FetchGroup.
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore — handler may not exist */ }
    }

    ipcMain.handle('rss:repairRuntime', async () => {
      if (deps.useMock) {
        return ok({ repaired: false, mock: true }, true)
      }

      try {
        await deps.rsshubStop().catch(() => {
          // ignore stop failures during repair
        })
        const healthy = await deps.rsshubEnsureHealthy()
        const rsshubStatus = await deps.describeRsshubStatus()
        return ok(
          {
            repaired: healthy,
            rsshub: rsshubStatus,
          },
          false,
        )
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
    })

    ipcMain.handle('rss:diagnostics', async () => {
      if (deps.useMock) {
        return ok(
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
            update: deps.rssUpdateLock.getStatus(),
            lastFetchInvocation: deps.loadFetchInvocationSnapshot(),
            artifacts: {
              root: deps.getArtifactsRootDir(),
              hasOpml: false,
              benchmarkJson: null,
              benchmarkMarkdown: null,
            },
            benchmark: null,
            sources: [],
            capabilityMatrix: deps.getRouteCapabilityMatrix(),
          },
          true,
        )
      }

      try {
        const rsshubRequired = await deps.warmEmbeddedRSSHubForDiagnostics()
        const opmlPath = deps.joinPath(deps.getArtifactsRootDir(), 'subscriptions.opml')
        const benchmarkJsonPath = deps.joinPath(deps.getArtifactsRootDir(), 'benchmark.latest.json')
        const benchmarkMarkdownPath = deps.joinPath(deps.getArtifactsRootDir(), 'benchmark.latest.md')
        const latestBenchmark = await deps.loadLatestBenchmarkSnapshot()
        let hasOpml = false
        try {
          await deps.readFileUtf8(opmlPath)
          hasOpml = true
        } catch {
          hasOpml = false
        }

        const rsshubStatus = await deps.describeRsshubStatus()
        const sources = deps.getRSSSources()
        return ok(
          {
            rsshub: rsshubStatus,
            rsshubRequired,
            update: deps.rssUpdateLock.getStatus(),
            lastFetchInvocation: deps.loadFetchInvocationSnapshot(),
            artifacts: {
              root: deps.getArtifactsRootDir(),
              hasOpml,
              // fire-and-forget: probe existence by attempting read; null means "not present" — the diagnostic snapshot just omits the path.
              benchmarkJson: await deps.readFileUtf8(benchmarkJsonPath).then(() => benchmarkJsonPath).catch(() => null),
              // fire-and-forget: probe existence by attempting read; null means "not present" — the diagnostic snapshot just omits the path.
              benchmarkMarkdown: await deps.readFileUtf8(benchmarkMarkdownPath).then(() => benchmarkMarkdownPath).catch(() => null),
            },
            benchmark: latestBenchmark,
            sources: deps.buildSourceDiagnostics(
              sources.map((entry) => ({
                id: entry.id,
                name: entry.name,
                url: entry.url,
                group_name: entry.group_name,
                platform: (entry.platform as PlatformType) || 'rss',
              })),
            ),
            capabilityMatrix: deps.getRouteCapabilityMatrix(),
          },
          false,
        )
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
    })

    return {
      dispose(): void {
        for (const channel of CHANNELS) {
          try { ipcMain.removeHandler(channel) } catch { /* ignore — already removed */ }
        }
      },
    }
  },
}

/** Exposed for the registration-behavior test (channels list assertion). */
export const _diagnosticsGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
