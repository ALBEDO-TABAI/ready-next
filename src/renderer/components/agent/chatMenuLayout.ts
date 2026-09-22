import { subscribeWorkbenchWindowResize } from '../../modules/workbench/windowResize'

const CHAT_PANEL_SELECTOR = '[data-chat-panel-root="true"]'

export function getChatMenuHorizontalFrame(
  anchor: HTMLElement,
  preferredWidth: number,
  preferredLeft: number,
): { left: number; width: number } {
  const panel = anchor.closest(CHAT_PANEL_SELECTOR)?.getBoundingClientRect()
  const leftEdge = Math.ceil(Math.max(8, (panel?.left ?? 0) + 8))
  const rightEdge = Math.floor(Math.min(window.innerWidth - 8, (panel?.right ?? window.innerWidth) - 8))
  const width = Math.max(0, Math.min(preferredWidth, rightEdge - leftEdge))
  return {
    left: Math.max(leftEdge, Math.min(Math.round(preferredLeft), rightEdge - width)),
    width,
  }
}

export function subscribeChatMenuLayout(anchor: HTMLElement | null, sync: () => void): () => void {
  const unsubscribeWindowResize = subscribeWorkbenchWindowResize(sync)
  const observer = new ResizeObserver(sync)
  if (anchor) {
    observer.observe(anchor)
    const panel = anchor.closest(CHAT_PANEL_SELECTOR)
    if (panel && panel !== anchor) observer.observe(panel)
  }
  window.addEventListener('scroll', sync, true)
  return () => {
    observer.disconnect()
    unsubscribeWindowResize()
    window.removeEventListener('scroll', sync, true)
  }
}
