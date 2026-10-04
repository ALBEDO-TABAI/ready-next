/**
 * 平台专用正文抽取：这些页面的正文不在通用 Readability 能识别的结构里。
 *
 * - 小红书笔记页由脚本渲染，正文只在 `window.__INITIAL_STATE__` 的笔记数据里；
 *   通用路径会把整段状态 JSON 当成正文。
 * - Hacker News 帖子页整页是排版表格，通用路径只能留下一堆表格源码。
 *
 * 只读取页面已经给出的数据，不发额外请求；识别不出就返回 null 交回通用路径。
 */
import type { ExtractionMetadata } from './extraction-adapter'

export interface PlatformArticle {
  title: string
  contentMarkdown: string
  metadata: ExtractionMetadata
  /** The platform data was read completely, so a short body is still the whole article. */
  complete: boolean
}

export function extractPlatformArticle(document: Document, sourceUrl: string): PlatformArticle | null {
  let url: URL
  try { url = new URL(sourceUrl) } catch { return null }
  const host = url.hostname.replace(/^www\./, '')
  if (host === 'xiaohongshu.com' || host.endsWith('.xiaohongshu.com')) return extractXiaohongshuNote(document, url)
  if (host === 'news.ycombinator.com' && url.pathname === '/item') return extractHackerNewsItem(document, url)
  return null
}

// ── 小红书 ─────────────────────────────────────────────────────────────

interface XhsImage { urlDefault?: string; urlPre?: string; url?: string; infoList?: Array<{ imageScene?: string; url?: string }> }
interface XhsNote {
  noteId?: string; title?: string; desc?: string; type?: string; time?: number; ipLocation?: string
  user?: { nickname?: string }; tagList?: Array<{ name?: string }>; imageList?: XhsImage[]
}

function extractXiaohongshuNote(document: Document, url: URL): PlatformArticle | null {
  const state = readInitialState(document)
  const detailMap = (state?.note as { noteDetailMap?: Record<string, { note?: XhsNote }> } | undefined)?.noteDetailMap
  if (!detailMap) return null
  const idFromPath = url.pathname.match(/\/(?:explore|discovery\/item|item)\/([0-9a-f]{16,})/i)?.[1]
  const current = (state?.note as { currentNoteId?: string; firstNoteId?: string } | undefined)
  const key = [idFromPath, current?.currentNoteId, current?.firstNoteId].find((id) => id && detailMap[id]?.note)
    || Object.keys(detailMap).find((id) => detailMap[id]?.note?.noteId)
  const note = key ? detailMap[key]?.note : undefined
  if (!note || (!note.desc?.trim() && !note.imageList?.length && !note.title?.trim())) return null

  const images = (note.imageList || []).map(xhsImageUrl).filter((src): src is string => !!src)
  const desc = cleanXhsText(note.desc || '')
  const lines = desc.split(/\n+/).map((line) => line.trim()).filter(Boolean)
  // Tags the text does not already mention join its closing tag line, or form one.
  const tags = (note.tagList || []).map((tag) => tag.name?.trim()).filter((name): name is string => !!name && !desc.includes(`#${name}`)).map((name) => `#${name}`)
  const tagLine = lines.length && /^(?:#\S+\s*)+$/.test(lines[lines.length - 1]) ? lines.pop()! : ''
  const closingTags = [tagLine, ...tags].filter(Boolean).join(' ')
  // Pictures lead a note, as on Xiaohongshu itself; the text and its tags follow.
  const blocks: string[] = note.type === 'video'
    ? [images[0] ? `![视频封面](${images[0]})` : '', '_视频笔记：打开原文观看视频。_']
    : images.map((src, index) => `![图 ${index + 1}](${src})`)
  blocks.push(...lines.map(escapeMarkdownLine))
  if (closingTags) blocks.push(closingTags)

  return {
    title: cleanXhsText(note.title || '') || desc.split('\n')[0]?.slice(0, 80) || '小红书笔记',
    contentMarkdown: blocks.filter(Boolean).join('\n\n'),
    metadata: {
      author: note.user?.nickname || undefined,
      published: typeof note.time === 'number' && Number.isFinite(note.time) ? new Date(note.time).toISOString() : undefined,
      description: desc.slice(0, 200) || undefined,
      image: images[0],
      site: '小红书',
      lang: 'zh-CN',
    },
    complete: true,
  }
}

/** `__INITIAL_STATE__` is a JS literal: it may contain bare `undefined`, which JSON rejects. */
function readInitialState(document: Document): Record<string, unknown> | null {
  for (const script of Array.from(document.querySelectorAll('script'))) {
    const text = script.textContent || ''
    const start = text.indexOf('window.__INITIAL_STATE__')
    if (start < 0) continue
    const equals = text.indexOf('=', start)
    if (equals < 0) continue
    const literal = text.slice(equals + 1).trim().replace(/;\s*$/, '').replace(/(?<=[:[,]\s*)undefined(?=\s*[,}\]])/g, 'null')
    try {
      const value = JSON.parse(literal)
      if (value && typeof value === 'object') return value as Record<string, unknown>
    } catch {
      // silent-catch: an unreadable state literal falls back to generic extraction.
      return null
    }
  }
  return null
}

