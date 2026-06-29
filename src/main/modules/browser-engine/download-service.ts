import type { Session } from 'electron'
import { existsSync, statSync } from 'fs'
import { basename, extname, isAbsolute, join } from 'path'
import { BrowserDataService } from './data-service'

interface BrowserDownloadServiceDeps {
  dataService: BrowserDataService
  sendToRenderer: (channel: string, data: unknown) => void
}

export interface BrowserDownloadUrlToDirectoryPayload {
  url: string
  targetDir: string
  sourcePageUrl?: string | null
  suggestedName?: string | null
  downloadHeaders?: Record<string, string> | null
}

export interface BrowserDownloadUrlToDirectoryResult {
  success: boolean
  savePath?: string
  filename?: string
  error?: string
}

interface PendingTargetedDownload {
  requestedUrl: string
  targetDir: string
  suggestedName?: string | null
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

export class BrowserDownloadService {
  private registeredSessions = new WeakSet<Session>()
  private pendingTargetedDownloads = new Map<string, PendingTargetedDownload[]>()

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

    this.ensureRegistered(targetSession)
    return await new Promise((resolve) => {
      const pending: PendingTargetedDownload = {
        requestedUrl: url,
        targetDir,
        suggestedName: payload.suggestedName,
        resolve,
        timer: setTimeout(() => {
          this.removePendingTargetedDownload(url, pending)
          resolve({ success: false, error: '下载没有开始' })
        }, TARGETED_DOWNLOAD_START_TIMEOUT_MS),
      }
      const queue = this.pendingTargetedDownloads.get(url) ?? []
      queue.push(pending)
      this.pendingTargetedDownloads.set(url, queue)
      const headers = buildDownloadHeaders(payload)
      try {
        targetSession.downloadURL(url, Object.keys(headers).length > 0 ? { headers } : undefined)
      } catch (error) {
        clearTimeout(pending.timer)
        this.removePendingTargetedDownload(url, pending)
        resolve({ success: false, error: error instanceof Error ? error.message : String(error) })
      }
    })
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

  ensureRegistered(targetSession: Session): void {
    if (this.registeredSessions.has(targetSession)) return

    targetSession.on('will-download', (_event, item) => {
      const downloadId = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const pendingTarget = this.takePendingTargetedDownload(item.getURL(), item.getURLChain())
      let savePath = item.getSavePath() || ''
      let filename = item.getFilename()
      const mimeType = typeof item.getMimeType === 'function' ? item.getMimeType() : null
      if (pendingTarget) {
        try {
          savePath = uniquePathForDownload(
            pendingTarget.targetDir,
            withInferredExtension(
              pendingTarget.suggestedName || filename || filenameFromUrl(pendingTarget.requestedUrl),
              filename || filenameFromUrl(pendingTarget.requestedUrl),
              mimeType,
            ),
          )
          item.setSavePath(savePath)
          filename = basename(savePath)
        } catch (error) {
          item.cancel()
          pendingTarget.resolve({ success: false, error: error instanceof Error ? error.message : String(error) })
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
        const finalPath = item.getSavePath()
        if (state === 'completed') {
          try {
            this.deps.dataService.updateDownloadProgress(downloadId, item.getReceivedBytes())
            this.deps.dataService.updateDownloadState(downloadId, 'completed', {
              savePath: finalPath,
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
            this.deps.dataService.updateDownloadState(downloadId, state, {
              savePath: finalPath,
              mimeType,
              endTime: Math.max(startedAt, Math.floor(Date.now() / 1000)),
              error: state,
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
          state,
          savePath: finalPath,
        })
        if (pendingTarget) {
          pendingTarget.resolve({
            success: state === 'completed',
            savePath: state === 'completed' ? finalPath : undefined,
            filename,
            error: state === 'completed' ? undefined : state,
          })
        }
      })
    })

    this.registeredSessions.add(targetSession)
  }
}
