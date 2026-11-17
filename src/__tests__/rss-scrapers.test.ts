import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { detectPlatform } from '../main/modules/rss-engine/scrapers/index'
import { NativeRSSScraper } from '../main/modules/rss-engine/scrapers/native-rss'
import { createScraper } from '../main/modules/rss-engine/scrapers/index'
import {
  BilibiliScraper,
  DouyinScraper,
  WeiboScraper,
  isLikelyStaleBilibiliResult,
} from '../main/modules/rss-engine/scrapers/rsshub'

describe('RSS scraper platform detection', () => {
  it('detects creator watchlist URLs by platform', () => {
    assert.equal(detectPlatform('https://space.bilibili.com/1577804'), 'bilibili')
    assert.equal(detectPlatform('https://www.youtube.com/@matthewencina'), 'youtube')
    assert.equal(detectPlatform('https://www.xiaohongshu.com/user/profile/5fc91b41000000000101fe32'), 'xiaohongshu')
    assert.equal(detectPlatform('https://xhsurl.cn/abc123'), 'xiaohongshu')
    assert.equal(detectPlatform('https://weibo.com/u/6182606334'), 'weibo')
    assert.equal(detectPlatform('https://m.weibo.cn/profile/6182606334'), 'weibo')
    assert.equal(detectPlatform('https://vimeo.com/offf'), 'vimeo')
    assert.equal(detectPlatform('https://www.behance.net/yokohara6e48'), 'behance')
    assert.equal(detectPlatform('https://x.com/op7418'), 'twitter')
    assert.equal(detectPlatform('https://t.zsxq.com/7DCdg'), 'zsxq')
  })
})

describe('DouyinScraper', () => {
  it('extracts sec_uid from Douyin share URLs after redirect resolution', () => {
    const scraper = new DouyinScraper('http://127.0.0.1:1240')
    const url =
      'https://www.iesdouyin.com/share/user/MS4wLjABAAAALOZo7U1a1Vx6naYNstpIKkhwgCA6Gxiz9H_yKHu_hKKIynxXzGDdoFesfAkBc6O0?did=MS4wLjABAAAAZ1KBsSPaEumKpeiiuVw-Zl1lKS9wrfJW9Gb22FVDOs7cVBRghFYZD89PQ8NC6UKp&iid=MS4wLjABAAAA2riyDQLlqSkpi5dtS_r6YSKVmSUF7e_JCIVWo9zYEa_q3zdu6XNqKuPhJZFnnq5a&with_sec_did=1&sec_uid=MS4wLjABAAAALOZo7U1a1Vx6naYNstpIKkhwgCA6Gxiz9H_yKHu_hKKIynxXzGDdoFesfAkBc6O0'

    assert.equal(
      scraper.extractUserId(url),
      'MS4wLjABAAAALOZo7U1a1Vx6naYNstpIKkhwgCA6Gxiz9H_yKHu_hKKIynxXzGDdoFesfAkBc6O0',
    )
  })

  it('does not retry WAF-like route failures', async () => {
    const scraper = new DouyinScraper('http://127.0.0.1:1240') as DouyinScraper & {
      fetchRoute: (routePath: string, platform: string) => Promise<{
        items: never[]
        feedTitle: string
        platform: string
        error?: string
      }>
    }

    let attempts = 0
    scraper.fetchRoute = async (_routePath, platform) => {
      attempts += 1
      return {
        items: [],
        feedTitle: '',
        platform,
        error: 'Empty post data',
      }
    }

    await scraper.fetchItems('https://www.douyin.com/user/MS4wLjABAAAATEST')

    assert.equal(attempts, 1)
  })
})

describe('Bilibili freshness heuristic', () => {
  it('treats very old bilibili route results as likely stale', () => {
    const stale = isLikelyStaleBilibiliResult({
      items: [
        {
          itemId: 'bilibili_1',
          title: '旧视频',
          description: '',
          link: 'https://www.bilibili.com/video/BV1fr421M7y7',
          pubDate: '2026-03-04T11:00:00.000Z',
          author: '',
          coverImage: null,
          metadata: {},
        },
      ],
      feedTitle: 'Bilibili 39627524',
      platform: 'bilibili',
    }, Date.parse('2026-03-31T08:00:00.000Z'))

    assert.equal(stale, true)
  })

  it('keeps a recent route result', () => {
    const stale = isLikelyStaleBilibiliResult({
      items: [
        {
          itemId: 'bilibili_1',
          title: '新视频',
          description: '',
          link: 'https://www.bilibili.com/video/BV1fr421M7y7',
          pubDate: '2026-03-28T11:00:00.000Z',
          author: '',
          coverImage: null,
          metadata: {},
        },
      ],
      feedTitle: 'Bilibili 39627524',
      platform: 'bilibili',
    }, Date.parse('2026-03-31T08:00:00.000Z'))

    assert.equal(stale, false)
  })
})

