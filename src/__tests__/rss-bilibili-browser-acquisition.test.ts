import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { enrichBilibiliBrowserItems } from '../main/modules/rss-engine/browser-acquisition'
import type { ScrapedItem } from '../main/modules/rss-engine/scrapers/base'

describe('Bilibili browser acquisition enrichment', () => {
  it('drops noisy fallback summary text and keeps view count plus full publish time', async () => {
    const originalFetch = globalThis.fetch

    globalThis.fetch = (async () =>
      ({
        json: async () => ({
          code: 0,
          data: {
            desc: '',
            pubdate: 1711867200,
            stat: {
              view: 123456,
            },
          },
        }),
      }) as Response) as typeof fetch

    try {
      const items: ScrapedItem[] = [
        {
          itemId: 'bilibili_test',
          title: '测试视频',
          description: '12.3万 4567 03-31 某幻君',
          link: 'https://www.bilibili.com/video/BV1TestTest1',
          pubDate: '',
          author: '',
          coverImage: null,
          metadata: {},
        },
      ]

      const [item] = await enrichBilibiliBrowserItems(items)

      assert.equal(item?.description, '')
      assert.equal(item?.author, '播放量 12.3万')
      assert.equal(item?.pubDate, '2024-03-31T06:40:00.000Z')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
