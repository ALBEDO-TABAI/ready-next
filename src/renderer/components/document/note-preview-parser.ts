import { format, isValid, parseISO } from 'date-fns'
import { parse as parseYaml } from 'yaml'
import { EBOOK_INLINE_IMAGE_TITLE } from '../../../shared/ebook'
import { parseBareWidgetPayloadSegments, parseShowWidgetFences, type DocumentWidgetData } from './widget-fence-parser'

export interface PreviewTag {
  id: string
  label: string
  raw: string
  kind: 'tag' | 'type' | 'related'
  href?: string
}

export interface PreviewProperty {
  key: string
  label: string
  rawValue: string
  displayValue: string
  kind: 'text' | 'link' | 'chips' | 'empty'
  href?: string
  chips?: PreviewTag[]
}

export interface PreviewEmbed {
  id: string
  kind: 'youtube' | 'bilibili' | 'image' | 'video'
  source: 'metadata' | 'body'
  url: string
  displayUrl: string
  embedUrl?: string
  videoId?: string
  thumbnailUrl?: string
  title?: string
  channel?: string
  published?: string
  duration?: string
  alt?: string
  localPath?: string | null
  isLocal?: boolean
}

/**
 * Char range of a block inside the *normalized* (CRLF→LF) full note text.
 * `null` means the block could not be mapped back to a unique source span —
 * preview-edit must treat such blocks as read-only.
 */
export interface PreviewBlockSourceRange {
  start: number
  end: number
}

export type PreviewBlock =
  | { id: string; type: 'markdown'; markdown: string; source: PreviewBlockSourceRange | null }
  | { id: string; type: 'details'; summary: string; markdown: string; open: boolean; source: PreviewBlockSourceRange | null }
  | { id: string; type: 'embed'; embedId: string; source: PreviewBlockSourceRange | null }
  | { id: string; type: 'chips'; chips: PreviewTag[]; source: PreviewBlockSourceRange | null }
  | { id: string; type: 'widget'; widgetId: string; source: PreviewBlockSourceRange | null }
  | { id: string; type: 'widget_error'; reason: string; source: PreviewBlockSourceRange | null }

export interface StructuredNotePreview {
  properties: PreviewProperty[]
  tags: PreviewTag[]
  related: PreviewTag[]
  embeds: PreviewEmbed[]
  widgets: DocumentWidgetData[]
  heroEmbed: PreviewEmbed | null
  bodyMarkdown: string
  blocks: PreviewBlock[]
  warnings: string[]
}

const PROPERTY_TOKEN_PATTERN = /(^|\s)([A-Za-z][A-Za-z0-9_-]*):/g
const LIST_MARKER_PATTERN = /^[-*+]\s+(.+)$/
const TAG_TOKEN_PATTERN = /#[^\s,]+/g
const KNOWN_METADATA_ORDER = [
  'created',
  'url',
  'title',
  'channel',
  'related',
  'published',
  'thumbnailurl',
  'duration',
  'type',
  'tags',
] as const
const PROPERTY_LABELS: Record<string, string> = {
  created: 'created',
  url: 'url',
  title: 'title',
  channel: 'channel',
  related: 'related',
  published: 'published',
  thumbnailurl: 'thumbnailUrl',
  duration: 'duration',
  type: 'type',
  tags: 'tags',
}
const SECTION_HEADING_TITLES = new Set<string>([
  'about',
  'description',
  'summary',
  'notes',
  'transcript',
  'links',
  'metadata',
  '简介',
  '描述',
  '摘要',
  '说明',
])
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', 'ogg', 'm4v'])
const MULTI_VALUE_KEYS = new Set(['tags', 'related'])

type MetadataMap = Map<string, string[]>

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n?/g, '\n')
}

function normalizeKey(key: string): string {
  return key.trim().toLowerCase()
}

