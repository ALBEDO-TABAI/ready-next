/**
 * Readability keeps an article's text but sometimes drops its pictures: a lead figure above the body, slides that
 * ship in templates, a figure inside a layout wrapper. A dropped picture comes back only when it belongs to the
 * article in the source page, and it returns right after the kept block that preceded it there, so the body reads
 * as the page did instead of ending in a pile of images. Site chrome, teasers linking elsewhere and icons stay out.
 */

const TEXT_BLOCKS = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption, pre, td'
const CHROME = 'nav, aside, footer, dialog, form, [role="navigation"], [role="complementary"], [role="contentinfo"], [role="banner"]'
const DECORATIVE_CLASS = /\b(site-footer|site-header|nav-|navigation|logo|menu|avatar|tracker|tracking)\b/
const IMAGE_FILE = /\.(?:jpe?g|png|gif|webp|avif)(?:[?#]|$)/i
// Boxes inside an article that point readers elsewhere (the same family Readability treats as unlikely content).
const ELSEWHERE_BOX = /related|recommend|read-?next|more-stories|popular|trending|newsletter|share|social|sponsor|advert|outbrain|taboola|comment|sidebar|breadcrumb/i
const SHOW_ELEMENT = 1

function textKey(element: Element): string {
  const text = (element.textContent || '').replace(/\s+/g, ' ').trim()
  return text.length < 30 ? '' : text.slice(0, 80)
}

function imageKey(src: string | null, baseUrl: string): string | null {
  if (!src) return null
  try {
    const url = new URL(src, baseUrl)
    return /^https?:$/.test(url.protocol) ? `${url.host}${url.pathname}` : null
  } catch {
    return null
  }
}

/** Kept blocks inside a list, table or quote anchor their container, so a picture never lands inside one. */
function placement(block: Element): Element {
  return block.parentElement?.closest('ul, ol, dl, table, blockquote') ?? block
}

function restorablePicture(img: Element, region: Element, baseUrl: string): { url: string; alt: string } | null {
  const src = img.getAttribute('src')
  if (!imageKey(src, baseUrl) || img.closest(CHROME)) return null
  for (let box = img.parentElement; box && box !== region; box = box.parentElement) {
    if (ELSEWHERE_BOX.test(`${box.getAttribute('class') || ''} ${box.id}`)) return null
  }
  if (DECORATIVE_CLASS.test((img.getAttribute('class') || '').toLowerCase())) return null
  const width = parseInt(img.getAttribute('width') || '', 10)
  const height = parseInt(img.getAttribute('height') || '', 10)
  if (Number.isFinite(width) && Number.isFinite(height) && (width <= 16 || height <= 16 || (width <= 48 && height <= 48))) {
    return null
  }
  // A picture linking to another page is a teaser; one opening itself or a spot on this page is content.
  const link = img.closest('a[href]')
  if (link) {
    try {
      const target = new URL(link.getAttribute('href') || '', baseUrl)
      const page = new URL(baseUrl)
      if (!IMAGE_FILE.test(target.pathname) && `${target.host}${target.pathname}` !== `${page.host}${page.pathname}`) return null
    } catch {
      return null
    }
  }
  return { url: new URL(src!, baseUrl).toString(), alt: (img.getAttribute('alt') || '').trim() }
}

export function restoreMissingImages(contentHtml: string, source: Document, baseUrl: string): string {
  const host = source.createElement('div')
  host.innerHTML = contentHtml
  const kept = new Map<string, Element>()
  for (const block of Array.from(host.querySelectorAll(TEXT_BLOCKS))) {
    const key = textKey(block)
    if (key && !kept.has(key)) kept.set(key, block)
  }
  const sourceBlocks = new Map<string, Element>()
  for (const block of Array.from(source.body?.querySelectorAll(TEXT_BLOCKS) ?? [])) {
    const key = textKey(block)
    if (kept.has(key) && !sourceBlocks.has(key)) sourceBlocks.set(key, block)
  }
  const anchors = [...sourceBlocks.values()]
  if (anchors.length === 0) return contentHtml
  let common: Element | null = anchors[0]
  for (const anchor of anchors.slice(1)) {
    while (common && !common.contains(anchor)) common = common.parentElement
  }
  if (!common) return contentHtml
  const region = common.closest('article, main, [role="main"]') ?? common

  const present = new Set(Array.from(host.querySelectorAll('img')).flatMap((img) => imageKey(img.getAttribute('src'), baseUrl) ?? []))
  const firstKept = placement(kept.values().next().value as Element)
  const lastFigure = new Map<Element | null, Element>()
  let after: Element | null = null
  let restored = 0
  const walker = source.createTreeWalker(region, SHOW_ELEMENT)
  for (let node = walker.nextNode() as Element | null; node; node = walker.nextNode() as Element | null) {
    if (node.matches(TEXT_BLOCKS)) {
      const block = kept.get(textKey(node))
      if (block && sourceBlocks.get(textKey(node)) === node) after = placement(block)
      continue
    }
    if (node.tagName !== 'IMG') continue
    const key = imageKey(node.getAttribute('src'), baseUrl)
    const picture = key && !present.has(key) ? restorablePicture(node, region, baseUrl) : null
    if (!key || !picture) continue
    present.add(key)
    const figure = host.ownerDocument.createElement('figure')
    const img = figure.appendChild(host.ownerDocument.createElement('img'))
    img.setAttribute('src', picture.url)
    if (picture.alt) img.setAttribute('alt', picture.alt)
    const previous = lastFigure.get(after)
    if (previous) previous.after(figure)
    else if (after) after.after(figure)
    else firstKept.before(figure)
    lastFigure.set(after, figure)
    restored += 1
  }
  return restored > 0 ? host.innerHTML : contentHtml
}
