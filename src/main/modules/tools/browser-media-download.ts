/**
 * P3 Phase B1（2026-07-03，纯移动拆分）— browser-tools 媒体下载簇。
 *
 * 从 browser-tools.ts 1511-1958 逐字搬出：文件名推断/安全落盘/pinimg
 * 归一与 originals 升级/媒体 URL 判定/下载执行（session 优先、fetch 兜底、
 * Referer/UA 头修正、Pinterest 变体回退）。行为零变更；browser-tools 保留
 * `pinimgOriginalsUrl`/`normalizeDownloadTargets` 门面再导出，外部消费者
 * 零改动。
 */
import { access, mkdir, writeFile } from 'fs/promises'
import { constants as fsConstants } from 'fs'
import { join, basename, extname } from 'path'
import { homedir } from 'os'
import type { BrowserController } from '../browser-engine/ipc-handler'
import type { BrowserResourceKind } from '../browser-engine/resource-sniffer'
import { broadcastDirectoryChanged } from '../document-engine/ipc/directory-change-broadcast'
import { createToolExecutionOutput, type ToolExecutionOutput } from '../agent-control/tools-runtime/tool-result-types'

export function expandHomePath(input: string): string {
  const raw = String(input || '').trim()
  if (!raw) return join(homedir(), 'Documents')
  if (raw === '~') return homedir()
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2))
  return raw
}

export function sanitizeFilename(input: string, fallback = 'download'): string {
  let sanitized = ''
  for (const char of String(input || '')) {
    const code = char.charCodeAt(0)
    sanitized += code <= 31 || '<>:"/\\|?*'.includes(char) ? '-' : char
  }
  const cleaned = sanitized
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
  if (!cleaned) return fallback
  return cleaned.slice(0, 120)
}

export function safeHostname(input: string): string | undefined {
  try {
    return new URL(input).hostname
  } catch {
    // silent-catch: malformed URL input simply has no hostname for filename hints.
    return undefined
  }
}

function extensionFromContentType(contentType: string): string {
  const type = String(contentType || '').toLowerCase().split(';')[0].trim()
  const table: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
    'image/avif': '.avif',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'application/pdf': '.pdf',
    'text/html': '.html',
    'text/plain': '.txt',
    'application/json': '.json',
  }
  return table[type] || ''
}

function inferFilenameParts(
  url: string,
  fallbackBase: string,
  contentType: string,
): { base: string; ext: string } {
  let pathnameBase = ''
  let pathnameExt = ''
  try {
    const parsed = new URL(url)
    pathnameBase = basename(parsed.pathname || '')
    pathnameExt = extname(pathnameBase || '')
  } catch {
    // silent-catch: URL 解析失败回退空 base/ext，由 content-type 推断兜底。
    pathnameBase = ''
    pathnameExt = ''
  }

  const contentExt = extensionFromContentType(contentType)
  const ext = pathnameExt || contentExt || '.bin'
  const rawBase = pathnameBase ? pathnameBase.slice(0, pathnameBase.length - pathnameExt.length) : fallbackBase
  const base = sanitizeFilename(rawBase || fallbackBase, fallbackBase)
  return { base, ext: ext.startsWith('.') ? ext : `.${ext}` }
}

async function writeFileSmart(
  directory: string,
  base: string,
  ext: string,
  data: Buffer,
  overwrite: boolean,
): Promise<string> {
  const safeBase = sanitizeFilename(base, 'download')
  const safeExt = ext.startsWith('.') ? ext : `.${ext}`
  const defaultPath = join(directory, `${safeBase}${safeExt}`)

  if (overwrite) {
    await writeFile(defaultPath, data)
    return defaultPath
  }

  for (let i = 0; i < 200; i += 1) {
    const candidate = i === 0 ? defaultPath : join(directory, `${safeBase}-${i}${safeExt}`)
    try {
      await writeFile(candidate, data, { flag: 'wx' })
      return candidate
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code === 'EEXIST') continue
      throw error
    }
  }

  throw new Error(`无法在目录中写入文件：${directory}`)
}