function makeId(prefix: string, value: string, index: number): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${prefix}-${normalized || 'item'}-${index}`
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith('\'') && trimmed.endsWith('\''))
  ) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

function stripMarkdownDestinationBrackets(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

function splitFrontmatter(content: string): {
  frontmatter: Record<string, unknown> | null
  body: string
  warnings: string[]
} {
  if (!content.startsWith('---\n')) {
    return { frontmatter: null, body: content, warnings: [] }
  }

  const match = content.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!match) {
    return { frontmatter: null, body: content, warnings: [] }
  }

  const rawBlock = match[1]
  const blockLines = rawBlock.split('\n')
  const looksLikeMetadata = blockLines.some((line) => /^[A-Za-z][A-Za-z0-9_-]*\s*:/.test(line.trim()))
  if (!looksLikeMetadata) {
    return { frontmatter: null, body: content, warnings: [] }
  }

  try {
    const parsed = parseYaml(rawBlock)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const fallback = parseLooseFrontmatter(rawBlock)
      if (fallback) {
        return {
          frontmatter: fallback,
          body: content.slice(match[0].length),
          warnings: [],
        }
      }
      return {
        frontmatter: null,
        body: content.slice(match[0].length),
        warnings: [],
      }
    }

    return {
      frontmatter: parsed as Record<string, unknown>,
      body: content.slice(match[0].length),
      warnings: [],
    }
  } catch (error) {
    const fallback = parseLooseFrontmatter(rawBlock)
    if (fallback) {
      return {
        frontmatter: fallback,
        body: content.slice(match[0].length),
        warnings: [],
      }
    }
    const message = error instanceof Error ? error.message : String(error)
    return {
      frontmatter: null,
      body: content,
      warnings: [`frontmatter 解析失败，已按普通正文处理: ${message}`],
    }
  }
}

function parseLooseFrontmatter(block: string): Record<string, unknown> | null {
  const lines = normalizeLineEndings(block).split('\n')
  const record: Record<string, unknown> = {}
  let activeKey: string | null = null
  let parsedAny = false

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const bulletMatch = trimmed.match(LIST_MARKER_PATTERN)
    if (bulletMatch && activeKey) {
      const existing = record[activeKey]
      if (Array.isArray(existing)) {
        existing.push(stripWrappingQuotes(bulletMatch[1]))
      } else {
        record[activeKey] = [stripWrappingQuotes(bulletMatch[1])]
      }
      parsedAny = true
      continue
    }

    const pairMatch = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/)
    if (!pairMatch) {
      activeKey = null
      continue
    }

    const key = normalizeKey(pairMatch[1])
    const value = stripWrappingQuotes(pairMatch[2])
    parsedAny = true

    if (!value) {
      record[key] = Array.isArray(record[key]) ? record[key] : []
      activeKey = key
      continue
    }

    if (value.startsWith('[') && value.endsWith(']')) {
      const items = value
        .slice(1, -1)
        .split(',')
        .map((item) => stripWrappingQuotes(item))
        .filter(Boolean)
      record[key] = items
      activeKey = null
      continue
    }

    record[key] = value
    activeKey = null
  }

  return parsedAny ? record : null
}

function addMetadataValue(map: MetadataMap, key: string, rawValue: string): void {
  const normalizedKey = normalizeKey(key)
  const value = stripWrappingQuotes(rawValue)
  const existing = map.get(normalizedKey) || []

  if (MULTI_VALUE_KEYS.has(normalizedKey)) {
    map.set(normalizedKey, [...existing, value].filter(Boolean))
    return
  }

  map.set(normalizedKey, value ? [value] : existing)
}

function metadataFromRecord(record: Record<string, unknown>): MetadataMap {
  const map: MetadataMap = new Map()

  Object.entries(record).forEach(([key, value]) => {
    const normalizedKey = normalizeKey(key)
    if (value == null) return

    if (Array.isArray(value)) {
      value.forEach((item) => addMetadataValue(map, normalizedKey, stringifyScalar(item)))
      return
    }

    if (typeof value === 'object') {
      addMetadataValue(map, normalizedKey, JSON.stringify(value))
      return
    }

    addMetadataValue(map, normalizedKey, stringifyScalar(value))
  })

  return map
}

function stringifyScalar(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

function parseChainedMetadataLine(line: string): Array<{ key: string; value: string }> {
  // Header-metadata heuristic is line-oriented: a plain `key: value [key: value]*`
  // line right after frontmatter is treated as additional metadata. We must NOT
  // apply this to lines that are clearly markup / inline HTML — e.g. a B 站 /
  // YouTube embed `<iframe src="..." style="width:100%; height:500px;"></iframe>`
  // would otherwise donate spurious `src` / `height` keys into the properties
  // table. Reject any line containing HTML angle brackets so embedded media,
  // self-closing tags and span markup never leak into metadata.
  if (line.includes('<') || line.includes('>')) return []
  const matches: Array<{ key: string; start: number; end: number }> = []
  PROPERTY_TOKEN_PATTERN.lastIndex = 0

  for (const match of line.matchAll(PROPERTY_TOKEN_PATTERN)) {
    const prefix = match[1] || ''
    const key = match[2]
    const keyStart = match.index + prefix.length
    const end = keyStart + key.length + 1
    matches.push({ key, start: keyStart, end })
  }

  if (matches.length === 0) return []

  return matches.map((entry, index) => {
    const nextStart = matches[index + 1]?.start ?? line.length
    const rawValue = line.slice(entry.end, nextStart).trim()
    return {
      key: entry.key,
      value: stripWrappingQuotes(rawValue),
    }
  })
}

function parseHeaderMetadata(content: string): { metadata: MetadataMap; body: string } {
  const lines = normalizeLineEndings(content).split('\n')
  const metadata: MetadataMap = new Map()
  let consumedLineCount = 0
  let started = false
  let openListKey: string | null = null

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmed = line.trim()

    if (trimmed.length === 0) {
      if (started) {
        consumedLineCount = index + 1
        break
      }
      consumedLineCount = index + 1
      continue
    }

    if (openListKey) {
      const bulletMatch = trimmed.match(LIST_MARKER_PATTERN)
      if (bulletMatch) {
        addMetadataValue(metadata, openListKey, bulletMatch[1])
        started = true
        consumedLineCount = index + 1
        continue
      }
      openListKey = null
    }

    const pairs = parseChainedMetadataLine(trimmed)
    if (pairs.length === 0) {
      if (!started) {
        return { metadata: new Map(), body: content }
      }
      break
    }

    started = true
    consumedLineCount = index + 1
    openListKey = null

    pairs.forEach(({ key, value }) => {
      const normalizedKey = normalizeKey(key)
      if (value.length === 0) {
        metadata.set(normalizedKey, metadata.get(normalizedKey) || [])
        openListKey = normalizedKey
        return
      }
      addMetadataValue(metadata, normalizedKey, value)
    })
  }

  return {
    metadata,
    body: lines.slice(consumedLineCount).join('\n'),
  }
}

function mergeMetadata(frontmatter: MetadataMap, header: MetadataMap): MetadataMap {
  const merged: MetadataMap = new Map(frontmatter)

  header.forEach((values, key) => {
    if (MULTI_VALUE_KEYS.has(key)) {
      merged.set(key, [...(merged.get(key) || []), ...values])
      return
    }
    merged.set(key, values)
  })

  return merged
}

function formatDateValue(value: string): string {
  const normalized = stripWrappingQuotes(value)
  const parsed = parseISO(normalized)
  if (!isValid(parsed)) return normalized

  const hasTime = /[T\s]\d{1,2}:\d{2}/.test(normalized)
  return format(parsed, hasTime ? 'yyyy-MM-dd HH:mm' : 'yyyy-MM-dd')
}

function formatDurationValue(value: string): string {
  const normalized = stripWrappingQuotes(value)
  if (!/^\d+$/.test(normalized)) return normalized

  const totalSeconds = Number(normalized)
  if (!Number.isFinite(totalSeconds)) return normalized

  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function parseWikiLink(raw: string): { target: string; label: string } | null {
  const trimmed = stripWrappingQuotes(raw)
  const match = trimmed.match(/^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/)
  if (!match) return null

  const target = match[1].trim()
  const label = (match[2] || target.split(/[/\\]/).pop() || target).trim()
  return { target, label }
}

function isAbsolutePath(input: string): boolean {
  return input.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(input) || input.startsWith('\\\\')
}

function normalizePath(input: string): string {
  return input.replace(/\\/g, '/')
}

function decodeLocalReference(input: string): string {
  if (!/%[0-9a-f]{2}/i.test(input)) return input
  try {
    return decodeURIComponent(input)
  } catch {
    // silent-catch: malformed percent-encoding keeps the raw reference
    return input
  }
}

function getDirectory(path: string | null | undefined): string | null {
  if (!path) return null
  const normalized = normalizePath(path)
  const lastSlash = normalized.lastIndexOf('/')
  return lastSlash > 0 ? normalized.slice(0, lastSlash) : null
}

function getReferenceBasename(reference: string): string {
  const cleaned = stripMarkdownDestinationBrackets(reference).split('?')[0].split('#')[0]
  return cleaned.split(/[/\\]/).pop() || cleaned
}

function resolveRelativePath(baseDir: string, relativePath: string): string {
  const baseParts = normalizePath(baseDir).split('/').filter(Boolean)
  const relativeParts = normalizePath(relativePath).split('/').filter(Boolean)
  const rootPrefix = normalizePath(baseDir).startsWith('/') ? '/' : ''

  relativeParts.forEach((part) => {
    if (part === '.') return
    if (part === '..') {
      baseParts.pop()
      return
    }
    baseParts.push(part)
  })

  return `${rootPrefix}${baseParts.join('/')}`
}

function toLocalFileUrl(filePath: string): string {
  const normalized = normalizePath(filePath)
  const encoded = normalized
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return normalized.startsWith('/')
    ? `local-file://${encoded}`
    : `local-file:///${encoded}`
}

