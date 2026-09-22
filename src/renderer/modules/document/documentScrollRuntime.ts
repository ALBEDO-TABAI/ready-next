import {
  captureMarkdownLineAnchor,
  resolveMarkdownLineFromAnchor,
  type DocumentScrollAnchorSnapshot,
} from './documentScrollAnchor'

function estimateTextareaLineHeight(element: HTMLElement): number {
  const styles = window.getComputedStyle(element)
  const lineHeight = Number.parseFloat(styles.lineHeight)
  if (Number.isFinite(lineHeight) && lineHeight > 0) return lineHeight
  const fontSize = Number.parseFloat(styles.fontSize)
  return Number.isFinite(fontSize) && fontSize > 0 ? fontSize * 1.6 : 24
}

function captureTextareaAnchor(element: HTMLElement, content: string): Pick<DocumentScrollAnchorSnapshot, 'anchorTitle' | 'anchorOrdinal' | 'anchorProgress'> | null {
  if (!(element instanceof HTMLTextAreaElement)) return null
  const lineNumber = Math.floor(element.scrollTop / estimateTextareaLineHeight(element)) + 1
  const anchor = captureMarkdownLineAnchor(content, lineNumber)
  return anchor
    ? { anchorTitle: anchor.title, anchorOrdinal: anchor.ordinal, anchorProgress: anchor.progress }
    : null
}

function getElementContentOffset(container: HTMLElement, child: HTMLElement, containerTop?: number): number {
  const resolvedContainerTop = containerTop ?? container.getBoundingClientRect().top
  const childRect = child.getBoundingClientRect()
  return childRect.top - resolvedContainerTop + container.scrollTop
}

function capturePreviewAnchor(element: HTMLElement): Pick<DocumentScrollAnchorSnapshot, 'anchorTitle' | 'anchorOrdinal' | 'anchorProgress'> | null {
  const headings = Array.from(element.querySelectorAll<HTMLElement>('[data-ready-heading-title]'))
  if (headings.length === 0) return null
  const headingCounts = new Map<string, number>()
  const contentTop = element.scrollTop + 8
  const containerTop = element.getBoundingClientRect().top
  let nearest: HTMLElement | null = null
  let nearestIndex = 0
  const ordinals = headings.map((heading) => {
    const title = heading.dataset.readyHeadingTitle || ''
    const ordinal = headingCounts.get(title) || 0
    headingCounts.set(title, ordinal + 1)
    return ordinal
  })
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]
    const top = getElementContentOffset(element, heading, containerTop)
    if (top <= contentTop + 16) {
      nearest = heading
      nearestIndex = index
      continue
    }
    if (!nearest) {
      nearest = heading
      nearestIndex = index
    }
    break
  }
  if (!nearest) return null
  const sectionStart = getElementContentOffset(element, nearest, containerTop)
  const nextHeading = headings[nearestIndex + 1] || null
  const sectionEnd = nextHeading
    ? getElementContentOffset(element, nextHeading, containerTop)
    : Math.max(element.scrollHeight, sectionStart + element.clientHeight)
  const sectionLength = Math.max(1, sectionEnd - sectionStart)
  const progress = Math.max(0, Math.min(1, (contentTop - sectionStart) / sectionLength))
  return {
    anchorTitle: nearest.dataset.readyHeadingTitle || null,
    anchorOrdinal: ordinals[nearestIndex] || 0,
    anchorProgress: progress,
  }
}

export function captureElementScroll(
  element: HTMLElement,
  content: string,
  options?: { includeAnchor?: boolean },
): DocumentScrollAnchorSnapshot {
  const maxScroll = Math.max(0, element.scrollHeight - element.clientHeight)
  const top = Math.max(0, Math.min(element.scrollTop, maxScroll))
  const anchor = options?.includeAnchor === false
    ? null
    : captureTextareaAnchor(element, content) || capturePreviewAnchor(element)
  return {
    top,
    ratio: maxScroll > 0 ? top / maxScroll : 0,
    maxScroll,
    anchorTitle: anchor?.anchorTitle || null,
    anchorOrdinal: anchor?.anchorOrdinal ?? null,
    anchorProgress: anchor?.anchorProgress ?? null,
  }
}

