export type BrowserActionKind = 'navigate' | 'search'

export interface BrowserActionRecord {
  kind: BrowserActionKind
  value: string
  normalizedValue: string
  updatedAt: number
}

function normalizeWhitespace(value: string): string {
  return String(value || '').trim().replace(/\s+/g, ' ')
}

export function normalizeDomain(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

export function domainsLikelyMatch(left?: string | null, right?: string | null): boolean {
  const a = normalizeDomain(String(left || ''))
  const b = normalizeDomain(String(right || ''))
  if (!a || !b) return false
  if (a === b) return true
  return a.endsWith(`.${b}`) || b.endsWith(`.${a}`)
}

export function normalizeBrowserActionValue(kind: BrowserActionKind, value: string): string {
  const normalized = normalizeWhitespace(value)
  if (!normalized) return ''
  if (kind === 'search') return normalized.toLowerCase()
  try {
    const parsed = new URL(normalized)
    return parsed.href
  } catch {
    return normalized
  }
}

function pruneRecentBrowserActions(records: BrowserActionRecord[], limit: number): BrowserActionRecord[] {
  return records
    .slice()
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, limit)
}

export function rememberRecentBrowserAction(
  records: BrowserActionRecord[],
  kind: BrowserActionKind,
  value: string,
  options?: {
    updatedAt?: number
    limit?: number
  },
): BrowserActionRecord[] {
  const normalizedValue = normalizeBrowserActionValue(kind, value)
  if (!normalizedValue) return pruneRecentBrowserActions(records, options?.limit || 8)
  return pruneRecentBrowserActions(
    [
      {
        kind,
        value: normalizeWhitespace(value),
        normalizedValue,
        updatedAt: Number(options?.updatedAt || Date.now()),
      },
      ...records.filter((item) => !(item.kind === kind && item.normalizedValue === normalizedValue)),
    ],
    options?.limit || 8,
  )
}

export function findRecentBrowserActionInRecords(
  records: BrowserActionRecord[],
  kind: BrowserActionKind,
  value: string,
  withinMs = 45_000,
  now = Date.now(),
): BrowserActionRecord | null {
  const normalizedValue = normalizeBrowserActionValue(kind, value)
  if (!normalizedValue) return null
  return records.find((item) =>
    item.kind === kind
      && item.normalizedValue === normalizedValue
      && now - item.updatedAt <= withinMs) || null
}
