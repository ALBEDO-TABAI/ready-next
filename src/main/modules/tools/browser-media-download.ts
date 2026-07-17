/**
 * P3 Phase B1（2026-07-03，纯移动拆分）— browser-tools 媒体下载簇。
 *
 * 从 browser-tools.ts 1511-1958 逐字搬出：文件名推断/安全落盘/pinimg
 * 归一与 originals 升级/媒体 URL 判定/下载执行（session 优先、fetch 兜底、
 * Referer/UA 头修正、Pinterest 变体回退）。行为零变更；browser-tools 保留
 * `pinimgOriginalsUrl`/`normalizeDownloadTargets` 门面再导出，外部消费者
 * 零改动。
 */
import { access, mkdir, open, rename, statfs, unlink } from 'fs/promises'
import { constants as fsConstants, existsSync, realpathSync } from 'fs'
import { join, basename, dirname, extname, isAbsolute, relative, resolve } from 'path'
import { homedir } from 'os'
import { createHash, randomUUID } from 'crypto'
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

export const DEFAULT_BROWSER_DOWNLOAD_DIRECTORY = join(homedir(), 'Downloads', 'Ready')

function isWithin(root: string, target: string): boolean {
  const canonical = (input: string): string => {
    let cursor = resolve(input)
    const suffix: string[] = []
    while (!existsSync(cursor)) {
      const parent = dirname(cursor)
      if (parent === cursor) break
      suffix.unshift(basename(cursor))
      cursor = parent
    }
    try { cursor = realpathSync(cursor) } catch { /* silent-catch: nonexistent suffix uses the bounded lexical fallback below. */ }
    return resolve(cursor, ...suffix)
  }
  const child = relative(canonical(root), canonical(target))
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

function isDangerouslyBroadFilesystemRoot(value: string): boolean {
  const root = resolve(expandHomePath(value))
  return root === resolve('/') || root === resolve(homedir())
}

export function resolveAuthorizedBrowserDownloadDirectory(
  requested: unknown,
  options: { currentUserText?: string | null; trustedRoots?: readonly string[] } = {},
): { ok: true; directory: string; authority: 'ready_default' | 'user_instruction' | 'task_resource' } | {
  ok: false
  errorCode: 'download_directory_not_authorized'
  requested: string
} {
  const raw = String(requested || '').trim()
  if (!raw) return { ok: true, directory: DEFAULT_BROWSER_DOWNLOAD_DIRECTORY, authority: 'ready_default' }
  const directory = resolve(expandHomePath(raw))
  if (isWithin(DEFAULT_BROWSER_DOWNLOAD_DIRECTORY, directory)) {
    return { ok: true, directory, authority: 'ready_default' }
  }
  for (const trustedRoot of options.trustedRoots || []) {
    if (trustedRoot && !isDangerouslyBroadFilesystemRoot(trustedRoot) && isWithin(expandHomePath(trustedRoot), directory)) {
      return { ok: true, directory, authority: 'task_resource' }
    }
  }
  const userText = String(options.currentUserText || '')
  if (
    !isDangerouslyBroadFilesystemRoot(directory)
    && ((raw.length >= 4 && userText.includes(raw)) || (directory.length >= 4 && userText.includes(directory)))
  ) {
    return { ok: true, directory, authority: 'user_instruction' }
  }
  return { ok: false, errorCode: 'download_directory_not_authorized', requested: raw }
}

export function resolveAuthorizedBrowserOutputPath(
  requested: unknown,
  options: { currentUserText?: string | null; trustedRoots?: readonly string[] } = {},
): { ok: true; path: string; authority: 'ready_default' | 'user_instruction' | 'task_resource' } | {
  ok: false
  errorCode: 'output_path_not_authorized'
  requested: string
} {
  const raw = String(requested || '').trim()
  if (!raw) return { ok: false, errorCode: 'output_path_not_authorized', requested: raw }
  const path = resolve(expandHomePath(raw))
  const directory = dirname(path)
  const authorized = resolveAuthorizedBrowserDownloadDirectory(directory, options)
  if (!authorized.ok) return { ok: false, errorCode: 'output_path_not_authorized', requested: raw }
  return { ok: true, path, authority: authorized.authority }
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

function pageScopedDownloadProtocol(url: string): boolean {
  return /^(?:blob:|data:)/i.test(url)
}

async function reservePageDownloadPath(directory: string, requestedName: string): Promise<{
  finalPath: string
  temporaryPath: string
}> {
  const safeName = sanitizeFilename(basename(requestedName), 'download')
  const ext = extname(safeName)
  const stem = ext ? safeName.slice(0, -ext.length) : safeName
  for (let index = 0; index < 200; index += 1) {
    const filename = index === 0 ? safeName : `${stem || 'download'} (${index})${ext}`
    const finalPath = join(directory, filename)
    try {
      const reservation = await open(finalPath, 'wx')
      await reservation.close()
      return {
        finalPath,
        temporaryPath: join(directory, `.ready-${randomUUID()}.part`),
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
  }
  throw new Error('download_destination_exhausted')
}

export async function downloadPageScopedUrlToDirectory(
  controller: BrowserController,
  params: {
    url: string
    directory: string
    suggestedName: string
    tabId?: string | null
    maxBytes: number
    signal?: AbortSignal
  },
): Promise<{
  success: boolean
  savePath?: string
  filename?: string
  size?: number
  sha256?: string
  mimeType?: string | null
  urlChain?: string[]
  error?: string
}> {
  const tabId = params.tabId || null
  const streamKey = '__readyBrowserPageDownloadStreams'
  let streamId = ''
  let finalPath = ''
  let temporaryPath = ''
  let file: Awaited<ReturnType<typeof open>> | null = null
  try {
    const initialized = await controller.executeJS(tabId, `(async () => {
      const root = globalThis;
      const key = ${JSON.stringify(streamKey)};
      const store = root[key] instanceof Map ? root[key] : new Map();
      root[key] = store;
      const response = await fetch(${JSON.stringify(params.url)}, { credentials: 'include' });
      if (!response.ok && !/^(blob:|data:)/i.test(${JSON.stringify(params.url)})) {
        throw new Error('download_http_' + response.status);
      }
      if (!response.body) throw new Error('download_stream_unavailable');
      const id = 'ready-download-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      store.set(id, { reader: response.body.getReader() });
      return {
        id,
        contentType: response.headers.get('content-type') || '',
        contentLength: Number(response.headers.get('content-length') || 0) || 0,
      };
    })()`, { timeoutMs: 30_000, signal: params.signal }) as {
      id?: unknown
      contentType?: unknown
      contentLength?: unknown
    } | null
    streamId = String(initialized?.id || '')
    if (!streamId) throw new Error('download_stream_initialization_failed')
    const contentType = String(initialized?.contentType || '')
    const declaredBytes = Number(initialized?.contentLength || 0)
    if (declaredBytes > params.maxBytes) throw new Error('download_byte_budget_exceeded')
    const parts = inferFilenameParts(params.url, params.suggestedName, contentType)
    const reserved = await reservePageDownloadPath(params.directory, `${parts.base}${parts.ext}`)
    finalPath = reserved.finalPath
    temporaryPath = reserved.temporaryPath
    file = await open(temporaryPath, 'wx')
    const hash = createHash('sha256')
    let size = 0

    while (true) {
      if (params.signal?.aborted) throw params.signal.reason || new Error('download_aborted')
      const chunk = await controller.executeJS(tabId, `(async () => {
        const store = globalThis[${JSON.stringify(streamKey)}];
        const state = store instanceof Map ? store.get(${JSON.stringify(streamId)}) : null;
        if (!state) throw new Error('download_stream_expired');
        const next = await state.reader.read();
        if (next.done) {
          store.delete(${JSON.stringify(streamId)});
          return { done: true, chunk: '' };
        }
        const bytes = next.value;
        let binary = '';
        const stride = 0x8000;
        for (let offset = 0; offset < bytes.length; offset += stride) {
          binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + stride)));
        }
        return { done: false, chunk: btoa(binary) };
      })()`, { timeoutMs: 30_000, signal: params.signal }) as { done?: unknown; chunk?: unknown } | null
      if (chunk?.done === true) break
      const buffer = Buffer.from(String(chunk?.chunk || ''), 'base64')
      if (buffer.length === 0) continue
      size += buffer.length
      if (size > params.maxBytes) throw new Error('download_byte_budget_exceeded')
      hash.update(buffer)
      await file.write(buffer)
    }

    if (size <= 0) throw new Error('downloaded_file_empty')
    await file.sync()
    await file.close()
    file = null
    await rename(temporaryPath, finalPath)
    return {
      success: true,
      savePath: finalPath,
      filename: basename(finalPath),
      size,
      sha256: hash.digest('hex'),
      mimeType: contentType || null,
      urlChain: [params.url],
    }
  } catch (error) {
    // silent-catch: the original failure is returned to the caller after best-effort cleanup.
    await file?.close().catch(() => undefined)
    if (temporaryPath) await unlink(temporaryPath).catch(() => undefined)
    if (finalPath) await unlink(finalPath).catch(() => undefined)
    return { success: false, error: error instanceof Error ? error.message : String(error), urlChain: [params.url] }
  } finally {
    if (streamId) {
      await controller.executeJS(tabId, `(() => {
        const store = globalThis[${JSON.stringify(streamKey)}];
        const state = store instanceof Map ? store.get(${JSON.stringify(streamId)}) : null;
        if (state) { try { state.reader.cancel(); } catch {} store.delete(${JSON.stringify(streamId)}); }
      })()`, { timeoutMs: 2_000 }).catch(() => undefined)
    }
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
    maxTotalBytes?: number
    abortSignal?: AbortSignal
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
  const directory = expandHomePath(params.directory || '~/Documents')
  const filenamePrefix = sanitizeFilename(String(params.filenamePrefix || '').trim(), 'download')

  await mkdir(directory, { recursive: true })
  try {
    await access(directory, fsConstants.W_OK)
  } catch {
    // silent-catch: 目录不可写以结构化错误文本返回给模型。
    return `Error: target directory is not writable: ${directory}`
  }

  let disk: Awaited<ReturnType<typeof statfs>>
  try {
    disk = await statfs(directory)
  } catch (error) {
    // silent-catch: capacity lookup failure is returned verbatim and prevents the download.
    return `Error: cannot read download disk capacity: ${error instanceof Error ? error.message : String(error)}`
  }
  const availableBytes = Math.max(0, Number(disk.bavail) * Number(disk.bsize))
  const reserveBytes = Math.min(512 * 1024 * 1024, Math.floor(availableBytes * 0.1))
  const diskBudget = Math.max(0, availableBytes - reserveBytes)
  const requestedBudget = Number.isFinite(params.maxTotalBytes) && Number(params.maxTotalBytes) > 0
    ? Number(params.maxTotalBytes)
    : diskBudget
  const taskByteBudget = Math.min(diskBudget, requestedBudget)
  if (taskByteBudget <= 0) return 'Error: download_disk_budget_unavailable'

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
  let consumedBytes = 0
  for (let index = 0; index < targets.length; index += 1) {
    const { url, fallbackUrl } = targets[index]
    if (params.abortSignal?.aborted) {
      results.push({ url: url.slice(0, 2048), success: false, error: 'download_aborted' })
      break
    }
    if (!/^(?:https?:\/\/|blob:|data:)/i.test(url)) {
      results.push({ url, success: false, error: 'unsupported_protocol' })
      continue
    }

    const remainingBudget = Math.max(0, taskByteBudget - consumedBytes)
    if (remainingBudget <= 0) {
      results.push({ url: url.slice(0, 2048), success: false, error: 'download_byte_budget_exceeded' })
      break
    }
    if (pageScopedDownloadProtocol(url)) {
      const pageResult = await downloadPageScopedUrlToDirectory(controller, {
        url,
        directory,
        suggestedName: `${filenamePrefix}-${index + 1}`,
        tabId,
        maxBytes: remainingBudget,
        signal: params.abortSignal,
      })
      if (pageResult.success) consumedBytes += Number(pageResult.size || 0)
      results.push({
        url: url.slice(0, 2048),
        success: pageResult.success,
        path: pageResult.savePath,
        filename: pageResult.filename,
        size: pageResult.size,
        sha256: pageResult.sha256,
        content_type: pageResult.mimeType,
        url_chain: pageResult.urlChain || [],
        error: pageResult.error,
        via: 'browser_page_session',
      })
      continue
    }
    if (typeof controller.downloadUrlToDirectory !== 'function') {
      results.push({ url, success: false, error: 'browser_session_download_unavailable' })
      continue
    }
    let finalResult: Awaited<ReturnType<BrowserController['downloadUrlToDirectory']>> | null = null
    let downloadedUrl = url
    for (const candidate of [url, fallbackUrl].filter((value): value is string => Boolean(value))) {
      try {
        const sessionResult = await controller.downloadUrlToDirectory({
          url: candidate,
          targetDir: directory,
          tabId,
          sourcePageUrl: referer || null,
          suggestedName: filenamePrefix ? `${filenamePrefix}-${index + 1}` : null,
          downloadHeaders: downloadHeadersForTarget(candidate),
          maxBytes: remainingBudget,
          signal: params.abortSignal,
        })
        finalResult = sessionResult
        downloadedUrl = candidate
        if (sessionResult.success) break
      } catch (error) {
        // silent-catch: each session failure is retained in finalResult and returned for this URL.
        finalResult = { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
    if (!finalResult?.success) {
      results.push({
        url: downloadedUrl,
        success: false,
        error: finalResult?.error || 'browser_session_download_failed',
        via: 'browser_session',
        url_chain: finalResult?.urlChain || [],
      })
      continue
    }
    consumedBytes += Number(finalResult.size || 0)
    results.push({
      url: downloadedUrl,
      success: true,
      path: finalResult.savePath,
      filename: finalResult.filename,
      size: finalResult.size,
      sha256: finalResult.sha256,
      content_type: finalResult.mimeType,
      url_chain: finalResult.urlChain || [],
      via: 'browser_session',
    })
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
    byteBudget: taskByteBudget,
    bytesWritten: consumedBytes,
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
