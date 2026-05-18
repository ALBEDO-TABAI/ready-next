import type { BrowserHostView } from './host-types'
import { DEFAULT_BROWSER_PAGE_BACKGROUND, resolveBrowserPageBackground } from '../../../shared/browser-page-background'

const PAGE_BACKGROUND_PROBE_SCRIPT = `(() => {
  const readColor = (element) => {
    if (!element) return null
    const style = window.getComputedStyle(element)
    return {
      color: style.backgroundColor,
    }
  }

  const coversViewport = (element) => {
    if (!element || !(element instanceof Element)) return false
    const rect = element.getBoundingClientRect()
    const viewportWidth = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1)
    const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1)
    return rect.width >= viewportWidth * 0.72 && rect.height >= viewportHeight * 0.48
  }

  const documentCandidates = []
  const viewportCandidates = []
  const html = document.documentElement
  const body = document.body
  for (const element of [html, body]) {
    const candidate = readColor(element)
    if (candidate) documentCandidates.push(candidate)
  }

  const appRoots = [
    document.getElementById('root'),
    document.getElementById('app'),
    document.querySelector('[data-reactroot]'),
    body?.firstElementChild || null,
  ]
  for (const element of appRoots) {
    if (!coversViewport(element)) continue
    const candidate = readColor(element)
    if (candidate) documentCandidates.push(candidate)
  }

  const width = Math.max(1, window.innerWidth || html?.clientWidth || 1)
  const height = Math.max(1, window.innerHeight || html?.clientHeight || 1)
  const points = [
    [Math.round(width / 2), Math.round(height / 2)],
    [Math.min(32, width - 1), Math.min(32, height - 1)],
    [Math.max(0, width - 33), Math.min(32, height - 1)],
    [Math.min(32, width - 1), Math.max(0, height - 33)],
    [Math.max(0, width - 33), Math.max(0, height - 33)],
    [Math.round(width / 2), Math.min(Math.max(32, Math.round(height * 0.2)), height - 1)],
    [Math.round(width / 2), Math.max(0, Math.round(height * 0.8))],
  ]

  for (const [x, y] of points) {
    let node = document.elementFromPoint(x, y)
    let depth = 0
    while (node && depth < 8) {
      const candidate = readColor(node)
      if (candidate) viewportCandidates.push(candidate)
      if (node === body || node === html) break
      node = node.parentElement
      depth += 1
    }
  }

  const rootStyle = html ? window.getComputedStyle(html) : null
  const bodyStyle = body ? window.getComputedStyle(body) : null
  return {
    document: documentCandidates,
    viewport: viewportCandidates,
    colorScheme: rootStyle?.colorScheme || bodyStyle?.colorScheme || '',
    prefersDark: window.matchMedia?.('(prefers-color-scheme: dark)')?.matches === true,
  }
})()`

export class BrowserPageBackgroundService {
  private readonly appliedBackgroundByView = new WeakMap<BrowserHostView, string>()

  constructor(private readonly logBrowserDiag: (message: string) => void) {}

  reset(view: BrowserHostView): void {
    this.applyBackground(view, DEFAULT_BROWSER_PAGE_BACKGROUND)
  }

  async sync(view: BrowserHostView): Promise<void> {
    try {
      const probe = await view.webContents.executeJavaScript(PAGE_BACKGROUND_PROBE_SCRIPT, true)
      this.applyBackground(view, resolveBrowserPageBackground(probe))
    } catch (error) {
      this.logBrowserDiag(`[browser-host][background] sync failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private applyBackground(view: BrowserHostView, color: string): void {
    if (this.appliedBackgroundByView.get(view) === color) return
    try {
      view.setBackgroundColor(color)
      this.appliedBackgroundByView.set(view, color)
    } catch (error) {
      this.logBrowserDiag(`[browser-host][background] apply failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
