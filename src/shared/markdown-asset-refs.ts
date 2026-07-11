/**
 * Markdown local-media reference scanning & rewriting for document export.
 *
 * The MD-bundle export ("连带 assets 的 md 压缩包") needs to find every local
 * media file a document renders, copy it into the bundle's `assets/` folder
 * and rewrite the reference so the exported markdown keeps working anywhere.
 *
 * This module is deliberately environment-agnostic (no `path`, no `fs`): it
 * only recognizes reference *syntax* and hands each destination to a caller
 *-provided replacer. Path resolution/existence live in the main process
 * (`document-engine/export/markdown-bundle.ts`).
 *
 * Recognized reference shapes (mirrors what NotePreview actually renders):
 *   ![alt](dest "title")            — markdown image/video/audio embeds
 *   [text](dest)                    — plain links, only when dest has a media extension
 *   <img|video|audio|source src=…>  — inline HTML media tags
 *
 * References inside fenced code blocks and inline code spans are literal
 * text in the preview, so they are never rewritten.
 */

export type MarkdownMediaRefKind = 'md-image' | 'md-link' | 'html-src'

export interface MarkdownMediaRef {
  /** Destination exactly as written, minus wrapping `<>` for md refs. */
  rawDest: string
  /**
   * Local path candidate decoded from the destination:
   * - `local-file://` / `file://` URLs → decoded absolute path
   * - plain destinations → percent-decoded as-is (relative or absolute)
   * - external destinations (http/https/data/mailto/tel/#anchor) → null
   */
  localCandidate: string | null
  kind: MarkdownMediaRefKind
}

/** Media file extensions the preview renders as embeds (images/video/audio). */
export const MEDIA_REF_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'tiff', 'tif',
  'mp4', 'webm', 'mov', 'avi', 'mkv', 'ogg',
  'mp3', 'wav', 'flac', 'aac', 'm4a',
])

const EXTERNAL_SCHEME_REGEX = /^(https?:|data:|mailto:|tel:|javascript:|about:|blob:|#)/i

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Decode a `local-file://` / `file://` URL back into an absolute filesystem
 * path. Mirrors the main-process protocol handler: a "standard" scheme URL
 * like `local-file:///Users/x/a.png` parses with an empty host, while
 * `local-file://Users/x/a.png` swallows `Users` as the (lowercased) host —
 * both must reconstruct the same absolute path.
 */
function decodeLocalFileUrl(url: string): string | null {
  const match = url.match(/^(?:local-file|file):\/\/([^/]*)(\/.*)?$/i)
  if (!match) return null
  const host = match[1] || ''
  const pathname = safeDecodeURIComponent(match[2] || '/')
  let filePath = host && host !== 'localhost' ? `/${host}${pathname}` : pathname
  // Windows drive-letter form: /C:/Users/... → C:/Users/...
  if (/^\/[a-zA-Z]:[/\\]/.test(filePath)) filePath = filePath.slice(1)
  return filePath
}

export function decodeMarkdownRefLocalCandidate(rawDest: string): string | null {
  const trimmed = rawDest.trim()
  if (!trimmed || EXTERNAL_SCHEME_REGEX.test(trimmed)) return null
  if (/^(?:local-file|file):/i.test(trimmed)) return decodeLocalFileUrl(trimmed)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) && !/^[a-zA-Z]:[/\\]/.test(trimmed)) {
    // Unknown scheme (not a Windows drive path) — leave untouched.
    return null
  }
  return safeDecodeURIComponent(trimmed)
}

