import { access, mkdir, writeFile } from 'fs/promises'
import { constants as fsConstants } from 'fs'
import { basename, extname, join } from 'path'
import { homedir } from 'os'

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

interface BrowserCapabilityHost {
  openForCaptureTarget(url: string): Promise<{ success: boolean; tabId?: string; reused?: boolean; error?: string }>
  createTab(url: string): Promise<{ success: boolean; tabId?: string; error?: string }>
  navigate(tabId: string | null, url: string): Promise<{ success: boolean; error?: string }>
  getActiveTab(): { id: string; url: string } | undefined
  executeJS(tabId: string | null, code: string): Promise<unknown>
  captureLiveTabPage?(
    url: string,
    options?: { timeoutMs?: number; settleMs?: number; script?: string },
  ): Promise<unknown | null>
  captureBackgroundPage?(
    url: string,
    options?: { timeoutMs?: number; settleMs?: number; script?: string },
  ): Promise<unknown>
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

function inferFilename(url: string, prefix: string, contentType: string): { base: string; ext: string } {
  try {
    const parsed = new URL(url)
    const rawName = basename(parsed.pathname || '') || prefix
    const ext = extname(rawName) || inferExtensionFromContentType(contentType)
    const base = sanitizeFilename(rawName.replace(new RegExp(`${ext.replace('.', '\\.')}$`), ''), prefix)
    return { base, ext: ext || '.bin' }
  } catch {
    return { base: sanitizeFilename(prefix, 'download'), ext: inferExtensionFromContentType(contentType) || '.bin' }
  }
}

function inferExtensionFromContentType(contentType: string): string {
  const normalized = String(contentType || '').toLowerCase()
  if (normalized.includes('image/jpeg')) return '.jpg'
  if (normalized.includes('image/png')) return '.png'
  if (normalized.includes('image/webp')) return '.webp'
  if (normalized.includes('image/gif')) return '.gif'
  if (normalized.includes('application/json')) return '.json'
  if (normalized.includes('text/html')) return '.html'
  return ''
}

async function writeFileSmart(
  directory: string,
  base: string,
  ext: string,
  buffer: Buffer,
  overwrite: boolean,
): Promise<string> {
  let filePath = join(directory, `${base}${ext}`)
  if (overwrite) {
    await writeFile(filePath, buffer)
    return filePath
  }

  let suffix = 1
  while (true) {
    try {
      await access(filePath, fsConstants.F_OK)
      filePath = join(directory, `${base}-${suffix}${ext}`)
      suffix += 1
    } catch {
      await writeFile(filePath, buffer)
      return filePath
    }
  }
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
    items.push({
      sourceUrl: String(record.sourceUrl || sourceUrl || ''),
      title,
      link,
      summary,
      media,
      rawFields: record,
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
          pushRow({ sourceUrl: location.href, title, link, summary: '' })
          if (rows.length >= limit) break
        }
        return rows
      }

      for (const node of candidates) {
        if (!(node instanceof HTMLElement) || !isVisible(node)) continue
        const anchor = node.querySelector('a[href]')
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
          rawFields: {},
        }
        if (__READY_EXTRACT_TEMPLATE__ === 'custom') {
          const rawFields = {}
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

  async openTarget(url: string, mode: BrowserOpenTargetMode = 'prefer_reuse'): Promise<BrowserOpenTargetResult> {
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
  async scrollViewportOnce(tabId: string | null): Promise<{ scrollY: number; atBottom: boolean }> {
    const raw = await this.host.executeJS(
      tabId,
      `
        (() => {
          const before = window.scrollY || 0
          const viewport = window.innerHeight || 800
          window.scrollBy({ top: Math.round(viewport * 0.9), left: 0, behavior: 'instant' })
          const after = window.scrollY || 0
          const maxScroll = Math.max(0, (document.body?.scrollHeight || 0) - viewport)
          return { scrollY: after, atBottom: after >= maxScroll - 2 || after === before }
        })()
      `,
    ) as { scrollY?: number; atBottom?: boolean } | null
    return { scrollY: Number(raw?.scrollY || 0), atBottom: Boolean(raw?.atBottom) }
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
    const scrollDelayMs = Math.max(50, Math.min(5_000, Number(options.scrollDelayMs || 300)))
    const stableRounds = Math.max(1, Math.min(8, Number(options.stableRounds || 2)))

    const raw = await this.host.executeJS(
      tabId,
      `
        (async () => {
          const __READY_SCROLL_COLLECT__ = ${JSON.stringify(options.template)}
          const maxScrolls = ${JSON.stringify(maxScrolls)}
          const scrollDelayMs = ${JSON.stringify(scrollDelayMs)}
          const stableRoundsTarget = ${JSON.stringify(stableRounds)}
          const rows = []
          let stableRounds = 0
          let lastHeight = 0
          let scrolls = 0

          while (scrolls < maxScrolls && stableRounds < stableRoundsTarget) {
            window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' })
            await new Promise((resolve) => setTimeout(resolve, scrollDelayMs))
            const nextHeight = document.body.scrollHeight || 0
            if (nextHeight === lastHeight) {
              stableRounds += 1
            } else {
              stableRounds = 0
              lastHeight = nextHeight
            }
            scrolls += 1
          }

          return {
            items: await (${buildStructuredExtractionScript({ ...options, wait: undefined }).trim()}) ,
            reachedEnd: stableRounds >= stableRoundsTarget,
            scrolls,
          }
        })()
      `,
    ) as { items?: unknown[]; reachedEnd?: boolean; scrolls?: number } | null

    const activeTab = this.host.getActiveTab()
    return {
      template: options.template,
      items: normalizeStructuredItems(activeTab?.url || '', raw?.items || []),
      sourceUrl: activeTab?.url || '',
      reachedEnd: Boolean(raw?.reachedEnd),
      scrolls: Number(raw?.scrolls || 0),
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
      onProgress?: (progress: { total: number; completed: number; failed: number; currentLabel?: string | null }) => void
    },
  ): Promise<{
    directory: string
    total: number
    success: number
    failed: number
    results: Array<Record<string, unknown>>
  }> {
    const directory = expandHomePath(String(options?.directory || '~/Documents'))
    const overwrite = options?.overwrite === true
    const retryFailed = options?.retryFailed === true
    const filenamePrefix = sanitizeFilename(String(options?.filenamePrefix || '').trim(), 'download')
    const filteredUrls = urls.map((item) => String(item || '').trim()).filter(Boolean)

    await mkdir(directory, { recursive: true })
    await access(directory, fsConstants.W_OK)

    const results: Array<Record<string, unknown>> = []
    let completed = 0
    let failed = 0
    for (let index = 0; index < filteredUrls.length; index += 1) {
      const url = filteredUrls[index]
      const attemptDownload = async (): Promise<Record<string, unknown>> => {
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Ready Browser Capability)',
          },
        })
        if (!response.ok) {
          throw new Error(`http_${response.status}`)
        }
        const contentType = response.headers.get('content-type') || ''
        const buffer = Buffer.from(await response.arrayBuffer())
        const fileParts = inferFilename(url, `${filenamePrefix}-${index + 1}`, contentType)
        const filePath = await writeFileSmart(directory, fileParts.base, fileParts.ext, buffer, overwrite)
        return {
          url,
          success: true,
          path: filePath,
          size: buffer.byteLength,
          content_type: contentType,
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
