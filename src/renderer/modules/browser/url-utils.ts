import { resolveSearchEngine, searchTemplateUrl } from '../../../shared/search-engines'
import { getBrowserSearchSettings } from './search-settings'
import { DEFAULT_BROWSER_URL, isReadyBrowserBlankUrl } from '../../../shared/browser-defaults'

export { DEFAULT_BROWSER_URL, READY_BROWSER_BLANK_URL, isReadyBrowserBlankUrl } from '../../../shared/browser-defaults'

export const LOGIN_DOMAINS = [
  'google.com', 'youtube.com', 'github.com', 'twitter.com', 'x.com',
  'facebook.com', 'instagram.com', 'linkedin.com', 'notion.so',
  'slack.com', 'discord.com', 'reddit.com', 'amazon.com', 'netflix.com',
  'bilibili.com', 'zhihu.com', 'weibo.com', 'taobao.com', 'jd.com',
  'douyin.com', 'baidu.com', 'feishu.cn', 'dingtalk.com',
]

export function extractBrowserDomain(url: string): string {
  try {
    const hostname = new URL(url).hostname
    const parts = hostname.split('.')
    if (parts.length >= 2) return parts.slice(-2).join('.')
    return hostname
  } catch {
    return ''
  }
}

export function isLikelyAbsolutePath(value: string): boolean {
  if (!value) return false
  if (value.startsWith('/')) return true
  if (/^[a-zA-Z]:[\\/]/.test(value)) return true
  if (value.startsWith('\\\\')) return true
  return false
}

export function normalizeBrowserUrlInput(
  input: string,
  toFileUrl: (path: string) => string,
  searchEngine = getBrowserSearchSettings().searchEngine,
): string {
  const trimmed = input.trim()
  if (!trimmed) return DEFAULT_BROWSER_URL
  if (trimmed.startsWith('file://')) return trimmed
  if (trimmed.startsWith('local-file://')) {
    const rawPath = decodeURIComponent(trimmed.replace(/^local-file:\/\//, ''))
    return toFileUrl(rawPath)
  }
  if (isLikelyAbsolutePath(trimmed)) return toFileUrl(trimmed)
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed
  if (trimmed.includes('.') && !trimmed.includes(' ')) return `https://${trimmed}`
  return searchTemplateUrl(resolveSearchEngine(searchEngine).search, trimmed)
}

export function isLocalHtmlBrowserUrl(url: string): boolean {
  const normalized = String(url || '').trim()
  try {
    const parsed = new URL(normalized)
    if (parsed.protocol !== 'file:' && parsed.protocol !== 'local-file:') return false
    const path = decodeURIComponent(`${parsed.host || ''}${parsed.pathname || ''}`)
    return /\.(?:html|htm)$/i.test(path)
  } catch {
    // silent-catch: URL parse fallback for HTML-extension detection; non-URL inputs return false (correct behavior — they are not local HTML).
    return false
  }
}

export function isSupportedBrowserNavigationUrl(url: string): boolean {
  const normalized = String(url || '').trim()
  return isReadyBrowserBlankUrl(normalized) || /^https?:\/\//i.test(normalized) || isLocalHtmlBrowserUrl(normalized)
}

/** What a tab's row says on hover: its whole title, and the site it is on (the row itself shows the title only). */
export function browserTabHoverText(tab: { title?: string | null; domain?: string | null; url?: string | null }): string {
  const title = tab.title || 'New Tab'
  const domain = tab.domain || extractBrowserDomain(tab.url || '')
  return domain && domain !== title ? `${title}\n${domain}` : title
}
