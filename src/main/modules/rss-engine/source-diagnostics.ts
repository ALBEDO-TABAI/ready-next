import { platformLabel, type PlatformType } from './scrapers'

export type SourceBackend = 'native' | 'rsshub' | 'browser' | 'scrapling'

export type RouteFailureKind =
  | 'startup'
  | 'chromium'
  | 'route'
  | 'anti_bot'
  | 'waf'
  | 'auth'
  | 'unknown'

export type SourceBackendState = 'stable' | 'conditional' | 'failing' | 'untested'

export interface RSSRouteErrorInfo {
  kind: RouteFailureKind
  detail: string | null
  message: string
  recordedAt: string
}

export interface RouteCapabilityMatrixEntry {
  platform: PlatformType
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
  platform: PlatformType
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
  lastRouteError: RSSRouteErrorInfo | null
}

export interface RSSSourceBenchmarkEntry {
  sourceId: string
  sourceName: string
  platform: PlatformType
  backend: SourceBackend
  chromiumRequired: boolean
  scraplingEligible: boolean
  success: boolean
  durationMs: number
  itemCount: number
  error: string | null
  failureKind: RouteFailureKind | null
}

export interface RSSSourceBenchmarkPlatformSummary {
  platform: PlatformType
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

export interface RSSSourceBenchmarkSummary {
  sourceCount: number
  successCount: number
  failureCount: number
  p50DurationMs: number | null
  p95DurationMs: number | null
  scraplingCandidatePlatforms: PlatformType[]
  platforms: RSSSourceBenchmarkPlatformSummary[]
}

interface RSSSourceLike {
  id: string
  name: string
  url: string
  group_name?: string | null
  platform?: string | null
}

interface RecordedRouteAttempt {
  sourceId: string
  sourceName: string
  url: string
  groupName: string
  platform: PlatformType
  backend: SourceBackend
  durationMs: number
  itemCount: number
  success: boolean
  warning: string | null
  attemptedAt: string
  succeededAt: string | null
  lastRouteError: RSSRouteErrorInfo | null
}

export type RouteAttemptSnapshotEntry = RecordedRouteAttempt

interface RouteAttemptInput {
  sourceId: string
  sourceName: string
  url: string
  groupName?: string | null
  platform: PlatformType
  backend?: SourceBackend
  durationMs: number
  itemCount: number
  success: boolean
  warning?: string | null
  error?: string | null
  attemptedAt?: string
}

const routeAttemptStore = new Map<string, RecordedRouteAttempt>()

export function allowsRSSHubFallbackAfterBrowser(_platform: PlatformType): boolean {
  return false
}

const routeCapabilityMatrix: Record<PlatformType, RouteCapabilityMatrixEntry> = {
  rss: {
    platform: 'rss',
    label: platformLabel('rss'),
    backend: 'native',
    fallbackOrder: ['native'],
    chromiumRequired: false,
    scraplingEligible: false,
    notes: '优先保留原生 RSS/Atom 抓取，不建议引入 Scrapling。',
  },
  youtube: {
    platform: 'youtube',
    label: platformLabel('youtube'),
    backend: 'native',
    fallbackOrder: ['native'],
    chromiumRequired: false,
    scraplingEligible: false,
    notes: 'Atom feed 已稳定，保持当前 native 路径。',
  },
  twitter: {
    platform: 'twitter',
    label: platformLabel('twitter'),
    backend: 'native',
    fallbackOrder: ['native'],
    chromiumRequired: false,
    scraplingEligible: false,
    notes: '现有 syndication 路径可用，不建议默认引入 Scrapling。',
  },
  bilibili: {
    platform: 'bilibili',
    label: platformLabel('bilibili'),
    backend: 'rsshub',
    fallbackOrder: ['rsshub', 'native', 'scrapling'],
    chromiumRequired: false,
    scraplingEligible: false,
    notes: '继续以 RSSHub/官方 API 回退为主体，Scrapling 仅保留远期 anti-risk 备选。',
  },
  weibo: {
    platform: 'weibo',
    label: platformLabel('weibo'),
    backend: 'browser',
    fallbackOrder: ['browser', 'scrapling'],
    chromiumRequired: true,
    scraplingEligible: true,
    notes: '统一复用应用内浏览器 session；失败时优先引导回浏览器处理登录或验证，Scrapling 仅做候选 fallback。',
  },
  douyin: {
    platform: 'douyin',
    label: platformLabel('douyin'),
    backend: 'browser',
    fallbackOrder: ['browser', 'scrapling'],
    chromiumRequired: true,
    scraplingEligible: true,
    notes: '优先使用应用内浏览器获取；默认不再静默回退 RSSHub，页面风控持续失败时再单独评估 Scrapling fallback。',
  },
  xiaohongshu: {
    platform: 'xiaohongshu',
    label: platformLabel('xiaohongshu'),
    backend: 'browser',
    fallbackOrder: ['browser', 'scrapling'],
    chromiumRequired: true,
    scraplingEligible: true,
    notes: '优先使用应用内浏览器获取；默认不再静默回退 RSSHub，browser route 仍不稳时再评估 Scrapling fallback。',
  },
  vimeo: {
    platform: 'vimeo',
    label: platformLabel('vimeo'),
    backend: 'native',
    fallbackOrder: ['native'],
    chromiumRequired: false,
    scraplingEligible: false,
    notes: '原生 Vimeo RSS 已可用，保持轻量路径。',
  },
  behance: {
    platform: 'behance',
    label: platformLabel('behance'),
    backend: 'native',
    fallbackOrder: ['native'],
    chromiumRequired: false,
    scraplingEligible: false,
    notes: '原生 feed 可用，不建议引入更重抓取链路。',
  },
  zsxq: {
    platform: 'zsxq',
    label: platformLabel('zsxq'),
    backend: 'native',
    fallbackOrder: ['native'],
    chromiumRequired: false,
    scraplingEligible: false,
    notes: '当前 API 路径稳定，保持现状。',
  },
}

function normalizePlatform(platform: string | null | undefined): PlatformType {
  const candidate = (platform || 'rss') as PlatformType
  return routeCapabilityMatrix[candidate] ? candidate : 'rss'
}

function quantile(values: number[], percentile: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * percentile) - 1))
  return sorted[index] ?? null
}

