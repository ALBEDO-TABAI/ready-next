import { createHash } from 'crypto'
import type { ScrapedItem } from './scrapers/base'

interface RSSItemIdentityInput {
  link?: string | null
  guid?: string | null
  description?: string | null
  title?: string | null
  publishedAt?: number | null
}

export interface CanonicalRSSItemIdentity {
  id: string
  guid: string
  link: string
}

const BILIBILI_VIDEO_URL = /(?:https?:)?\/\/(?:www\.)?bilibili\.com\/video\/(BV[0-9A-Za-z]+|av\d+)/i
const BILIBILI_VIDEO_URL_GLOBAL = /(?:https?:)?\/\/(?:www\.)?bilibili\.com\/video\/(BV[0-9A-Za-z]+|av\d+)/gi
const BILIBILI_DYNAMIC_URL = /(?:https?:)?\/\/(?:t\.bilibili\.com\/\d+|www\.bilibili\.com\/(?:opus|dynamic)\/\d+)/i
const TWITTER_STATUS_URL = /(?:https?:)?\/\/(?:www\.)?(?:twitter\.com|x\.com)\/(?:i\/status|[^/?#]+\/status)\/(\d+)/i

function shortHash(value: string): string {
  return createHash('md5').update(value).digest('hex').slice(0, 12)
}

function findMatch(
  candidates: Array<string | null | undefined>,
  pattern: RegExp,
): RegExpMatchArray | null {
  for (const candidate of candidates) {
    const match = String(candidate || '').match(pattern)
    if (match) return match
  }
  return null
}

function findSingleBilibiliVideoInDescription(
  input: RSSItemIdentityInput,
): RegExpMatchArray | null {
  if (!findMatch([input.link, input.guid], BILIBILI_DYNAMIC_URL)) return null
  const matches = [...String(input.description || '').matchAll(BILIBILI_VIDEO_URL_GLOBAL)]
  const videoIds = new Set(matches.map((match) => match[1].toLowerCase()))
  return videoIds.size === 1 ? matches[0] : null
}

export function resolveCanonicalRSSItemIdentity(
  input: RSSItemIdentityInput,
): CanonicalRSSItemIdentity | null {
  const bilibiliMatch = findMatch([input.link, input.guid], BILIBILI_VIDEO_URL)
    ?? findSingleBilibiliVideoInDescription(input)
  if (bilibiliMatch) {
    const rawVideoId = bilibiliMatch[1]
    const videoId = /^bv/i.test(rawVideoId)
      ? `BV${rawVideoId.slice(2)}`
      : `av${rawVideoId.slice(2)}`
    const link = `https://www.bilibili.com/video/${videoId}`
    return {
      id: `bilibili_${shortHash(link)}`,
      guid: link,
      link,
    }
  }

  const twitterMatch = findMatch([input.link, input.guid], TWITTER_STATUS_URL)
  if (twitterMatch) {
    const statusId = twitterMatch[1]
    const link = `https://x.com/i/status/${statusId}`
    return {
      id: `twitter_${shortHash(statusId)}`,
      guid: link,
      link,
    }
  }

  return null
}

export function normalizeScrapedItemIdentity(item: ScrapedItem): ScrapedItem {
  const rssGuid = typeof item.metadata.rssGuid === 'string'
    ? item.metadata.rssGuid
    : null
  const identity = resolveCanonicalRSSItemIdentity({
    link: item.link,
    guid: rssGuid,
    description: item.description,
  })
  if (!identity) return item

  return {
    ...item,
    itemId: identity.id,
    link: identity.link,
    metadata: {
      ...item.metadata,
      rssGuid: identity.guid,
    },
  }
}

export function normalizeScrapedItemIdentities(items: ScrapedItem[]): ScrapedItem[] {
  const normalized: ScrapedItem[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const candidate = normalizeScrapedItemIdentity(item)
    if (seen.has(candidate.itemId)) continue
    seen.add(candidate.itemId)
    normalized.push(candidate)
  }
  return normalized
}
