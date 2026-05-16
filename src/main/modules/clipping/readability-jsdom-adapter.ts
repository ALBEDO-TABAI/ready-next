/**
 * P1.6 — `ReadabilityJsdomAdapter` 实现。
 *
 * 移植自 standalone skill `clip-page.mjs` 的 extractPageData 逻辑：jsdom
 * 解析 → @mozilla/readability 抽正文 → turndown(+gfm) 转 markdown，meta 与
 * JSON-LD 在同一遍 DOM 中扫描。Phase 1 保持行为一致是为了让 P1.9 fixture
 * 快照可作为 Phase 2 defuddle swap 的回归 gate。
 *
 * 该模块对 jsdom 的 require 走异步动态 import：jsdom 在 Electron renderer
 * 上下文里加载失败时（用不到，但避免误链路），整个 web_clip_url 应当返回
 * `clip_parse_failed`，由 caller 负责映射；adapter 自己不抛出非 Error。
 */

import { Readability } from '@mozilla/readability'
import { JSDOM } from 'jsdom'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'

import type {
  ExtractionAdapter,
  ExtractionDiagnostics,
  ExtractionInput,
  ExtractionMetadata,
  ExtractionResult,
} from './extraction-adapter'

const READ_CONFIDENCE_FULL = 0.85
const READ_CONFIDENCE_PARTIAL = 0.55
const READ_CONFIDENCE_NONE = 0.25
const MIN_CONTENT_CHARS = 200

export class ReadabilityJsdomAdapter implements ExtractionAdapter {
  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    const dom = new JSDOM(input.html, {
      url: input.url,
      contentType: 'text/html',
    })
    const document = dom.window.document
    const structuredData = parseJsonLd(document)
    const metaLookup = buildMetaLookup(document)

    // Some CMSes (RebelMouse listicle-slideshow most notably) only render
    // the current gallery slide into visible DOM; the remaining 18+ slides'
    // <img> elements ship inside <noscript> or <script type="text/template">
    // for client-side hydration. JSDOM does not parse the inside of those
    // inert containers, so we "unseal" them — re-parse their innerHTML as a
    // DOM fragment and lift any <img> elements out to the parent so the
    // promotion + reconciliation passes can see them.
    unsealInertImageContainers(document, dom.window.document)

    // Lazy-loaded sites (Next.js Image, srcset, data-src, etc.) ship a
    // placeholder `src` and the real URL in attributes that only resolve
    // after JS runs. Promote them BEFORE readability so img survival heuristics
    // work and the resolved markdown has live URLs. Resolve relative paths
    // against the final page URL.
    promoteLazyImages(document, input.url)

    let readabilityArticle: ReturnType<Readability['parse']> = null
    try {
      const clone = document.cloneNode(true) as Document
      readabilityArticle = new Readability(clone).parse()
    } catch {
      readabilityArticle = null
    }

    let contentHtml = readabilityArticle?.content || document.body?.innerHTML || ''

    // Carousel/slideshow reconciliation. Some CMSes (RebelMouse, Glide,
    // Flickity) wrap gallery images in slideshow containers with prev/next
    // navigation UI. Readability tends to strip those entire containers
    // because the nav links/buttons make them look like UI chrome rather
    // than article content. We compare the image URLs surviving in the
    // readability article against the full set we found (and promoted) in
    // the original DOM; if a material number went missing, append them as
    // a `<figure>` sequence so turndown emits them in the final markdown.
    const articleImageUrls = collectImageUrls(contentHtml)
    const allDomImageUrls = collectImageUrlsFromDocument(document, input.url)
    const missing = filterContentImagesNotIn(allDomImageUrls, articleImageUrls)
    if (missing.length >= 3) {
      contentHtml = appendMissingImagesAsFigures(contentHtml, missing)
    }

    const turndown = createTurndownService(input.url)
    const contentMarkdown = turndown.turndown(contentHtml).trim()

