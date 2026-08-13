import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { tmpdir } from 'node:os'

import { BROWSER_LOCAL_MEDIA_UPLOAD_EXTENSIONS } from '../../../shared/browser-local-media-upload'

const REMOTE_MEDIA_DROP_DIR = join(tmpdir(), 'ready-remote-media-drop')
const REMOTE_MEDIA_DROP_MAX_BYTES = 30 * 1024 * 1024
const REMOTE_MEDIA_DROP_MAX_URLS = 8
const REMOTE_MEDIA_DROP_PRUNE_AGE_MS = 30 * 60 * 1000
const REMOTE_MEDIA_DROP_CLEANUP_DELAY_MS = 60 * 1000

export interface RemoteMediaDropDownloadResult {
  files: string[]
  failed: Array<{ url: string; error: string }>
}

interface RemoteMediaDropDeps {
  fetchImpl?: typeof fetch
  now?: () => number
}

const MIME_EXTENSIONS = new Map<string, string>([
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['image/bmp', 'bmp'],
  ['image/tiff', 'tiff'],
  ['video/mp4', 'mp4'],
  ['video/quicktime', 'mov'],
  ['video/webm', 'webm'],
])

function sanitizeFileName(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex -- normalize an untrusted remote filename before filesystem use
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 96) || 'remote-media'
}

function normalizeContentType(value: string | null): string {
  return String(value || '').split(';')[0].trim().toLowerCase()
}

function extFromUrl(url: URL): string {
  return extname(url.pathname).replace(/^\./, '').toLowerCase()
}

function isAcceptedExt(ext: string): boolean {
  return BROWSER_LOCAL_MEDIA_UPLOAD_EXTENSIONS.has(ext.toLowerCase())
}

function isAcceptedContentType(contentType: string): boolean {
  return contentType.startsWith('image/') || contentType.startsWith('video/')
}

function extForRemote(url: URL, contentType: string): string | null {
  const mimeExt = MIME_EXTENSIONS.get(contentType)
  if (mimeExt) return mimeExt
  const urlExt = extFromUrl(url)
  return isAcceptedExt(urlExt) ? urlExt : null
}

function fileNameForRemote(url: URL, contentType: string): string {
  const ext = extForRemote(url, contentType) || 'jpg'
  const urlName = sanitizeFileName(basename(url.pathname) || `remote-media.${ext}`)
  const base = extname(urlName) ? urlName.slice(0, -extname(urlName).length) : urlName
  return `${Date.now()}-${randomUUID()}-${base}.${ext}`
}

async function pruneRemoteMediaDropCache(now: number): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(REMOTE_MEDIA_DROP_DIR)
  } catch {
    return
  }
  await Promise.all(entries.map(async (entry) => {
    const path = join(REMOTE_MEDIA_DROP_DIR, entry)
    try {
      const info = await stat(path)
      if (now - info.mtimeMs > REMOTE_MEDIA_DROP_PRUNE_AGE_MS) await rm(path, { force: true })
    } catch {
      // Best-effort temp cache pruning.
    }
  }))
}

async function downloadOneRemoteMedia(url: string, deps: Required<RemoteMediaDropDeps>): Promise<string> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('只支持 HTTP 图片地址')

  const response = await deps.fetchImpl(parsed.href, { signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`下载失败：${response.status}`)

  const contentType = normalizeContentType(response.headers.get('content-type'))
  const urlExt = extFromUrl(parsed)
  const canTrustExtension = isAcceptedExt(urlExt) && (!contentType || contentType === 'application/octet-stream')
  if (!isAcceptedContentType(contentType) && !canTrustExtension) {
    throw new Error('远程资源不是图片或视频')
  }
  if (!extForRemote(parsed, contentType) && !canTrustExtension) {
    throw new Error('远程图片格式暂不支持')
  }

  const contentLength = Number(response.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > REMOTE_MEDIA_DROP_MAX_BYTES) {
    throw new Error('远程文件过大')
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > REMOTE_MEDIA_DROP_MAX_BYTES) throw new Error('远程文件过大')

  await mkdir(REMOTE_MEDIA_DROP_DIR, { recursive: true })
  const filePath = join(REMOTE_MEDIA_DROP_DIR, fileNameForRemote(parsed, contentType))
  await writeFile(filePath, buffer)
  return filePath
}

export async function downloadRemoteMediaDropUrls(
  urls: readonly string[],
  deps: RemoteMediaDropDeps = {},
): Promise<RemoteMediaDropDownloadResult> {
  const resolvedDeps: Required<RemoteMediaDropDeps> = {
    fetchImpl: deps.fetchImpl || fetch,
    now: deps.now || Date.now,
  }
  await pruneRemoteMediaDropCache(resolvedDeps.now()).catch(() => undefined)

  const uniqueUrls = Array.from(new Set(urls.map((url) => String(url || '').trim()).filter(Boolean)))
    .slice(0, REMOTE_MEDIA_DROP_MAX_URLS)
  const result: RemoteMediaDropDownloadResult = { files: [], failed: [] }
  for (const url of uniqueUrls) {
    try {
      result.files.push(await downloadOneRemoteMedia(url, resolvedDeps))
    } catch (error) {
      result.failed.push({ url, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}

export async function removeRemoteMediaDropFiles(files: readonly string[]): Promise<void> {
  await Promise.all(files.map(async (filePath) => {
    try {
      await rm(filePath, { force: true })
    } catch {
      // Best-effort temp cleanup.
    }
  }))
}

export function scheduleRemoteMediaDropCleanup(files: readonly string[]): void {
  if (files.length === 0) return
  const timer = setTimeout(() => {
    void removeRemoteMediaDropFiles(files)
  }, REMOTE_MEDIA_DROP_CLEANUP_DELAY_MS)
  if (typeof timer === 'object' && timer && 'unref' in timer && typeof timer.unref === 'function') timer.unref()
}