function getReferenceExtension(reference: string): string {
  const basename = getReferenceBasename(reference)
  const lastDot = basename.lastIndexOf('.')
  return lastDot > 0 ? basename.slice(lastDot + 1).toLowerCase() : ''
}

function isObsidianEmbedSizeToken(token: string): boolean {
  const normalized = token.trim().toLowerCase()
  return /^\d+$/.test(normalized) || /^\d+x\d+$/.test(normalized) || /^\d+x$/.test(normalized) || /^x\d+$/.test(normalized)
}

function parseObsidianEmbed(
  raw: string,
): {
  target: string
  kind: 'image' | 'video'
  label: string
} | null {
  const trimmed = stripWrappingQuotes(raw)
  const match = trimmed.match(/^!\[\[([^\]]+)\]\]$/)
  if (!match) return null

  const parts = match[1]
    .split('|')
    .map((part) => stripWrappingQuotes(part).trim())
    .filter(Boolean)

  const target = parts[0]
  if (!target) return null

  const extension = getReferenceExtension(target)
  const kind = IMAGE_EXTENSIONS.has(extension)
    ? 'image'
    : VIDEO_EXTENSIONS.has(extension)
      ? 'video'
      : null
  if (!kind) return null

  const label = parts.slice(1).find((part) => !isObsidianEmbedSizeToken(part)) || getReferenceBasename(target)

  return {
    target,
    kind,
    label,
  }
}

function escapeMarkdownImageText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]')
}