function restoreAnchorScroll(element: HTMLElement, snapshot: DocumentScrollAnchorSnapshot, content: string): boolean {
  if (!snapshot.anchorTitle) return false
  if (element instanceof HTMLTextAreaElement) {
    const line = resolveMarkdownLineFromAnchor(content, snapshot)
    if (!line) return false
    element.scrollTop = Math.max(0, Math.round((line - 1) * estimateTextareaLineHeight(element)))
    return true
  }
  const headings = Array.from(element.querySelectorAll<HTMLElement>('[data-ready-heading-title]'))
  const containerTop = element.getBoundingClientRect().top
  let seenOrdinal = 0
  const targetIndex = headings.findIndex((heading) => {
    if (heading.dataset.readyHeadingTitle !== snapshot.anchorTitle) return false
    const matches = seenOrdinal === (snapshot.anchorOrdinal || 0)
    seenOrdinal += 1
    return matches
  })
  const target = targetIndex >= 0 ? headings[targetIndex] : null
  if (!target) return false
  const sectionStart = getElementContentOffset(element, target, containerTop)
  const nextHeading = headings[targetIndex + 1] || null
  const sectionEnd = nextHeading
    ? getElementContentOffset(element, nextHeading, containerTop)
    : Math.max(element.scrollHeight, sectionStart + element.clientHeight)
  const maxScroll = Math.max(0, element.scrollHeight - element.clientHeight)
  const progress = Math.max(0, Math.min(1, snapshot.anchorProgress ?? 0))
  const nextTop = sectionStart + (sectionEnd - sectionStart) * progress - 8
  element.scrollTop = Math.max(0, Math.min(Math.round(nextTop), maxScroll))
  return true
}

export function restoreElementScroll(
  element: HTMLElement,
  snapshot: DocumentScrollAnchorSnapshot,
  content: string,
): () => void {
  const restore = () => {
    if (restoreAnchorScroll(element, snapshot, content)) return
    const maxScroll = Math.max(0, element.scrollHeight - element.clientHeight)
    const nextTop = snapshot.maxScroll === maxScroll ? snapshot.top : snapshot.ratio * maxScroll
    element.scrollTop = Math.max(0, Math.min(Math.round(nextTop), maxScroll))
  }
  restore()
  const frame = requestAnimationFrame(restore)
  let resizeFrame: number | null = null
  const observer = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => {
        if (resizeFrame !== null) cancelAnimationFrame(resizeFrame)
        resizeFrame = requestAnimationFrame(() => {
          resizeFrame = null
          restore()
        })
      })
    : null
  observer?.observe(element)
  const settleTimer = window.setTimeout(() => observer?.disconnect(), 800)
  return () => {
    cancelAnimationFrame(frame)
    if (resizeFrame !== null) cancelAnimationFrame(resizeFrame)
    window.clearTimeout(settleTimer)
    observer?.disconnect()
  }
}

export function findScrollCandidates(scope: HTMLElement): HTMLElement[] {
  return [
    scope.querySelector('textarea'),
    scope.querySelector('.document-preview-surface'),
    scope.querySelector('.document-editor-surface'),
    scope,
  ].filter((element): element is HTMLElement => element instanceof HTMLElement)
}

export function findCurrentScrollElement(scope: HTMLElement): HTMLElement | null {
  const candidates = findScrollCandidates(scope)
  return candidates.find((element) => element.scrollTop > 0)
    || candidates.find((element) => element.scrollHeight > element.clientHeight)
    || null
}

/** Capture while scrolling; departure only flushes the captured value, never hidden layout. */
export function trackDocumentScrollPosition(
  element: HTMLElement,
  getContent: () => string,
  save: (snapshot: DocumentScrollAnchorSnapshot) => void,
): { flush: () => void; dispose: () => void } {
  let pending: DocumentScrollAnchorSnapshot | null = null
  let timer: number | undefined
  const flush = () => {
    window.clearTimeout(timer)
    if (pending) save(pending)
    pending = null
  }
  const handleScroll = () => {
    pending = captureElementScroll(element, '', { includeAnchor: false })
    window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      pending = captureElementScroll(element, getContent())
      flush()
    }, 220)
  }
  element.addEventListener('scroll', handleScroll, { passive: true })
  return {
    flush,
    dispose: () => {
      element.removeEventListener('scroll', handleScroll)
      flush()
    },
  }
}
