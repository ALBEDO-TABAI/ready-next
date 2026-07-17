import type { DownloadItem, Session } from 'electron'
import { closeSync, createReadStream, existsSync, openSync, statSync } from 'fs'
import { rename, stat, unlink } from 'fs/promises'
import { createHash } from 'crypto'
import { basename, extname, isAbsolute, join } from 'path'
import { isIP } from 'net'
import { BrowserDataService } from './data-service'

interface BrowserDownloadServiceDeps {
  dataService: BrowserDataService
  sendToRenderer: (channel: string, data: unknown) => void
}

export interface BrowserDownloadUrlToDirectoryPayload {
  url: string
  targetDir: string
  tabId?: string | null
  sourcePageUrl?: string | null
  suggestedName?: string | null
  downloadHeaders?: Record<string, string> | null
  maxBytes?: number | null
  signal?: AbortSignal
}

export interface BrowserDownloadUrlToDirectoryResult {
  success: boolean
  savePath?: string
  filename?: string
  size?: number
  sha256?: string
  mimeType?: string | null
  urlChain?: string[]
  error?: string
}

interface PendingTargetedDownload {
  requestedUrl: string
  targetDir: string
  suggestedName?: string | null
  maxBytes?: number | null
  budgetError?: string | null
  signal?: AbortSignal
  abortListener?: (() => void) | null
  item?: DownloadItem | null
  cleanupOnAbort?: (() => Promise<void>) | null
  aborted: boolean
  settled: boolean
  resolve: (result: BrowserDownloadUrlToDirectoryResult) => void
  timer: ReturnType<typeof setTimeout>
}

const TARGETED_DOWNLOAD_START_TIMEOUT_MS = 30_000
const DOWNLOAD_HEADER_MAX_LENGTH: Record<string, number> = {
  Referer: 2_048,
  'User-Agent': 512,
  'Accept-Language': 256,
  Accept: 512,
}
const DOWNLOAD_HEADER_NAME_MAP = new Map<string, keyof typeof DOWNLOAD_HEADER_MAX_LENGTH>([
  ['referer', 'Referer'],
  ['referrer', 'Referer'],
  ['user-agent', 'User-Agent'],
  ['accept-language', 'Accept-Language'],
  ['accept', 'Accept'],
])

// C0 control-character range (U+0000-U+001F) plus the cross-platform reserved
// filename chars. Built via String.fromCharCode so the regex source contains
// no literal control bytes (satisfies eslint `no-control-regex`).
const FILENAME_UNSAFE_PATTERN = new RegExp(
  '[\\\\/:*?"<>|' + String.fromCharCode(0x00) + '-' + String.fromCharCode(0x1f) + ']',
  'g',
)

function sanitizeFilename(input: string, fallback = 'download'): string {
  const trimmed = input.trim()
  const safe = trimmed
    .replace(FILENAME_UNSAFE_PATTERN, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+$/, '')
    .replace(/^\.+/, '')
    .slice(0, 180)
    .trim()
  return safe || fallback
}

function filenameFromUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const name = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '')
    return sanitizeFilename(name || 'download')
  } catch {
    return 'download'
  }
}

function safeHeaderValue(value: unknown, maxLength: number): string | null {
  const text = String(value || '').trim()
  if (!text || text.length > maxLength) return null
  if (/[\r\n]/.test(text)) return null
  return text
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function isPrivateIpv4(host: string): boolean {
  const octets = host.split('.').map(Number)
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = octets
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
}

export function isBrowserLocalNetworkUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (!host) return false
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
    const ipVersion = isIP(host)
    if (ipVersion === 4) return isPrivateIpv4(host)
    if (ipVersion === 6) {
      return host === '::1'
        || host === '::'
        || /^f[cd]/i.test(host)
        || /^fe[89ab]/i.test(host)
    }
    return false
  } catch {
    return false
  }
}

export function rejectsPublicToLocalDownloadRedirect(requestedUrl: string, urlChain: readonly string[]): boolean {
  if (isBrowserLocalNetworkUrl(requestedUrl)) return false
  return urlChain.some((url) => isBrowserLocalNetworkUrl(url))
}

