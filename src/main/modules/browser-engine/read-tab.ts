import { createHash } from 'node:crypto'
import { JSDOM } from 'jsdom'
import { ReadabilityJsdomAdapter } from '../clipping/readability-jsdom-adapter'
import { buildSanitizerBundle, decodeSanitizerResult } from '../clipping/privacy-sanitizer'
import type { BrowserReadResult } from '../../../shared/browser-shell'

export const MAX_READER_DOM_BYTES = 5 * 1024 * 1024
// Bound the response before it crosses the process boundary; also verify bytes in Main.
export const READ_TAB_SCRIPT = `(() => {
  const result = ${buildSanitizerBundle({ preservePagination: true })};
  if (result.ok && new TextEncoder().encode(result.html).byteLength > ${MAX_READER_DOM_BYTES}) return { ok: false, reason: 'too_large' };
  return result;
})()`

export async function extractRenderedArticle(tabId: string, url: string, raw: unknown): Promise<BrowserReadResult> {
  if (raw && typeof raw === 'object' && 'reason' in raw && raw.reason === 'too_large') return { success: false, error: 'too_large' }
  const { result } = decodeSanitizerResult(raw)
  if (!result.ok) return { success: false, error: result.reason === 'unsupported_protocol' ? 'unsupported_protocol' : 'not_readable' }
  if (!result.stable || result.url !== url || result.finalUrl !== url) return { success: false, error: 'page_changed' }
  if (Buffer.byteLength(result.html, 'utf8') > MAX_READER_DOM_BYTES) return { success: false, error: 'too_large' }
  // Same Markdown extractor as RSS, with executable markup removed before extraction.
  const dom = new JSDOM(result.html, { url })
  const doc = dom.window.document
  for (const node of doc.querySelectorAll('script, style, iframe, object, embed, form')) node.remove()
  for (const node of doc.querySelectorAll('*')) {
    for (const attribute of [...node.attributes]) {
      if (/^on/i.test(attribute.name) || attribute.name === 'srcdoc') node.removeAttribute(attribute.name)
    }
  }
  for (const image of doc.querySelectorAll('img')) {
    for (const attribute of [...image.attributes]) {
      if (attribute.name !== 'src' && attribute.name !== 'alt' && attribute.name !== 'title') image.removeAttribute(attribute.name)
    }
    const source = image.getAttribute('src')
    const parsed = source && URL.parse(source, doc.baseURI)
    if (!parsed || !['http:', 'https:', 'data:'].includes(parsed.protocol)) image.remove()
    else image.setAttribute('src', parsed.href)
  }
  const html = doc.documentElement.outerHTML
  dom.window.close()
  const extracted = await new ReadabilityJsdomAdapter({ tables: 'markdown' }).extract({ html, url, sanitized: true })
  const text = extracted.contentMarkdown
  if (Buffer.byteLength(text, 'utf8') > MAX_READER_DOM_BYTES) return { success: false, error: 'too_large' }
  if (!text.trim() || extracted.diagnostics.confidence < 0.4) return { success: false, error: 'not_readable' }
  const revision = createHash('sha256').update(url).update(text).digest('hex')
  const timestamp = Date.now(), date = Date.parse(extracted.metadata.published || '')
  const publishedAt = Number.isFinite(date) ? date : null
  const byline = extracted.metadata.author || null, siteName = extracted.metadata.site || new URL(url).hostname
  const title = extracted.title || result.title
  return { success: true, data: {
    url, title, byline, siteName, publishedAt, lang: extracted.metadata.lang || result.lang || null,
    article: { id: `browser:${tabId}:${revision}`, revision, sourceRevision: revision, sourceId: '', source: siteName,
      title, link: url, summary: extracted.metadata.description || '', author: byline, publishedAt, collectedAt: timestamp,
      coverImage: null, read: true, starred: false, inboxVisible: false, classifications: [], bodyStatus: 'ready' },
    body: { fetching: false, status: 'ready', revision, fetchedAt: timestamp, sourceUrl: url, error: null },
    text, textKind: 'body', offset: 0, totalLength: text.length, nextOffset: null,
  } }
}
