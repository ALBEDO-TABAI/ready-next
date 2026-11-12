/**
 * P3 Phase B1（2026-07-03，纯移动拆分）— browser-tools 媒体下载簇。
 *
 * 从 browser-tools.ts 拆出的文件名推断、安全落盘、媒体 URL 判定和
 * 下载执行。输入 URL 只做精确去重，不按站点猜测或合成新 URL。
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
import type { BrowserMutationBoundary } from './browser-action-executor'

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
  options: { trustedRoots?: readonly string[] } = {},
): { ok: true; directory: string; authority: 'ready_default' | 'task_resource' } | {
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
  return { ok: false, errorCode: 'download_directory_not_authorized', requested: raw }
}

export function resolveAuthorizedBrowserOutputPath(
  requested: unknown,
  options: { trustedRoots?: readonly string[] } = {},
): { ok: true; path: string; authority: 'ready_default' | 'task_resource' } | {
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
    const filename = index === 0 ? safeName : `${stem || 'download'} (${index + 1})${ext}`
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
    mutationBoundary: BrowserMutationBoundary
  },
): Promise<string | ToolExecutionOutput> {
  const rawUrls = params.urls
    .map((item) => String(item || '').trim())
    .filter((item) => item.length > 0)
  const targets = [...new Set(rawUrls)].slice(0, 100)
  if (targets.length === 0) return 'Error: urls is required and must be a non-empty array'

  return await params.mutationBoundary.invokeTransport(async () => {
  const tabId = params.tabId || null
  const directory = expandHomePath(params.directory || '~/Documents')
  const filenamePrefix = sanitizeFilename(String(params.filenamePrefix || '').trim(), '')

  await mkdir(directory, { recursive: true })
  try {
    await access(directory, fsConstants.W_OK)
  } catch {
    // silent-catch: 目录不可写以结构化错误文本返回给模型。
    params.mutationBoundary.recordMechanicalFact({ delivery: 'not_delivered' })
    return `Error: target directory is not writable: ${directory}`
  }

  let disk: Awaited<ReturnType<typeof statfs>>
  try {
    disk = await statfs(directory)
  } catch (error) {
    // silent-catch: capacity lookup failure is returned verbatim and prevents the download.
    params.mutationBoundary.recordMechanicalFact({ delivery: 'not_delivered' })
    return `Error: cannot read download disk capacity: ${error instanceof Error ? error.message : String(error)}`
  }
  const availableBytes = Math.max(0, Number(disk.bavail) * Number(disk.bsize))
  const reserveBytes = Math.min(512 * 1024 * 1024, Math.floor(availableBytes * 0.1))
  const diskBudget = Math.max(0, availableBytes - reserveBytes)
  const requestedBudget = Number.isFinite(params.maxTotalBytes) && Number(params.maxTotalBytes) > 0
    ? Number(params.maxTotalBytes)
    : diskBudget
  const taskByteBudget = Math.min(diskBudget, requestedBudget)
  if (taskByteBudget <= 0) {
    params.mutationBoundary.recordMechanicalFact({ delivery: 'not_delivered' })
    return 'Error: download_disk_budget_unavailable'
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
  let consumedBytes = 0
  for (let index = 0; index < targets.length; index += 1) {
    const url = targets[index]
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
        suggestedName: `${filenamePrefix || 'download'}-${index + 1}`,
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
    try {
      finalResult = await controller.downloadUrlToDirectory({
        url,
        targetDir: directory,
        tabId,
        sourcePageUrl: referer || null,
        suggestedName: filenamePrefix ? `${filenamePrefix}-${index + 1}` : null,
        fallbackName: `download-${index + 1}`,
        downloadHeaders: downloadHeadersForTarget(url),
        maxBytes: remainingBudget,
        signal: params.abortSignal,
      })
    } catch (error) {
      // silent-catch: the per-URL transport failure is retained in the structured result.
      finalResult = { success: false, error: error instanceof Error ? error.message : String(error) }
    }
    if (!finalResult?.success) {
      results.push({
        url,
        success: false,
        error: finalResult?.error || 'browser_session_download_failed',
        via: 'browser_session',
        url_chain: finalResult?.urlChain || [],
      })
      continue
    }
    consumedBytes += Number(finalResult.size || 0)
    results.push({
      url,
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
  params.mutationBoundary.recordMechanicalFact(successCount > 0
    ? { delivery: 'delivered', effect: 'download' }
    : { delivery: 'not_delivered' })
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
  })
  })
}