function classifyRouteFailure(message: string): RSSRouteErrorInfo {
  const normalized = message.trim()
  const lower = normalized.toLowerCase()

  if (
    lower.includes('could not find chrome') ||
    lower.includes('chromium') ||
    lower.includes('browser platform') ||
    lower.includes('executable path') ||
    lower.includes('chrome path')
  ) {
    return {
      kind: 'chromium',
      detail: 'chromium_unavailable',
      message: normalized,
      recordedAt: new Date().toISOString(),
    }
  }

  if (
    lower.includes('rsshub unavailable') ||
    lower.includes('failed to start') ||
    lower.includes('eaddrinuse') ||
    lower.includes('address already in use') ||
    lower.includes('connect econrefused') ||
    lower.includes('healthz')
  ) {
    return {
      kind: 'startup',
      detail: 'rsshub_runtime_unavailable',
      message: normalized,
      recordedAt: new Date().toISOString(),
    }
  }

  if (
    lower.includes('targetcloseerror') ||
    lower.includes('target closed') ||
    lower.includes('frame got detached') ||
    lower.includes('execution context was destroyed') ||
    lower.includes('browser_target_closed') ||
    lower.includes('cannot extract user id') ||
    lower.includes('http 5') ||
    lower.includes('http 4')
  ) {
    return {
      kind: 'route',
      detail:
        lower.includes('targetcloseerror') ||
        lower.includes('target closed') ||
        lower.includes('frame got detached') ||
        lower.includes('browser_target_closed')
        ? 'browser_target_closed'
        : lower.includes('cannot extract user id')
          ? 'route_parser_failed'
          : 'route_request_failed',
      message: normalized,
      recordedAt: new Date().toISOString(),
    }
  }

  if (
    lower.includes('empty post data') ||
    lower.includes('waf') ||
    lower.includes('risk control') ||
    lower.includes('-352') ||
    lower.includes('-799')
  ) {
    return {
      kind: 'waf',
      detail: 'upstream_waf_or_risk_control',
      message: normalized,
      recordedAt: new Date().toISOString(),
    }
  }

  if (
    lower.includes('captcha') ||
    lower.includes('验证') ||
    lower.includes('滑块') ||
    lower.includes('too many requests') ||
    lower.includes('rate limit')
  ) {
    return {
      kind: 'anti_bot',
      detail: 'captcha_or_rate_limit',
      message: normalized,
      recordedAt: new Date().toISOString(),
    }
  }

  if (
    lower.includes('passport.weibo.com/visitor') ||
    lower.includes('/login?redirect') ||
    lower.includes('browser_session_login_required') ||
    lower.includes('login') ||
    lower.includes('sign in') ||
    lower.includes('unauthorized') ||
    lower.includes('forbidden') ||
    lower.includes('cookie') ||
    lower.includes('登录')
  ) {
    return {
      kind: 'auth',
      detail: 'login_or_cookie_required',
      message: normalized,
      recordedAt: new Date().toISOString(),
    }
  }

  return {
    kind: 'unknown',
    detail: null,
    message: normalized,
    recordedAt: new Date().toISOString(),
  }
}

export function resolveSourceBackend(platform: PlatformType): SourceBackend {
  return routeCapabilityMatrix[platform]?.backend ?? 'native'
}