    const title = readabilityArticle?.title?.trim() || document.title?.trim() || ''
    const description =
      readabilityArticle?.excerpt?.trim() ||
      metaLookup['name:description'] ||
      metaLookup['property:og:description'] ||
      ''
    const author = guessAuthor(metaLookup, structuredData)
    const published = guessPublished(metaLookup, structuredData, document)
    const image = guessImage(metaLookup, structuredData)
    const site = guessSite(metaLookup, structuredData, input.url)
    const lang = document.documentElement.getAttribute('lang') || ''
    const wordCount = contentMarkdown ? contentMarkdown.split(/\s+/).filter(Boolean).length : 0

    const metadata: ExtractionMetadata = {
      author: author || undefined,
      published: published || undefined,
      description: description || undefined,
      image: image || undefined,
      site: site || undefined,
      lang: lang || undefined,
      wordCount: wordCount > 0 ? wordCount : undefined,
    }

    const cleanedTitle = cleanTitle(title, metadata.site || '')
    const warnings: string[] = []
    if (!readabilityArticle) warnings.push('readability_parse_returned_null')
    if (!contentMarkdown) warnings.push('content_markdown_empty')
    if (contentMarkdown && contentMarkdown.length < MIN_CONTENT_CHARS) {
      warnings.push('content_markdown_below_threshold')
    }

    const diagnostics: ExtractionDiagnostics = {
      extractionSource: 'readability',
      confidence: resolveConfidence(readabilityArticle, contentMarkdown),
      warnings,
    }

    return {
      title: cleanedTitle,
      contentMarkdown,
      metadata,
      structuredData,
      metaLookup,
      diagnostics,
    }
  }
}

function resolveConfidence(
  readabilityArticle: ReturnType<Readability['parse']>,
  contentMarkdown: string,
): number {
  if (!readabilityArticle) return READ_CONFIDENCE_NONE
  if (contentMarkdown.length >= MIN_CONTENT_CHARS) return READ_CONFIDENCE_FULL
  return READ_CONFIDENCE_PARTIAL
}

function createTurndownService(baseUrl: string): TurndownService {
  const service = new TurndownService({
    codeBlockStyle: 'fenced',
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
  })
  service.use(gfm)
  service.keep(['table', 'thead', 'tbody', 'tr', 'th', 'td'])
  service.addRule('absoluteImage', {
    filter: 'img',
    replacement(_content: string, node: unknown) {
      const img = node as { getAttribute?: (k: string) => string | null }
      const src = resolveImgSrc(img, baseUrl)
      if (!src) return ''
      const alt = img.getAttribute?.('alt') || ''
      return `![${alt}](${src})`
    },
  })
  service.addRule('figureCaption', {
    filter: 'figure',
    replacement(content: string, node: unknown) {
      const figure = node as {
        querySelector?: (selector: string) => { getAttribute?: (k: string) => string | null; textContent?: string } | null
      }
      const img = figure.querySelector?.('img')
      if (!img) return `\n\n${content}\n\n`
      const src = resolveImgSrc(img, baseUrl)
      if (!src) return `\n\n${content}\n\n`
      const alt = img.getAttribute?.('alt') || ''
      const caption = figure.querySelector?.('figcaption')?.textContent?.trim() || ''
      let output = `![${alt}](${src})`
      if (caption) output += `\n\n_${caption}_`
      return `\n\n${output}\n\n`
    },
  })
  return service
}

const LAZY_SRC_ATTRS = [
  'data-src',
  'data-original',
  'data-lazy-src',
  'data-image-src',
  'data-actualsrc',
  'data-hi-res-src',
  'data-cms-src',
  'data-defer-src',
  'data-img-src',
  'data-image',
  'data-actual-src',
  'data-fallback-src',
  'data-orig-src',
  'data-large',
  'data-medium',
  'data-image-url',
  // RebelMouse CMS (PaperMag, Indy100, OK! Mag, Daily Dot, etc.) — the
  // real URL lives in data-runner-src; src is a viewbox-only SVG placeholder.
  'data-runner-src',
  // Flickity / Glide / Splide carousels.
  'data-flickity-lazyload',
  'data-flickity-lazyload-src',
  'data-glide-src',
  'data-splide-lazy',
  // Background-image patterns that some galleries reuse for <img>.
  'data-bg-src',
  'data-background-src',
  // BBC / Guardian / NYT internal CMSes.
  'data-source',
  'data-full-src',
  'data-zoom-src',
  // WeChat / Chinese CMS.
  'data-real-src',
] as const

