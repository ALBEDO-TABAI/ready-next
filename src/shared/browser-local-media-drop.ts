import { filterBrowserLocalMediaUploadPaths } from './browser-local-media-upload'

export const READY_LOCAL_MEDIA_DROP_SCHEME = 'ready-local-media-drop:'

export interface BrowserLocalMediaDropRequest {
  paths: string[]
  urls?: string[]
  x?: number
  y?: number
}

function finiteNumber(value: unknown): number | undefined {
  const next = Number(value)
  return Number.isFinite(next) ? next : undefined
}

export function buildBrowserLocalMediaDropUrl(request: BrowserLocalMediaDropRequest): string {
  const payload = encodeURIComponent(JSON.stringify(request))
  return `${READY_LOCAL_MEDIA_DROP_SCHEME}//upload?payload=${payload}`
}

export function parseBrowserLocalMediaDropUrl(url: string): BrowserLocalMediaDropRequest | null {
  if (!url.startsWith(READY_LOCAL_MEDIA_DROP_SCHEME)) return null
  try {
    const parsedUrl = new URL(url)
    const rawPayload = parsedUrl.searchParams.get('payload')
    if (!rawPayload) return null
    const payload = JSON.parse(rawPayload) as Partial<BrowserLocalMediaDropRequest>
    const paths = filterBrowserLocalMediaUploadPaths(
      Array.isArray(payload.paths)
        ? payload.paths.map((path) => ({ path: String(path || '') }))
        : [],
    )
    const urls = Array.isArray(payload.urls)
      ? Array.from(new Set(payload.urls
        .map((value) => normalizeRemoteMediaUrl(value))
        .filter((value): value is string => Boolean(value))))
        .slice(0, 8)
      : []
    if (paths.length === 0 && urls.length === 0) return null
    const request: BrowserLocalMediaDropRequest = {
      paths,
      x: finiteNumber(payload.x),
      y: finiteNumber(payload.y),
    }
    if (urls.length > 0) request.urls = urls
    return request
  } catch {
    return null
  }
}

function normalizeRemoteMediaUrl(value: unknown): string | null {
  try {
    const parsed = new URL(String(value || '').trim())
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.href
  } catch {
    return null
  }
}
