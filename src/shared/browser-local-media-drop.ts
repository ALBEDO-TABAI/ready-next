import { filterBrowserLocalMediaUploadPaths } from './browser-local-media-upload'

export const READY_LOCAL_MEDIA_DROP_SCHEME = 'ready-local-media-drop:'

export interface BrowserLocalMediaDropRequest {
  paths: string[]
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
    if (paths.length === 0) return null
    return {
      paths,
      x: finiteNumber(payload.x),
      y: finiteNumber(payload.y),
    }
  } catch {
    return null
  }
}