function normalizeObsidianMarkdownEmbeds(markdown: string): string {
  const lines = markdown.split('\n')
  let inCodeFence = false

  return lines.map((line) => {
    const trimmed = line.trimStart()
    if (/^```/.test(trimmed) || /^~~~/.test(trimmed)) {
      inCodeFence = !inCodeFence
      return line
    }

    if (inCodeFence) return line

    return line.replace(/!\[\[([^\]]+)\]\]/g, (match) => {
      const embed = parseObsidianEmbed(match)
      if (!embed || embed.kind !== 'image') return match
      return `![${escapeMarkdownImageText(embed.label)}](<${embed.target}>)`
    })
  }).join('\n')
}

function resolveReference(reference: string, notePath: string | null | undefined): {
  displayUrl: string
  resolvedUrl: string
  localPath: string | null
  isLocal: boolean
} {
  const rawReference = stripMarkdownDestinationBrackets(stripWrappingQuotes(reference))

  if (/^(https?:|data:|local-file:|file:)/i.test(rawReference)) {
    return {
      displayUrl: rawReference,
      resolvedUrl: rawReference,
      localPath: null,
      isLocal: /^(local-file:|file:)/i.test(rawReference),
    }
  }

  const trimmed = decodeLocalReference(rawReference)

  if (isAbsolutePath(trimmed)) {
    return {
      displayUrl: trimmed,
      resolvedUrl: toLocalFileUrl(trimmed),
      localPath: trimmed,
      isLocal: true,
    }
  }

  const noteDir = getDirectory(notePath)
  if (!noteDir) {
    return {
      displayUrl: trimmed,
      resolvedUrl: trimmed,
      localPath: null,
      isLocal: false,
    }
  }

  const resolvedPath = resolveRelativePath(noteDir, trimmed)
  return {
    displayUrl: trimmed,
    resolvedUrl: toLocalFileUrl(resolvedPath),
    localPath: resolvedPath,
    isLocal: true,
  }
}

/**
 * Recognize a B 站 (Bilibili) player iframe embedded in markdown body:
 *   `<iframe src="https://player.bilibili.com/player.html?...bvid=BV...">...</iframe>`
 * The obsidian-web-clip `b站-clipper.json` preset writes exactly this. We
 * trust this specific origin (`player.bilibili.com/player.html`) because it
 * is the official embed endpoint and serves the same content the linked URL
 * does. Returns the BV id + the safe player URL, or null.
 */
function extractBilibiliEmbed(line: string): { bvid: string; embedUrl: string; pageUrl: string } | null {
  const trimmed = line.trim()
  // Anchored: the iframe must constitute the entire (trimmed) line so we
  // don't accidentally consume prose that happens to contain an iframe.
  const iframeMatch = trimmed.match(/^<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>\s*<\/iframe>$/i)
  if (!iframeMatch) return null
  const src = iframeMatch[1]
  // Whitelist: only the official Bilibili player endpoint is safe to mount
  // as a renderer iframe. Anything else falls through (markdown body keeps
  // the raw iframe text; the markdown renderer's sanitize step will strip
  // it into nothing visible — acceptable, as widening the trust list
  // requires a deliberate review).
  if (!/^https?:\/\/player\.bilibili\.com\/player\.html\b/i.test(src)) return null
  const bvidMatch = src.match(/[?&]bvid=(BV[A-Za-z0-9]+)/)
  if (!bvidMatch) return null
  const bvid = bvidMatch[1]
  let page = '1'
  try {
    const parsed = new URL(src)
    const rawPage = parsed.searchParams.get('p') || ''
    if (/^\d+$/.test(rawPage)) page = rawPage
  } catch {
    // silent-catch: invalid trusted-player URLs fall back to page 1 while preserving the BVID.
    page = '1'
  }
  const canonical = new URL('https://player.bilibili.com/player.html')
  canonical.searchParams.set('isOutside', 'true')
  canonical.searchParams.set('bvid', bvid)
  canonical.searchParams.set('p', page)
  canonical.searchParams.set('autoplay', '0')
  return {
    bvid,
    embedUrl: canonical.toString(),
    pageUrl: `https://www.bilibili.com/video/${bvid}/`,
  }
}

function parseMarkdownImageLine(line: string): { alt: string; target: string } | null {
  const match = line.trim().match(/^!\[([^\]]*)\]\((.+)\)$/)
  if (!match) return null

  const rawDestination = match[2].trim()
  if (rawDestination.startsWith('<')) {
    const closingIndex = rawDestination.indexOf('>')
    if (closingIndex <= 0) return null
    const title = stripWrappingQuotes(rawDestination.slice(closingIndex + 1).trim())
    if (title === EBOOK_INLINE_IMAGE_TITLE) return null
    return { alt: match[1], target: rawDestination.slice(1, closingIndex) }
  }

  return { alt: match[1], target: rawDestination }
}

function extractYouTubeVideoId(url: string): string | null {
  const trimmed = stripWrappingQuotes(url)
  const matchers = [
    /youtu\.be\/([A-Za-z0-9_-]{6,})/i,
    /youtube\.com\/watch\?v=([A-Za-z0-9_-]{6,})/i,
    /youtube\.com\/shorts\/([A-Za-z0-9_-]{6,})/i,
    /youtube\.com\/embed\/([A-Za-z0-9_-]{6,})/i,
  ]

  for (const matcher of matchers) {
    const match = trimmed.match(matcher)
    if (match) return match[1]
  }

  return null
}

function buildTagChips(values: string[], kind: 'tag' | 'type' | 'related'): PreviewTag[] {
  const chips: PreviewTag[] = []

  values.forEach((value) => {
    const raw = stripWrappingQuotes(value)
    if (kind === 'related') {
      const wiki = parseWikiLink(raw)
      if (wiki) {
        chips.push({ id: '', label: wiki.label, raw, kind })
        return
      }
      if (/^https?:\/\//i.test(raw)) {
        chips.push({ id: '', label: raw, raw, kind, href: raw })
        return
      }
      chips.push({ id: '', label: raw, raw, kind })
      return
    }

    const tagMatches = raw.match(TAG_TOKEN_PATTERN)
    if (!tagMatches || tagMatches.length === 0) {
      chips.push({ id: '', label: raw, raw, kind })
      return
    }

    tagMatches.forEach((tag) => {
      chips.push({
        id: '',
        label: tag,
        raw: tag,
        kind: tag.startsWith('#type/') ? 'type' : kind,
      })
    })
  })

  const deduped = new Map<string, PreviewTag>()
  chips.forEach((chip, index) => {
    const key = `${chip.kind}:${chip.label}`
    if (!deduped.has(key)) {
      deduped.set(key, {
        ...chip,
        id: makeId(chip.kind, chip.label, index),
      })
    }
  })
  return Array.from(deduped.values())
}

function isTagOnlyValue(value: string): boolean {
  const trimmed = stripWrappingQuotes(value)
  const matches = trimmed.match(TAG_TOKEN_PATTERN)
  if (!matches || matches.length === 0) return false

  const rest = trimmed.replace(TAG_TOKEN_PATTERN, '').replace(/[，,\s]+/g, '')
  return rest.length === 0
}

function buildProperties(metadata: MetadataMap): {
  properties: PreviewProperty[]
  tags: PreviewTag[]
  related: PreviewTag[]
} {
  const orderedKeys = Array.from(metadata.keys()).filter((key) => key !== 'ready_state').sort((a, b) => {
    const aIndex = KNOWN_METADATA_ORDER.indexOf(a as (typeof KNOWN_METADATA_ORDER)[number])
    const bIndex = KNOWN_METADATA_ORDER.indexOf(b as (typeof KNOWN_METADATA_ORDER)[number])
    if (aIndex === -1 && bIndex === -1) return a.localeCompare(b)
    if (aIndex === -1) return 1
    if (bIndex === -1) return -1
    return aIndex - bIndex
  })

  const allTags: PreviewTag[] = []
  const allRelated: PreviewTag[] = []
  const properties = orderedKeys.map((key) => {
    const values = (metadata.get(key) || []).map((value) => stripWrappingQuotes(value)).filter(Boolean)
    const rawValue = values.join(', ')

    if (values.length === 0) {
      return {
        key,
        label: PROPERTY_LABELS[key] || key,
        rawValue: '',
        displayValue: '—',
        kind: 'empty' as const,
      }
    }

    if (key === 'tags') {
      const chips = buildTagChips(values, 'tag')
      allTags.push(...chips)
      return {
        key,
        label: PROPERTY_LABELS[key] || key,
        rawValue,
        displayValue: chips.map((chip) => chip.label).join(', '),
        kind: 'chips' as const,
        chips,
      }
    }

    if (key === 'related') {
      const chips = buildTagChips(values, 'related')
      allRelated.push(...chips)
      return {
        key,
        label: PROPERTY_LABELS[key] || key,
        rawValue,
        displayValue: chips.map((chip) => chip.label).join(', '),
        kind: 'chips' as const,
        chips,
      }
    }

    if (values.every(isTagOnlyValue)) {
      const chips = buildTagChips(values, 'type')
      allTags.push(...chips)
      return {
        key,
        label: PROPERTY_LABELS[key] || key,
        rawValue,
        displayValue: chips.map((chip) => chip.label).join(', '),
        kind: 'chips' as const,
        chips,
      }
    }

    const scalar = values[values.length - 1]
    if (key === 'created' || key === 'published') {
      return {
        key,
        label: PROPERTY_LABELS[key] || key,
        rawValue,
        displayValue: formatDateValue(scalar),
        kind: 'text' as const,
      }
    }

    if (key === 'duration') {
      return {
        key,
        label: PROPERTY_LABELS[key] || key,
        rawValue,
        displayValue: formatDurationValue(scalar),
        kind: 'text' as const,
      }
    }

    if (/^https?:\/\//i.test(scalar)) {
      return {
        key,
        label: PROPERTY_LABELS[key] || key,
        rawValue,
        displayValue: scalar,
        kind: 'link' as const,
        href: scalar,
      }
    }

    return {
      key,
      label: PROPERTY_LABELS[key] || key,
      rawValue,
      displayValue: values.join(' · '),
      kind: 'text' as const,
    }
  })

  return {
    properties,
    tags: dedupeChips(allTags),
    related: dedupeChips(allRelated),
  }
}

function dedupeChips(chips: PreviewTag[]): PreviewTag[] {
  const map = new Map<string, PreviewTag>()
  chips.forEach((chip, index) => {
    const key = `${chip.kind}:${chip.label}`
    if (!map.has(key)) {
      map.set(key, {
        ...chip,
        id: chip.id || makeId(chip.kind, chip.label, index),
      })
    }
  })
  return Array.from(map.values())
}

function buildMetadataEmbed(metadata: MetadataMap, notePath: string | null | undefined): PreviewEmbed | null {
  const url = metadata.get('url')?.[0]
  if (!url) return null

  const videoId = extractYouTubeVideoId(url)
  if (!videoId) return null

  const resolvedUrl = resolveReference(url, notePath)
  const thumbnailRaw = metadata.get('thumbnailurl')?.[0]
  const thumbnail = thumbnailRaw ? resolveReference(thumbnailRaw, notePath).resolvedUrl : `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`

  return {
    id: makeId('embed', url, 0),
    kind: 'youtube',
    source: 'metadata',
    url: resolvedUrl.resolvedUrl,
    displayUrl: url,
    videoId,
    embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}?rel=0`,
    thumbnailUrl: thumbnail,
    title: metadata.get('title')?.[0],
    channel: metadata.get('channel')?.[0],
    published: metadata.get('published')?.[0] ? formatDateValue(metadata.get('published')?.[0] || '') : undefined,
    duration: metadata.get('duration')?.[0] ? formatDurationValue(metadata.get('duration')?.[0] || '') : undefined,
    localPath: resolvedUrl.localPath,
    isLocal: resolvedUrl.isLocal,
  }
}

function buildBodyEmbed(
  kind: PreviewEmbed['kind'],
  reference: string,
  notePath: string | null | undefined,
  options: Partial<PreviewEmbed> = {},
): PreviewEmbed {
  const resolved = resolveReference(reference, notePath)
  return {
    id: makeId('embed', `${kind}-${reference}`, 0),
    kind,
    source: 'body',
    url: resolved.resolvedUrl,
    displayUrl: resolved.displayUrl,
    localPath: resolved.localPath,
    isLocal: resolved.isLocal,
    ...options,
  }
}

function parseStandaloneTagLine(line: string): PreviewTag[] | null {
  const trimmed = line.trim()
  const matches = trimmed.match(TAG_TOKEN_PATTERN)
  if (!matches || matches.length === 0) return null

  const rest = trimmed.replace(TAG_TOKEN_PATTERN, '').replace(/[，,\s]+/g, '')
  if (rest.length > 0) return null

  return dedupeChips(
    matches.map((tag, index) => ({
      id: makeId(tag.startsWith('#type/') ? 'type' : 'tag', tag, index),
      label: tag,
      raw: tag,
      kind: tag.startsWith('#type/') ? 'type' : 'tag',
    })),
  )
}

function parseStandaloneEmbedLine(
  line: string,
  notePath: string | null | undefined,
): PreviewEmbed | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  const bilibili = extractBilibiliEmbed(trimmed)
  if (bilibili) {
    return buildBodyEmbed('bilibili', bilibili.pageUrl, notePath, {
      videoId: bilibili.bvid,
      embedUrl: bilibili.embedUrl,
    })
  }

  const markdownImage = parseMarkdownImageLine(trimmed)
  if (markdownImage) {
    return buildBodyEmbed('image', markdownImage.target, notePath, {
      alt: markdownImage.alt,
    })
  }

  const obsidianEmbed = parseObsidianEmbed(trimmed)
  if (obsidianEmbed) {
    if (obsidianEmbed.kind === 'image') {
      return buildBodyEmbed('image', obsidianEmbed.target, notePath, {
        alt: obsidianEmbed.label,
      })
    }
    return buildBodyEmbed('video', obsidianEmbed.target, notePath, {
      title: obsidianEmbed.label,
    })
  }

  if (/^https?:\/\/\S+$/i.test(trimmed)) {
    const youtubeId = extractYouTubeVideoId(trimmed)
    if (youtubeId) {
      return buildBodyEmbed('youtube', trimmed, notePath, {
        videoId: youtubeId,
        embedUrl: `https://www.youtube-nocookie.com/embed/${youtubeId}?rel=0`,
        thumbnailUrl: `https://i.ytimg.com/vi/${youtubeId}/maxresdefault.jpg`,
      })
    }

    const extension = getReferenceExtension(trimmed)
    if (IMAGE_EXTENSIONS.has(extension)) {
      return buildBodyEmbed('image', trimmed, notePath)
    }
    if (VIDEO_EXTENSIONS.has(extension)) {
      return buildBodyEmbed('video', trimmed, notePath)
    }
  }

  return null
}

