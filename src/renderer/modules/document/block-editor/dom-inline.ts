import { isDocumentColor, type InlineMarks, type InlineSpan } from '../../../../shared/document-blocks'
import { parseReadyUri, toReadyUri } from '../../../../shared/ready-ref'
import { refCapsuleKind } from '../../../components/ui/ref-capsule-kinds'

export function sliceSpans(spans: readonly InlineSpan[], start: number, end = Infinity): InlineSpan[] {
  let position = 0
  return spans.flatMap(span => {
    const from = Math.max(0, start - position), to = Math.min(span.text.length, end - position)
    position += span.text.length
    return from < to ? [{ text: span.text.slice(from, to), marks: { ...span.marks } }] : []
  })
}
export const plainText = (spans: readonly InlineSpan[]) => spans.map(span => span.text).join('')

export function readInline(root: Node, blockSeparator = '\n'): InlineSpan[] {
  const spans: InlineSpan[] = []
  const push = (text: string, marks: InlineMarks) => { if (text) spans.push({ text, marks: { ...marks } }) }
  function walk(node: Node, inherited: InlineMarks) {
    if (node.nodeType === 3) { push(node.textContent ?? '', inherited); return }
    if (!(node instanceof HTMLElement)) return
    const tag = node.tagName
    if (['SCRIPT', 'STYLE', 'META', 'LINK'].includes(tag)) return
    if (tag === 'BR') { push('\n', inherited); return }
    const marks = { ...inherited }
    if (['STRONG', 'B'].includes(tag) || /^(bold|[6-9]00)$/.test(node.style.fontWeight)) marks.bold = true
    if (['EM', 'I'].includes(tag) || node.style.fontStyle === 'italic') marks.italic = true
    if (['S', 'DEL', 'STRIKE'].includes(tag) || node.style.textDecoration.includes('line-through')) marks.strike = true
    if (tag === 'CODE') marks.code = true
    if (tag === 'U' || node.style.textDecoration.includes('underline')) marks.underline = true
    for (const [key, value] of [['color', node.dataset.readyColor ?? node.style.color], ['background', node.dataset.readyBackground ?? node.style.backgroundColor]] as const) {
      if (isDocumentColor(value)) marks[key] = value
    }
    if (node.dataset.readyWiki) marks.reference = { kind: 'wiki', target: node.dataset.readyWiki }
    else if (tag === 'A') {
      const href = node.dataset.readyHref ?? node.getAttribute('href') ?? ''
      if (href.startsWith('ready://')) {
        const ref = parseReadyUri(href); if (ref.ok) marks.reference = { kind: 'ready', ref: ref.ref }
      } else if (href && (node.dataset.readyHref || !/^(?:javascript|data|vbscript):/i.test(href.trim()))) {
        marks.reference = { kind: 'link', href, ...(node.title ? { title: node.title } : {}) }
      }
    }
    const block = /^(P|DIV|LI|H[1-6]|BLOCKQUOTE)$/.test(tag)
    if (block && spans.length && !plainText(spans).endsWith('\n')) push(blockSeparator, {})
    for (const child of node.childNodes) walk(child, marks)
    if (block && node.nextSibling) push(blockSeparator, {})
    if (tag === 'IMG') push(node.getAttribute('alt') ?? '', marks)
  }
  for (const child of root.childNodes) walk(child, {})
  return spans
}

export function drawInline(root: HTMLElement, spans: readonly InlineSpan[]) {
  const fragment = document.createDocumentFragment()
  for (const { text, marks } of spans) {
    let node: Node = document.createTextNode(text)
    for (const [key, tag] of [['bold', 'strong'], ['italic', 'em'], ['strike', 's'], ['underline', 'u'], ['code', 'code']] as const) {
      if (marks[key]) { const wrapper = document.createElement(tag); wrapper.append(node); node = wrapper }
    }
    if (marks.color || marks.background) {
      const wrapper = document.createElement('span')
      if (marks.color) { wrapper.dataset.readyColor = marks.color; wrapper.style.color = `var(--color-${marks.color}, var(--text-primary))` }
      if (marks.background) { wrapper.dataset.readyBackground = marks.background; wrapper.style.backgroundColor = `var(--color-${marks.background}, transparent)` }
      wrapper.append(node); node = wrapper
    }
    if (marks.reference) {
      const wrapper = document.createElement('a')
      if (marks.reference.kind === 'wiki') wrapper.dataset.readyWiki = marks.reference.target
      else {
        const href = marks.reference.kind === 'ready' ? toReadyUri(marks.reference.ref) : marks.reference.href
        // An existing unsafe link remains a model value, never a navigable DOM URL.
        if (!/^(?:javascript|data|vbscript):/i.test(href.trim())) wrapper.setAttribute('href', href)
        else wrapper.dataset.readyHref = href
        if (marks.reference.kind === 'link' && marks.reference.title) wrapper.title = marks.reference.title
      }
      // A Ready reference reads as a capsule (W6 §2.1): only a class and data on this same link, so the text, the
      // caret and input methods are untouched and the source stays the Markdown link it was.
      const reference = marks.reference
      if (reference.kind !== 'link') {
        wrapper.className = 'rn-ref'
        wrapper.dataset.readyRefCapsule = ''
        // A [[wiki]] target names a page, or a board when it keeps its .canvas extension.
        wrapper.dataset.refKind = reference.kind === 'ready' ? refCapsuleKind(reference.ref) : /\.canvas$/i.test(reference.target.split('#')[0]) ? 'canvas' : 'page'
        wrapper.draggable = true
        if (reference.kind === 'ready' && reference.ref.kind === 'day') wrapper.dataset.readyDateMention = ''
      }
      wrapper.append(node); node = wrapper
    }
    fragment.append(node)
  }
  root.replaceChildren(fragment)
}

export function getCaret(root: HTMLElement): { start: number; end: number; backward: boolean } {
  const selection = window.getSelection()
  if (!selection?.anchorNode || !selection.focusNode || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return { start: 0, end: 0, backward: false }
  const offset = (node: Node, at: number) => {
    const range = document.createRange(); range.selectNodeContents(root); range.setEnd(node, at)
    return range.toString().length
  }
  const a = offset(selection.anchorNode, selection.anchorOffset), b = offset(selection.focusNode, selection.focusOffset)
  return { start: Math.min(a, b), end: Math.max(a, b), backward: b < a }
}
export function setCaret(root: HTMLElement, start: number, end = start, backward = false) {
  const point = (at: number): [Node, number] => {
    const walker = document.createTreeWalker(root, 4)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent?.length ?? 0
      if (at <= length) return [node, at]
      at -= length
    }
    return [root, root.childNodes.length]
  }
  const range = document.createRange(); range.setStart(...point(start)); range.setEnd(...point(end))
  const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range)
  if (backward) selection?.setBaseAndExtent(...point(end), ...point(start))
}

export function atVerticalEdge(root: HTMLElement, direction: 'up' | 'down') {
  const selection = window.getSelection()
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null
  const rect = range?.getBoundingClientRect?.()
  if (rect?.height) {
    const box = root.getBoundingClientRect(), line = parseFloat(window.getComputedStyle(root).lineHeight) || 24
    return direction === 'up' ? rect.top - box.top < line * 0.75 : box.bottom - rect.bottom < line * 0.75
  }
  const caret = getCaret(root)
  return direction === 'up' ? caret.start === 0 : caret.end === (root.textContent?.length ?? 0)
}
