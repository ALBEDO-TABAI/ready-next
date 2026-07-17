import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname } from 'node:path'

export type ParsedByteRange =
  | { kind: 'range'; start: number; end: number }
  | { kind: 'unsatisfiable' }

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.tiff': 'image/tiff', '.tif': 'image/tiff',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska', '.ogg': 'video/ogg',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac',
  '.aac': 'audio/aac', '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf', '.json': 'application/json',
  '.epub': 'application/epub+zip',
  '.mobi': 'application/x-mobipocket-ebook',
  '.azw': 'application/vnd.amazon.ebook',
  '.azw3': 'application/vnd.amazon.ebook',
  '.fb2': 'application/x-fictionbook+xml',
  '.cbz': 'application/vnd.comicbook+zip',
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
}

export function parseSingleByteRange(value: string, fileSize: number): ParsedByteRange {
  const match = value.trim().match(/^bytes=(\d*)-(\d*)$/i)
  if (!match || fileSize <= 0) return { kind: 'unsatisfiable' }

  const rawStart = match[1]
  const rawEnd = match[2]
  if (!rawStart && !rawEnd) return { kind: 'unsatisfiable' }

  if (!rawStart) {
    const suffixLength = Number(rawEnd)
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { kind: 'unsatisfiable' }
    return {
      kind: 'range',
      start: Math.max(0, fileSize - suffixLength),
      end: fileSize - 1,
    }
  }

  const start = Number(rawStart)
  const requestedEnd = rawEnd ? Number(rawEnd) : fileSize - 1
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= fileSize ||
    requestedEnd < start
  ) {
    return { kind: 'unsatisfiable' }
  }
  return { kind: 'range', start, end: Math.min(requestedEnd, fileSize - 1) }
}

export function resolveLocalFileRequestPath(url: string, platform = process.platform): string {
  const parsed = new URL(url)
  const decodedPathname = decodeURIComponent(parsed.pathname)
  let filePath = parsed.host ? `/${parsed.host}${decodedPathname}` : decodedPathname
  if (platform === 'win32' && filePath.startsWith('/')) {
    filePath = filePath.slice(1)
    if (filePath.length >= 2 && filePath[1] === ':') {
      filePath = filePath[0].toUpperCase() + filePath.slice(1)
    }
  }
  return filePath
}

function createFileStream(filePath: string, start?: number, end?: number): ReadableStream<Uint8Array> {
  const stream = createReadStream(filePath, start === undefined ? undefined : { start, end })
  return new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on('data', (chunk) => controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk))
      stream.on('end', () => controller.close())
      stream.on('error', (error) => controller.error(error))
    },
    cancel() {
      stream.destroy()
    },
  })
}

function corsHeaders(contentType: string): Record<string, string> {
  return {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range',
  }
}

export async function createLocalFileResponse(
  request: Request,
  options: { isPathAllowed(path: string): boolean },
): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders('application/octet-stream') })
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD, OPTIONS' } })
  }

  let filePath: string
  try {
    filePath = resolveLocalFileRequestPath(request.url)
  } catch {
    return new Response('Bad Request', { status: 400 })
  }
  if (!options.isPathAllowed(filePath)) return new Response('Forbidden', { status: 403 })

  let fileSize: number
  try {
    const stats = await stat(filePath)
    if (!stats.isFile()) return new Response('Not Found', { status: 404 })
    fileSize = stats.size
  } catch {
    return new Response('Not Found', { status: 404 })
  }

  const contentType = MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream'
  const commonHeaders = corsHeaders(contentType)
  const rangeHeader = request.headers.get('Range')
  if (rangeHeader) {
    const parsedRange = parseSingleByteRange(rangeHeader, fileSize)
    if (parsedRange.kind === 'unsatisfiable') {
      return new Response(null, {
        status: 416,
        headers: {
          ...commonHeaders,
          'Content-Range': `bytes */${fileSize}`,
          'Content-Length': '0',
        },
      })
    }
    const { start, end } = parsedRange
    const headers = {
      ...commonHeaders,
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Content-Length': String(end - start + 1),
    }
    return new Response(
      request.method === 'HEAD' ? null : createFileStream(filePath, start, end),
      { status: 206, headers },
    )
  }

  const headers = { ...commonHeaders, 'Content-Length': String(fileSize) }
  return new Response(request.method === 'HEAD' ? null : createFileStream(filePath), {
    status: 200,
    headers,
  })
}