const LAZY_SRCSET_ATTRS = [
  'data-srcset',
  'data-lazy-srcset',
  'data-actual-srcset',
  'data-runner-srcset',
] as const

const NOSCRIPT_IMG_RE = /<img\b[^>]*?\bsrc\s*=\s*"([^"]+)"[^>]*>/i
const NOSCRIPT_IMG_RE_SINGLE = /<img\b[^>]*?\bsrc\s*=\s*'([^']+)'[^>]*>/i

function unsealInertImageContainers(document: Document, ownerWindow: Document): void {
  // HTML5 <template> elements are the dominant inert container on modern
  // CMSes (RebelMouse listicle-slideshow uses ~13 of them on a 20-image
  // gallery). Their children live in `template.content` as a
  // DocumentFragment — `querySelectorAll('img')` on the main document
  // does NOT see them. We must access .content explicitly and clone any
  // <img> elements out so subsequent passes (promoteLazyImages, readability,
  // reconciliation) can find them.
  for (const tmpl of Array.from(document.querySelectorAll('template'))) {
    const node = tmpl as HTMLElement & { content?: DocumentFragment }
    const fragment = node.content
    if (!fragment) continue
    const imgs = Array.from(fragment.querySelectorAll('img'))
    if (imgs.length === 0) continue
    const parent = tmpl.parentNode
    if (!parent) continue
    for (const img of imgs) {
      parent.insertBefore(img.cloneNode(true), tmpl)
    }
  }

  // Legacy text-template patterns: `<script type="text/template">` and
  // friends store template HTML as `textContent`. We re-parse with a fresh
  // <div> sandbox and lift <img> out.
  const textTemplateSelectors = [
    'script[type="text/template"]',
    'script[type="text/x-template"]',
    'script[type="text/html"]',
  ]
  for (const selector of textTemplateSelectors) {
    for (const container of Array.from(document.querySelectorAll(selector))) {
      const inner = container.textContent || ''
      if (!inner.includes('<img')) continue
      const wrapper = ownerWindow.createElement('div')
      try {
        wrapper.innerHTML = inner
      } catch {
        continue
      }
      const lifted = Array.from(wrapper.querySelectorAll('img'))
      if (lifted.length === 0) continue
      const parent = container.parentNode
      if (!parent) continue
      for (const img of lifted) {
        parent.insertBefore(img, container)
      }
    }
  }

  // <noscript> sometimes ships a no-JS fallback <img>. JSDOM with default
  // settings already parses noscript children as DOM, but some snippets
  // arrive as text-only. Belt-and-suspenders re-parse.
  for (const noscript of Array.from(document.querySelectorAll('noscript'))) {
    if (noscript.querySelectorAll('img').length > 0) continue // already parsed
    const inner = noscript.textContent || ''
    if (!inner.includes('<img')) continue
    const wrapper = ownerWindow.createElement('div')
    try {
      wrapper.innerHTML = inner
    } catch {
      continue
    }
    const lifted = Array.from(wrapper.querySelectorAll('img'))
    if (lifted.length === 0) continue
    const parent = noscript.parentNode
    if (!parent) continue
    for (const img of lifted) {
      parent.insertBefore(img, noscript)
    }
  }
}