describe('BilibiliScraper, the signed-out route', () => {
  type RouteStub = (routePath: string, platform: string) => Promise<import('../main/modules/rss-engine/scrapers/base').ScrapeResult>
  const video = {
    itemId: 'rsshub_new',
    title: '最新投稿',
    description: '',
    link: 'https://www.bilibili.com/video/BV1newnewnew',
    pubDate: '2026-03-31T09:00:00.000Z',
    author: '',
    coverImage: null,
    metadata: {},
  }

  it('asks RSSHub for the uploads, then for the dynamics, and nothing else', async () => {
    const originalFetch = globalThis.fetch
    const fetched: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      fetched.push(String(input))
      throw new Error('ECONNREFUSED')
    }) as typeof fetch
    try {
      const result = await new BilibiliScraper('http://127.0.0.1:1240').fetchItems('https://space.bilibili.com/946974?from=x')
      assert.equal(result.items.length, 0)
      assert.ok(result.error)
      assert.ok(fetched.length > 0)
      assert.ok(
        fetched.every((url) => url.startsWith('http://127.0.0.1:1240/bilibili/user/')),
        `only RSSHub is asked, never Bilibili itself: ${fetched.join(', ')}`,
      )
      assert.ok(fetched.some((url) => url.includes('/bilibili/user/video/946974')))
      assert.ok(fetched.some((url) => url.includes('/bilibili/user/dynamic/946974')))
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('stops at the uploads route when it answers', async () => {
    const scraper = new BilibiliScraper('http://127.0.0.1:1240') as BilibiliScraper & { fetchRoute: RouteStub }
    const calls: string[] = []
    scraper.fetchRoute = async (routePath, platform) => {
      calls.push(routePath)
      return { items: [video], feedTitle: '影视飓风', platform }
    }

    const result = await scraper.fetchItems('https://space.bilibili.com/946974')

    assert.equal(result.items[0]?.title, '最新投稿')
    assert.deepEqual(calls, ['/bilibili/user/video/946974'])
  })

  it('only takes a space address; a short or video link is resolved by the browser session first', async () => {
    const originalFetch = globalThis.fetch
    let fetches = 0
    globalThis.fetch = (async () => { fetches += 1; throw new Error('must not fetch') }) as typeof fetch
    try {
      const result = await new BilibiliScraper('http://127.0.0.1:1240').fetchItems('https://b23.tv/abc')
      assert.equal(result.items.length, 0)
      assert.match(result.error || '', /空间页的链接/)
      assert.equal(fetches, 0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('Xiaohongshu has no scraper of its own', () => {
  it('is read only through the browser session', () => {
    assert.throws(() => createScraper('xiaohongshu'), /Ready 浏览器会话/)
  })
})

describe('WeiboScraper', () => {
  it('extracts user id from mobile profile URLs', () => {
    const scraper = new WeiboScraper('http://127.0.0.1:1240')

    assert.equal(scraper.extractUserId('https://m.weibo.cn/profile/6182606334'), '6182606334')
    assert.equal(scraper.extractUserId('https://m.weibo.cn/u/6182606334'), '6182606334')
    assert.equal(
      scraper.extractUserId('https://m.weibo.cn/p/index?containerid=1005056182606334'),
      '6182606334',
    )
  })
})

describe('NativeRSSScraper cover images', () => {
  it('reads the first picture of a CDATA description, as RSSHub writes it', () => {
    const cover = 'http://sns-webpic-qc.xhscdn.com/202610051405/aaf39b1a/notes_pre_post/1040g3k8!nc_n_webp_mw_1'
    const result = new NativeRSSScraper().parseXML(`<?xml version="1.0"?><rss version="2.0"><channel><title>广州潮会吃 - 小红书</title>
      <item><title>广州新的！！白云也有了</title><link>https://www.xiaohongshu.com/user/profile/5e31b693000000000100bb06</link>
      <description><![CDATA[<img src="${cover}" width="1186" height="1581" referrerpolicy="no-referrer"><br>广州新的！！白云也有了]]></description></item>
      </channel></rss>`, 'xiaohongshu')
    assert.equal(result.items[0]?.coverImage, cover)
    assert.equal(result.items[0]?.description, '广州新的！！白云也有了')
  })
})
