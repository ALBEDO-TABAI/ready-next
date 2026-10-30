import type { PhrasingContent } from 'mdast'
import { toMarkdown } from 'mdast-util-to-markdown'
import { gfmToMarkdown } from 'mdast-util-gfm'
import { decodeString } from 'micromark-util-decode-string'
import { markdownTree } from './markdown'
import { isDocumentColor, type DocumentColor } from './palette'
import { parseReadyUri, toReadyUri, type ReadyRef } from '../ready-ref'

export type InlineReference = { kind: 'link'; href: string; title?: string }
  | { kind: 'wiki'; target: string } | { kind: 'ready'; ref: ReadyRef }
export interface InlineMarks {
  bold?: true; italic?: true; strike?: true; code?: true; underline?: true
  color?: DocumentColor; background?: DocumentColor; reference?: InlineReference
}
export interface InlineSpan { text: string; marks: InlineMarks }
export interface InlineModel {
  capability: 'rich'; source: string; spans: InlineSpan[]; baseline: string; prefix: string; suffix: string
}
export interface InlineSourceOnly { capability: 'source'; source: string; reason: string }

function markKey(m: InlineMarks): string {
  return JSON.stringify([Boolean(m.bold), Boolean(m.italic), Boolean(m.strike), Boolean(m.code), Boolean(m.underline), m.color, m.background,
    m.reference?.kind === 'ready' ? ['ready', toReadyUri(m.reference.ref)] : m.reference?.kind === 'wiki' ? ['wiki', m.reference.target]
      : m.reference ? ['link', m.reference.href, m.reference.title] : null])
}
function normalize(spans: readonly InlineSpan[]): InlineSpan[] {
  const result: InlineSpan[] = []
  for (const span of spans) {
    if (!span.text) continue
    const previous = result[result.length - 1]
    if (previous && markKey(previous.marks) === markKey(span.marks)) previous.text += span.text
    else result.push({ text: span.text, marks: { ...span.marks } })
  }
  return result
}
function signature(spans: readonly InlineSpan[]): string {
  return JSON.stringify(normalize(spans).map(s => [s.text, markKey(s.marks)]))
}
function sourceOnly(source: string, reason: string): InlineSourceOnly { return { capability: 'source', source, reason } }
function textFragment(raw: string): string {
  return decodeString(raw.replace(/[ \t]*(?:\r\n|\r|\n)[ \t]*/g, '\n')).replace(/\r\n?/g, '\n')
}

export function parseInlineBlock(source: string): InlineModel | InlineSourceOnly {
  const root = markdownTree(source)
  if (!root.children.length && /^\s*$/.test(source)) {
    return { capability: 'rich', source, spans: [], baseline: '[]', prefix: '', suffix: source }
  }
  const block = root.children[0]
  if (root.children.length !== 1 || (block.type !== 'paragraph' && block.type !== 'heading')) return sourceOnly(source, '需源码编辑：不是单一行内文本块')
  const spans: InlineSpan[] = []
  let issue = ''
  function push(text: string, marks: InlineMarks) { spans.push({ text, marks: { ...marks } }) }
  function walk(nodes: PhrasingContent[], inherited: InlineMarks) {
    let marks = { ...inherited }
    const stack: Array<{ tag: string; marks: InlineMarks }> = []
    for (const node of nodes) {
      switch (node.type) {
        case 'text': {
          const raw = source.slice(node.position!.start.offset!, node.position!.end.offset!)
          if (textFragment(raw) !== node.value.replace(/\r\n?/g, '\n')) { issue = '无法保真映射的行内文本'; break }
          if (/(^|[^\\])\[[^\]\r\n]+\]\[[^\]\r\n]*\]/.test(raw)) issue = '引用式链接需要文档上下文'
          const re = /!?\[\[([^[\]\r\n]+)\]\]/g
          let cursor = 0
          for (const match of raw.matchAll(re)) {
            const at = match.index
            const slashes = /\\*$/.exec(raw.slice(0, at))![0].length
            if (slashes % 2) continue
            if (match[0].startsWith('!') || marks.reference) { issue = '行内嵌入或嵌套引用'; break }
            push(textFragment(raw.slice(cursor, at)), marks)
            const parts = match[1].split('|')
            if (parts.length > 2 || !parts[0] || parts[1] === '') { issue = '无法表达的 Wiki 引用'; break }
            push(parts[1] ?? parts[0], { ...marks, reference: { kind: 'wiki', target: parts[0] } })
            cursor = at + match[0].length
          }
          push(textFragment(raw.slice(cursor)), marks)
          break
        }
        case 'strong': walk(node.children, { ...marks, bold: true }); break
        case 'emphasis': walk(node.children, { ...marks, italic: true }); break
        case 'delete': walk(node.children, { ...marks, strike: true }); break
        case 'inlineCode': push(node.value, { ...marks, code: true }); break
        case 'link': {
          if (marks.reference) { issue = '嵌套链接'; break }
          if (node.url.startsWith('ready://')) {
            const parsed = parseReadyUri(node.url)
            if (!parsed.ok || node.title) { issue = '无效 ReadyRef'; break }
            walk(node.children, { ...marks, reference: { kind: 'ready', ref: parsed.ref } })
          } else walk(node.children, { ...marks, reference: { kind: 'link', href: node.url, ...(node.title ? { title: node.title } : {}) } })
          break
        }
        case 'html': {
          if (node.value === '<u>') { stack.push({ tag: 'u', marks }); marks = { ...marks, underline: true }; break }
          const span = /^<span style="([^"]+)">$/.exec(node.value)
          if (span) {
            const next = { ...marks }
            const seen = new Set<string>()
            for (const declaration of span[1].split(';').map(s => s.trim()).filter(Boolean)) {
              const pair = /^(color|background-color):\s*([a-z]+)$/.exec(declaration)
              if (!pair || !isDocumentColor(pair[2]) || seen.has(pair[1])) { issue = '不支持的颜色样式'; break }
              seen.add(pair[1]); next[pair[1] === 'color' ? 'color' : 'background'] = pair[2]
            }
            if (!seen.size) issue = '空颜色样式'
            stack.push({ tag: 'span', marks }); marks = next; break
          }
          const close = /^<\/(u|span)>$/.exec(node.value)
          const previous = close ? stack.pop() : undefined
          if (!close || !previous || previous.tag !== close[1]) issue = '不支持或未配对的 HTML'
          else marks = previous.marks
          break
        }
        default: issue = `无法表达的行内结构：${node.type}`
      }
    }
    if (stack.length) issue = '未闭合的行内 HTML'
  }
  walk(block.children, {})
  if (issue) return sourceOnly(source, `需源码编辑：${issue}`)
  const normalized = normalize(spans)
  const start = block.children[0]?.position?.start.offset ?? source.length
  const end = block.children[block.children.length - 1]?.position?.end.offset ?? source.length
  return { capability: 'rich', source, spans: normalized, baseline: signature(normalized), prefix: source.slice(0, start), suffix: source.slice(end) }
}