function promoteLazyImages(document: Document, baseUrl: string): void {
  // Promote `<picture><source srcset=...>` siblings onto the inner <img>
  // before the per-img scan, so a fully empty <img> still inherits the
  // largest <source> candidate.
  for (const picture of Array.from(document.querySelectorAll('picture'))) {
    const img = picture.querySelector('img')
    if (!img) continue
    const currentSrc = img.getAttribute('src')?.trim() || ''
    if (currentSrc && !looksLikePlaceholder(currentSrc)) continue
    const sources = Array.from(picture.querySelectorAll('source'))
    let best = ''
    for (const source of sources) {
      const srcset =
        source.getAttribute('srcset')?.trim() ||
        source.getAttribute('data-srcset')?.trim() ||
        ''
      if (!srcset) continue
      const picked = pickLargestFromSrcset(srcset)
      if (picked) {
        best = picked
        break // <source> elements are ordered by media query preference; first hit is the chosen one
      }
    }
    if (best) img.setAttribute('src', best)
  }

  for (const img of Array.from(document.querySelectorAll('img'))) {
    const current = img.getAttribute('src')?.trim() || ''
    let resolved = looksLikePlaceholder(current) ? '' : current
    if (!resolved) {
      for (const attr of LAZY_SRC_ATTRS) {
        const candidate = img.getAttribute(attr)?.trim()
        if (candidate) {
          resolved = candidate
          break
        }
      }
    }
    if (!resolved) {
      const srcset = img.getAttribute('srcset')?.trim()
      if (srcset) resolved = pickLargestFromSrcset(srcset)
    }
    if (!resolved) {
      for (const attr of LAZY_SRCSET_ATTRS) {
        const candidate = img.getAttribute(attr)?.trim()
        if (candidate) {
          const picked = pickLargestFromSrcset(candidate)
          if (picked) {
            resolved = picked
            break
          }
        }
      }
    }
    if (!resolved) {
      // Last-resort: many SEO-conscious sites mirror the real <img> inside
      // an adjacent <noscript> so headless scrapers can still find it.
      const sibling = img.parentElement?.querySelector('noscript')?.textContent || ''
      if (sibling) {
        const match = NOSCRIPT_IMG_RE.exec(sibling) || NOSCRIPT_IMG_RE_SINGLE.exec(sibling)
        if (match) resolved = match[1]
      }
    }
    if (!resolved) continue
    const absolute = toAbsoluteUrl(resolved, baseUrl)
    if (absolute) img.setAttribute('src', absolute)
  }
}

const IMG_TAG_SRC_RE = /<img\b[^>]*?\bsrc\s*=\s*"([^"]+)"/gi

function collectImageUrls(html: string): Set<string> {
  const out = new Set<string>()
  for (const match of html.matchAll(IMG_TAG_SRC_RE)) {
    const src = match[1]
    if (src && /^https?:\/\//i.test(src)) out.add(normalizeImageUrl(src))
  }
  return out
}

function collectImageUrlsFromDocument(document: Document, baseUrl: string): { url: string; alt: string }[] {
  const seen = new Set<string>()
  const out: { url: string; alt: string }[] = []
  for (const img of Array.from(document.querySelectorAll('img'))) {
    // Skip 1×1 tracking / scorecard pixels.
    const w = parseInt(img.getAttribute('width') || '', 10)
    const h = parseInt(img.getAttribute('height') || '', 10)
    if (Number.isFinite(w) && Number.isFinite(h) && (w <= 16 || h <= 16)) continue
    // Skip site nav / logo / footer images.
    const classes = (img.getAttribute('class') || '').toLowerCase()
    if (/\b(site-footer|site-header|nav-|navigation|logo|menu|avatar|tracker|tracking)\b/.test(classes)) continue
    const src = img.getAttribute('src')?.trim() || ''
    if (!src || looksLikePlaceholder(src)) continue
    const absolute = toAbsoluteUrl(src, baseUrl)
    if (!absolute) continue
    const key = normalizeImageUrl(absolute)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ url: absolute, alt: img.getAttribute('alt')?.trim() || '' })
  }
  return out
}

function normalizeImageUrl(url: string): string {
  // Drop fragment + sort query params so the same image with different
  // width/quality params still dedupes.
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    const params = Array.from(parsed.searchParams.entries()).sort()
    parsed.search = ''
    for (const [k, v] of params) parsed.searchParams.append(k, v)
    return parsed.toString()
  } catch {
    return url
  }
}

function filterContentImagesNotIn(
  all: { url: string; alt: string }[],
  present: Set<string>,
): { url: string; alt: string }[] {
  // Use a path-only key for the present-set comparison so that the same
  // CDN image at different widths (e.g. `?width=980` vs `?width=1200`) is
  // recognized as already-present.
  const presentPaths = new Set<string>()
  for (const url of present) {
    try {
      const parsed = new URL(url)
      presentPaths.add(`${parsed.host}${parsed.pathname}`)
    } catch {
      presentPaths.add(url)
    }
  }
  const out: { url: string; alt: string }[] = []
  for (const item of all) {
    let key = item.url
    try {
      const parsed = new URL(item.url)
      key = `${parsed.host}${parsed.pathname}`
    } catch {
      // ignore
    }
    if (presentPaths.has(key)) continue
    out.push(item)
    presentPaths.add(key)
  }
  return out
}