function mimeTypeFromDownloadedPath(path: string, contentType?: string | null): string | null {
  const normalizedContentType = String(contentType || '').split(';')[0].trim().toLowerCase()
  if (normalizedContentType) return normalizedContentType
  switch (extname(path).toLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    case '.mp4': return 'video/mp4'
    case '.mov': return 'video/quicktime'
    case '.pdf': return 'application/pdf'
    case '.md':
    case '.markdown': return 'text/markdown'
    case '.txt': return 'text/plain'
    default: return null
  }
}

function artifactKindForDownload(path: string, mimeType?: string | null): string {
  if (mimeType?.startsWith('image/')) return 'image'
  if (mimeType?.startsWith('video/')) return 'video'
  const ext = extname(path).toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) return 'image'
  if (['.mp4', '.mov'].includes(ext)) return 'video'
  return 'download'
}

function buildDownloadedArtifacts(results: Array<Record<string, unknown>>, directory: string): Array<{
  id: string
  module: string
  kind: string
  label: string
  path: string
  mimeType: string | null
  sourceRunId: null
  createdAt: string
  meta: Record<string, unknown>
}> {
  const createdAt = new Date().toISOString()
  return results
    .filter((item) => item.success === true && typeof item.path === 'string' && item.path.trim())
    .map((item, index) => {
      const path = String(item.path)
      const mimeType = mimeTypeFromDownloadedPath(path, String(item.content_type || ''))
      return {
        id: `browser-download:${Date.now()}:${index}`,
        module: 'browser',
        kind: artifactKindForDownload(path, mimeType),
        label: String(item.filename || basename(path)),
        path,
        mimeType,
        sourceRunId: null,
        createdAt,
        meta: {
          source: 'browser_download',
          directory,
          via: item.via || null,
          url: item.url || null,
        },
      }
    })
}

/** Pinterest serves the same pin at multiple resolutions via a leading PATH
 *  segment (/236x/, /474x/, /564x/, /736x/, /1200x/, /originals/). The grid
 *  lazy-loads thumbnails, so an ad-hoc collect→download mixes thumbnails with
 *  duplicates of the same pin. We collapse resolution variants by a
 *  size-independent fingerprint and prefer the /originals/ variant. */
const PINIMG_SIZE_SEGMENT = /^(originals|\d+x(\d+)?)$/i

function isPinimgHost(host: string): boolean {
  return /(^|\.)pinimg\.com$/i.test(host)
}

/** Size-independent identity of a pinimg image (host + path minus the leading
 *  size segment). null for non-pinimg or unexpected URL shapes. */
function pinimgFingerprint(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl)
    if (!isPinimgHost(url.hostname)) return null
    const segments = url.pathname.split('/').filter(Boolean)
    if (segments.length < 2 || !PINIMG_SIZE_SEGMENT.test(segments[0])) return null
    return `${url.hostname.toLowerCase()}/${segments.slice(1).join('/').toLowerCase()}`
  } catch {
    // silent-catch: malformed URL has no pinimg fingerprint; caller dedupes by raw string.
    return null
  }
}

/** Upgrade a pinimg thumbnail URL to its /originals/ variant; null when the URL
 *  is not an upgradeable pinimg URL. */
export function pinimgOriginalsUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl)
    if (!isPinimgHost(url.hostname)) return null
    const segments = url.pathname.split('/').filter(Boolean)
    if (segments.length < 2 || !PINIMG_SIZE_SEGMENT.test(segments[0])) return null
    if (segments[0].toLowerCase() === 'originals') return null
    segments[0] = 'originals'
    url.pathname = `/${segments.join('/')}`
    return url.toString()
  } catch {
    // silent-catch: malformed URL is simply not an upgradeable pinimg URL.
    return null
  }
}

export interface NormalizedDownloadTarget {
  /** Preferred URL to download (/originals/ variant for pinimg thumbnails). */
  url: string
  /** Pre-upgrade URL, retried only if the preferred one fails to fetch. */
  fallbackUrl: string | null
}

