function safeUrl(input: string): URL | null {
  try {
    return new URL(input)
  } catch {
    return null
  }
}

function extractWeiboUserId(url: URL): string | null {
  let match = url.pathname.match(/^\/u\/(\d+)\/?$/i)
  if (match) return match[1]
  match = url.pathname.match(/^\/profile\/(\d+)\/?$/i)
  if (match) return match[1]
  match = url.pathname.match(/^\/(\d+)\/?$/i)
  if (match) return match[1]
  const containerId = url.searchParams.get('containerid') || ''
  match = containerId.match(/^100505(\d+)$/i)
  return match ? match[1] : null
}

function extractXiaohongshuProfileId(url: URL): string | null {
  const match = url.pathname.match(/\/user\/profile\/([a-zA-Z0-9_-]+)\/?$/i)
  return match ? match[1] : null
}

function extractDouyinUserId(url: URL): string | null {
  const secUid = url.searchParams.get('sec_uid')
  if (secUid) return secUid
  const match = url.pathname.match(/\/user\/([^/?#]+)\/?$/i)
  return match ? decodeURIComponent(match[1]) : null
}

function buildCaptureKey(rawUrl: string): string | null {
  const url = safeUrl(rawUrl)
  if (!url) return null
  const hostname = url.hostname.toLowerCase()

  if (hostname.endsWith('xiaohongshu.com')) {
    const profileId = extractXiaohongshuProfileId(url)
    if (profileId) return `xiaohongshu:profile:${profileId}`
  }

  if (hostname === 'weibo.com' || hostname === 'm.weibo.cn') {
    const userId = extractWeiboUserId(url)
    if (userId) return `weibo:user:${userId}`
  }

  if (hostname.endsWith('douyin.com') || hostname === 'v.douyin.com' || hostname === 'www.iesdouyin.com') {
    const userId = extractDouyinUserId(url)
    if (userId) return `douyin:user:${userId}`
  }

  const pathname = url.pathname.replace(/\/+$/, '') || '/'
  return `${hostname}:${pathname}`
}

export function isReusableCaptureTabUrl(targetUrl: string, currentUrl: string): boolean {
  const current = safeUrl(currentUrl)
  if (!current) return false
  if (/\/login\b/i.test(current.pathname)) return false

  const targetKey = buildCaptureKey(targetUrl)
  const currentKey = buildCaptureKey(currentUrl)
  if (!targetKey || !currentKey) return false
  return targetKey === currentKey
}

export function findReusableCaptureTabId(
  targetUrl: string,
  tabs: Array<{ id: string; url: string }>,
  activeTabId?: string | null,
): string | null {
  const matches = tabs.filter((tab) => isReusableCaptureTabUrl(targetUrl, tab.url))
  if (matches.length === 0) return null
  return matches.find((tab) => tab.id !== activeTabId)?.id || matches[0]?.id || null
}
