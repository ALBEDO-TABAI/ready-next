import { access, mkdir } from 'fs/promises'
import { constants as fsConstants } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type {
  BrowserDownloadUrlToDirectoryPayload,
  BrowserDownloadUrlToDirectoryResult,
} from './download-service'

import type {
  BrowserAggregateOptions,
  BrowserExtractStructuredOptions,
  BrowserExtractStructuredResult,
  BrowserOpenTargetMode,
  BrowserOpenTargetResult,
  BrowserScrollCollectOptions,
  BrowserScrollCollectResult,
  BrowserStructuredItem,
  BrowserWaitForConditionOptions,
} from './capability-types'
import { BrowserActionExecutor } from '../tools/browser-action-executor'
import type { ToolExecutionOutput } from '../agent-control/tools-runtime/tool-result-types'
import type { BrowserLeaseGate } from './agent-browser-lease-gate'

interface BrowserCapabilityHost {
  openForCaptureTarget(url: string): Promise<{ success: boolean; tabId?: string; reused?: boolean; error?: string }>
  createTab(url: string): Promise<{ success: boolean; tabId?: string; error?: string }>
  navigate(tabId: string | null, url: string): Promise<{ success: boolean; error?: string }>
  getActiveTab(): { id: string; url: string } | undefined
  executeJS(tabId: string | null, code: string): Promise<unknown>
  dispatchMouse?(
    tabId: string | null,
    payload: Record<string, unknown>,
  ): Promise<void>
  captureLiveTabPage?(
    url: string,
    options?: { timeoutMs?: number; settleMs?: number; script?: string },
  ): Promise<unknown | null>
  captureBackgroundPage?(
    url: string,
    options?: { timeoutMs?: number; settleMs?: number; script?: string },
  ): Promise<unknown>
  downloadUrlToDirectory?(
    payload: BrowserDownloadUrlToDirectoryPayload,
  ): Promise<BrowserDownloadUrlToDirectoryResult>
}

interface ScrollMetrics {
  url: string
  x: number
  y: number
  viewport: number
  height: number
  maxScroll: number
}

const capabilityActionExecutor = new BrowserActionExecutor()

function outputRecord(output: string | ToolExecutionOutput): Record<string, unknown> {
  if (typeof output !== 'string') return output.data || {}
  try {
    const parsed = JSON.parse(output) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function expandHomePath(input: string): string {
  if (!input || input === '~') return homedir()
  if (input.startsWith('~/')) return join(homedir(), input.slice(2))
  return input
}

function replaceIllegalFilenameChars(value: string): string {
  let next = ''
  for (const char of value) {
    const code = char.charCodeAt(0)
    next += code <= 31 || '<>:"/\\|?*'.includes(char) ? '-' : char
  }
  return next
}

function sanitizeFilename(value: string, fallback: string): string {
  const trimmed = replaceIllegalFilenameChars(String(value || '').trim())
  return trimmed.length > 0 ? trimmed : fallback
}

function normalizeStructuredItems(sourceUrl: string, raw: unknown): BrowserStructuredItem[] {
  const rows = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown[] }).items)
      ? (raw as { items: unknown[] }).items
      : []

  const seen = new Set<string>()
  const items: BrowserStructuredItem[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const record = row as Record<string, unknown>
    const link = String(record.link || record.url || '').trim() || undefined
    const title = String(record.title || record.name || '').trim() || undefined
    const summary = String(record.summary || record.description || record.excerpt || '').trim() || undefined
    const media = Array.isArray(record.media)
      ? record.media.map((value) => String(value || '').trim()).filter(Boolean)
      : [String(record.image || record.coverImage || '').trim()].filter(Boolean)
    const dedupeKey = link || `${title || ''}|${summary || ''}|${media.join('|')}`
    if (!dedupeKey || seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    const nestedRawFields = record.rawFields && typeof record.rawFields === 'object'
      ? record.rawFields as Record<string, unknown>
      : null
    items.push({
      sourceUrl: String(record.sourceUrl || sourceUrl || ''),
      title,
      link,
      summary,
      media,
      rawFields: nestedRawFields ? { ...record, ...nestedRawFields } : record,
    })
  }
  return items
}