/** Dedupe a raw URL list; for Pinterest images upgrade to /originals/ and
 *  collapse resolution variants of the same pin. Non-pinimg URLs dedupe by
 *  exact string. First occurrence determines output order; the preferred URL is
 *  always the /originals/ variant and the fetch-fallback is a thumbnail variant
 *  if ANY non-originals variant of the same pin appears — regardless of order
 *  (so an `/originals/`-first list still has a 403/404 fallback). */
export function normalizeDownloadTargets(urls: string[]): NormalizedDownloadTarget[] {
  const order: string[] = []
  const byKey = new Map<string, NormalizedDownloadTarget>()
  for (const raw of urls) {
    const fingerprint = pinimgFingerprint(raw)
    const dedupeKey = fingerprint ?? raw
    const originals = pinimgOriginalsUrl(raw)
    const existing = byKey.get(dedupeKey)
    if (!existing) {
      order.push(dedupeKey)
      byKey.set(dedupeKey, originals
        ? { url: originals, fallbackUrl: raw }          // thumbnail → originals, keep thumbnail as fallback
        : { url: raw, fallbackUrl: null })              // originals (or non-pinimg) seen first
      continue
    }
    // Same pin seen again at a different size. Keep the originals as preferred;
    // if we don't yet have a thumbnail fallback, adopt this non-originals variant.
    if (!existing.fallbackUrl && originals && originals !== raw) {
      existing.fallbackUrl = raw
    }
  }
  return order.map((key) => byKey.get(key)!)
}

/** Count URLs that look like image-board CDN assets (Pinterest pinimg). A batch
 *  dominated by these is a board/gallery harvest that must go through the
 *  structured image_gallery collection, not raw manual download. */
export function imageBoardHarvestUrlCount(urls: string[]): number {
  let count = 0
  for (const raw of urls) {
    try {
      if (isPinimgHost(new URL(String(raw)).hostname)) count += 1
    } catch {
      // silent-catch: unparseable URL 不计入 image-board 统计。
      // ignore unparseable urls
    }
  }
  return count
}