function shouldPromoteToSectionHeading(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return false
  if (!SECTION_HEADING_TITLES.has(trimmed.toLowerCase())) return false
  return true
}

type MarkdownFenceMarker = { marker: '`' | '~'; length: number }

function normalizeMarkdownBlockSource(lines: string[]): string {
  return normalizeObsidianMarkdownEmbeds(
    lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
  )
}

interface MarkdownLineBuffer {
  lines: string[]
  lineIndices: number[]
}

function flushMarkdownBlock(
  buffer: MarkdownLineBuffer,
  blocks: PreviewBlock[],
  indexRef: { value: number },
  rangeForLines: (firstLineIndex: number, lastLineIndex: number) => PreviewBlockSourceRange | null,
): void {
  if (buffer.lines.length === 0) return
  const markdown = normalizeMarkdownBlockSource(buffer.lines)
  // Trim the buffered span to its non-blank extent so the recorded range never
  // swallows the blank separator lines around the block.
  let firstContent = 0
  while (firstContent < buffer.lines.length && buffer.lines[firstContent].trim().length === 0) firstContent += 1
  let lastContent = buffer.lines.length - 1
  while (lastContent >= 0 && buffer.lines[lastContent].trim().length === 0) lastContent -= 1
  const source = firstContent <= lastContent
    ? rangeForLines(buffer.lineIndices[firstContent], buffer.lineIndices[lastContent])
    : null
  buffer.lines.length = 0
  buffer.lineIndices.length = 0
  if (!markdown) return

  blocks.push({
    id: makeId('markdown', `block-${indexRef.value}`, indexRef.value),
    type: 'markdown',
    markdown,
    source,
  })
  indexRef.value += 1
}