function buildStructuredExtractionScript(options: BrowserExtractStructuredOptions): string {
  const template = options.template
  const itemSelector = options.itemSelector || ''
  const fields = Array.isArray(options.fields) ? options.fields : []
  const limit = Math.max(1, Math.min(200, Number(options.limit || 40)))
  const minWidth = Math.max(24, Math.min(2400, Number(options.minWidth || 120)))

  if (options.customScript) {
    return `
      (async () => {
        const __READY_EXTRACT_TEMPLATE__ = ${JSON.stringify(template)}
        const __READY_CUSTOM_SCRIPT__ = ${JSON.stringify(options.customScript)}
        return await eval(__READY_CUSTOM_SCRIPT__)
      })()
    `
  }

  return `
    (() => {
      const __READY_EXTRACT_TEMPLATE__ = ${JSON.stringify(template)}
      const limit = ${JSON.stringify(limit)}
      const itemSelector = ${JSON.stringify(itemSelector)}
      const minWidth = ${JSON.stringify(minWidth)}
      const customFields = ${JSON.stringify(fields)}
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim()
      const isVisible = (el) => {
        if (!(el instanceof HTMLElement)) return false
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return false
        const style = getComputedStyle(el)
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') > 0
      }
      const textFor = (node, selector) => {
        const target = selector ? node.querySelector(selector) : node
        return target ? normalize(target.textContent || '') : ''
      }
      const attrFor = (node, selector, attr) => {
        const target = selector ? node.querySelector(selector) : node
        if (!target) return ''
        if (attr === 'href' && target instanceof HTMLAnchorElement) return normalize(target.href || '')
        if (attr === 'src' && target instanceof HTMLImageElement) return normalize(target.currentSrc || target.src || '')
        return normalize(target.getAttribute(attr || '') || '')
      }
      const structureFor = (node) => {
        const el = node instanceof Element ? node : null
        if (!el) return null
        const nearest = el.closest('nav,aside,header,main,article,section,[role]')
        const containerClass = nearest instanceof HTMLElement
          ? normalize(String(nearest.className || '')).slice(0, 120)
          : ''
        return {
          inNavigationRegion: Boolean(el.closest('nav,[role="navigation"]')),
          inSidebarRegion: Boolean(el.closest('aside,[role="complementary"],[class*="sidebar" i],[class*="side-bar" i],[class*="side_nav" i],[class*="side-nav" i]')),
          inHeaderRegion: Boolean(el.closest('header,[role="banner"]')),
          inMainContentRegion: Boolean(el.closest('main,article,[role="main"]')) && !Boolean(el.closest('nav,aside,header,[role="navigation"],[role="banner"],[role="complementary"]')),
          nearestTagName: nearest instanceof Element ? nearest.tagName.toLowerCase() : '',
          nearestRole: nearest instanceof Element ? normalize(nearest.getAttribute('role') || '') : '',
          nearestAriaLabel: nearest instanceof Element ? normalize(nearest.getAttribute('aria-label') || nearest.getAttribute('data-testid') || '') : '',
          containerClass,
        }
      }
      const candidates = itemSelector
        ? Array.from(document.querySelectorAll(itemSelector))
        : Array.from(document.querySelectorAll('article, [role="article"], section, li, .card, [class*="card"], [class*="post"], [class*="feed"], [data-testid*="card" i]'))
      const rows = []
      const seen = new Set()

      const pushRow = (row) => {
        const key = row.link || row.url || [row.title, row.summary].filter(Boolean).join('|')
        if (!key || seen.has(key)) return
        seen.add(key)
        rows.push(row)
      }

      if (__READY_EXTRACT_TEMPLATE__ === 'image_gallery') {
        const images = itemSelector
          ? Array.from(document.querySelectorAll(itemSelector))
          : Array.from(document.querySelectorAll('img'))
        for (const node of images) {
          if (!(node instanceof HTMLImageElement) || !isVisible(node)) continue
          const rect = node.getBoundingClientRect()
          if (rect.width < minWidth || rect.height < 40) continue
          pushRow({
            sourceUrl: location.href,
            title: normalize(node.alt || node.getAttribute('title') || ''),
            link: normalize(node.closest('a')?.href || node.currentSrc || node.src || ''),
            summary: '',
            media: [normalize(node.currentSrc || node.src || '')].filter(Boolean),
            rawFields: { structure: structureFor(node) },
          })
          if (rows.length >= limit) break
        }
        return rows
      }

      if (__READY_EXTRACT_TEMPLATE__ === 'link_list') {
        const links = itemSelector
          ? Array.from(document.querySelectorAll(itemSelector))
          : Array.from(document.querySelectorAll('a[href]'))
        for (const node of links) {
          if (!(node instanceof HTMLAnchorElement) || !isVisible(node)) continue
          const title = normalize(node.textContent || node.getAttribute('title') || node.getAttribute('aria-label') || '')
          const link = normalize(node.href || '')
          if (!link) continue
          pushRow({ sourceUrl: location.href, title, link, summary: '', rawFields: { structure: structureFor(node) } })
          if (rows.length >= limit) break
        }
        return rows
      }

      for (const node of candidates) {
        if (!(node instanceof HTMLElement) || !isVisible(node)) continue
        const anchors = Array.from(node.querySelectorAll('a[href]'))
          .filter((item) => item instanceof HTMLAnchorElement)
        const anchor = anchors
          .map((item) => {
            const rect = item.getBoundingClientRect()
            return { item, area: isVisible(item) ? Math.max(0, rect.width) * Math.max(0, rect.height) : 0 }
          })
          .sort((a, b) => b.area - a.area)[0]?.item || anchors[0]
        const title = normalize(
          node.querySelector('h1,h2,h3,h4,strong,[data-testid*="title" i],[class*="title"]')?.textContent ||
          anchor?.textContent ||
          node.getAttribute('aria-label') ||
          ''
        )
        const summary = normalize(
          node.querySelector('p,[data-testid*="summary" i],[class*="summary"],[class*="desc"],[class*="excerpt"]')?.textContent ||
          ''
        )
        const link = normalize(anchor instanceof HTMLAnchorElement ? anchor.href : '')
        const media = Array.from(node.querySelectorAll('img'))
          .filter((img) => img instanceof HTMLImageElement && isVisible(img))
          .map((img) => normalize(img.currentSrc || img.src || ''))
          .filter(Boolean)
          .slice(0, 4)
        const row = {
          sourceUrl: location.href,
          title,
          link,
          summary,
          media,
          rawFields: { structure: structureFor(node) },
        }
        if (__READY_EXTRACT_TEMPLATE__ === 'custom') {
          const rawFields = { structure: structureFor(node) }
          for (const field of customFields) {
            const fieldName = normalize(field.name)
            if (!fieldName) continue
            const fieldType = String(field.type || 'text')
            rawFields[field.name] =
              fieldType === 'html'
                ? (field.selector ? node.querySelector(field.selector)?.innerHTML || '' : node.innerHTML)
                : fieldType === 'href' || fieldType === 'src' || fieldType === 'attr'
                  ? attrFor(node, field.selector, field.attr || fieldType)
                  : textFor(node, field.selector)
          }
          row.rawFields = rawFields
          if (!row.title && typeof rawFields.title === 'string') row.title = rawFields.title
          if (!row.link && typeof rawFields.link === 'string') row.link = rawFields.link
          if (!row.summary && typeof rawFields.summary === 'string') row.summary = rawFields.summary
        }
        pushRow(row)
        if (rows.length >= limit) break
      }

      return rows
    })()
  `
}