async function sha256File(path: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function buildDownloadHeaders(payload: BrowserDownloadUrlToDirectoryPayload): Record<string, string> {
  const headers: Record<string, string> = {}
  const input = payload.downloadHeaders && typeof payload.downloadHeaders === 'object'
    ? payload.downloadHeaders
    : {}
  for (const [rawName, rawValue] of Object.entries(input)) {
    const name = DOWNLOAD_HEADER_NAME_MAP.get(rawName.trim().toLowerCase())
    if (!name) continue
    const value = safeHeaderValue(rawValue, DOWNLOAD_HEADER_MAX_LENGTH[name])
    if (!value) continue
    if (name === 'Referer' && !isHttpUrl(value)) continue
    headers[name] = value
  }

  if (!headers.Referer) {
    const referrer = safeHeaderValue(payload.sourcePageUrl, DOWNLOAD_HEADER_MAX_LENGTH.Referer)
    if (referrer && isHttpUrl(referrer)) {
      headers.Referer = referrer
    }
  }

  return headers
}

function extensionFromMimeType(mimeType: string | null | undefined): string {
  const normalized = (String(mimeType || '').toLowerCase().split(';')[0] || '').trim()
  const table: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/avif': '.avif',
    'image/svg+xml': '.svg',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/ogg': '.ogv',
    'video/quicktime': '.mov',
    'video/x-matroska': '.mkv',
    'application/vnd.apple.mpegurl': '.m3u8',
    'application/x-mpegurl': '.m3u8',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'audio/aac': '.aac',
    'audio/webm': '.webm',
    'audio/ogg': '.ogg',
    'audio/wav': '.wav',
    'application/pdf': '.pdf',
  }
  return table[normalized] || ''
}

function withInferredExtension(requestedName: string, fallbackName: string, mimeType: string | null | undefined): string {
  if (extname(requestedName)) return requestedName
  const fallbackExt = extname(fallbackName)
  const inferredExt = fallbackExt || extensionFromMimeType(mimeType)
  return inferredExt ? `${requestedName}${inferredExt}` : requestedName
}

function uniquePathForDownload(targetDir: string, requestedName: string): string {
  const safeName = sanitizeFilename(basename(requestedName), 'download')
  const ext = extname(safeName)
  const base = ext ? safeName.slice(0, -ext.length) : safeName
  let candidate = join(targetDir, safeName)
  let index = 1
  while (existsSync(candidate)) {
    candidate = join(targetDir, `${base || 'download'} (${index})${ext}`)
    index += 1
  }
  return candidate
}

function reserveUniquePathForDownload(targetDir: string, requestedName: string): string {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const candidate = uniquePathForDownload(targetDir, requestedName)
    try {
      closeSync(openSync(candidate, 'wx'))
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
  }
  throw new Error('download_destination_exhausted')
}

export class BrowserDownloadService {
  private registeredSessions = new WeakSet<Session>()
  private pendingTargetedDownloads = new Map<string, PendingTargetedDownload[]>()
  private timedOutTargetedDownloads = new Map<string, number>()

  constructor(private readonly deps: BrowserDownloadServiceDeps) {}

  async downloadUrlToDirectory(
    targetSession: Session,
    payload: BrowserDownloadUrlToDirectoryPayload,
  ): Promise<BrowserDownloadUrlToDirectoryResult> {
    const url = String(payload.url || '').trim()
    const targetDir = String(payload.targetDir || '').trim()
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return { success: false, error: '下载地址无效' }
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { success: false, error: '暂不支持这个网页资源类型' }
    }
    try {
      if (!targetDir || !isAbsolute(targetDir) || !statSync(targetDir).isDirectory()) {
        return { success: false, error: '目标目录不可用' }
      }
    } catch {
      return { success: false, error: '目标目录不可用' }
    }

    if (payload.signal?.aborted) return { success: false, error: 'download_aborted' }