export function getMarkdownRefExtension(rawDest: string): string {
  const withoutQuery = rawDest.split(/[?#]/, 1)[0] || ''
  const lastSegment = withoutQuery.split(/[/\\]/).pop() || ''
  const dotIndex = lastSegment.lastIndexOf('.')
  return dotIndex > 0 ? lastSegment.slice(dotIndex + 1).toLowerCase() : ''
}

export function isMediaRefExtension(rawDest: string): boolean {
  return MEDIA_REF_EXTENSIONS.has(getMarkdownRefExtension(rawDest))
}

/**
 * Build a boolean mask over `markdown` marking characters that live inside
 * fenced code blocks or inline code spans — references there are literal
 * text and must never be rewritten.
 */
function buildCodeMask(markdown: string): Uint8Array {
  const mask = new Uint8Array(markdown.length)
  const lines = markdown.split('\n')
  let offset = 0
  let fence: { marker: string } | null = null

  for (const line of lines) {
    const fenceMatch = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/)
    if (fence) {
      mask.fill(1, offset, offset + line.length)
      if (fenceMatch && fenceMatch[1][0] === fence.marker[0] && fenceMatch[1].length >= fence.marker.length) {
        fence = null
      }
    } else if (fenceMatch) {
      fence = { marker: fenceMatch[1] }
      mask.fill(1, offset, offset + line.length)
    } else {
      // Inline code spans on this line: `...` (single or multi-backtick).
      const spanRegex = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g
      let spanMatch: RegExpExecArray | null
      while ((spanMatch = spanRegex.exec(line)) !== null) {
        mask.fill(1, offset + spanMatch.index, offset + spanMatch.index + spanMatch[0].length)
      }
    }
    offset += line.length + 1
  }
  return mask
}

interface PendingRewrite {
  start: number
  end: number
  replacement: string
}

function wrapMarkdownDest(dest: string): string {
  return /[\s()]/.test(dest) ? `<${dest}>` : dest
}

/**
 * Walk every media reference in `markdown` (outside code), call `replace`
 * with each destination, and splice in the returned replacement destination.
 * `replace` returning null keeps the reference untouched.
 *
 * The replacement string is a plain destination (e.g. `assets/pic.png`);
 * markdown-syntax escaping/wrapping is handled here.
 */
export function rewriteMarkdownMediaRefs(
  markdown: string,
  replace: (ref: MarkdownMediaRef) => string | null,
): string {
  const mask = buildCodeMask(markdown)
  const rewrites: PendingRewrite[] = []

  const pushRewrite = (start: number, end: number, ref: MarkdownMediaRef, asHtmlAttr: boolean) => {
    if (mask[start]) return
    const replacement = replace(ref)
    if (replacement === null || replacement === ref.rawDest) return
    rewrites.push({
      start,
      end,
      replacement: asHtmlAttr ? replacement : wrapMarkdownDest(replacement),
    })
  }

  // Markdown image embeds and plain links:  (!?)[label](dest "title")
  // dest is either <angle-bracketed> or a run without whitespace/closing
  // paren (one level of balanced parens allowed).
  const mdRefRegex = /(!?)\[((?:\\.|[^\]\\])*)\]\(\s*(<[^<>\n]*>|(?:\\.|\([^()\n]*\)|[^\s()\\])+)((?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*)\)/g
  let mdMatch: RegExpExecArray | null
  while ((mdMatch = mdRefRegex.exec(markdown)) !== null) {
    const isImage = mdMatch[1] === '!'
    const destToken = mdMatch[3]
    const wrapped = destToken.startsWith('<') && destToken.endsWith('>')
    const rawDest = wrapped ? destToken.slice(1, -1) : destToken
    if (!isImage && !isMediaRefExtension(rawDest)) continue
    const destStart = mdMatch.index + mdMatch[0].indexOf(destToken, mdMatch[1].length + mdMatch[2].length)
    pushRewrite(destStart, destStart + destToken.length, {
      rawDest,
      localCandidate: decodeMarkdownRefLocalCandidate(rawDest),
      kind: isImage ? 'md-image' : 'md-link',
    }, false)
  }

  // Inline HTML media tags: <img/video/audio/source ... src="...">
  const htmlSrcRegex = /<(?:img|video|audio|source)\b[^>]*?\ssrc\s*=\s*("([^"\n]*)"|'([^'\n]*)')/gi
  let htmlMatch: RegExpExecArray | null
  while ((htmlMatch = htmlSrcRegex.exec(markdown)) !== null) {
    const quoted = htmlMatch[1]
    const rawDest = htmlMatch[2] ?? htmlMatch[3] ?? ''
    if (!rawDest) continue
    const valueStart = htmlMatch.index + htmlMatch[0].length - quoted.length + 1
    pushRewrite(valueStart, valueStart + rawDest.length, {
      rawDest,
      localCandidate: decodeMarkdownRefLocalCandidate(rawDest),
      kind: 'html-src',
    }, true)
  }

  if (rewrites.length === 0) return markdown

  rewrites.sort((a, b) => a.start - b.start)
  const parts: string[] = []
  let cursor = 0
  for (const rewrite of rewrites) {
    if (rewrite.start < cursor) continue // overlapping match — keep the earlier rewrite
    parts.push(markdown.slice(cursor, rewrite.start), rewrite.replacement)
    cursor = rewrite.end
  }
  parts.push(markdown.slice(cursor))
  return parts.join('')
}
