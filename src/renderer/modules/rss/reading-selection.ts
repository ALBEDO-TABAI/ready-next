import type { RSSReadingRange } from '../../../shared/rss-reading'

const SELECTOR = '[data-ready-reading-run]'
const runId = (element: HTMLElement) => Number(element.dataset.readyReadingRun)
const containing = (node: Node, body: HTMLElement): HTMLElement | null => {
  const element = (node.nodeType === 1 ? node as Element : node.parentElement)?.closest<HTMLElement>(SELECTOR) || null
  return element && body.contains(element) ? element : null
}
export function selectedReadingRange(body: HTMLElement, selection: Selection | null): { selection: RSSReadingRange | null; paragraph: RSSReadingRange | null } {
  if (!selection?.rangeCount) return { selection: null, paragraph: null }
  const selected = selection.getRangeAt(0)
  if (!body.contains(selected.startContainer) || !body.contains(selected.endContainer)) return { selection: null, paragraph: null }
  const mappedEndpoint = (node: Node) => {
    const element = node.nodeType === 1 ? node as Element : node.parentElement
    return !element?.closest('button,input,svg,img') && (node.nodeType !== 3 || !!containing(node, body))
  }
  if (!mappedEndpoint(selected.startContainer) || !mappedEndpoint(selected.endContainer)) return { selection: null, paragraph: null }
  const elements = Array.from(body.querySelectorAll<HTMLElement>(SELECTOR))
  const selectedRuns = selected.collapsed ? [] : elements.flatMap((element) => {
    if (!selected.intersectsNode(element)) return []
    const prefix = body.ownerDocument.createRange(); prefix.selectNodeContents(element)
    let start = 0, end = element.textContent?.length || 0
    if (element.contains(selected.startContainer)) { prefix.setEnd(selected.startContainer, selected.startOffset); start = prefix.toString().length }
    if (element.contains(selected.endContainer)) { prefix.selectNodeContents(element); prefix.setEnd(selected.endContainer, selected.endOffset); end = prefix.toString().length }
    return end > start ? [{ element, start, end }] : []
  })
  const first = selectedRuns[0], last = selectedRuns.at(-1)
  const focus = first?.element || containing(selected.startContainer, body)
  const paragraph = focus ? elements.filter((element) => element.dataset.readyReadingBlock === focus.dataset.readyReadingBlock) : []
  const head = paragraph[0], tail = paragraph.at(-1)
  return {
    selection: first && last ? { start: { run: runId(first.element), offset: first.start }, end: { run: runId(last.element), offset: last.end } } : null,
    paragraph: head && tail && paragraph.some((element) => element.textContent?.length) ? { start: { run: runId(head), offset: 0 }, end: { run: runId(tail), offset: tail.textContent?.length || 0 } } : null,
  }
}
export function revealReadingRange(body: HTMLElement, range: RSSReadingRange): void {
  const elements = Array.from(body.querySelectorAll<HTMLElement>(SELECTOR))
  const start = elements.find((element) => runId(element) === range.start.run), end = elements.find((element) => runId(element) === range.end.run)
  if (!start || !end) throw new Error('引用位置暂时无法显示，请重新引用。')
  const point = (element: HTMLElement, offset: number): { node: Node; offset: number } => {
    const walker = body.ownerDocument.createTreeWalker(element, 4)
    let node: Node | null
    while ((node = walker.nextNode())) {
      const length = node.textContent?.length || 0
      if (offset <= length) return { node, offset }
      offset -= length
    }
    throw new Error('引用位置已不可用。')
  }
  const from = point(start, range.start.offset), to = point(end, range.end.offset)
  const selected = body.ownerDocument.createRange(); selected.setStart(from.node, from.offset); selected.setEnd(to.node, to.offset)
  const selection = body.ownerDocument.defaultView?.getSelection()
  selection?.removeAllRanges(); selection?.addRange(selected)
  start.scrollIntoView({ block: 'center' })
}
