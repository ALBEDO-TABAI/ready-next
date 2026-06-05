/**
 * Materialize a clipped .md from sandbox to the user's vault folder.
 *
 * The pipeline writes `<outputsRoot>/obsidian-web-clip/<note>.md` with image
 * references pointing at remote http(s) URLs. When the user explicitly chose
 * a target folder by drag-dropping (host-IPC path, NOT model-facing), we:
 *
 *   1. Read the sandbox .md content.
 *   2. Scan all `![alt](url)` references whose URL is http(s).
 *   3. Download each image; on success write to
 *      `<targetDir>/<noteBaseName>.assets/<8hex>.<ext>` and rewrite the
 *      markdown reference to the relative path. On failure leave the
 *      original remote URL in place and record a non-fatal warning.
 *   4. Write the rewritten .md to `<targetDir>/<noteBaseName>.md`.
 *   5. Unlink the sandbox .md so the sandbox doesn't accumulate orphans.
 *
 * Net effect: a self-contained `<noteBaseName>.md + <noteBaseName>.assets/`
 * pair appears in the user-chosen folder; the sandbox is left empty. Move
 * semantics, not copy. If anything fails mid-materialize, the sandbox file
 * stays in place so user can retry / inspect.
 *
 * Pure module — no electron, no skills-runtime. All fs/fetch operations
 * are injected via the `MaterializeDeps` adapter so unit tests can run in
 * host Node without touching the network or disk.
 */

import { createHash } from 'node:crypto'

const IMG_MARKDOWN_RE = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+(?:\s+"[^"]*")?)\)/g
// Any image ref regardless of scheme; we use this for the defense-in-depth
// stripper that removes blob:/data:/javascript: refs the pipeline didn't
// already sanitize.
const IMG_MARKDOWN_ANY_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
const UNFETCHABLE_SCHEME_RE = /^(?:blob|data|javascript|about|chrome|file|filesystem):/i
const HTTP_RE = /^https?:\/\//i

const DEFAULT_MAX_BYTES_PER_IMAGE = 12 * 1024 * 1024 // 12 MB hard cap per image
const DEFAULT_FETCH_TIMEOUT_MS = 20_000
const DEFAULT_PARALLELISM = 2

export interface MaterializeDeps {
  /** Read the sandbox .md content. */
  readMarkdown: (path: string) => Promise<string>
  /** Delete sandbox .md after successful materialization. */
  unlink: (path: string) => Promise<void>
  /** Ensure a directory exists (recursive). */
  ensureDir: (path: string) => Promise<void>
  /** Write text or binary file. */
  writeFile: (path: string, content: string | Uint8Array) => Promise<void>
  /** Stat a path; throws if missing. Used to check target dir is a directory. */
  statIsDirectory: (path: string) => Promise<boolean>
  /** HTTP fetch for an image. Returns bytes + content-type or null on failure. */
  fetchImage: (
    url: string,
    options: { signal?: AbortSignal; maxBytes: number; timeoutMs: number; sourcePageUrl?: string | null },
  ) => Promise<{ bytes: Uint8Array; contentType: string } | null>
  /** Path join — injected so tests can use posix path on Windows. */
  joinPath: (...segments: string[]) => string
  /** Path basename. */
  basename: (path: string) => string
  /** Path is absolute? */
  isAbsolute: (path: string) => boolean
}

export interface MaterializeInput {
  /** Absolute sandbox path of the .md produced by runClipPipeline. */
  sandboxMdPath: string
  /** Absolute target folder the user dragged into. */
  targetDir: string
  /** Optional override; defaults to basename of sandboxMdPath without extension. */
  noteBaseNameOverride?: string
  /** Optional max bytes per image. */
  maxBytesPerImage?: number
  /** Optional per-image fetch timeout. */
  fetchTimeoutMs?: number
  /** Optional download parallelism. Default 2. */
  parallelism?: number
  /** Optional AbortSignal for the whole materialization. */
  abortSignal?: AbortSignal
  /** Source page for cookie/referrer-sensitive image hosts. */
  sourcePageUrl?: string | null
}

export interface MaterializeResult {
  /** Absolute path of the .md in the target folder. */
  finalMdPath: string
  /** Absolute paths of every downloaded asset. */
  assetPaths: string[]
  /** Number of image refs that failed to download (left as remote URL). */
  imageDownloadFailures: number
  /** First few failure messages (for diagnostics, not user-facing). */
  failureMessages: string[]
}

export type MaterializeErrorKind =
  | 'invalid_target'
  | 'not_a_directory'
  | 'sandbox_read_failed'
  | 'target_write_failed'
  | 'sandbox_unlink_failed'

