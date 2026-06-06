import { createHash } from 'crypto'

import type {
  BrowserCapabilityTaskHandle,
  BrowserStructuredItem,
} from './capability-types'

export interface BrowserCollectionTarget {
  /** Back-compat alias for canonicalUrl. */
  url: string
  canonicalUrl: string
  openUrl: string
  stableHref: string
  title?: string
  sourceId: string
  titleConfidence: 'none' | 'low' | 'medium' | 'high'
  order: number
  kind: 'content' | 'video'
  excludedReason?: string
  confidence: number
}

const NAVIGATION_WORDS = new Set([
  'about',
  'account',
  'category',
  'discover',
  'explore',
  'feed',
  'help',
  'home',
  'index',
  'login',
  'me',
  'message',
  'messages',
  'notification',
  'notifications',
  'profile',
  'register',
  'search',
  'settings',
  'signup',
  'tag',
  'tags',
  'topic',
  'topics',
  'user',
  'users',
])

const ASSET_PATH_RE = /\.(?:avif|gif|jpe?g|png|svg|webp|css|js|json|xml|pdf|zip)$/i
const TRACKING_PARAM_RE = /^(?:utm_|spm$|fbclid$|gclid$|yclid$|from$|source$|ref$|share$|share_id$|shareid$)/i
const ID_PARAM_RE = /^(?:id|item|item_id|post|post_id|note|note_id|article|article_id|slug)$/i

function normalizeSpace(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function stableHash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 10)
}

function sanitizeSourceId(value: string): string {
  return value
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

function meaningfulTitle(item: BrowserStructuredItem): string {
  const title = normalizeSpace(item.title)
  if (title) return title
  const rawTitle = item.rawFields && typeof item.rawFields === 'object'
    ? normalizeSpace((item.rawFields as Record<string, unknown>).title)
    : ''
  if (rawTitle) return rawTitle
  return normalizeSpace(item.summary).slice(0, 80)
}

function sourceUrlForItem(item: BrowserStructuredItem): string | undefined {
  const source = normalizeSpace(item.sourceUrl)
  return source || undefined
}

function parseTargetUrl(item: BrowserStructuredItem): URL | null {
  const raw = normalizeSpace(item.link)
  if (!raw) return null
  try {
    if (/^https?:\/\//i.test(raw)) return new URL(raw)
    const source = sourceUrlForItem(item)
    return source ? new URL(raw, source) : null
  } catch {
    return null
  }
}

function pathSegments(url: URL): string[] {
  return url.pathname.split('/').map((part) => part.trim()).filter(Boolean)
}

function hasStableQueryId(url: URL): boolean {
  for (const [key, value] of url.searchParams.entries()) {
    if (ID_PARAM_RE.test(key) && normalizeSpace(value).length >= 3) return true
  }
  return false
}

function canonicalTargetUrl(url: URL): string {
  const copy = new URL(url.toString())
  copy.hash = ''
  for (const key of Array.from(copy.searchParams.keys())) {
    if (TRACKING_PARAM_RE.test(key)) copy.searchParams.delete(key)
  }
  copy.pathname = copy.pathname.replace(/\/+$/g, '') || '/'
  return copy.toString()
}

function openTargetUrl(url: URL): string {
  const copy = new URL(url.toString())
  copy.hash = ''
  copy.pathname = copy.pathname.replace(/\/+$/g, '') || '/'
  return copy.toString()
}

function canonicalIdentity(url: URL): string {
  const copy = new URL(canonicalTargetUrl(url))
  for (const key of Array.from(copy.searchParams.keys())) {
    if (!ID_PARAM_RE.test(key)) copy.searchParams.delete(key)
  }
  return `${copy.origin}${copy.pathname}${copy.search ? `?${copy.searchParams.toString()}` : ''}`
}

function looksLikeContentTarget(url: URL, item: BrowserStructuredItem): boolean {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (ASSET_PATH_RE.test(url.pathname)) return false

  const segments = pathSegments(url)
  if (segments.length === 0) return false

  try {
    const source = sourceUrlForItem(item)
    if (source) {
      const sourceUrl = new URL(source)
      if (sourceUrl.origin !== url.origin) return false
      const sourcePath = sourceUrl.pathname.replace(/\/+$/g, '') || '/'
      const targetPath = url.pathname.replace(/\/+$/g, '') || '/'
      if (sourceUrl.origin === url.origin && sourcePath === targetPath && !hasStableQueryId(url)) return false
    }
  } catch {
    // Ignore malformed source URLs; the candidate URL has already been parsed.
  }

  const last = segments[segments.length - 1] || ''
  const title = meaningfulTitle(item)
  const hasUsefulTitle = title.length >= 2 && !NAVIGATION_WORDS.has(title.toLowerCase())
  const hasMedia = Array.isArray(item.media) && item.media.length > 0
  const hasStablePathSegment = /[A-Za-z0-9]/.test(last) && last.length >= 4
  const shallowNavigation = segments.length === 1 && NAVIGATION_WORDS.has(last.toLowerCase()) && !hasStableQueryId(url)

  if (shallowNavigation) return false
  return hasStableQueryId(url) || segments.length >= 2 || hasStablePathSegment || hasUsefulTitle || hasMedia
}

export function sourceIdFromUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const segments = pathSegments(parsed)
    const last = segments[segments.length - 1] || ''
    const candidate = sanitizeSourceId(last)
    if (candidate.length >= 1) return candidate
    for (const [key, value] of parsed.searchParams.entries()) {
      if (ID_PARAM_RE.test(key)) {
        const id = sanitizeSourceId(value)
        if (id.length >= 3) return id
      }
    }
  } catch {
    // fall back to a hash below
  }
  return stableHash(url)
}

