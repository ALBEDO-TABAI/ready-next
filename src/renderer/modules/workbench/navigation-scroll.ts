import type { NavigationEntry } from '../../../shared/navigation-history'

function selectorWithin(element: HTMLElement, panel: Element): string {
  if (element === panel) return ':scope'
  const parts: string[] = []
  let node: Element | null = element
  while (node && node !== panel) {
    const parent: Element | null = node.parentElement
    if (!parent) break
    parts.unshift(`:nth-child(${[...parent.children].indexOf(node) + 1})`)
    node = parent
  }
  return `:scope > ${parts.join(' > ')}`
}
export function captureNavigationScroll(mode: NavigationEntry['mode']): NavigationEntry['anchor'] {
  const panel = document.querySelector<HTMLElement>(`[data-workbench-mode-panel="${mode}"]`)
  return panel ? [panel, ...panel.querySelectorAll<HTMLElement>('*')].flatMap(el => el.scrollTop || el.scrollLeft
    ? [{ selector: selectorWithin(el, panel), top: el.scrollTop, left: el.scrollLeft }] : []) : []
}
/** A reference may mount asynchronously (especially RSS). Restore only after its own content is present. */
export async function restoreNavigationScroll(entry: NavigationEntry): Promise<void> {
  const anchors = entry.anchor.filter(anchor => anchor.selector !== 'browser')
  if (!anchors.length) return
  const deadline = performance.now() + 3000
  await new Promise<void>((resolve, reject) => {
    const apply = () => {
      const panel = document.querySelector<HTMLElement>(`[data-workbench-mode-panel="${entry.mode}"]`)
      const articleId = entry.ref.kind === 'rss-item' ? entry.ref.id : null
      const article = articleId ? [...(panel?.querySelectorAll<HTMLElement>('[data-rss-article-id]') ?? [])]
        .find(el => el.dataset.rssArticleId === articleId) : null
      const ready = panel && (entry.ref.kind !== 'rss-item' || article?.dataset.navigationLoaded === 'true')
      const restored = ready && anchors.every(anchor => {
        const element = anchor.selector === ':scope' ? panel : panel.querySelector<HTMLElement>(anchor.selector)
        if (!element) return false
        element.scrollTop = anchor.top; element.scrollLeft = anchor.left
        return (Math.abs(element.scrollTop - anchor.top) < 1 || element.scrollTop >= element.scrollHeight - element.clientHeight)
          && (Math.abs(element.scrollLeft - anchor.left) < 1 || element.scrollLeft >= element.scrollWidth - element.clientWidth)
      })
      if (restored) resolve()
      else if (performance.now() >= deadline) reject(new Error('目标内容尚未就绪，无法恢复阅读位置'))
      else requestAnimationFrame(apply)
    }
    requestAnimationFrame(apply)
  })
}
