export const DEFAULT_BROWSER_URL = 'https://gemini.google.com'
export const SEARCH_URL = 'https://www.google.com/search?q='

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
  return `${SEARCH_URL}${encodeURIComponent(trimmed)}`
}
