/**
 * P1-E5 (2026-07-03, browser action receipt contract) — a deterministic,
 * read-only "what changed" summary attached to write actions (click / type)
 * so the model does not have to browser_read after every step. Answers
 * the first-principles question "did this action change the page, and how":
 * URL change, title, focused element, and any visible toast/alert/aria-live.
 *
 * The probe is strictly read-only (no page mutation, no P3c freeform surface).
 * `buildBrowserActionReceipt` is a pure shaper (unit-tested); the IO capture
 * degrades to `{ captured: false }` on any probe failure so a receipt can
 * never fail the underlying write action.
 */

export interface BrowserActionReceiptProbe {
  url?: unknown
  title?: unknown
  activeElement?: unknown
  visibleSignal?: unknown
}

export interface BrowserActionReceipt {
  captured: boolean
  url?: string
  urlChanged?: boolean
  title?: string
  activeElement?: string
  /** First visible toast / alert / aria-live text, trimmed + length-capped. */
  visibleSignal?: string
}

const VISIBLE_SIGNAL_MAX = 200
const TITLE_MAX = 200
const ACTIVE_ELEMENT_MAX = 120

/** Read-only probe: identity + focus + first visible transient signal.
 *  No writes, no eval of caller code — a fixed expression only. */
export const BROWSER_ACTION_RECEIPT_PROBE_JS = `(() => {
  const __READY_ACTION_RECEIPT__ = true
  const trim = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim()
  const activeEl = document.activeElement
  const active = activeEl
    ? trim((activeEl.tagName || '').toLowerCase() + ':' + (activeEl.getAttribute && (activeEl.getAttribute('aria-label') || activeEl.getAttribute('placeholder') || activeEl.id || '') || ''))
    : ''
  let visibleSignal = ''
  try {
    const sel = '[role=alert],[role=status],[aria-live],.toast,.message,.notification,.ant-message,.el-message,.snackbar'
    const nodes = Array.from(document.querySelectorAll(sel))
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) continue
      const rect = node.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) continue
      const style = getComputedStyle(node)
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') <= 0) continue
      const text = trim(node.textContent || '')
      if (text) { visibleSignal = text; break }
    }
  } catch (_e) { /* signal scan is best-effort */ }
  return {
    url: String(window.location.href || ''),
    title: String(document.title || ''),
    activeElement: active,
    visibleSignal,
  }
})()`

function trimTo(value: unknown, max: number): string {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function buildBrowserActionReceipt(params: {
  beforeUrl: string | null | undefined
  after: BrowserActionReceiptProbe | null | undefined
}): BrowserActionReceipt {
  const after = params.after
  if (!after || typeof after !== 'object') return { captured: false }
  const url = trimTo(after.url, 2048)
  if (!url) return { captured: false }
  const beforeUrl = String(params.beforeUrl || '').trim()
  const receipt: BrowserActionReceipt = {
    captured: true,
    url,
    urlChanged: Boolean(beforeUrl) && beforeUrl !== url,
  }
  const title = trimTo(after.title, TITLE_MAX)
  if (title) receipt.title = title
  const activeElement = trimTo(after.activeElement, ACTIVE_ELEMENT_MAX)
  if (activeElement && activeElement !== ':') receipt.activeElement = activeElement
  const visibleSignal = trimTo(after.visibleSignal, VISIBLE_SIGNAL_MAX)
  if (visibleSignal) receipt.visibleSignal = visibleSignal
  return receipt
}

export async function captureBrowserActionReceipt(
  controller: { executeJS: (tabId: string | null, code: string) => Promise<unknown> },
  tabId: string | null,
  beforeUrl: string | null | undefined,
): Promise<BrowserActionReceipt> {
  try {
    const raw = await controller.executeJS(tabId, BROWSER_ACTION_RECEIPT_PROBE_JS)
    const after = raw && typeof raw === 'object' ? raw as BrowserActionReceiptProbe : null
    return buildBrowserActionReceipt({ beforeUrl, after })
  } catch {
    return { captured: false }
  }
}