function appendMissingImagesAsFigures(
  html: string,
  missing: { url: string; alt: string }[],
): string {
  const figures = missing.map(({ url, alt }) => {
    const safeAlt = alt.replace(/"/g, '&quot;')
    const safeUrl = url.replace(/"/g, '&quot;')
    return `<figure><img src="${safeUrl}" alt="${safeAlt}" /></figure>`
  })
  return `${html}\n<div data-clip-gallery-reconciled="true">\n${figures.join('\n')}\n</div>`
}

function looksLikePlaceholder(src: string): boolean {
  if (!src) return true
  if (src.startsWith('data:image/svg+xml')) return true
  if (src.startsWith('data:image/gif;base64,R0lGODlh')) return true
  if (/\b(blank|placeholder|spacer|transparent|loading|pixel)[._\-]/i.test(src)) return true
  return false
}

function resolveImgSrc(
  img: { getAttribute?: (k: string) => string | null },
  baseUrl: string,
): string {
  const direct = img.getAttribute?.('src')?.trim() || ''
  if (direct) {
    const absolute = toAbsoluteUrl(direct, baseUrl)
    if (absolute) return absolute
  }
  for (const attr of LAZY_SRC_ATTRS) {
    const candidate = img.getAttribute?.(attr)?.trim()
    if (candidate) {
      const absolute = toAbsoluteUrl(candidate, baseUrl)
      if (absolute) return absolute
    }
  }
  const srcset = img.getAttribute?.('srcset')?.trim()
  if (srcset) {
    const picked = pickLargestFromSrcset(srcset)
    if (picked) {
      const absolute = toAbsoluteUrl(picked, baseUrl)
      if (absolute) return absolute
    }
  }
  return ''
}

function pickLargestFromSrcset(srcset: string): string {
  // srcset: "url1 480w, url2 768w, url3 1200w" or "url1 1x, url2 2x"
  const entries = srcset
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const idx = part.lastIndexOf(' ')
      if (idx < 0) return { url: part, weight: 1 }
      const url = part.slice(0, idx).trim()
      const descriptor = part.slice(idx + 1).trim()
      let weight = 1
      const wMatch = descriptor.match(/^(\d+(?:\.\d+)?)w$/)
      const xMatch = descriptor.match(/^(\d+(?:\.\d+)?)x$/)
      if (wMatch) weight = parseFloat(wMatch[1])
      else if (xMatch) weight = parseFloat(xMatch[1]) * 1000
      return { url, weight }
    })
  if (entries.length === 0) return ''
  entries.sort((a, b) => b.weight - a.weight)
  return entries[0].url
}

function toAbsoluteUrl(href: string, baseUrl: string): string {
  if (!href) return ''
  if (/^data:/i.test(href)) return '' // never emit base64 placeholders
  if (/^https?:\/\//i.test(href)) return href
  if (/^\/\//.test(href)) return `https:${href}`
  try {
    return new URL(href, baseUrl).toString()
  } catch {
    return ''
  }
}

function parseJsonLd(document: Document): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = []
  for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    const raw = script.textContent?.trim()
    if (!raw) continue
    try {
      const parsed = JSON.parse(raw) as unknown
      flattenJsonLd(parsed, results)
    } catch {
      // ignore malformed blocks
    }
  }
  return results
}

function flattenJsonLd(value: unknown, output: Record<string, unknown>[]): void {
  if (!value) return
  if (Array.isArray(value)) {
    for (const item of value) flattenJsonLd(item, output)
    return
  }
  if (typeof value !== 'object') return
  const record = value as Record<string, unknown>
  output.push(record)
  if (Array.isArray(record['@graph'])) {
    flattenJsonLd(record['@graph'], output)
  }
}

