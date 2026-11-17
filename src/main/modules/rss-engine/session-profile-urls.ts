/**
 * Which page a session subscription opens. Pure string work: an address that does not name the profile itself
 * (a short link, a video link) is opened as it is, and the browser follows it the way it would for a person.
 */
import type { PlatformType } from './scrapers'

export function extractWeiboUserId(url: string): string | null {
  let match = url.match(/weibo\.com\/u\/(\d+)/i)
  if (match) return match[1]
  match = url.match(/m\.weibo\.cn\/u\/(\d+)/i)
  if (match) return match[1]
  match = url.match(/m\.weibo\.cn\/profile\/(\d+)/i)
  if (match) return match[1]
  match = url.match(/[?&]containerid=100505(\d+)/i)
  if (match) return match[1]
  match = url.match(/weibo\.com\/(\d+)/i)
  return match ? match[1] : null
}

export function extractXiaohongshuUserId(url: string): string | null {
  let match = url.match(/\/user\/profile\/([a-zA-Z0-9_-]+)(?:[/?#]|$)/i)
  if (match) return match[1]
  match = url.match(/xiaohongshu\.com\/([a-f0-9]{24})(?:[/?#]|$)/i)
  return match ? match[1] : null
}

export function extractBilibiliUserId(url: string): string | null {
  const match = url.match(/space\.bilibili\.com\/(\d+)/i)
  return match ? match[1] : null
}

export function bilibiliUploadsUrl(ownerId: string): string {
  return `https://space.bilibili.com/${ownerId}/upload/video`
}

export function normalizeBrowserAcquisitionUrl(platform: PlatformType, url: string): string {
  if (platform === 'bilibili') {
    const ownerId = extractBilibiliUserId(url)
    return ownerId ? bilibiliUploadsUrl(ownerId) : url
  }
  if (platform === 'weibo') {
    const userId = extractWeiboUserId(url)
    return userId ? `https://weibo.com/u/${userId}` : url
  }
  if (platform === 'xiaohongshu') {
    const userId = extractXiaohongshuUserId(url)
    return userId ? `https://www.xiaohongshu.com/user/profile/${userId}` : url
  }
  return url
}
