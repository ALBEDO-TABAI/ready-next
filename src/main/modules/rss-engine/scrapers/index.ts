/**
 * ScraperFactory: URL → platform detection → scraper instance
 * Ported from lets-go-rss ScraperFactory
 */

import { type BaseScraper } from './base'
import { NativeRSSScraper } from './native-rss'
import { YouTubeScraper } from './youtube'
import { TwitterScraper } from './twitter'
import { ZsxqScraper } from './zsxq'
import { VimeoScraper } from './vimeo'
import { BehanceScraper } from './behance'
import { BilibiliScraper, WeiboScraper, DouyinScraper } from './rsshub'

export type PlatformType =
  | 'youtube'
  | 'twitter'
  | 'bilibili'
  | 'weibo'
  | 'douyin'
  | 'xiaohongshu'
  | 'vimeo'
  | 'behance'
  | 'zsxq'
  | 'rss'

export function detectPlatform(url: string): PlatformType {
  const lower = url.toLowerCase()

  if (lower.includes('youtube.com') || lower.includes('youtu.be')) return 'youtube'
  if (lower.includes('bilibili.com') || lower.includes('b23.tv') || lower.includes('bili2233.cn')) return 'bilibili'
  if (lower.includes('weibo.com') || lower.includes('weibo.cn') || lower.includes('m.weibo.cn')) return 'weibo'
  if (lower.includes('douyin.com')) return 'douyin'
  if (lower.includes('xiaohongshu.com') || lower.includes('xhslink.com') || lower.includes('xhsurl.cn')) return 'xiaohongshu'
  if (lower.includes('x.com') || lower.includes('twitter.com')) return 'twitter'
  if (lower.includes('vimeo.com')) return 'vimeo'
  if (lower.includes('behance.net')) return 'behance'
  if (lower.includes('zsxq.com')) return 'zsxq'

  return 'rss'
}

export function createScraper(platform: PlatformType, rsshubBase?: string): BaseScraper {
  const hub = rsshubBase ?? 'http://localhost:1200'

  switch (platform) {
    case 'youtube':
      return new YouTubeScraper()
    case 'twitter':
      return new TwitterScraper(hub)
    case 'zsxq':
      return new ZsxqScraper(hub)
    case 'vimeo':
      return new VimeoScraper()
    case 'behance':
      return new BehanceScraper()
    case 'bilibili':
      return new BilibiliScraper(hub)
    case 'weibo':
      return new WeiboScraper(hub)
    case 'douyin':
      return new DouyinScraper(hub)
    case 'xiaohongshu':
      // Read only through the person's browser session; there is no scraper that asks on its own.
      throw new Error('小红书订阅只通过 Ready 浏览器会话获取')
    case 'rss':
    default:
      return new NativeRSSScraper()
  }
}

/** Human-readable platform label */
export function platformLabel(platform: PlatformType): string {
  const labels: Record<PlatformType, string> = {
    youtube: 'YouTube',
    twitter: 'Twitter/X',
    bilibili: 'Bilibili',
    weibo: '微博',
    douyin: '抖音',
    xiaohongshu: '小红书',
    vimeo: 'Vimeo',
    behance: 'Behance',
    zsxq: '知识星球',
    rss: 'RSS'
  }
  return labels[platform] ?? 'RSS'
}

/**
 * Whether a platform can end up asking RSSHub. Only Bilibili does, and only when the person is not signed in to
 * it in Ready's browser; every other login platform is read through the browser session alone.
 */
export function mayUseRSSHub(platform: PlatformType): boolean {
  return platform === 'bilibili'
}