export function getRouteCapabilityMatrix(): RouteCapabilityMatrixEntry[] {
  return Object.values(routeCapabilityMatrix)
}

export function recordSourceRouteAttempt(input: RouteAttemptInput): void {
  const attemptedAt = input.attemptedAt ?? new Date().toISOString()
  const backend = input.backend ?? resolveSourceBackend(input.platform)
  const routeError = input.error ? classifyRouteFailure(input.error) : null

  routeAttemptStore.set(input.sourceId, {
    sourceId: input.sourceId,
    sourceName: input.sourceName,
    url: input.url,
    groupName: input.groupName || 'default',
    platform: input.platform,
    backend,
    durationMs: input.durationMs,
    itemCount: input.itemCount,
    success: input.success,
    warning: input.warning?.trim() || null,
    attemptedAt,
    succeededAt: input.success ? attemptedAt : null,
    lastRouteError: routeError,
  })
}

export function getRouteAttempt(sourceId: string): RecordedRouteAttempt | null {
  return routeAttemptStore.get(sourceId) ?? null
}

export function listRouteAttempts(): RouteAttemptSnapshotEntry[] {
  return Array.from(routeAttemptStore.values())
}

export function restoreRouteAttempts(entries: RouteAttemptSnapshotEntry[]): void {
  routeAttemptStore.clear()
  for (const entry of entries) {
    routeAttemptStore.set(entry.sourceId, entry)
  }
}

export function buildSourceDiagnostics(
  sources: RSSSourceLike[],
  scraplingEnabledPlatforms: PlatformType[] = [],
): RSSSourceDiagnosticsEntry[] {
  const scraplingEnabled = new Set(scraplingEnabledPlatforms)

  return sources.map((source) => {
    const platform = normalizePlatform(source.platform)
    const capability = routeCapabilityMatrix[platform]
    const attempt = routeAttemptStore.get(source.id)

    let backendState: SourceBackendState = 'untested'
    if (attempt) {
      if (!attempt.success) {
        backendState = 'failing'
      } else if (capability.chromiumRequired || attempt.warning) {
        backendState = 'conditional'
      } else {
        backendState = 'stable'
      }
    }

    return {
      sourceId: source.id,
      sourceName: source.name,
      url: source.url,
      groupName: source.group_name || 'default',
      platform,
      platformLabel: capability.label,
      backend: attempt?.backend ?? capability.backend,
      backendState,
      fallbackOrder: capability.fallbackOrder,
      chromiumRequired: capability.chromiumRequired,
      scraplingEligible: capability.scraplingEligible,
      scraplingEnabled: capability.scraplingEligible && scraplingEnabled.has(platform),
      note: capability.notes,
      lastAttemptAt: attempt?.attemptedAt ?? null,
      lastSuccessAt: attempt?.succeededAt ?? null,
      lastDurationMs: attempt?.durationMs ?? null,
      lastItemCount: attempt?.itemCount ?? null,
      lastWarning: attempt?.warning ?? null,
      lastRouteError: attempt?.lastRouteError ?? null,
    }
  })
}

export function buildBenchmarkSummary(entries: RSSSourceBenchmarkEntry[]): RSSSourceBenchmarkSummary {
  const durations = entries.map((entry) => entry.durationMs)
  const grouped = new Map<PlatformType, RSSSourceBenchmarkEntry[]>()

  for (const entry of entries) {
    const bucket = grouped.get(entry.platform) ?? []
    bucket.push(entry)
    grouped.set(entry.platform, bucket)
  }

  const platforms = Array.from(grouped.entries()).map(([platform, bucket]) => {
    const successCount = bucket.filter((entry) => entry.success).length
    const failureCount = bucket.length - successCount
    const platformDurations = bucket.map((entry) => entry.durationMs)
    const capability = routeCapabilityMatrix[platform]

    return {
      platform,
      label: capability.label,
      backend: capability.backend,
      chromiumRequired: capability.chromiumRequired,
      scraplingEligible: capability.scraplingEligible,
      sourceCount: bucket.length,
      successCount,
      failureCount,
      p50DurationMs: quantile(platformDurations, 0.5),
      p95DurationMs: quantile(platformDurations, 0.95),
    }
  })

  const scraplingCandidatePlatforms = platforms
    .filter((entry) => entry.scraplingEligible && entry.failureCount > 0)
    .map((entry) => entry.platform)

  return {
    sourceCount: entries.length,
    successCount: entries.filter((entry) => entry.success).length,
    failureCount: entries.filter((entry) => !entry.success).length,
    p50DurationMs: quantile(durations, 0.5),
    p95DurationMs: quantile(durations, 0.95),
    scraplingCandidatePlatforms,
    platforms,
  }
}