function looksLikeMediaDownloadUrl(url: string): boolean {
  const lower = url.toLowerCase()
  if (/\.(mp4|webm|mov|m4v|mkv|ogv|mp3|m4a|aac|ogg|wav|m3u8)(?:[?#]|$)/.test(lower)) return true
  return lower.includes('mime_type=video')
    || lower.includes('/video/')
    || lower.includes('douyinvod.com')
    || lower.includes('v26-web.douyinvod.com')
}

function downloadHeadersForTarget(url: string): Record<string, string> | null {
  if (!looksLikeMediaDownloadUrl(url)) return null
  return {
    Accept: 'video/webm,video/ogg,video/*;q=0.9,audio/*;q=0.8,*/*;q=0.8',
  }
}

export function normalizeResourceKinds(value: unknown): BrowserResourceKind[] {
  const allowed = new Set<BrowserResourceKind>(['video', 'audio', 'image', 'document', 'json', 'stream', 'unknown'])
  if (!Array.isArray(value)) return []
  const kinds: BrowserResourceKind[] = []
  for (const item of value) {
    const kind = String(item || '').trim() as BrowserResourceKind
    if (allowed.has(kind) && !kinds.includes(kind)) kinds.push(kind)
  }
  return kinds
}

export async function downloadUrlsToDirectory(
  controller: BrowserController,
  params: {
    urls: string[]
    directory: string
    filenamePrefix?: string
    overwrite?: boolean
    tabId?: string | null
    referer?: string | null
  },
): Promise<string | ToolExecutionOutput> {
  const rawUrls = params.urls
    .map((item) => String(item || '').trim())
    .filter((item) => item.length > 0)
  // Pinterest dedupe/originals-upgrade BEFORE the 100 cap so the cap counts
  // distinct pins, not resolution variants of the same pin.
  const targets = normalizeDownloadTargets(rawUrls).slice(0, 100)
  if (targets.length === 0) return 'Error: urls is required and must be a non-empty array'

  const tabId = params.tabId || null
  const overwrite = params.overwrite === true
  const directory = expandHomePath(params.directory || '~/Documents')
  const filenamePrefix = sanitizeFilename(String(params.filenamePrefix || '').trim(), 'download')

  await mkdir(directory, { recursive: true })
  try {
    await access(directory, fsConstants.W_OK)
  } catch {
    // silent-catch: 目录不可写以结构化错误文本返回给模型。
    return `Error: target directory is not writable: ${directory}`
  }

  let referer = String(params.referer || '').trim()
  if (!referer) {
    try {
      referer = String(await controller.executeJS(tabId, 'window.location.href') || '')
    } catch {
      // silent-catch: 读不到当前页 URL 时以无 Referer 方式下载。
      referer = ''
    }
  }

  const results: Array<Record<string, unknown>> = []
  for (let index = 0; index < targets.length; index += 1) {
    const { url, fallbackUrl } = targets[index]
    if (!/^https?:\/\//i.test(url)) {
      results.push({ url, success: false, error: 'unsupported_protocol' })
      continue
    }

    let downloadedViaSession = false
    if (typeof controller.downloadUrlToDirectory === 'function') {
      try {
        const sessionResult = await controller.downloadUrlToDirectory({
          url,
          targetDir: directory,
          sourcePageUrl: referer || null,
          suggestedName: filenamePrefix ? `${filenamePrefix}-${index + 1}` : null,
          downloadHeaders: downloadHeadersForTarget(url),
        })
        if (sessionResult.success) {
          downloadedViaSession = true
          results.push({
            url,
            success: true,
            path: sessionResult.savePath,
            filename: sessionResult.filename,
            via: 'browser_session',
          })
        }
      } catch {
        // silent-catch: session download failed; fetch fallback records the final outcome.
      }
    }
    if (downloadedViaSession) continue

    try {
      // Prefer the (upgraded /originals/) url; if it 404s, retry the original
      // pre-upgrade variant so a missing original never drops the pin entirely.
      const fetchOnce = (target: string) => fetch(target, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Ready Browser Agent)',
          ...(downloadHeadersForTarget(target) || {}),
          ...(referer ? { Referer: referer } : {}),
        },
      })
      let fetchedUrl = url
      let response = await fetchOnce(url)
      if (!response.ok && fallbackUrl && fallbackUrl !== url) {
        const retry = await fetchOnce(fallbackUrl)
        if (retry.ok) {
          fetchedUrl = fallbackUrl
          response = retry
        }
      }
      if (!response.ok) {
        results.push({
          url: fetchedUrl,
          success: false,
          error: `http_${response.status}`,
          via: 'fetch',
        })
        continue
      }

      const contentType = response.headers.get('content-type') || ''
      const buffer = Buffer.from(await response.arrayBuffer())
      const fallbackBase = filenamePrefix
        ? `${filenamePrefix}-${index + 1}`
        : `download-${index + 1}`
      const parts = inferFilenameParts(fetchedUrl, fallbackBase, contentType)
      const filePath = await writeFileSmart(directory, parts.base, parts.ext, buffer, overwrite)
      results.push({
        url: fetchedUrl,
        success: true,
        path: filePath,
        size: buffer.byteLength,
        content_type: contentType,
        via: 'fetch',
      })
    } catch (error) {
      // silent-catch: 单条下载失败已记入 results，整体流程不中断。
      results.push({
        url,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        via: 'fetch',
      })
    }
  }

  const successCount = results.filter((item) => item.success === true).length
  // EP2 dogfood gap 4 — tool writes must surface in the file tree
  // immediately, even for directories the renderer never expanded.
  if (successCount > 0) {
    try {
      broadcastDirectoryChanged([directory])
    } catch {
      // silent-catch: 目录广播失败不破坏下载结果。
    }
  }
  const body = {
    directory,
    total: results.length,
    success: successCount,
    failed: results.length - successCount,
    results,
  }
  const artifacts = buildDownloadedArtifacts(results, directory)
  const text = JSON.stringify(body, null, 2)
  if (artifacts.length === 0) return text
  return createToolExecutionOutput(text, {
    shape: 'json',
    data: body,
    projectionPatch: { recentArtifacts: artifacts },
    contextModifier: {
      activeFrame: {
        discoveredHandles: artifacts.map((artifact) => ({
          ...artifact,
          type: 'recent_artifact',
        })),
      },
    },
  })
}