function xhsImageUrl(image: XhsImage): string | null {
  const candidate = image.infoList?.find((info) => info.imageScene === 'WB_DFT')?.url || image.urlDefault || image.url || image.urlPre
  if (!candidate) return null
  try {
    const parsed = new URL(candidate, 'https://www.xiaohongshu.com')
    if (parsed.protocol === 'http:') parsed.protocol = 'https:'
    return parsed.protocol === 'https:' ? parsed.href : null
  } catch { return null }
}

/** Topic links render as `#话题[话题]#` and stickers as `[名称R]` in the raw text. */
function cleanXhsText(value: string): string {
  return value.replace(/#([^#\n[]+)\[话题\]#/g, '#$1').replace(/\[[^\]\n]{1,8}R\]/g, '').replace(/[ \t]+\n/g, '\n').trim()
}

function escapeMarkdownLine(line: string): string {
  return line.replace(/^([#>*+-]|\d+\.)(?=\s)/, '\\$1')
}

// ── Hacker News ───────────────────────────────────────────────────────

const HN_TOP_COMMENTS = 8

function extractHackerNewsItem(document: Document, url: URL): PlatformArticle | null {
  const item = document.querySelector('table.fatitem') || document.querySelector('#hnmain')
  const titleLink = item?.querySelector('.titleline > a')
  if (!item || !titleLink) return null
  const title = text(titleLink)
  const href = absolute(titleLink.getAttribute('href') || '', url)
  const discussion = href === absolute(`item?id=${url.searchParams.get('id') || ''}`, url)
  const subline = item.querySelector('.subline') || item.querySelector('.subtext')
  const author = text(subline?.querySelector('.hnuser'))
  const points = text(subline?.querySelector('.score'))
  const age = subline?.querySelector('.age')
  const published = age?.getAttribute('title')?.split(' ')[0] || ''
  const commentCount = Array.from(subline?.querySelectorAll('a') || []).map(text).find((label) => /comments?$|discuss$/.test(label)) || ''

  const blocks: string[] = []
  blocks.push([points, author ? `by ${author}` : '', text(age), commentCount].filter(Boolean).join(' · '))
  if (href && !discussion) blocks.push(`原文链接：[${new URL(href).hostname.replace(/^www\./, '')}](${href})`)
  const toptext = item.querySelector('.toptext')
  if (toptext && text(toptext)) blocks.push(...paragraphs(toptext, url))

  const comments = Array.from(document.querySelectorAll('tr.comtr'))
    .filter((row) => (row.querySelector('td.ind')?.getAttribute('indent') || '0') === '0')
    .map((row) => ({ user: text(row.querySelector('.hnuser')), age: text(row.querySelector('.age')), body: row.querySelector('.commtext') }))
    .filter((comment): comment is { user: string; age: string; body: Element } => !!comment.body && !!text(comment.body))
  if (comments.length) {
    blocks.push(`## 评论`)
    for (const comment of comments.slice(0, HN_TOP_COMMENTS)) {
      blocks.push(`**${comment.user || 'anonymous'}**${comment.age ? ` · ${comment.age}` : ''}`)
      blocks.push(paragraphs(comment.body, url).map((paragraph) => paragraph.split('\n').map((line) => `> ${line}`).join('\n')).join('\n>\n'))
    }
    if (comments.length > HN_TOP_COMMENTS) blocks.push(`_还有 ${comments.length - HN_TOP_COMMENTS} 条一级评论，打开原文查看完整讨论。_`)
  }

  return {
    title,
    contentMarkdown: blocks.filter(Boolean).join('\n\n'),
    metadata: { author: author || undefined, published: published || undefined, site: 'Hacker News', lang: 'en' },
    complete: true,
  }
}

/** HN text uses bare text runs separated by `<p>`; keep links and code, drop the reply chrome. */
function paragraphs(root: Element, base: URL): string[] {
  const clone = root.cloneNode(true) as Element
  clone.querySelectorAll('.reply, .comhead, script, style').forEach((node) => node.remove())
  const out: string[] = []
  let current = ''
  const flush = () => { const value = current.replace(/\s+/g, ' ').trim(); if (value) out.push(value); current = '' }
  const walk = (node: Node) => {
    if (node.nodeType === 3) { current += node.textContent || ''; return }
    if (node.nodeType !== 1) return
    const element = node as Element
    const tag = element.tagName.toLowerCase()
    if (tag === 'p' || tag === 'br') flush()
    if (tag === 'pre') { flush(); out.push('```\n' + (element.textContent || '').replace(/\n+$/, '') + '\n```'); return }
    if (tag === 'a') {
      const href = absolute(element.getAttribute('href') || '', base)
      const label = (element.textContent || '').trim()
      current += href ? `[${label || href}](${href})` : label
      return
    }
    if (tag === 'i' || tag === 'em') { current += `*${(element.textContent || '').trim()}*`; return }
    if (tag === 'code') { current += `\`${(element.textContent || '').trim()}\``; return }
    element.childNodes.forEach(walk)
    if (tag === 'p' || tag === 'div') flush()
  }
  clone.childNodes.forEach(walk)
  flush()
  return out
}

function text(node: Element | null | undefined): string {
  return (node?.textContent || '').replace(/\s+/g, ' ').trim()
}

function absolute(href: string, base: URL): string {
  if (!href) return ''
  try {
    const parsed = new URL(href, base)
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : ''
  } catch { return '' }
}
