import { mkdir, readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { basename, dirname, extname, join, posix } from 'path'
import { XMLParser } from 'fast-xml-parser'
import JSZip from 'jszip'
import TurndownService from 'turndown'
import { EBOOK_MARKDOWN_MARKER } from '../../../shared/ebook'

export interface EbookMarkdownImportResult {
  success: boolean
  outputDir?: string
  indexPath?: string
  assetCount?: number
  warnings?: string[]
  error?: string
  errorCode?: string
}

interface ManifestItem {
  id: string
  href: string
  mediaType: string
  properties?: string
}

interface SpineItem {
  idref: string
}

interface ParsedPackage {
  title: string
  baseDir: string
  manifest: Map<string, ManifestItem>
  spine: SpineItem[]
  tocPath?: string
  navPath?: string
}

interface EbookTocEntry {
  path: string
  title: string
  level: number
}

const IMAGE_MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/bmp',
])
const MAX_MARKDOWN_FILENAME_STEM_LENGTH = 120

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return []
  return Array.isArray(value) ? value : [value]
}

function normalizeZipPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '')
}

function resolveZipPath(baseDir: string, href: string): string {
  const decoded = decodeURIComponent(href.split('#')[0].split('?')[0] || '')
  const joined = normalizeZipPath(posix.normalize(posix.join(baseDir, decoded)))
  if (!joined || joined.startsWith('../') || joined.includes('/../')) return ''
  return joined
}

