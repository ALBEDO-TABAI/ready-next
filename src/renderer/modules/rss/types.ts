export type RSSHubChromiumSource = 'env' | 'cache' | 'system' | 'downloaded' | 'none'
export type SourceBackend = 'native' | 'rsshub' | 'browser' | 'scrapling'
export type RouteFailureKind = 'startup' | 'chromium' | 'route' | 'anti_bot' | 'waf' | 'auth' | 'unknown'
export type SourceBackendState = 'stable' | 'conditional' | 'failing' | 'untested'

export interface RSSHubChromiumStatusData {
  ready: boolean
  executablePath: string | null
  source: RSSHubChromiumSource
  cacheDir: string
  buildId: string
  downloadSupported: boolean | null
  lastCheckedAt: string | null
  lastError: string | null
}

export interface RSSHubRuntimeStatusData {
  state: 'stopped' | 'starting' | 'running' | 'error' | 'mock'
  running: boolean
  port: number
  baseUrl: string | null
  restartCount: number
  lastError: string | null
  lastStartupError: string | null
  lastRuntimeError: string | null
  lastRuntimeErrorAt: string | null
  startedAt: string | null
  exitedAt: string | null
  chromium: RSSHubChromiumStatusData
}

export interface RSSUpdateTaskStatusData {
  running: boolean
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  sourceCount: number
  insertedCount: number
  errors: string[]
  digest: boolean
  message: string | null
}

export interface RSSStatusData {
  rsshub: RSSHubRuntimeStatusData
  rsshubRequired: boolean
  update: RSSUpdateTaskStatusData
  artifactsDir: string
}

export interface RSSDiagnosticsData {
  rsshub: RSSHubRuntimeStatusData
  rsshubRequired: boolean
  update: RSSUpdateTaskStatusData
  lastFetchInvocation: {
    recordedAt: string | null
    mode: 'refreshSource' | 'fetchAll' | null
    sourceId: string | null
    sourceIds: string[]
    group: string | null
    digest: boolean | null
    } | null
  artifacts: {
    root: string
    hasOpml: boolean
    benchmarkJson: string | null
    benchmarkMarkdown: string | null
  }
  benchmark: RSSBenchmarkResultData | null
  sources: RSSSourceDiagnosticsEntry[]
  capabilityMatrix: RouteCapabilityMatrixEntry[]
}

export interface RSSRouteErrorInfoData {
  kind: RouteFailureKind
  detail: string | null
  message: string
  recordedAt: string
}

export interface RSSBrowserOpenActionData {
  type: 'open_in_browser'
  label: string
  url: string
  platform: string
  reason: 'login' | 'verify' | 'inspect'
}

export interface RouteCapabilityMatrixEntry {
  platform: string
  label: string
  backend: SourceBackend
  fallbackOrder: SourceBackend[]
  chromiumRequired: boolean
  scraplingEligible: boolean
  notes: string
}

export interface RSSSourceDiagnosticsEntry {
  sourceId: string
  sourceName: string
  url: string
  groupName: string
  platform: string
  platformLabel: string
  backend: SourceBackend
  backendState: SourceBackendState
  fallbackOrder: SourceBackend[]
  chromiumRequired: boolean
  scraplingEligible: boolean
  scraplingEnabled: boolean
  note: string
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  lastDurationMs: number | null
  lastItemCount: number | null
  lastWarning: string | null
  lastRouteError: RSSRouteErrorInfoData | null
}

export interface RSSBenchmarkEntryData {
  sourceId: string
  sourceName: string
  platform: string
  backend: SourceBackend
  chromiumRequired: boolean
  scraplingEligible: boolean
  success: boolean
  durationMs: number
  itemCount: number
  error: string | null
  failureKind: RouteFailureKind | null
}

export interface RSSBenchmarkPlatformSummaryData {
  platform: string
  label: string
  backend: SourceBackend
  chromiumRequired: boolean
  scraplingEligible: boolean
  sourceCount: number
  successCount: number
  failureCount: number
  p50DurationMs: number | null
  p95DurationMs: number | null
}

export interface RSSBenchmarkSummaryData {
  sourceCount: number
  successCount: number
  failureCount: number
  p50DurationMs: number | null
  p95DurationMs: number | null
  scraplingCandidatePlatforms: string[]
  platforms: RSSBenchmarkPlatformSummaryData[]
}

export interface RSSBenchmarkResultData {
  startedAt: string
  finishedAt: string
  sourceCount: number
  entries: RSSBenchmarkEntryData[]
  summary: RSSBenchmarkSummaryData
  artifacts: {
    benchmarkJson: string
    benchmarkMarkdown: string
  }
}

export interface RSSRefreshSourceResultData {
  message: string
  fetched: number
  sourceId: string
  sourceName?: string
  backend?: SourceBackend
  itemCount?: number
  running?: boolean
  errors?: string[]
  browserAction?: RSSBrowserOpenActionData
}
