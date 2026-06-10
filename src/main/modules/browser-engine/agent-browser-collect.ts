/**
 * Visible-collect dedup + stop-condition logic (counterplan §5.5, WP4 core).
 *
 * The collection LOOP itself (read map → extract → expand one → re-read →
 * dedup → scroll → checkpoint) lives in the task runner, but the two decisions
 * that must be correct and deterministic are pulled out here so they are pure
 * and unit-testable:
 *
 *   - item identity / dedup: in CODE, never delegated to the model. A normalized
 *     link is the key; absent a link, hash(text)+container path.
 *   - stop conditions: all are hard budgets (max items / rounds / expands /
 *     duration / consecutive-empty rounds), satisfying the "budget is a hard
 *     limit" red line.
 *
 * Pure module — no Electron, no IO.
 */

export interface VisibleCollectItem {
  link?: string
  text?: string
  containerPath?: string
  [key: string]: unknown
}

export interface VisibleCollectLimits {
  maxItems: number
  maxRounds: number
  maxExpandsPerRound: number
  maxDurationMs: number
  /** Stop after this many consecutive rounds that add nothing new. */
  emptyRoundsToStop: number
}

export const DEFAULT_VISIBLE_COLLECT_LIMITS: VisibleCollectLimits = {
  maxItems: 200,
  maxRounds: 40,
  maxExpandsPerRound: 8,
  maxDurationMs: 5 * 60_000,
  emptyRoundsToStop: 2,
}

export const DISCOVERY_ESCALATION_SCROLL_STEPS = 2
export const DISCOVERY_ESCALATION_TIMEOUT_MS = 5_000

export const DISCOVERY_ESCALATION_LOADING_GONE_JS = `
(() => {
  const visible = (el) => {
    if (!(el instanceof Element)) return false
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    const style = getComputedStyle(el)
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') > 0
  }
  const busy = Array.from(document.querySelectorAll([
    '[aria-busy="true"]',
    '[role="progressbar"]',
    '[class*="loading" i]',
    '[class*="spinner" i]',
    '[class*="skeleton" i]',
    '[data-loading="true"]'
  ].join(','))).some(visible)
  return document.readyState !== 'loading' && !busy
})()
`.trim()

function normalizeLink(link: string): string {
  try {
    const url = new URL(link)
    url.hash = ''
    // Drop common tracking params that fragment otherwise-identical items.
    for (const p of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'spm', 'ref']) {
      url.searchParams.delete(p)
    }
    return url.toString()
  } catch {
    return link.trim()
  }
}

function hashText(text: string): string {
  // Small, stable, dependency-free FNV-1a — only needs to be a dedup key.
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

export function itemIdentity(item: VisibleCollectItem): string {
  const link = String(item.link ?? '').trim()
  if (link) return `link:${normalizeLink(link)}`
  const text = String(item.text ?? '').replace(/\s+/g, ' ').trim()
  const container = String(item.containerPath ?? '').trim()
  return `text:${hashText(text)}:${container}`
}

/**
 * Stateful deduper used across rounds. Tracks every identity ever seen so that
 * an item dropped in round 1 is not re-collected in round 5.
 */
export class VisibleCollectDeduper {
  private readonly seen = new Set<string>()

  /** Add new (unseen) items; returns only the freshly-added ones. */
  addBatch(items: VisibleCollectItem[]): VisibleCollectItem[] {
    const fresh: VisibleCollectItem[] = []
    for (const item of items) {
      const id = itemIdentity(item)
      if (this.seen.has(id)) continue
      this.seen.add(id)
      fresh.push(item)
    }
    return fresh
  }

  get size(): number {
    return this.seen.size
  }
}

export interface CollectLoopState {
  collectedCount: number
  round: number
  consecutiveEmptyRounds: number
  elapsedMs: number
  cancelled?: boolean
  leaseLost?: boolean
}

export type CollectStopReason =
  | 'max_items'
  | 'max_rounds'
  | 'max_duration'
  | 'no_new_content'
  | 'cancelled'
  | 'lease_lost'
  | null

/**
 * Decide whether the loop should stop, and why. `null` means keep going.
 */
export function evaluateStop(
  state: CollectLoopState,
  limits: VisibleCollectLimits = DEFAULT_VISIBLE_COLLECT_LIMITS,
): CollectStopReason {
  if (state.cancelled) return 'cancelled'
  if (state.leaseLost) return 'lease_lost'
  if (state.collectedCount >= limits.maxItems) return 'max_items'
  if (state.round >= limits.maxRounds) return 'max_rounds'
  if (state.elapsedMs >= limits.maxDurationMs) return 'max_duration'
  if (state.consecutiveEmptyRounds >= limits.emptyRoundsToStop) return 'no_new_content'
  return null
}

export async function runDiscoveryEscalationProbe<T>(opts: {
  scrollViewportOnce: () => Promise<{ scrollY: number; atBottom: boolean }>
  readFreshItems: () => Promise<T[]>
  scrollSteps?: number
}): Promise<{ freshItems: T[]; scrolls: number; atBottom: boolean }> {
  const scrollSteps = Math.max(1, Math.floor(opts.scrollSteps ?? DISCOVERY_ESCALATION_SCROLL_STEPS))
  let atBottom = false
  let scrolls = 0
  for (let i = 0; i < scrollSteps; i += 1) {
    const scrolled = await opts.scrollViewportOnce()
    scrolls += 1
    atBottom = Boolean(scrolled.atBottom)
  }
  const freshItems = await opts.readFreshItems()
  return { freshItems, scrolls, atBottom }
}