export class BrowserCapabilityService {
  constructor(private readonly host: BrowserCapabilityHost) {}

  private async readScrollMetrics(tabId: string | null): Promise<ScrollMetrics> {
    const raw = await this.host.executeJS(tabId, `(() => {
      const root = document.scrollingElement || document.documentElement || document.body
      const viewport = Math.max(1, Number(window.innerHeight || root?.clientHeight || 800))
      const height = Math.max(viewport, Number(root?.scrollHeight || document.body?.scrollHeight || 0))
      const y = Math.max(0, Number(window.scrollY || root?.scrollTop || 0))
      return {
        url: String(location.href || ''),
        x: Math.max(1, Math.round(Number(window.innerWidth || root?.clientWidth || 800) / 2)),
        y,
        viewport,
        height,
        maxScroll: Math.max(0, height - viewport)
      }
    })()`) as Partial<ScrollMetrics> | null
    const viewport = Math.max(1, Number(raw?.viewport || 800))
    const height = Math.max(viewport, Number(raw?.height || viewport))
    return {
      url: String(raw?.url || this.host.getActiveTab()?.url || ''),
      x: Math.max(1, Number(raw?.x || 400)),
      y: Math.max(0, Number(raw?.y || 0)),
      viewport,
      height,
      maxScroll: Math.max(0, Number(raw?.maxScroll ?? height - viewport)),
    }
  }

