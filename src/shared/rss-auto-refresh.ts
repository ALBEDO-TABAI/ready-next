export const RSS_AUTO_REFRESH_INTERVAL_KEY = 'rss:auto_refresh_interval_ms'

export const RSS_LAST_FETCH_ALL_COMPLETED_AT_KEY = 'rss:last_fetch_all_completed_at'

export const DEFAULT_RSS_AUTO_REFRESH_INTERVAL_MS = 15 * 60 * 1000

export const RSS_SUPPORTED_AUTO_REFRESH_INTERVALS_MS = [
  0,
  15 * 60 * 1000,
  30 * 60 * 1000,
  60 * 60 * 1000,
  3 * 60 * 60 * 1000,
  6 * 60 * 60 * 1000,
  12 * 60 * 60 * 1000,
] as const

export function parseRSSAutoRefreshInterval(value: string | null | undefined): number {
  if (!value) return DEFAULT_RSS_AUTO_REFRESH_INTERVAL_MS
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_RSS_AUTO_REFRESH_INTERVAL_MS
  return RSS_SUPPORTED_AUTO_REFRESH_INTERVALS_MS.includes(
    parsed as (typeof RSS_SUPPORTED_AUTO_REFRESH_INTERVALS_MS)[number],
  )
    ? parsed
    : DEFAULT_RSS_AUTO_REFRESH_INTERVAL_MS
}

export interface RSSAutoRefreshSnapshot {
  running: boolean
  intervalMs: number
  nextRunAt: string | null
  completedAt: string | null
  success: boolean | null
  fetched: number
  message: string | null
  errors: string[]
}
