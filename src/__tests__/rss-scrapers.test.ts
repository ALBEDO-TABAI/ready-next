import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { detectPlatform } from '../main/modules/rss-engine/scrapers/index'
import { DouyinScraper, WeiboScraper, XiaohongshuScraper } from '../main/modules/rss-engine/scrapers/rsshub'

describe('RSS scraper platform detection', () => {
  it('detects creator watchlist URLs by platform', () => {
    assert.equal(detectPlatform('https://space.bilibili.com/1577804'), 'bilibili')
    assert.equal(detectPlatform('https://www.youtube.com/@matthewencina'), 'youtube')
    assert.equal(detectPlatform('https://www.xiaohongshu.com/user/profile/5fc91b41000000000101fe32'), 'xiaohongshu')
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

describe('XiaohongshuScraper', () => {
  it('resolves xhs short links before extracting user id', async () => {
    const scraper = new XiaohongshuScraper('http://127.0.0.1:1240') as XiaohongshuScraper & {
      resolveFinalUrl: (url: string) => Promise<string>
      fetchRouteWithRecovery: (routePath: string, platform: string) => Promise<{
        items: never[]
        feedTitle: string
        platform: string
      }>
    }

    let requestedRoute = ''
    scraper.resolveFinalUrl = async () => 'https://www.xiaohongshu.com/user/profile/5fc91b41000000000101fe32'
    scraper.fetchRouteWithRecovery = async (routePath, platform) => {
      requestedRoute = `${platform}:${routePath}`
      return {
        items: [],
        feedTitle: '',
        platform,
      }
    }

    await scraper.fetchItems('https://xhslink.com/abc123')

    assert.equal(requestedRoute, 'xiaohongshu:/xiaohongshu/user/5fc91b41000000000101fe32/notes')
  })

  it('retries transient browser route failures once', async () => {
    const scraper = new XiaohongshuScraper('http://127.0.0.1:1240') as XiaohongshuScraper & {
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
      if (attempts === 1) {
        return {
          items: [],
          feedTitle: '',
          platform,
          error: 'TargetCloseError: target closed',
        }
      }
      return {
        items: [],
        feedTitle: '',
        platform,
      }
    }

    await scraper.fetchItems('https://www.xiaohongshu.com/user/profile/5fc91b41000000000101fe32')

    assert.equal(attempts, 2)
  })
})