// Group common marks before serializing: **a** followed by **b** must not become **a****b**.
const wrappers = ['reference', 'bold', 'italic', 'strike', 'underline', 'color', 'background'] as const
function phrasing(spans: InlineSpan[], depth = 0): PhrasingContent[] {
  if (depth === wrappers.length) return spans.map(span => span.marks.code
    ? { type: 'inlineCode', value: span.text } : { type: 'text', value: span.text })
  const key = wrappers[depth]
  const result: PhrasingContent[] = []
  for (let index = 0; index < spans.length;) {
    const value = spans[index].marks[key]
    let end = index + 1
    while (end < spans.length && JSON.stringify(spans[end].marks[key]) === JSON.stringify(value)) end++
    const group = spans.slice(index, end)
    const children = phrasing(group, depth + 1)
    if (!value) result.push(...children)
    else if (key === 'bold') result.push({ type: 'strong', children })
    else if (key === 'italic') result.push({ type: 'emphasis', children })
    else if (key === 'strike') result.push({ type: 'delete', children })
    else if (key === 'reference') {
      const ref = group[0].marks.reference!
      if (ref.kind === 'wiki') {
        const text = group.map(s => s.text).join('')
        if (/[[\]|\r\n]/.test(ref.target) || /[[\]|\r\n]/.test(text) || !ref.target
          || group.some(s => Object.keys(s.marks).some(k => k !== 'reference'))) throw new Error('Wiki 引用内容需要源码编辑')
        result.push({ type: 'html', value: `[[${ref.target}${text === ref.target ? '' : `|${text}`}]]` })
      } else {
        result.push({ type: 'link', url: ref.kind === 'ready' ? toReadyUri(ref.ref) : ref.href,
          title: ref.kind === 'link' ? ref.title : undefined, children })
      }
    } else {
      const open = key === 'underline' ? '<u>' : `<span style="${key === 'color' ? 'color' : 'background-color'}: ${value}">`
      result.push({ type: 'html', value: open }, ...children, { type: 'html', value: key === 'underline' ? '</u>' : '</span>' })
    }
    index = end
  }
  return result
}

export function serializeInlineBlock(model: InlineModel, spans: readonly InlineSpan[]): { capability: 'rich'; markdown: string } | InlineSourceOnly {
  try {
    const normalized = normalize(spans)
    if (signature(normalized) === model.baseline) return { capability: 'rich', markdown: model.source }
    for (const span of normalized) {
      if ((span.marks.color && !isDocumentColor(span.marks.color)) || (span.marks.background && !isDocumentColor(span.marks.background))) throw new Error('颜色不在 Ready 色板中')
      if (span.marks.code && /[\r\n]/.test(span.text)) throw new Error('行内代码不能保真表达换行')
    }
    const inline = toMarkdown({ type: 'root', children: [{ type: 'paragraph', children: phrasing(normalized) }] }, { extensions: [gfmToMarkdown()] }).replace(/\n$/, '')
    const markdown = model.prefix + inline + model.suffix
    const checked = parseInlineBlock(markdown)
    if (checked.capability !== 'rich' || signature(checked.spans) !== signature(normalized)) return sourceOnly(model.source, '需源码编辑：此标记组合不能保真输出')
    return { capability: 'rich', markdown }
  } catch (error) {
    return sourceOnly(model.source, `需源码编辑：${error instanceof Error ? error.message : String(error)}`)
  }
}