function titleConfidenceFor(title: string, explicit?: unknown): BrowserCollectionTarget['titleConfidence'] {
  const value = String(explicit || '').trim()
  if (value === 'none' || value === 'low' || value === 'medium' || value === 'high') return value
  if (!title) return 'none'
  return title.length >= 6 ? 'high' : 'medium'
}

function numericOr(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function targetKindFrom(rawKind: unknown, url: string, title: string): BrowserCollectionTarget['kind'] {
  const explicit = String(rawKind || '').trim()
  if (explicit === 'video') return 'video'
  const haystack = `${url} ${title}`.toLowerCase()
  return /(?:\/video\/|video|短视频|视频)/i.test(haystack) ? 'video' : 'content'
}

export function normalizeCollectionTargets(rawTargets: Array<{
  url?: unknown
  canonicalUrl?: unknown
  openUrl?: unknown
  title?: unknown
  sourceId?: unknown
  titleConfidence?: unknown
  order?: unknown
  kind?: unknown
  confidence?: unknown
}>): BrowserCollectionTarget[] {
  const seen = new Set<string>()
  const targets: BrowserCollectionTarget[] = []
  for (let index = 0; index < rawTargets.length; index += 1) {
    const raw = rawTargets[index]
    const rawCanonicalUrl = normalizeSpace(raw.canonicalUrl || raw.url)
    const rawOpenUrl = normalizeSpace(raw.openUrl || raw.url || raw.canonicalUrl)
    if (!rawCanonicalUrl && !rawOpenUrl) continue
    let parsedCanonical: URL
    let parsedOpen: URL
    try {
      parsedCanonical = new URL(rawCanonicalUrl || rawOpenUrl)
      parsedOpen = new URL(rawOpenUrl || rawCanonicalUrl)
    } catch {
      continue
    }
    if (parsedCanonical.protocol !== 'http:' && parsedCanonical.protocol !== 'https:') continue
    if (parsedOpen.protocol !== 'http:' && parsedOpen.protocol !== 'https:') continue
    const canonicalUrl = canonicalTargetUrl(parsedCanonical)
    const openUrl = openTargetUrl(parsedOpen)
    const identity = canonicalIdentity(parsedCanonical)
    if (seen.has(identity)) continue
    seen.add(identity)
    const title = normalizeSpace(raw.title)
    const sourceId = sanitizeSourceId(normalizeSpace(raw.sourceId)) || sourceIdFromUrl(canonicalUrl)
    const target: BrowserCollectionTarget = {
      url: canonicalUrl,
      canonicalUrl,
      openUrl,
      stableHref: openUrl,
      sourceId,
      titleConfidence: titleConfidenceFor(title, raw.titleConfidence),
      order: Math.max(1, Math.trunc(numericOr(raw.order, index + 1))),
      kind: targetKindFrom(raw.kind, canonicalUrl, title),
      confidence: Math.max(0, Math.min(1, numericOr(raw.confidence, 0.72))),
    }
    if (title) target.title = title
    targets.push(target)
  }
  return targets
}

export function deriveCollectionTargets(items: BrowserStructuredItem[]): BrowserCollectionTarget[] {
  const candidates: Array<{ url: string; canonicalUrl: string; openUrl: string; stableHref: string; title?: string; sourceId: string; order: number; titleConfidence: BrowserCollectionTarget['titleConfidence']; kind: BrowserCollectionTarget['kind']; confidence: number }> = []
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    const parsed = parseTargetUrl(item)
    if (!parsed || !looksLikeContentTarget(parsed, item)) continue
    const title = meaningfulTitle(item)
    const canonicalUrl = canonicalTargetUrl(parsed)
    const openUrl = openTargetUrl(parsed)
    const sourceId = sourceIdFromUrl(canonicalUrl)
    candidates.push({
      url: canonicalUrl,
      canonicalUrl,
      openUrl,
      stableHref: openUrl,
      sourceId,
      order: index + 1,
      titleConfidence: titleConfidenceFor(title),
      kind: targetKindFrom((item.rawFields as Record<string, unknown> | undefined)?.kind, canonicalUrl, title),
      confidence: title || (Array.isArray(item.media) && item.media.length > 0) ? 0.82 : 0.62,
      ...(title ? { title } : {}),
    })
  }
  return normalizeCollectionTargets(candidates)
}

function resultObject(task: BrowserCapabilityTaskHandle): Record<string, unknown> | null {
  return task.result && typeof task.result === 'object' ? task.result as Record<string, unknown> : null
}

export function targetsFromTask(task: BrowserCapabilityTaskHandle | null): BrowserCollectionTarget[] {
  if (!task) return []
  const result = resultObject(task)
  const direct = Array.isArray(result?.noteCandidates)
    ? normalizeCollectionTargets(result.noteCandidates as Array<{ url?: unknown; title?: unknown; sourceId?: unknown }>)
    : []
  if (direct.length > 0) return direct

  const resultItems = Array.isArray(result?.items) ? result.items as BrowserStructuredItem[] : []
  const fromResultItems = deriveCollectionTargets(resultItems)
  if (fromResultItems.length > 0) return fromResultItems

  const checkpointItems = task.checkpoint && Array.isArray(task.checkpoint.partialResults)
    ? task.checkpoint.partialResults as BrowserStructuredItem[]
    : []
  return deriveCollectionTargets(checkpointItems)
}