export class MaterializeError extends Error {
  constructor(
    public readonly kind: MaterializeErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'MaterializeError'
  }
}

export async function materializeToVault(
  input: MaterializeInput,
  deps: MaterializeDeps,
): Promise<MaterializeResult> {
  if (!input.targetDir || typeof input.targetDir !== 'string') {
    throw new MaterializeError('invalid_target', 'target_dir is empty')
  }
  if (!deps.isAbsolute(input.targetDir)) {
    throw new MaterializeError('invalid_target', `target_dir must be absolute: ${input.targetDir}`)
  }
  let isDir: boolean
  try {
    isDir = await deps.statIsDirectory(input.targetDir)
  } catch (err) {
    throw new MaterializeError('invalid_target', (err as Error).message)
  }
  if (!isDir) {
    throw new MaterializeError('not_a_directory', `target_dir is not a directory: ${input.targetDir}`)
  }

  let markdown: string
  try {
    markdown = await deps.readMarkdown(input.sandboxMdPath)
  } catch (err) {
    throw new MaterializeError('sandbox_read_failed', (err as Error).message)
  }

  // Defense-in-depth: scrub blob:/data:/javascript: image refs the pipeline
  // didn't already strip (e.g., if a future extractor produces them).
  // These URLs are unfetchable from outside the originating page context,
  // so leaving them as `![]()` in the saved .md produces broken-image
  // placeholders in Obsidian preview — the exact failure mode users see.
  markdown = stripUnfetchableImageRefs(markdown)

  const sandboxBase = deps.basename(input.sandboxMdPath)
  const noteBaseName = input.noteBaseNameOverride
    ? input.noteBaseNameOverride
    : sandboxBase.endsWith('.md')
      ? sandboxBase.slice(0, -3)
      : sandboxBase
  const finalMdPath = deps.joinPath(input.targetDir, `${noteBaseName}.md`)
  const assetsDir = deps.joinPath(input.targetDir, `${noteBaseName}.assets`)

  const imageRefs = collectImageRefs(markdown)
  let assetPaths: string[] = []
  let imageDownloadFailures = 0
  const failureMessages: string[] = []
  const rewriteMap = new Map<string, string>()

  if (imageRefs.length > 0) {
    await deps.ensureDir(assetsDir)
    const max = input.maxBytesPerImage ?? DEFAULT_MAX_BYTES_PER_IMAGE
    const timeoutMs = input.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
    const parallelism = Math.max(1, Math.min(input.parallelism ?? DEFAULT_PARALLELISM, 4))

    // Dedupe URLs so the same image isn't downloaded twice within one note.
    const uniqueUrls = Array.from(new Set(imageRefs.map((ref) => ref.url)))
    const downloadResults = new Map<string, string | null>() // url → relative path or null

    // Sequential batches of `parallelism`.
    for (let i = 0; i < uniqueUrls.length; i += parallelism) {
      const batch = uniqueUrls.slice(i, i + parallelism)
      const settled = await Promise.all(
        batch.map(async (url) => {
          if (input.abortSignal?.aborted) return [url, null] as const
          try {
            const fetched = await deps.fetchImage(url, {
              signal: input.abortSignal,
              maxBytes: max,
              timeoutMs,
              sourcePageUrl: input.sourcePageUrl,
            })
            if (!fetched || fetched.bytes.byteLength === 0) {
              failureMessages.push(`empty body: ${url}`)
              return [url, null] as const
            }
            if (!isImageResponse(fetched.contentType, fetched.bytes)) {
              failureMessages.push(`non-image response (${fetched.contentType || 'unknown'}): ${url}`)
              return [url, null] as const
            }
            const ext = inferExtension(url, fetched.contentType)
            const hash = createHash('sha256').update(fetched.bytes).digest('hex').slice(0, 12)
            const filename = `${hash}${ext}`
            const absoluteAssetPath = deps.joinPath(assetsDir, filename)
            await deps.writeFile(absoluteAssetPath, fetched.bytes)
            const relativePath = formatLocalPathForMarkdown(`${noteBaseName}.assets/${filename}`)
            return [url, relativePath, absoluteAssetPath] as const
          } catch (err) {
            failureMessages.push(`${url}: ${(err as Error).message}`)
            return [url, null] as const
          }
        }),
      )
      for (const entry of settled) {
        const [url, relative, absolute] = entry as readonly [string, string | null, string?]
        downloadResults.set(url, relative)
        if (relative && absolute) assetPaths.push(absolute)
      }
    }

    // Build rewrite map from URL → relative path; failures stay as the original URL.
    for (const [url, relative] of downloadResults) {
      if (relative) rewriteMap.set(url, relative)
      else imageDownloadFailures += 1
    }
  }

  const rewritten = rewriteMap.size > 0 ? rewriteMarkdownImageRefs(markdown, rewriteMap) : markdown

  try {
    await deps.writeFile(finalMdPath, rewritten)
  } catch (err) {
    throw new MaterializeError('target_write_failed', (err as Error).message)
  }

  try {
    await deps.unlink(input.sandboxMdPath)
  } catch (err) {
    // The .md and assets are already at the target; sandbox unlink failure
    // leaves an orphan in sandbox but doesn't poison the user vault. Surface
    // a non-fatal message rather than rolling back the move.
    failureMessages.push(`sandbox_unlink: ${(err as Error).message}`)
  }

  // Keep assetPaths stable + unique (writeFile dedupe by hash already does
  // most of this; just sort for determinism in tests).
  assetPaths = Array.from(new Set(assetPaths)).sort()

  return {
    finalMdPath,
    assetPaths,
    imageDownloadFailures,
    failureMessages,
  }
}

