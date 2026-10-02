import { fromMarkdown } from 'mdast-util-from-markdown'
import { toMarkdown } from 'mdast-util-to-markdown'
import { gfmFromMarkdown, gfmToMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import type { Nodes, Parents, Root, RootContent } from 'mdast'
import type { RSSArticle } from './rss-workspace'
import { documentCodeBehavior } from './document-code-language'

function webUrl(value: string, base?: string): string | null {
  try {
    const url = new URL(value, base || undefined)
    if (!['http:', 'https:'].includes(url.protocol)) return null
    url.username = ''; url.password = ''
    return url.href
  } catch { return null }
}

const text = (value: string) => ({ type: 'text' as const, value })
function plain(node: Nodes): string {
  return 'value' in node ? node.value : 'children' in node ? node.children.map(plain).join('') : ''
}

/** Produce ordinary editable Markdown, without activating source-specific document blocks. */
export function sourceMarkdownForNote(markdown: string, baseUrl: string): Root {
  const tree = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  const definitions = new Map<string, string>()
  const collect = (node: Nodes) => {
    if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url)
    if ('children' in node) node.children.forEach(collect)
  }
  collect(tree)
  const clean = (node: Nodes, inline = false): Nodes | null => {
    if (node.type === 'definition') return null
    if (node.type === 'html') return inline ? text(node.value) : { type: 'paragraph', children: [text(node.value)] }
    if (node.type === 'code') return { ...node, lang: node.lang === 'show-widget' || documentCodeBehavior(`language-${node.lang || ''}`) !== 'code' ? 'text' : node.lang }
    if (node.type === 'imageReference') node = { type: 'image', alt: node.alt, url: definitions.get(node.identifier) || '' }
    if (node.type === 'linkReference') node = { type: 'link', children: node.children, url: definitions.get(node.identifier) || '' }
    if (node.type === 'link' || node.type === 'image') {
      const url = webUrl(node.url, baseUrl)
      if (!url) return text(`${node.type === 'image' ? node.alt || '图片' : plain(node)}（原链接：${node.url}）`)
      node.url = url
    }
    if ('children' in node) {
      const parent = node as Parents
      const phrasing = ['paragraph', 'heading', 'emphasis', 'strong', 'delete', 'link', 'tableCell'].includes(node.type)
      parent.children = parent.children.map((child) => clean(child, phrasing)).filter((child): child is NonNullable<typeof child> => child !== null) as typeof parent.children
    }
    return node
  }
  return clean(tree) as Root
}

export function buildRSSNote(article: RSSArticle): string {
  const hasBody = article.body.markdown !== null
  const scope = hasBody ? article.body.status === 'partial' ? '部分正文' : '已保存正文' : '来源摘要（未取得完整正文）'
  const original = webUrl(article.link)
  const header: RootContent[] = [
    { type: 'heading', depth: 1, children: [text(article.title.replace(/\s+/g, ' '))] },
    { type: 'paragraph', children: [text(`来源：${article.source}。内容范围：${scope}。`)] },
    { type: 'paragraph', children: original ? [{ type: 'link', url: original, children: [text('打开原文')] }] : [text('原文地址未提供或无法使用。')] },
    { type: 'paragraph', children: [text('这是一份可编辑副本，不会修改 RSS 原文。')] },
    { type: 'thematicBreak' },
  ]
  const body = sourceMarkdownForNote(article.body.markdown ?? article.summary, article.body.sourceUrl || article.link)
  return toMarkdown({ type: 'root', children: [...header, ...body.children] }, {
    extensions: [gfmToMarkdown()], fences: true, fence: '~',
    unsafe: [
      { character: '{', inConstruct: 'phrasing', notInConstruct: ['destinationRaw', 'destinationLiteral', 'autolink'] },
      { character: ':', inConstruct: 'phrasing', notInConstruct: ['destinationRaw', 'destinationLiteral', 'autolink'] },
    ],
  })
}