  private async waitForScrollSettled(
    tabId: string | null,
    before: ScrollMetrics,
    signal: AbortSignal,
    timeoutMs = 1_200,
  ): Promise<ScrollMetrics> {
    const startedAt = Date.now()
    let last = before
    let stableReads = 0
    while (Date.now() - startedAt < timeoutMs) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('browser_scroll_aborted')
      await delay(50)
      const next = await this.readScrollMetrics(tabId)
      const unchanged = Math.abs(next.y - last.y) < 1 && next.height === last.height
      stableReads = unchanged ? stableReads + 1 : 0
      last = next
      if (stableReads >= 2 || next.y >= next.maxScroll - 2) return next
    }
    return last
  }

  /** Current active tab (id + url). Used by background collection to record the
   *  resolved page URL when the task was started without an explicit `url`
   *  (current-page collection), so failure-learning has a domain. */
  getActiveTab(): { id: string; url: string } | undefined {
    return this.host.getActiveTab()
  }

  async openTarget(
    url: string,
    mode: BrowserOpenTargetMode = 'prefer_reuse',
    leaseGate?: BrowserLeaseGate,
  ): Promise<BrowserOpenTargetResult> {
    if (leaseGate) {
      const output = await capabilityActionExecutor.execute({
        toolName: 'browser_tabs',
        args: { action: 'open', url },
        origin: url,
        leaseGate,
        dispatch: async () => JSON.stringify(await this.openTarget(url, mode)),
      })
      return outputRecord(output) as unknown as BrowserOpenTargetResult
    }
    if (mode === 'current_tab') {
      const activeTab = this.host.getActiveTab()
      const result = await this.host.navigate(activeTab?.id || null, url)
      return result.success
        ? { success: true, tabId: activeTab?.id || undefined, reused: Boolean(activeTab?.id), url }
        : { success: false, error: result.error }
    }

    if (mode === 'new_tab') {
      const created = await this.host.createTab(url)
      return created.success
        ? { success: true, tabId: created.tabId, reused: false, url }
        : { success: false, error: created.error }
    }

    const reusable = await this.host.openForCaptureTarget(url)
    if (reusable.success) {
      return { success: true, tabId: reusable.tabId, reused: reusable.reused, url }
    }

    const created = await this.host.createTab(url)
    return created.success
      ? { success: true, tabId: created.tabId, reused: false, url }
      : { success: false, error: created.error || reusable.error }
  }

  async navigateTargetTab(tabId: string, url: string, leaseGate?: BrowserLeaseGate): Promise<BrowserOpenTargetResult> {
    const output = await capabilityActionExecutor.execute({
      toolName: 'browser_navigate',
      args: { action: 'goto', tab_id: tabId, url },
      origin: url,
      leaseGate,
      dispatch: async () => {
        const result = await this.host.navigate(tabId, url)
        return JSON.stringify(result.success
          ? { success: true, tabId, reused: true, url }
          : { success: false, tabId, reused: true, url, error: result.error })
      },
    })
    return outputRecord(output) as unknown as BrowserOpenTargetResult
  }

  async waitForCondition(tabId: string | null, options: BrowserWaitForConditionOptions): Promise<{ matched: boolean; elapsedMs: number; value?: unknown }> {
    const startedAt = Date.now()
    const timeoutMs = Math.max(500, Math.min(60_000, Number(options.timeoutMs || 8_000)))
    const checkIntervalMs = Math.max(50, Math.min(2_000, Number(options.checkIntervalMs || 250)))
    const stableIterations = Math.max(1, Math.min(10, Number(options.stableIterations || 2)))
    let consecutiveMatches = 0
    let lastValue: unknown = null

    while (Date.now() - startedAt <= timeoutMs) {
      const result = await this.host.executeJS(
        tabId,
        `
          (() => {
            const __READY_WAIT_CONDITION__ = ${JSON.stringify(options.condition)}
            const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim()
            const selector = ${JSON.stringify(options.selector || '')}
            const customJs = ${JSON.stringify(options.customJs || '')}
            const bodyText = normalize(document.body?.innerText || '')
            const contentSignature = [bodyText.length, document.body?.scrollHeight || 0, document.body?.childElementCount || 0].join(':')
            let matched = false
            let value = null

            if (__READY_WAIT_CONDITION__ === 'page_readable') {
              matched = (document.readyState === 'interactive' || document.readyState === 'complete') && bodyText.length > 0
              value = { readyState: document.readyState, textLength: bodyText.length }
            } else if (__READY_WAIT_CONDITION__ === 'selector') {
              matched = Boolean(selector && document.querySelector(selector))
              value = matched
            } else if (__READY_WAIT_CONDITION__ === 'network_idle') {
              const resourceCount = performance.getEntriesByType('resource').length
              matched = document.readyState === 'complete'
              value = { resourceCount, contentSignature }
            } else if (__READY_WAIT_CONDITION__ === 'content_stable') {
              matched = bodyText.length > 0
              value = { contentSignature }
            } else if (__READY_WAIT_CONDITION__ === 'custom_js') {
              value = customJs ? eval(customJs) : false
              matched = Boolean(value)
            }

            return { matched, value }
          })()
        `,
      ) as { matched?: boolean; value?: unknown } | null

      if (options.condition === 'content_stable' || options.condition === 'network_idle') {
        const signature = JSON.stringify(result?.value || null)
        if (result?.matched && signature === JSON.stringify(lastValue)) {
          consecutiveMatches += 1
        } else {
          consecutiveMatches = result?.matched ? 1 : 0
          lastValue = result?.value ?? null
        }
        if (consecutiveMatches >= stableIterations) {
          return { matched: true, elapsedMs: Date.now() - startedAt, value: result?.value }
        }
      } else if (result?.matched) {
        return { matched: true, elapsedMs: Date.now() - startedAt, value: result?.value }
      }

      await delay(checkIntervalMs)
    }

    return { matched: false, elapsedMs: Date.now() - startedAt, value: lastValue }
  }

  async extractStructured(tabId: string | null, options: BrowserExtractStructuredOptions): Promise<BrowserExtractStructuredResult> {
    if (options.wait) {
      await this.waitForCondition(tabId, options.wait)
    }
    const raw = await this.host.executeJS(tabId, buildStructuredExtractionScript(options))
    // The source URL must come from the tab being extracted, not the active tab
    // (plan §3.5 / Codex R2 #3): an agent-tab background collection must not
    // attribute the user's current page as the source and pollute relative links.
    let sourceUrl = ''
    if (tabId) {
      try {
        sourceUrl = String(await this.host.executeJS(tabId, 'location.href') || '')
      } catch {
        sourceUrl = ''
      }
    }
    if (!sourceUrl) sourceUrl = this.host.getActiveTab()?.url || ''
    return {
      template: options.template,
      items: normalizeStructuredItems(sourceUrl, raw),
      sourceUrl,
    }
  }

  /**
   * Scroll one viewport-height down (counterplan §5.5 visible-collect loop).
   * Returns the new scroll position and whether the page bottom is reached.
   * NOTE: the humanized-input migration (WP5) will route this through the
   * unified write channel; today it is a single instant scroll step.
   */
  async scrollViewportOnce(tabId: string | null, leaseGate?: BrowserLeaseGate): Promise<{ scrollY: number; atBottom: boolean }> {
    if (!this.host.dispatchMouse) throw new Error('browser_trusted_scroll_unavailable')
    const before = await this.readScrollMetrics(tabId)
    const output = await capabilityActionExecutor.execute({
      toolName: 'browser_scroll',
      args: { tab_id: tabId, direction: 'down', amount: 'viewport' },
      origin: before.url,
      leaseGate,
      deadlineMs: 4_000,
      dispatch: async (_invocation, signal) => {
        await this.host.dispatchMouse?.(tabId, {
          type: 'mouseWheel',
          x: before.x,
          y: Math.max(1, Math.round(before.viewport / 2)),
          deltaX: 0,
          deltaY: Math.max(1, Math.round(before.viewport * 0.9)),
        })
        const after = await this.waitForScrollSettled(tabId, before, signal)
        return JSON.stringify({
          ok: true,
          trustedInput: true,
          scrollY: after.y,
          atBottom: after.y >= after.maxScroll - 2 || after.y === before.y,
        })
      },
    })
    const record = outputRecord(output)
    if (record.ok !== true) throw new Error(String(record.errorKind || record.message || 'browser_trusted_scroll_failed'))
    return { scrollY: Number(record.scrollY || 0), atBottom: record.atBottom === true }
  }

  async captureFromUrl(url: string, options: { customScript: string; timeoutMs?: number; settleMs?: number; preferReuse?: boolean }): Promise<unknown | null> {
    if (options.preferReuse !== false && typeof this.host.captureLiveTabPage === 'function') {
      try {
        const snapshot = await this.host.captureLiveTabPage(url, {
          timeoutMs: options.timeoutMs,
          settleMs: options.settleMs,
          script: options.customScript,
        })
        if (snapshot) return snapshot
      } catch {
        // fall through to background capture
      }
    }

    if (typeof this.host.captureBackgroundPage === 'function') {
      return this.host.captureBackgroundPage(url, {
        timeoutMs: options.timeoutMs,
        settleMs: options.settleMs,
        script: options.customScript,
      })
    }

    const opened = await this.openTarget(url, 'prefer_reuse')
    if (!opened.success) return null
    return this.host.executeJS(opened.tabId || null, options.customScript)
  }

  async extractStructuredFromUrl(url: string, options: BrowserExtractStructuredOptions): Promise<BrowserExtractStructuredResult> {
    if (options.customScript) {
      const raw = await this.captureFromUrl(url, {
        customScript: options.customScript,
        timeoutMs: options.timeoutMs,
        settleMs: options.settleMs,
        preferReuse: options.openMode !== 'new_tab',
      })
      return {
        template: options.template,
        items: normalizeStructuredItems(url, raw),
        sourceUrl: url,
      }
    }

    const opened = await this.openTarget(url, options.openMode || 'prefer_reuse')
    if (!opened.success) {
      throw new Error(opened.error || 'Failed to open target page')
    }
    return this.extractStructured(opened.tabId || null, options)
  }

  async scrollCollect(tabId: string | null, options: BrowserScrollCollectOptions): Promise<BrowserScrollCollectResult> {
    const maxScrolls = Math.max(1, Math.min(200, Number(options.maxScrolls || 24)))
    const stableRounds = Math.max(1, Math.min(8, Number(options.stableRounds || 2)))
    let unchangedRounds = 0
    let scrolls = 0
    let previous = await this.readScrollMetrics(tabId)
    while (scrolls < maxScrolls && unchangedRounds < stableRounds) {
      const scroll = await this.scrollViewportOnce(tabId)
      scrolls += 1
      const next = await this.readScrollMetrics(tabId)
      const unchanged = next.height === previous.height && next.y === previous.y
      unchangedRounds = unchanged || scroll.atBottom ? unchangedRounds + 1 : 0
      previous = next
      if (!scroll.atBottom) {
        await this.waitForCondition(tabId, {
          condition: 'content_stable',
          timeoutMs: Math.max(500, Math.min(3_000, Number(options.scrollDelayMs || 1_200))),
          checkIntervalMs: 100,
          stableIterations: 2,
        })
      }
    }
    const rawItems = await this.host.executeJS(
      tabId,
      buildStructuredExtractionScript({ ...options, wait: undefined }),
    )

    // Attribute sourceUrl to the TARGET tab, not the user's active tab: a
    // sub-agent collecting in the agent tab must not mis-source results (Codex
    // result-review #3). Fall back to the active tab only when no tabId is given.
    let sourceUrl = ''
    if (tabId) {
      sourceUrl = String((await this.host.executeJS(tabId, 'location.href')) || '')
    }
    if (!sourceUrl) sourceUrl = this.host.getActiveTab()?.url || ''
    return {
      template: options.template,
      items: normalizeStructuredItems(sourceUrl, rawItems),
      sourceUrl,
      reachedEnd: unchangedRounds >= stableRounds,
      scrolls,
    }
  }

  aggregateResults(items: BrowserStructuredItem[], options?: BrowserAggregateOptions): BrowserStructuredItem[] {
    const mergeStrategy = options?.mergeStrategy || 'dedupe'
    let merged = mergeStrategy === 'concat'
      ? [...items]
      : normalizeStructuredItems('', items)

    if (options?.sortBy === 'title') {
      merged = merged.sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')))
    } else if (options?.sortBy === 'link') {
      merged = merged.sort((a, b) => String(a.link || '').localeCompare(String(b.link || '')))
    } else if (options?.sortBy === 'source') {
      merged = merged.sort((a, b) => String(a.sourceUrl || '').localeCompare(String(b.sourceUrl || '')))
    }

    return merged
  }

  async batchDownload(
    urls: string[],
    options?: {
      directory?: string
      filenamePrefix?: string
      overwrite?: boolean
      retryFailed?: boolean
      resumeResults?: Array<Record<string, unknown>>
      shouldStop?: () => boolean
      onProgress?: (progress: {
        total: number
        completed: number
        failed: number
        currentLabel?: string | null
        results: Array<Record<string, unknown>>
      }) => void
    },
  ): Promise<{
    directory: string
    total: number
    success: number
    failed: number
    results: Array<Record<string, unknown>>
  }> {
    const directory = expandHomePath(String(options?.directory || '~/Documents'))
    const retryFailed = options?.retryFailed === true
    const filenamePrefix = sanitizeFilename(String(options?.filenamePrefix || '').trim(), 'download')
    const filteredUrls = urls.map((item) => String(item || '').trim()).filter(Boolean)

    await mkdir(directory, { recursive: true })
    await access(directory, fsConstants.W_OK)

    const results: Array<Record<string, unknown>> = Array.isArray(options?.resumeResults)
      ? options.resumeResults.map((item) => ({ ...item }))
      : []
    const completedUrls = new Set(results
      .filter((item) => item.success === true)
      .map((item) => String(item.url || ''))
      .filter(Boolean))
    let completed = completedUrls.size
    let failed = results.filter((item) => item.success !== true).length
    for (let index = 0; index < filteredUrls.length; index += 1) {
      const url = filteredUrls[index]
      if (options?.shouldStop?.()) break
      if (completedUrls.has(url)) {
        options?.onProgress?.({
          total: filteredUrls.length,
          completed,
          failed,
          currentLabel: url,
          results: results.map((item) => ({ ...item })),
        })
        continue
      }
      const priorFailures = results.filter((item) => item.success !== true && String(item.url || '') === url).length
      if (priorFailures > 0) {
        for (let resultIndex = results.length - 1; resultIndex >= 0; resultIndex -= 1) {
          const item = results[resultIndex]
          if (item.success !== true && String(item.url || '') === url) results.splice(resultIndex, 1)
        }
        failed = Math.max(0, failed - priorFailures)
      }
      const attemptDownload = async (): Promise<Record<string, unknown>> => {
        if (!this.host.downloadUrlToDirectory) throw new Error('browser_session_download_unavailable')
        const downloaded = await this.host.downloadUrlToDirectory({
          url,
          targetDir: directory,
          suggestedName: `${filenamePrefix}-${index + 1}`,
        })
        if (!downloaded.success) throw new Error(downloaded.error || 'browser_session_download_failed')
        return {
          url,
          success: true,
          path: downloaded.savePath,
          size: downloaded.size,
          sha256: downloaded.sha256,
          content_type: downloaded.mimeType,
          url_chain: downloaded.urlChain || [],
          via: 'browser_session',
        }
      }

      try {
        const downloaded = await attemptDownload()
        results.push(downloaded)
        completed += 1
      } catch (error) {
        if (retryFailed) {
          try {
            const downloaded = await attemptDownload()
            results.push({ ...downloaded, retried: true })
            completed += 1
          } catch (retryError) {
            results.push({
              url,
              success: false,
              error: retryError instanceof Error ? retryError.message : String(retryError),
            })
            failed += 1
          }
        } else {
          results.push({
            url,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          })
          failed += 1
        }
      }

      options?.onProgress?.({
        total: filteredUrls.length,
        completed,
        failed,
        currentLabel: url,
        results: results.map((item) => ({ ...item })),
      })
    }

    return {
      directory,
      total: filteredUrls.length,
      success: completed,
      failed,
      results,
    }
  }
}