    this.ensureRegistered(targetSession)
    return await new Promise((resolve) => {
      const pending: PendingTargetedDownload = {
        requestedUrl: url,
        targetDir,
        suggestedName: payload.suggestedName,
        maxBytes: Number.isFinite(payload.maxBytes) && Number(payload.maxBytes) > 0 ? Number(payload.maxBytes) : null,
        budgetError: null,
        signal: payload.signal,
        abortListener: null,
        item: null,
        cleanupOnAbort: null,
        aborted: false,
        settled: false,
        resolve,
        timer: setTimeout(() => {
          this.removePendingTargetedDownload(url, pending)
          this.timedOutTargetedDownloads.set(url, Date.now() + 60_000)
          this.resolvePendingTargetedDownload(pending, { success: false, error: '下载没有开始' })
        }, TARGETED_DOWNLOAD_START_TIMEOUT_MS),
      }
      const abort = () => {
        if (pending.settled) return
        pending.aborted = true
        if (!pending.item) {
          this.removePendingTargetedDownload(url, pending)
          this.timedOutTargetedDownloads.set(url, Date.now() + 60_000)
          this.resolvePendingTargetedDownload(pending, { success: false, error: 'download_aborted' })
          return
        }
        pending.item.cancel()
        void (async () => {
          await pending.cleanupOnAbort?.().catch(() => undefined)
          this.resolvePendingTargetedDownload(pending, { success: false, error: 'download_aborted' })
        })()
      }
      pending.abortListener = abort
      pending.signal?.addEventListener('abort', abort, { once: true })
      const queue = this.pendingTargetedDownloads.get(url) ?? []
      queue.push(pending)
      this.pendingTargetedDownloads.set(url, queue)
      const headers = buildDownloadHeaders(payload)
      try {
        targetSession.downloadURL(url, Object.keys(headers).length > 0 ? { headers } : undefined)
      } catch (error) {
        clearTimeout(pending.timer)
        this.removePendingTargetedDownload(url, pending)
        this.resolvePendingTargetedDownload(pending, { success: false, error: error instanceof Error ? error.message : String(error) })
      }
    })
  }

  private resolvePendingTargetedDownload(
    pending: PendingTargetedDownload,
    result: BrowserDownloadUrlToDirectoryResult,
  ): void {
    if (pending.settled) return
    pending.settled = true
    clearTimeout(pending.timer)
    if (pending.abortListener) pending.signal?.removeEventListener('abort', pending.abortListener)
    pending.resolve(result)
  }

  private removePendingTargetedDownload(url: string, pending: PendingTargetedDownload): void {
    const queue = this.pendingTargetedDownloads.get(url)
    if (!queue) return
    const nextQueue = queue.filter((item) => item !== pending)
    if (nextQueue.length === 0) {
      this.pendingTargetedDownloads.delete(url)
    } else {
      this.pendingTargetedDownloads.set(url, nextQueue)
    }
  }

  private takePendingTargetedDownload(itemUrl: string, urlChain: string[]): PendingTargetedDownload | null {
    const candidates = [itemUrl, ...urlChain]
    for (const candidate of candidates) {
      const queue = this.pendingTargetedDownloads.get(candidate)
      if (!queue || queue.length === 0) continue
      const pending = queue.shift() ?? null
      if (queue.length === 0) {
        this.pendingTargetedDownloads.delete(candidate)
      }
      if (pending) {
        clearTimeout(pending.timer)
      }
      return pending
    }
    return null
  }

  private consumeTimedOutTarget(itemUrl: string, urlChain: string[]): boolean {
    const now = Date.now()
    for (const [url, expiresAt] of this.timedOutTargetedDownloads) {
      if (expiresAt <= now) this.timedOutTargetedDownloads.delete(url)
    }
    for (const candidate of [itemUrl, ...urlChain]) {
      if (!this.timedOutTargetedDownloads.has(candidate)) continue
      this.timedOutTargetedDownloads.delete(candidate)
      return true
    }
    return false
  }

  ensureRegistered(targetSession: Session): void {
    if (this.registeredSessions.has(targetSession)) return

    targetSession.on('will-download', (_event, item) => {
      const downloadId = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const urlChain = item.getURLChain()
      const pendingTarget = this.takePendingTargetedDownload(item.getURL(), urlChain)
      if (!pendingTarget && this.consumeTimedOutTarget(item.getURL(), urlChain)) {
        item.cancel()
        return
      }
      let savePath = item.getSavePath() || ''
      let filename = item.getFilename()
      const mimeType = typeof item.getMimeType === 'function' ? item.getMimeType() : null
      let finalPath = savePath
      let temporaryPath = savePath
      let reservedFinalPath = false
      if (pendingTarget) {
        pendingTarget.item = item
        try {
          if (rejectsPublicToLocalDownloadRedirect(pendingTarget.requestedUrl, urlChain)) {
            item.cancel()
            this.resolvePendingTargetedDownload(pendingTarget, {
              success: false,
              error: 'redirect_to_local_network_rejected',
              urlChain,
            })
            return
          }
          const declaredBytes = item.getTotalBytes()
          if (pendingTarget.maxBytes && declaredBytes > pendingTarget.maxBytes) {
            item.cancel()
            this.resolvePendingTargetedDownload(pendingTarget, {
              success: false,
              error: 'download_byte_budget_exceeded',
              size: declaredBytes,
              urlChain,
            })
            return
          }
          finalPath = reserveUniquePathForDownload(
            pendingTarget.targetDir,
            withInferredExtension(
              pendingTarget.suggestedName || filename || filenameFromUrl(pendingTarget.requestedUrl),
              filename || filenameFromUrl(pendingTarget.requestedUrl),
              mimeType,
            ),
          )
          reservedFinalPath = true
          temporaryPath = join(pendingTarget.targetDir, `.ready-${downloadId}.part`)
          pendingTarget.cleanupOnAbort = async () => {
            await unlink(temporaryPath).catch(() => undefined)
            await unlink(finalPath).catch(() => undefined)
          }
          item.setSavePath(temporaryPath)
          savePath = finalPath
          filename = basename(finalPath)
        } catch (error) {
          item.cancel()
          if (reservedFinalPath) void unlink(finalPath).catch(() => undefined)
          this.resolvePendingTargetedDownload(pendingTarget, { success: false, error: error instanceof Error ? error.message : String(error) })
          return
        }
      }
      const totalBytes = item.getTotalBytes()
      const startedAt = Math.floor(Date.now() / 1000)
      const canResume = typeof item.canResume === 'function' ? item.canResume() : false

      try {
        this.deps.dataService.addDownload({
          id: downloadId,
          url: item.getURL(),
          filename,
          save_path: savePath,
          total_bytes: totalBytes,
          received_bytes: 0,
          state: 'progressing',
          mime_type: mimeType,
          end_time: null,
          can_resume: canResume,
        })
      } catch {
        /* ignore */
      }

      item.on('updated', (_ev, state) => {
        if (state !== 'progressing') return
        const received = item.getReceivedBytes()
        if (pendingTarget?.maxBytes && received > pendingTarget.maxBytes) {
          pendingTarget.budgetError = 'download_byte_budget_exceeded'
          item.cancel()
          return
        }
        try { this.deps.dataService.updateDownloadProgress(downloadId, received) } catch { /* ignore */ }
        try {
          this.deps.dataService.updateDownloadState(downloadId, 'progressing', {
            savePath: item.getSavePath() || '',
            mimeType,
            canResume: typeof item.canResume === 'function' ? item.canResume() : canResume,
          })
        } catch {
          /* ignore */
        }
        this.deps.sendToRenderer('browser:downloadUpdate', {
          id: downloadId,
          filename,
          totalBytes,
          receivedBytes: received,
          state: 'progressing',
          savePath: item.getSavePath() || savePath,
        })
      })

      item.once('done', (_ev, state) => {
        const downloadedPath = item.getSavePath() || temporaryPath
        void (async () => {
        let completedSize = 0
        let completedSha256 = ''
        let terminalState = pendingTarget?.aborted ? 'cancelled' : state
        let terminalError: string | null = pendingTarget?.aborted
          ? 'download_aborted'
          : pendingTarget?.budgetError || (state === 'completed' ? null : state)
        if (state === 'completed' && pendingTarget && !pendingTarget.aborted) {
          try {
            const downloadedStat = await stat(downloadedPath)
            if (!downloadedStat.isFile() || downloadedStat.size <= 0) throw new Error('downloaded_file_empty')
            completedSize = downloadedStat.size
            completedSha256 = await sha256File(downloadedPath)
            if (pendingTarget.aborted) throw new Error('download_aborted')
            await rename(downloadedPath, finalPath)
          } catch (error) {
            terminalState = 'interrupted'
            terminalError = error instanceof Error ? error.message : String(error)
            await unlink(downloadedPath).catch(() => undefined)
            await unlink(finalPath).catch(() => undefined)
          }
        } else if (state !== 'completed' && pendingTarget) {
          await unlink(downloadedPath).catch(() => undefined)
          await unlink(finalPath).catch(() => undefined)
        }
        const recordedPath = pendingTarget ? finalPath : downloadedPath
        if (terminalState === 'completed') {
          try {
            this.deps.dataService.updateDownloadProgress(downloadId, item.getReceivedBytes())
            this.deps.dataService.updateDownloadState(downloadId, 'completed', {
              savePath: recordedPath,
              mimeType,
              endTime: Math.max(startedAt, Math.floor(Date.now() / 1000)),
              error: null,
              canResume: typeof item.canResume === 'function' ? item.canResume() : canResume,
            })
          } catch {
            /* ignore */
          }
        } else {
          try {
            this.deps.dataService.updateDownloadProgress(downloadId, item.getReceivedBytes())
            this.deps.dataService.updateDownloadState(downloadId, terminalState, {
              savePath: recordedPath,
              mimeType,
              endTime: Math.max(startedAt, Math.floor(Date.now() / 1000)),
              error: terminalError,
              canResume: typeof item.canResume === 'function' ? item.canResume() : canResume,
            })
          } catch {
            /* ignore */
          }
        }
        this.deps.sendToRenderer('browser:downloadUpdate', {
          id: downloadId,
          filename,
          totalBytes,
          receivedBytes: item.getReceivedBytes(),
          state: terminalState,
          savePath: recordedPath,
        })
        if (pendingTarget) {
          this.resolvePendingTargetedDownload(pendingTarget, {
            success: terminalState === 'completed',
            savePath: terminalState === 'completed' ? recordedPath : undefined,
            filename,
            size: terminalState === 'completed' ? completedSize : undefined,
            sha256: terminalState === 'completed' ? completedSha256 : undefined,
            mimeType,
            urlChain,
            error: terminalState === 'completed' ? undefined : (terminalError || terminalState),
          })
        }
        })()
      })
    })

    this.registeredSessions.add(targetSession)
  }
}