function safeAssetName(sourcePath: string, usedNames: Set<string>): string {
  const raw = basename(sourcePath).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'asset'
  const ext = extname(raw)
  const stem = ext ? raw.slice(0, -ext.length) : raw
  let candidate = raw
  let counter = 2
  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${stem || 'asset'}-${counter}${ext}`
    counter += 1
  }
  usedNames.add(candidate.toLowerCase())
  return candidate
}

function assetsDirForMarkdown(markdownPath: string): string {
  return join(dirname(markdownPath), `${basename(markdownPath, extname(markdownPath))}.assets`)
}

function uniqueMarkdownOutputPath(sourcePath: string, fileName: string): string {
  const parent = dirname(sourcePath)
  const ext = extname(fileName) || '.md'
  const stem = basename(fileName, ext) || 'ebook'
  let candidate = join(parent, `${stem}${ext}`)
  let counter = 2
  while (existsSync(candidate) || existsSync(assetsDirForMarkdown(candidate))) {
    candidate = join(parent, `${stem} ${counter}${ext}`)
    counter += 1
  }
  return candidate
}

function normalizeTitleText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function replaceUnsafeFilenameChars(value: string): string {
  const forbiddenChars = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])
  return Array.from(value)
    .map((char) => forbiddenChars.has(char) || char.charCodeAt(0) < 32 ? ' ' : char)
    .join('')
}

function safeMarkdownFileName(title: string): string {
  const stem = replaceUnsafeFilenameChars(normalizeTitleText(title))
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, MAX_MARKDOWN_FILENAME_STEM_LENGTH)
    .replace(/[. ]+$/g, '')
    .trim() || 'ebook'
  return `${stem}.md`
}

function resolveBookTitle(pkg: ParsedPackage, sourcePath: string): string {
  return normalizeTitleText(pkg.title)
    || normalizeTitleText(basename(sourcePath, extname(sourcePath)))
    || 'Untitled'
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) return extractText(value[0])
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record['#text'] === 'string') return record['#text'].trim()
  }
  return ''
}

function parsePackage(opfXml: string, opfPath: string): ParsedPackage {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    removeNSPrefix: true,
  })
  const parsed = parser.parse(opfXml) as Record<string, unknown>
  const pkg = (parsed.package || parsed.opf || {}) as Record<string, unknown>
  const metadata = (pkg.metadata || {}) as Record<string, unknown>
  const manifestNode = (pkg.manifest || {}) as Record<string, unknown>
  const spineNode = (pkg.spine || {}) as Record<string, unknown>

  const title = extractText(metadata.title)
  const manifest = new Map<string, ManifestItem>()
  for (const item of asArray(manifestNode.item as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
    const id = typeof item.id === 'string' ? item.id : ''
    const href = typeof item.href === 'string' ? item.href : ''
    const mediaType = typeof item['media-type'] === 'string' ? item['media-type'] : ''
    if (!id || !href) continue
    manifest.set(id, {
      id,
      href,
      mediaType,
      properties: typeof item.properties === 'string' ? item.properties : undefined,
    })
  }

  const spine = asArray(spineNode.itemref as Record<string, unknown> | Record<string, unknown>[] | undefined)
    .map((item) => ({ idref: typeof item.idref === 'string' ? item.idref : '' }))
    .filter((item) => item.idref)

  const baseDir = posix.dirname(normalizeZipPath(opfPath)).replace(/^\.$/, '')
  const spineTocId = typeof spineNode.toc === 'string' ? spineNode.toc : ''
  const tocItem = (spineTocId ? manifest.get(spineTocId) : undefined)
    || Array.from(manifest.values()).find((item) => item.mediaType === 'application/x-dtbncx+xml')
  const navItem = Array.from(manifest.values()).find((item) =>
    item.properties?.split(/\s+/).includes('nav'),
  )

  return {
    title,
    baseDir,
    manifest,
    spine,
    tocPath: tocItem ? resolveZipPath(baseDir, tocItem.href) : undefined,
    navPath: navItem ? resolveZipPath(baseDir, navItem.href) : undefined,
  }
}

async function findOpfPath(zip: JSZip): Promise<string> {
  const containerFile = zip.file('META-INF/container.xml')
  if (!containerFile) throw new Error('EPUB 缺少 META-INF/container.xml')
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    removeNSPrefix: true,
  })
  const parsed = parser.parse(await containerFile.async('text')) as Record<string, unknown>
  const container = (parsed.container || {}) as Record<string, unknown>
  const rootfiles = ((container.rootfiles || {}) as Record<string, unknown>).rootfile
  const rootfile = asArray(rootfiles as Record<string, unknown> | Record<string, unknown>[] | undefined)
    .find((item) => typeof item['full-path'] === 'string')
  const opfPath = typeof rootfile?.['full-path'] === 'string' ? rootfile['full-path'] : ''
  if (!opfPath) throw new Error('EPUB 缺少 OPF 包定义')
  return normalizeZipPath(opfPath)
}

function extractNavLabelText(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return extractText(value)
  const record = value as Record<string, unknown>
  return extractText(record.text) || extractText(record)
}

function parseNcxToc(ncxXml: string, tocBaseDir: string): EbookTocEntry[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    removeNSPrefix: true,
  })
  const parsed = parser.parse(ncxXml) as Record<string, unknown>
  const ncx = (parsed.ncx || {}) as Record<string, unknown>
  const navMap = (ncx.navMap || {}) as Record<string, unknown>
  const entries: EbookTocEntry[] = []

  const walk = (points: unknown, level: number) => {
    for (const point of asArray(points as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
      if (!point || typeof point !== 'object') continue
      const record = point as Record<string, unknown>
      const title = normalizeTitleText(extractNavLabelText(record.navLabel))
      const content = record.content && typeof record.content === 'object'
        ? record.content as Record<string, unknown>
        : null
      const src = typeof content?.src === 'string' ? content.src : ''
      const path = src ? resolveZipPath(tocBaseDir, src) : ''
      if (title && path) entries.push({ path, title, level })
      walk(record.navPoint, level + 1)
    }
  }

  walk(navMap.navPoint, 2)
  return entries
}

function parseNavToc(navHtml: string, navBaseDir: string): EbookTocEntry[] {
  const tocNav = navHtml.match(/<nav\b[^>]*(?:epub:type|type)\s*=\s*(['"])toc\1[^>]*>([\s\S]*?)<\/nav>/i)?.[2]
    || navHtml
  const entries: EbookTocEntry[] = []
  for (const match of tocNav.matchAll(/<a\b[^>]*\bhref\s*=\s*(['"])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = match[2] || ''
    const title = normalizeTitleText(stripHtmlTags(match[3] || ''))
    const path = href ? resolveZipPath(navBaseDir, href) : ''
    if (title && path) entries.push({ path, title, level: 2 })
  }
  return entries
}

async function readEpubToc(zip: JSZip, pkg: ParsedPackage): Promise<EbookTocEntry[]> {
  if (pkg.tocPath) {
    const tocFile = zip.file(pkg.tocPath)
    if (tocFile) return parseNcxToc(await tocFile.async('text'), posix.dirname(pkg.tocPath).replace(/^\.$/, ''))
  }
  if (pkg.navPath) {
    const navFile = zip.file(pkg.navPath)
    if (navFile) return parseNavToc(await navFile.async('text'), posix.dirname(pkg.navPath).replace(/^\.$/, ''))
  }
  return []
}

function stripUnsafeHtml(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(href|src|xlink:href)\s*=\s*(['"])\s*javascript:[\s\S]*?\2/gi, ' $1="#"')
    .replace(/\s+(href|src|xlink:href)\s*=\s*javascript:[^\s>]+/gi, ' $1="#"')
    .replace(/\s+class\s*=\s*(['"]).*?\1/gi, '')
    .replace(/\s+style\s*=\s*(['"]).*?\1/gi, '')
}

function stripHtmlTags(value: string): string {
  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function extractHtmlBody(html: string): string {
  const match = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)
  return match?.[1] ? match[1] : html
}

function hasHeadingNamed(html: string, title: string): boolean {
  const target = normalizeTitleText(title)
  if (!target) return false
  for (const match of html.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi)) {
    if (normalizeTitleText(stripHtmlTags(match[1] || '')) === target) return true
  }
  return false
}

function prependTocHeading(html: string, entry: EbookTocEntry | undefined): string {
  if (!entry?.title || hasHeadingNamed(html, entry.title)) return html
  const headingTag = entry.level <= 2 ? 'h1' : 'h2'
  return `<${headingTag}>${escapeHtmlText(entry.title)}</${headingTag}>\n${html}`
}

function normalizeFootnotes(html: string): string {
  return html
    .replace(
      /<a\b([^>]*?)\b(?:epub:type|type)\s*=\s*(['"])noteref\2([^>]*)>([\s\S]*?)<\/a>/gi,
      (_match, before: string, _quote: string, after: string, label: string) => {
        const attrs = `${before} ${after}`
        const href = attrs.match(/\bhref\s*=\s*(['"])(.*?)\1/i)?.[2] || ''
        const id = href.replace(/^#/, '').trim()
        const marker = label.replace(/<[^>]+>/g, '').trim() || id || 'note'
        return `[^${marker}]`
      },
    )
    .replace(
      /<(aside|section|div)\b([^>]*?)\b(?:epub:type|type)\s*=\s*(['"])footnote\3([^>]*)>([\s\S]*?)<\/\1>/gi,
      (_match, _tag: string, before: string, _quote: string, after: string, body: string) => {
        const attrs = `${before} ${after}`
        const id = attrs.match(/\bid\s*=\s*(['"])(.*?)\1/i)?.[2] || 'note'
        const marker = id.replace(/^fn[-_]?/i, '') || id
        return `<p>[^${marker}]: ${body}</p>`
      },
    )
}

function createTurndown(): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  })
  service.addRule('tableCell', {
    filter: ['th', 'td'],
    replacement(content) {
      return ` ${content.trim().replace(/\s*\n+\s*/g, ' ')} |`
    },
  })
  service.addRule('tableRow', {
    filter: 'tr',
    replacement(content, node) {
      const rowNode = node as {
        parentNode?: { querySelector?: (selector: string) => unknown }
        children?: ArrayLike<{ tagName?: string }>
      }
      const parent = rowNode.parentNode
      const firstRow = parent?.querySelector?.('tr') === node
      const children = Array.from(rowNode.children || [])
      const hasHeader = children.some((child) => child.tagName?.toLowerCase() === 'th')
      const row = `|${content.trim()}\n`
      if (!firstRow && !hasHeader) return row
      const cellCount = Math.max(1, children.filter((child) => {
        const tag = child.tagName?.toLowerCase()
        return tag === 'th' || tag === 'td'
      }).length)
      return `${row}|${Array.from({ length: cellCount }, () => ' --- |').join('')}\n`
    },
  })
  service.addRule('table', {
    filter: 'table',
    replacement(content) {
      return `\n\n${content.trim()}\n\n`
    },
  })
  return service
}

function normalizeMarkdownFootnotes(markdown: string): string {
  return markdown
    .replace(/\\\[\^([^\]\n]+)\\\]/g, '[^$1]')
    .replace(/(\[\^[^\]\n]+\]:)\s*\n+\s*/g, '$1 ')
}

function demoteMarkdownHeadings(markdown: string): string {
  let inFence = false
  return markdown.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      return line
    }
    if (inFence) return line
    return line.replace(/^(#{1,6})(\s+)/, (match, hashes: string, space: string) => {
      if (hashes.length >= 6) return match
      return `${hashes}#${space}`
    })
  }).join('\n')
}