function getMarkdownFenceMarker(line: string): MarkdownFenceMarker | null {
  const match = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/)
  if (!match) return null
  const fence = match[1]
  return {
    marker: fence[0] as '`' | '~',
    length: fence.length,
  }
}

function isMarkdownFenceClosing(line: string, fence: MarkdownFenceMarker): boolean {
  const regex = fence.marker === '`'
    ? /^[ \t]{0,3}(`{3,})[ \t]*$/
    : /^[ \t]{0,3}(~{3,})[ \t]*$/
  const match = line.match(regex)
  return Boolean(match && match[1].length >= fence.length)
}

function parseDetailsOpenLine(line: string): { open: boolean } | null {
  const match = line.match(/^<details(\s+open)?\s*>$/i)
  if (!match) return null
  return { open: Boolean(match[1]) }
}

function parseDetailsSummaryLine(line: string): string | null {
  const match = line.match(/^<summary>\s*([\s\S]*?)\s*<\/summary>$/i)
  return match ? match[1].trim() : null
}

function isDetailsCloseLine(line: string): boolean {
  return /^<\/details>$/i.test(line)
}

function findDetailsCloseLineIndex(lines: string[], startIndex: number): number {
  let activeFence: MarkdownFenceMarker | null = null

  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index]
    if (activeFence) {
      if (isMarkdownFenceClosing(line, activeFence)) {
        activeFence = null
      }
      continue
    }

    const openingFence = getMarkdownFenceMarker(line)
    if (openingFence) {
      activeFence = openingFence
      continue
    }

    if (isDetailsCloseLine(line.trim())) {
      return index
    }
  }

  return -1
}

function parseBodyBlocks(
  content: string,
  notePath: string | null | undefined,
  existingEmbeds: PreviewEmbed[],
  baseOffset: number | null,
): {
  blocks: PreviewBlock[]
  bodyMarkdown: string
  embeds: PreviewEmbed[]
  widgets: DocumentWidgetData[]
  tags: PreviewTag[]
} {
  const blocks: PreviewBlock[] = []
  const tags: PreviewTag[] = []
  const embeds: PreviewEmbed[] = []
  const widgets: DocumentWidgetData[] = []
  const blockIndex = { value: 0 }
  const body = normalizeLineEndings(content)
  const widgetSegments = parseShowWidgetFences(body)

  // Source-range bookkeeping. Top-level fence segments are verbatim ordered
  // slices of `body`, so a plain arithmetic cursor recovers their offsets.
  // Bare-widget subsegments inside a text segment are located with a forward
  // indexOf and verified; any mismatch marks mapping as broken from that point
  // on (ranges become null → blocks degrade to read-only, never mis-edited).
  const rangeState = { broken: baseOffset === null }
  let segmentCursor = 0

  widgetSegments.forEach((segment) => {
    const segmentLength = segment.type === 'widget' ? segment.data.rawFence.length : segment.content.length
    const segmentStart = segmentCursor
    segmentCursor += segmentLength

    const toAbsoluteRange = (localStart: number, localEnd: number): PreviewBlockSourceRange | null => {
      if (rangeState.broken || baseOffset === null) return null
      if (localStart < 0 || localEnd < localStart) return null
      return { start: baseOffset + localStart, end: baseOffset + localEnd }
    }

    if (segment.type === 'widget' || segment.type === 'invalid-widget') {
      const source = toAbsoluteRange(segmentStart, segmentStart + segmentLength)
      if (segment.type === 'widget') {
        const widgetId = segment.data.id || makeId('widget', segment.data.title || `widget-${widgets.length}`, widgets.length)
        widgets.push({
          id: widgetId,
          ...segment.data,
        })
        blocks.push({
          id: makeId('widget-block', widgetId, blockIndex.value),
          type: 'widget',
          widgetId,
          source,
        })
      } else {
        blocks.push({
          id: makeId('widget-error', segment.reason, blockIndex.value),
          type: 'widget_error',
          reason: segment.reason,
          source,
        })
      }
      blockIndex.value += 1
      return
    }

    const normalizedSegments = parseBareWidgetPayloadSegments(segment.content)
    let subCursor = 0

    normalizedSegments.forEach((subsegment) => {
      if (subsegment.type === 'widget') {
        const fence = subsegment.data.rawFence
        let subStart = -1
        if (!rangeState.broken) {
          const found = segment.content.indexOf(fence, subCursor)
          if (found >= 0) {
            subStart = found
            subCursor = found + fence.length
          } else {
            rangeState.broken = true
          }
        }
        const widgetId = subsegment.data.id || makeId('widget', subsegment.data.title || `widget-${widgets.length}`, widgets.length)
        widgets.push({
          id: widgetId,
          ...subsegment.data,
        })
        blocks.push({
          id: makeId('widget-block', widgetId, blockIndex.value),
          type: 'widget',
          widgetId,
          source: subStart >= 0 ? toAbsoluteRange(segmentStart + subStart, segmentStart + subStart + fence.length) : null,
        })
        blockIndex.value += 1
        return
      }

      if (subsegment.type === 'invalid-widget') {
        let subStart = -1
        if (!rangeState.broken) {
          const found = segment.content.indexOf(subsegment.content, subCursor)
          if (found >= 0) {
            subStart = found
            subCursor = found + subsegment.content.length
          } else {
            rangeState.broken = true
          }
        }
        blocks.push({
          id: makeId('widget-error', subsegment.reason, blockIndex.value),
          type: 'widget_error',
          reason: subsegment.reason,
          source: subStart >= 0 ? toAbsoluteRange(segmentStart + subStart, segmentStart + subStart + subsegment.content.length) : null,
        })
        blockIndex.value += 1
        return
      }

      // `parseBareWidgetPayloadSegments` re-appends a fixed `\n\n` after parts
      // that had a (possibly longer) blank-line separator in the source, so the
      // verbatim core is the content minus that appended tail.
      const core = subsegment.content.endsWith('\n\n')
        ? subsegment.content.slice(0, -2)
        : subsegment.content
      let subAbsStart = -1
      let subAbsEnd = -1
      if (!rangeState.broken && core.length > 0) {
        const found = segment.content.indexOf(core, subCursor)
        if (found >= 0) {
          subAbsStart = segmentStart + found
          subAbsEnd = subAbsStart + core.length
          subCursor = found + core.length
        } else {
          rangeState.broken = true
        }
      }

      const lines = subsegment.content.split('\n')
      // Start offset of each line, local to `body` (only valid when subAbsStart >= 0).
      const lineStarts: number[] = new Array(lines.length)
      let lineAcc = subAbsStart
      for (let index = 0; index < lines.length; index += 1) {
        lineStarts[index] = lineAcc
        lineAcc += lines[index].length + 1
      }
      const rangeForLines = (firstLineIndex: number, lastLineIndex: number): PreviewBlockSourceRange | null => {
        if (subAbsStart < 0) return null
        const start = lineStarts[firstLineIndex]
        const end = Math.min(lineStarts[lastLineIndex] + lines[lastLineIndex].length, subAbsEnd)
        if (typeof start !== 'number' || typeof end !== 'number' || end < start) return null
        return toAbsoluteRange(start, end)
      }

      const markdownBuffer: MarkdownLineBuffer = { lines: [], lineIndices: [] }
      const pushBufferLine = (line: string, lineIndex: number) => {
        markdownBuffer.lines.push(line)
        markdownBuffer.lineIndices.push(lineIndex)
      }
      let activeFence: MarkdownFenceMarker | null = null

      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex]
        const trimmed = line.trim()

        if (activeFence) {
          pushBufferLine(line, lineIndex)
          if (isMarkdownFenceClosing(line, activeFence)) {
            activeFence = null
          }
          continue
        }

        const openingFence = getMarkdownFenceMarker(line)
        if (openingFence) {
          activeFence = openingFence
          pushBufferLine(line, lineIndex)
          continue
        }

        const detailsOpen = parseDetailsOpenLine(trimmed)
        if (detailsOpen) {
          const closeIndex = findDetailsCloseLineIndex(lines, lineIndex + 1)
          if (closeIndex >= 0) {
            const detailsLines = lines.slice(lineIndex + 1, closeIndex)
            const summaryLineIndex = detailsLines.findIndex((item) => item.trim().length > 0)
            const summary = summaryLineIndex >= 0
              ? parseDetailsSummaryLine(detailsLines[summaryLineIndex].trim())
              : null
            const markdownLines = summary == null
              ? detailsLines
              : detailsLines.slice(summaryLineIndex + 1)
            const markdown = normalizeMarkdownBlockSource(markdownLines)

            flushMarkdownBlock(markdownBuffer, blocks, blockIndex, rangeForLines)
            blocks.push({
              id: makeId('details', summary || `details-${blockIndex.value}`, blockIndex.value),
              type: 'details',
              summary: summary || '详情',
              markdown,
              open: detailsOpen.open,
              source: rangeForLines(lineIndex, closeIndex),
            })
            blockIndex.value += 1
            lineIndex = closeIndex
            continue
          }
        }

        const tagLine = parseStandaloneTagLine(trimmed)
        if (tagLine) {
          flushMarkdownBlock(markdownBuffer, blocks, blockIndex, rangeForLines)
          const dedupedTags = dedupeChips(tagLine)
          blocks.push({
            id: makeId('chips', dedupedTags.map((tag) => tag.label).join('-'), blockIndex.value),
            type: 'chips',
            chips: dedupedTags,
            source: rangeForLines(lineIndex, lineIndex),
          })
          tags.push(...dedupedTags)
          blockIndex.value += 1
          continue
        }

        const embed = parseStandaloneEmbedLine(trimmed, notePath)
        if (embed) {
          const duplicate = [...existingEmbeds, ...embeds].some((item) => item.kind === embed.kind && item.displayUrl === embed.displayUrl)
          if (!duplicate) {
            flushMarkdownBlock(markdownBuffer, blocks, blockIndex, rangeForLines)
            const nextEmbed = { ...embed, id: makeId('embed', embed.displayUrl, embeds.length) }
            embeds.push(nextEmbed)
            blocks.push({
              id: makeId('embed-block', nextEmbed.displayUrl, blockIndex.value),
              type: 'embed',
              embedId: nextEmbed.id,
              source: rangeForLines(lineIndex, lineIndex),
            })
            blockIndex.value += 1
            continue
          }
        }

        if (shouldPromoteToSectionHeading(trimmed)) {
          pushBufferLine(`## ${trimmed}`, lineIndex)
          continue
        }

        pushBufferLine(line, lineIndex)
      }

      flushMarkdownBlock(markdownBuffer, blocks, blockIndex, rangeForLines)
    })
  })

  return {
    blocks,
    bodyMarkdown: blocks
      .filter((block): block is Extract<PreviewBlock, { type: 'markdown' }> => block.type === 'markdown')
      .map((block) => block.markdown)
      .join('\n\n')
      .trim(),
    embeds,
    widgets,
    tags: dedupeChips(tags),
  }
}