interface ImageRef {
  url: string
  matchStart: number
  matchEnd: number
}

export function formatLocalPathForMarkdown(relativePath: string): string {
  if (!needsAngleBracketMarkdownDestination(relativePath)) return relativePath
  return `<${relativePath.replace(/\\/g, '\\\\').replace(/>/g, '\\>')}>`
}

function needsAngleBracketMarkdownDestination(relativePath: string): boolean {
  return /[\s()[\]{}<>]/.test(relativePath) || /[^\x20-\x7E]/.test(relativePath)
}

export function stripUnfetchableImageRefs(markdown: string): string {
  if (!markdown) return ''
  return markdown.replace(IMG_MARKDOWN_ANY_RE, (whole, alt: string, url: string) => {
    if (!UNFETCHABLE_SCHEME_RE.test(url)) return whole
    const trimmedAlt = (alt || '').trim()
    // Drop Jina's "Image N" auto-numbered alt because it carries no info.
    if (!trimmedAlt || /^image\s*\d*$/i.test(trimmedAlt)) return ''
    return `_${trimmedAlt}_`
  })
}

function collectImageRefs(markdown: string): ImageRef[] {
  const out: ImageRef[] = []
  for (const match of markdown.matchAll(IMG_MARKDOWN_RE)) {
    const matchStart = match.index ?? 0
    const matchEnd = matchStart + match[0].length
    const rawUrl = match[2]
    // Strip optional title (`url "title"`)
    const url = rawUrl.split(/\s+/)[0]
    if (!url || !HTTP_RE.test(url)) continue
    out.push({ url, matchStart, matchEnd })
  }
  return out
}

function rewriteMarkdownImageRefs(markdown: string, urlToRelative: Map<string, string>): string {
  return markdown.replace(IMG_MARKDOWN_RE, (whole, alt: string, urlChunk: string) => {
    const url = urlChunk.split(/\s+/)[0]
    const relative = urlToRelative.get(url)
    if (!relative) return whole
    return `![${alt}](${relative})`
  })
}

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
}

const ALLOWED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.svg', '.bmp', '.tiff', '.ico'])

function looksLikeImageBytes(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return true
  if (
    bytes.byteLength >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return true
  }
  if (
    bytes.byteLength >= 12
    && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70
    && bytes[8] === 0x61 && bytes[9] === 0x76 && bytes[10] === 0x69 && (bytes[11] === 0x66 || bytes[11] === 0x73)
  ) {
    return true
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return true
  const prefix = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.byteLength, 128))).trimStart().toLowerCase()
  return prefix.startsWith('<svg')
}

function isImageResponse(contentType: string, bytes: Uint8Array): boolean {
  const ct = (contentType || '').toLowerCase().split(';')[0].trim()
  if (!ct) return looksLikeImageBytes(bytes)
  if (ct.startsWith('image/')) return true
  if (ct === 'application/octet-stream' || ct === 'binary/octet-stream') {
    return looksLikeImageBytes(bytes)
  }
  return false
}

export function inferExtension(url: string, contentType: string): string {
  // 1. MIME map first — content-type is authoritative when present.
  const ct = (contentType || '').toLowerCase().split(';')[0].trim()
  if (ct && MIME_TO_EXT[ct]) return MIME_TO_EXT[ct]
  // 2. URL extension fallback (handles common CDN patterns).
  try {
    const parsed = new URL(url)
    const pathname = parsed.pathname.toLowerCase()
    const dot = pathname.lastIndexOf('.')
    if (dot >= 0 && dot >= pathname.length - 6) {
      const candidate = pathname.slice(dot)
      if (ALLOWED_EXTS.has(candidate)) return candidate === '.jpeg' ? '.jpg' : candidate
    }
  } catch {
    // ignore
  }
  return '.jpg'
}