async function rewriteAssets(
  zip: JSZip,
  html: string,
  baseDir: string,
  assetsDir: string,
  usedAssetNames: Set<string>,
  warnings: string[],
): Promise<{ html: string; assetCount: number }> {
  let assetCount = 0
  const replacements: Array<{ raw: string; next: string }> = []
  const attrRegex = /\s(src|href)\s*=\s*(['"])([^'"]+)\2/gi
  for (const match of html.matchAll(attrRegex)) {
    const raw = match[0]
    const attr = match[1].toLowerCase()
    const value = match[3]
    if (!value || /^(https?:|data:|mailto:|#|javascript:)/i.test(value)) continue
    const resolved = resolveZipPath(baseDir, value)
    if (!resolved) continue
    const file = zip.file(resolved)
    if (!file) continue
    const lower = resolved.toLowerCase()
    const isImage = IMAGE_MEDIA_TYPES.has(file.comment || '') || /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(lower)
    if (!isImage || attr !== 'src') continue
    const assetName = safeAssetName(resolved, usedAssetNames)
    await mkdir(assetsDir, { recursive: true })
    await writeFile(join(assetsDir, assetName), await file.async('nodebuffer'))
    assetCount += 1
    replacements.push({ raw, next: ` src="${basename(assetsDir)}/${assetName}"` })
  }
  let nextHtml = html
  for (const replacement of replacements) {
    nextHtml = nextHtml.split(replacement.raw).join(replacement.next)
  }
  if (assetCount === 0 && /<img\b/i.test(html)) {
    warnings.push('部分图片资源未能解析，已保留正文内容。')
  }
  return { html: nextHtml, assetCount }
}

export async function importEpubAsMarkdown(sourcePath: string): Promise<EbookMarkdownImportResult> {
  try {
    if (extname(sourcePath).toLowerCase() !== '.epub') {
      return {
        success: false,
        error: '当前只支持 EPUB 导入',
        errorCode: 'UNSUPPORTED_EBOOK_IMPORT',
      }
    }

    const zip = await JSZip.loadAsync(await readFile(sourcePath))
    const opfPath = await findOpfPath(zip)
    const opfFile = zip.file(opfPath)
    if (!opfFile) throw new Error('EPUB OPF 文件不存在')

    const pkg = parsePackage(await opfFile.async('text'), opfPath)
    const bookTitle = resolveBookTitle(pkg, sourcePath)
    const indexPath = uniqueMarkdownOutputPath(sourcePath, safeMarkdownFileName(bookTitle))
    const assetsDir = assetsDirForMarkdown(indexPath)

    const turndown = createTurndown()
    const usedAssetNames = new Set<string>()
    const warnings: string[] = []
    const sections: string[] = []
    let assetCount = 0
    const tocEntries = await readEpubToc(zip, pkg)
    const tocByPath = new Map<string, EbookTocEntry>()
    for (const entry of tocEntries) {
      if (!tocByPath.has(entry.path)) tocByPath.set(entry.path, entry)
    }

    for (const spineItem of pkg.spine) {
      const manifestItem = pkg.manifest.get(spineItem.idref)
      if (!manifestItem) {
        warnings.push(`跳过缺失章节：${spineItem.idref}`)
        continue
      }
      const chapterPath = resolveZipPath(pkg.baseDir, manifestItem.href)
      const chapterFile = chapterPath ? zip.file(chapterPath) : null
      if (!chapterFile) {
        warnings.push(`跳过无法读取的章节：${manifestItem.href}`)
        continue
      }
      const chapterBase = posix.dirname(chapterPath).replace(/^\.$/, '')
      const rawHtml = stripUnsafeHtml(normalizeFootnotes(await chapterFile.async('text')))
      const bodyHtml = prependTocHeading(extractHtmlBody(rawHtml), tocByPath.get(chapterPath))
      const rewritten = await rewriteAssets(zip, bodyHtml, chapterBase, assetsDir, usedAssetNames, warnings)
      assetCount += rewritten.assetCount
      const markdown = demoteMarkdownHeadings(normalizeMarkdownFootnotes(turndown.turndown(rewritten.html)))
        .replace(/\n{3,}/g, '\n\n')
        .trim()
      if (markdown) sections.push(markdown)
    }

    if (sections.length === 0) {
      throw new Error('EPUB 没有可导入的正文')
    }

    const warningBlock = warnings.length > 0
      ? `\n\n<!-- 导入提示：${warnings.join('；')} -->`
      : ''
    const markdown = `${EBOOK_MARKDOWN_MARKER}\n\n# ${bookTitle}\n\n${sections.join('\n\n')}${warningBlock}\n`
    await writeFile(indexPath, markdown, 'utf-8')

    return {
      success: true,
      outputDir: dirname(indexPath),
      indexPath,
      assetCount,
      warnings,
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      errorCode: 'EBOOK_IMPORT_FAILED',
    }
  }
}
