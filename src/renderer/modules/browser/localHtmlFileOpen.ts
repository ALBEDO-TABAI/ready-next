import { useBrowserTabs } from '../../stores/useBrowserTabs'
import { toFileUrl } from '../../utils/dragDrop'
import { browserTabActivationSequencer } from './browserTabActivationSequencer'
import { isReadyBoardFile } from '../../../shared/ready-board'

const LOCAL_HTML_EXTENSIONS = new Set(['html', 'htm'])

interface LocalHtmlBackendTab {
  id: string
  url: string
  title?: string
  loading?: boolean
  canGoBack?: boolean
  canGoForward?: boolean
  domain?: string
  favicon?: string | null
  owner?: 'manual' | 'agent'
  required?: boolean
  activity?: 'idle' | 'running' | 'attention'
  lastAuditedAt?: number | null
  error?: string | null
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    // silent-catch: decodeURIComponent fallback for malformed percent-encoded paths; raw value remains usable for downstream consumers.
    return value
  }
}

function toComparableLocalPath(value: string): string | null {
  const trimmed = String(value || '').trim()
  if (!trimmed) return null

  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'file:' && parsed.protocol !== 'local-file:') return null

    let path = parsed.pathname || ''
    if (parsed.protocol === 'local-file:' && parsed.host) {
      path = `/${parsed.host}${path}`
    }
    if (/^\/[a-zA-Z]:\//.test(path)) {
      path = path.slice(1)
    }
    return decodePath(path).replace(/\\/g, '/')
  } catch {
    // silent-catch: URL parse fallback for local file path normalization; raw trimmed value with backslash normalization remains a valid local-path candidate.
    return trimmed.replace(/\\/g, '/')
  }
}

function pointsToSameLocalHtmlFile(left: string, right: string): boolean {
  const leftPath = toComparableLocalPath(left)
  const rightPath = toComparableLocalPath(right)
  if (!leftPath || !rightPath) return false
  return leftPath === rightPath || leftPath.toLowerCase() === rightPath.toLowerCase()
}

function upsertBrowserTab(tab: LocalHtmlBackendTab, url: string, title?: string): void {
  const store = useBrowserTabs.getState()
  const nextTab = {
    id: tab.id,
    url,
    title: tab.title || title || 'Loading...',
    loading: Boolean(tab.loading),
    canGoBack: Boolean(tab.canGoBack),
    canGoForward: Boolean(tab.canGoForward),
    domain: tab.domain,
    favicon: tab.favicon || undefined,
    owner: tab.owner || 'manual',
    required: Boolean(tab.required),
    activity: tab.activity || 'idle',
    lastAuditedAt: tab.lastAuditedAt ?? null,
    error: tab.error || undefined,
  }

  if (store.tabs.some((existing) => existing.id === tab.id)) {
    store.updateTab(tab.id, nextTab)
  } else {
    store.addTab(nextTab)
  }
}

async function findExistingLocalHtmlTab(url: string): Promise<LocalHtmlBackendTab | null> {
  const tabs = await window.electronAPI?.browser?.getTabs?.()
  if (!Array.isArray(tabs)) return null
  const matches = tabs.filter((tab) => pointsToSameLocalHtmlFile(tab.url, url))
  if (matches.length === 0) return null

  return matches.sort((left, right) => {
    const score = (tab: LocalHtmlBackendTab) => {
      let value = 0
      if (tab.url.startsWith('file://')) value += 4
      if (!tab.loading) value += 2
      if (!tab.error) value += 1
      return value
    }
    return score(right) - score(left)
  })[0] || null
}

export function isLocalHtmlFilePath(path: string | null | undefined): boolean {
  if (!path) return false
  if (isReadyBoardFile(path)) return false
  const name = path.split(/[\\/]/).pop() || path
  const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() || '' : ''
  return LOCAL_HTML_EXTENSIONS.has(ext)
}

export async function openLocalHtmlFileInBrowser(path: string, title?: string): Promise<boolean> {
  if (!isLocalHtmlFilePath(path)) return false
  if (typeof window === 'undefined' || !window.electronAPI?.browser) return false

  const url = toFileUrl(path)
  const browser = window.electronAPI.browser
  const existingTab = await findExistingLocalHtmlTab(url).catch(() => null)

  if (existingTab) {
    if (existingTab.url !== url) {
      const navigation = await browser.navigate(existingTab.id, url)
      if (!navigation?.success) return false
    }
    const switched = await browser.switchTab?.(existingTab.id)
    if (!switched?.success) return false

    upsertBrowserTab({ ...existingTab, ...switched, id: existingTab.id }, url, title)
    browserTabActivationSequencer.invalidate()
    useBrowserTabs.getState().setActiveTabId(existingTab.id)
    useBrowserTabs.getState().setUrlInput(url)
    return true
  }

  const result = await browser.createTab(url) as
    | { success: boolean; tabId?: string; error?: string }
    | undefined

  if (!result?.success || !result.tabId) return false

  try {
    await browser.switchTab?.(result.tabId)
  } catch {
    // silent-catch: createTab already made the tab active in the main process; a switchTab failure here is a redundant no-op rather than a real loss.
  }

  upsertBrowserTab({
    id: result.tabId,
    url,
    title: title || 'Loading...',
    loading: true,
    canGoBack: false,
    canGoForward: false,
    owner: 'manual',
    required: false,
    activity: 'idle',
  }, url, title)
  browserTabActivationSequencer.invalidate()
  useBrowserTabs.getState().setActiveTabId(result.tabId)
  useBrowserTabs.getState().setUrlInput(url)
  return true
}
