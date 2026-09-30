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
    cover: { url: cover, availability: cover ? 'not_checked' : 'not_provided' }, understanding: 'not_performed' } as const
}
