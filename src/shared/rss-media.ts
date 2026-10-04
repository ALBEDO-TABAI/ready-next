import { hasLikelyVideoResource } from './browser-tab-resource-classifier'

export function rssHttpReference(value: string | null | undefined, base?: string): string | null {
  if (!value?.trim()) return null
  try { const url = new URL(value, base); return ['http:', 'https:'].includes(url.protocol) ? url.href : null }
  catch { return null }
}

/** URL hints and saved references do not prove remote availability or media understanding. */
export function describeRSSMedia(link: string, coverImage?: string | null) {
  const url = rssHttpReference(link)
  const kind = !url ? 'unknown' : hasLikelyVideoResource(url) ? 'video'
    : /\.(?:png|jpe?g|gif|webp|avif|svg)$/i.test(new URL(url).pathname) ? 'image' : 'article'
  const cover = rssHttpReference(coverImage, url || undefined) || (kind === 'image' ? url : null)
  return { kind, classifiedBy: 'url_hint', source: { url, availability: 'not_checked' },
    cover: { url: cover, availability: cover ? 'not_checked' : 'not_provided' }, readPerformsMediaUnderstanding: false } as const
}

export interface RSSVideoEmbed { provider: 'bilibili' | 'youtube'; embedUrl: string; pageUrl: string }

const BILIBILI_VIDEO = /bilibili\.com\/video\/(BV[0-9A-Za-z]{10}|av\d+)/i
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/

/**
 * Player for a video item, only on the two players the renderer CSP frames. A Bilibili dynamic that shares
 * exactly one video names it in its text; several or none means there is no single video to play.
 */
export function rssVideoEmbed(link: string, text = ''): RSSVideoEmbed | null {
  const url = rssHttpReference(link)
  if (!url) return null
  const parsed = new URL(url)
  const host = parsed.hostname.replace(/^(?:www|m)\./, '')
  if (host === 'bilibili.com' || host.endsWith('.bilibili.com')) {
    const direct = url.match(BILIBILI_VIDEO)?.[1]
    const shared = [...new Set([...text.matchAll(new RegExp(BILIBILI_VIDEO.source, 'gi'))].map((match) => match[1]))]
    const id = direct || (shared.length === 1 ? shared[0] : null)
    if (!id) return null
    const player = new URL('https://player.bilibili.com/player.html')
    player.searchParams.set('isOutside', 'true')
    if (id.toLowerCase().startsWith('av')) player.searchParams.set('aid', id.slice(2))
    else player.searchParams.set('bvid', id)
    const page = direct ? parsed.searchParams.get('p') : null
    player.searchParams.set('p', page && /^\d+$/.test(page) ? page : '1')
    player.searchParams.set('autoplay', '0')
    return { provider: 'bilibili', embedUrl: player.href, pageUrl: `https://www.bilibili.com/video/${id}/` }
  }
  const youtubeId = host === 'youtu.be' ? parsed.pathname.slice(1).split('/')[0]
    : host === 'youtube.com' || host === 'music.youtube.com'
      ? parsed.searchParams.get('v') || parsed.pathname.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/)?.[1]
      : null
  if (!youtubeId || !YOUTUBE_ID.test(youtubeId)) return null
  return { provider: 'youtube', embedUrl: `https://www.youtube-nocookie.com/embed/${youtubeId}?rel=0`, pageUrl: `https://www.youtube.com/watch?v=${youtubeId}` }
}