/**
 * Preview block source ranges refer to offsets inside THIS normalization of
 * the note text. Preview-edit operations must run on the same normalization
 * before splicing ranges.
 */
export function normalizePreviewNoteText(content: string): string {
  return normalizeLineEndings(content)
}

export function buildStructuredNotePreview(
  content: string,
  notePath?: string | null,
): StructuredNotePreview {
  const normalized = normalizeLineEndings(content)
  const frontmatterResult = splitFrontmatter(normalized)
  const headerResult = parseHeaderMetadata(frontmatterResult.body)
  const metadata = mergeMetadata(
    frontmatterResult.frontmatter ? metadataFromRecord(frontmatterResult.frontmatter) : new Map(),
    headerResult.metadata,
  )
  const propertyResult = buildProperties(metadata)
  const heroEmbed = buildMetadataEmbed(metadata, notePath)
  // Frontmatter + header metadata are consumed strictly from the front, so the
  // body is always a suffix of the normalized text. Guard it anyway: a broken
  // suffix invariant must disable source ranges, never misplace them.
  const bodyOffset = normalized.endsWith(headerResult.body)
    ? normalized.length - headerResult.body.length
    : null
  const bodyResult = parseBodyBlocks(
    headerResult.body,
    notePath,
    heroEmbed ? [heroEmbed] : [],
    bodyOffset,
  )
  const embeds = heroEmbed ? [heroEmbed, ...bodyResult.embeds] : bodyResult.embeds

  return {
    properties: propertyResult.properties,
    tags: dedupeChips([...propertyResult.tags, ...bodyResult.tags]),
    related: propertyResult.related,
    embeds,
    widgets: bodyResult.widgets,
    heroEmbed,
    bodyMarkdown: bodyResult.bodyMarkdown,
    blocks: bodyResult.blocks,
    warnings: frontmatterResult.warnings,
  }
}

export function resolvePreviewReference(reference: string, notePath?: string | null): {
  displayUrl: string
  resolvedUrl: string
  localPath: string | null
  isLocal: boolean
  extension: string
} {
  const resolved = resolveReference(reference, notePath)
  return {
    ...resolved,
    extension: getReferenceExtension(reference),
  }
}