function buildMetaLookup(document: Document): Record<string, string> {
  const lookup: Record<string, string> = {}
  for (const node of Array.from(document.querySelectorAll('meta'))) {
    const name = node.getAttribute('name')
    const property = node.getAttribute('property')
    const content = node.getAttribute('content')
    if (!content) continue
    if (name) lookup[`name:${name.toLowerCase()}`] = content.trim()
    if (property) lookup[`property:${property.toLowerCase()}`] = content.trim()
  }
  return lookup
}

function firstValue(...values: Array<string | undefined | null | unknown[]>): string {
  for (const value of values) {
    if (Array.isArray(value) && value.length > 0) {
      const head = value[0]
      if (typeof head === 'string' && head.trim()) return head.trim()
      if (head && typeof head === 'object') {
        const name = (head as Record<string, unknown>).name
        if (typeof name === 'string' && name.trim()) return name.trim()
      }
    }
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function getSchemaValues(
  schemaItems: Record<string, unknown>[],
  typeName: string | null,
  propertyPath: string,
): string[] {
  const out: string[] = []
  for (const item of schemaItems) {
    const types = Array.isArray(item['@type']) ? (item['@type'] as unknown[]) : [item['@type']]
    if (typeName) {
      const matched = types.some((t) => String(t).toLowerCase() === typeName.toLowerCase())
      if (!matched) continue
    }
    const value = getDeepValue(item, propertyPath)
    if (value !== undefined && value !== null && value !== '') {
      flattenAndPush(value, out)
    }
  }
  return out
}

function getDeepValue(target: unknown, propertyPath: string): unknown {
  if (!propertyPath) return target
  let current: unknown = target
  for (const key of propertyPath.split('.')) {
    if (current === undefined || current === null) return undefined
    if (Array.isArray(current)) {
      current = current.map((item) => getDeepValue(item, key)).filter((item) => item !== undefined)
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[key]
    } else {
      return undefined
    }
  }
  return current
}

function flattenAndPush(value: unknown, output: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) flattenAndPush(item, output)
  } else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.name === 'string' && record.name.trim()) output.push(record.name.trim())
    else if (typeof record['@id'] === 'string' && (record['@id'] as string).trim()) output.push((record['@id'] as string).trim())
    else if (typeof record.url === 'string' && record.url.trim()) output.push(record.url.trim())
  } else if (typeof value === 'string' && value.trim()) {
    output.push(value.trim())
  } else if (typeof value === 'number') {
    output.push(String(value))
  }
}

function guessAuthor(meta: Record<string, string>, schema: Record<string, unknown>[]): string {
  return firstValue(meta['name:author'], meta['property:article:author'], getSchemaValues(schema, null, 'author'))
}

function guessPublished(
  meta: Record<string, string>,
  schema: Record<string, unknown>[],
  document: Document,
): string {
  const timeElement =
    document.querySelector('time[datetime]')?.getAttribute('datetime') ||
    document.querySelector('meta[itemprop="datePublished"]')?.getAttribute('content') ||
    undefined
  return firstValue(
    meta['property:article:published_time'],
    meta['name:publishdate'],
    getSchemaValues(schema, null, 'datePublished'),
    timeElement || undefined,
  )
}

function guessImage(meta: Record<string, string>, schema: Record<string, unknown>[]): string {
  return firstValue(meta['property:og:image'], meta['name:twitter:image'], getSchemaValues(schema, null, 'image'))
}

function guessSite(
  meta: Record<string, string>,
  schema: Record<string, unknown>[],
  url: string,
): string {
  try {
    const hostname = new URL(url).hostname
    return firstValue(meta['property:og:site_name'], getSchemaValues(schema, 'WebSite', 'name'), hostname)
  } catch {
    return firstValue(meta['property:og:site_name'], getSchemaValues(schema, 'WebSite', 'name'))
  }
}

function cleanTitle(title: string, site: string): string {
  const trimmed = String(title || '').trim()
  if (!trimmed || !site) return trimmed
  const escaped = site.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const patterns = [
    new RegExp(`\\s*[|\\-–—]\\s*${escaped}\\s*$`, 'i'),
    new RegExp(`^\\s*${escaped}\\s*[|\\-–—]\\s*`, 'i'),
  ]
  for (const pattern of patterns) {
    if (pattern.test(trimmed)) return trimmed.replace(pattern, '').trim()
  }
  return trimmed
}
