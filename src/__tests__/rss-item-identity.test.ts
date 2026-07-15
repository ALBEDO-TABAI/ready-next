import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeScrapedItemIdentity,
  normalizeScrapedItemIdentities,
  resolveCanonicalRSSItemIdentity,
} from '../main/modules/rss-engine/item-identity'
import type { ScrapedItem } from '../main/modules/rss-engine/scrapers/base'

function scrapedItem(patch: Partial<ScrapedItem>): ScrapedItem {
  return {
    itemId: 'legacy-item',
    title: '价格2位数？PDD上买到的机器人还能这样？',
    description: '视频简介',
    link: 'https://example.com/item',
    pubDate: '2026-07-13T09:04:26.000Z',
    author: '影视飓风',
    coverImage: null,
    metadata: {},
    ...patch,
  }
}

test('Bilibili video identity is stable across canonical, tracked, and dynamic links', () => {
  const canonical = normalizeScrapedItemIdentity(scrapedItem({
    itemId: 'rsshub-item',
    link: 'https://www.bilibili.com/video/BV1d2N16KEh6',
  }))
  const tracked = normalizeScrapedItemIdentity(scrapedItem({
    itemId: 'browser-item',
    link: 'https://www.bilibili.com/video/BV1d2N16KEh6/?spm_id_from=333.1387.upload.video_card.click',
    metadata: { fingerprint: 'browser-card' },
  }))
  const dynamic = normalizeScrapedItemIdentity(scrapedItem({
    itemId: 'dynamic-item',
    link: 'https://t.bilibili.com/1224473984725155860',
    description: '动态正文。视频地址：https://www.bilibili.com/video/BV1d2N16KEh6',
  }))

  for (const item of [canonical, tracked, dynamic]) {
    assert.equal(item.itemId, 'bilibili_32618f4530e1')
    assert.equal(item.link, 'https://www.bilibili.com/video/BV1d2N16KEh6')
    assert.equal(item.metadata.rssGuid, 'https://www.bilibili.com/video/BV1d2N16KEh6')
  }
  assert.equal(tracked.metadata.fingerprint, 'browser-card')
})

test('one fetch batch keeps only one row when it contains multiple aliases', () => {
  const items = normalizeScrapedItemIdentities([
    scrapedItem({
      itemId: 'rsshub-item',
      link: 'https://www.bilibili.com/video/BV1d2N16KEh6',
    }),
    scrapedItem({
      itemId: 'browser-item',
      link: 'https://www.bilibili.com/video/BV1d2N16KEh6/?spm_id_from=tracking',
    }),
    scrapedItem({
      itemId: 'dynamic-item',
      link: 'https://t.bilibili.com/1224473984725155860',
      description: '视频地址：https://www.bilibili.com/video/BV1d2N16KEh6',
    }),
  ])

  assert.equal(items.length, 1)
  assert.equal(items[0]?.itemId, 'bilibili_32618f4530e1')
})

test('Twitter status identity is stable across legacy and current URL forms', () => {
  const legacy = normalizeScrapedItemIdentity(scrapedItem({
    link: 'https://twitter.com/a_green_being/status/2076598897779020159',
  }))
  const generic = normalizeScrapedItemIdentity(scrapedItem({
    link: 'https://twitter.com/i/status/2076598897779020159',
  }))
  const current = normalizeScrapedItemIdentity(scrapedItem({
    link: 'https://x.com/a_green_being/status/2076598897779020159?s=20',
  }))

  for (const item of [legacy, generic, current]) {
    assert.equal(item.itemId, 'twitter_148e678d133e')
    assert.equal(item.link, 'https://x.com/i/status/2076598897779020159')
    assert.equal(item.metadata.rssGuid, 'https://x.com/i/status/2076598897779020159')
  }
})

test('identity resolution does not collapse unrelated items by title or timestamp', () => {
  const first = resolveCanonicalRSSItemIdentity({
    link: 'https://www.bilibili.com/video/BV1d2N16KEh6',
    title: '相同标题',
    publishedAt: 1783933466,
  })
  const second = resolveCanonicalRSSItemIdentity({
    link: 'https://www.bilibili.com/video/BV1LoN76dEmF',
    title: '相同标题',
    publishedAt: 1783933466,
  })

  assert.ok(first)
  assert.ok(second)
  assert.notEqual(first.id, second.id)
  assert.notEqual(first.link, second.link)
})

test('unrecognized links keep their original scraper identity', () => {
  const original = scrapedItem({
    itemId: 'rss_original',
    link: 'https://example.com/posts/42?campaign=kept',
    metadata: { rssGuid: 'feed-guid-42' },
  })

  assert.equal(resolveCanonicalRSSItemIdentity(original), null)
  assert.equal(normalizeScrapedItemIdentity(original), original)
})

test('an article that only embeds a Bilibili video or tweet keeps its own identity', () => {
  const article = scrapedItem({
    itemId: 'rss_article',
    link: 'https://example.com/posts/embedded-media',
    description: [
      'Article body with references:',
      'https://www.bilibili.com/video/BV1d2N16KEh6',
      'https://x.com/a_green_being/status/2076598897779020159',
    ].join(' '),
    metadata: { rssGuid: 'article-guid' },
  })

  assert.equal(resolveCanonicalRSSItemIdentity(article), null)
  assert.equal(normalizeScrapedItemIdentity(article), article)
})

test('a Bilibili dynamic with multiple videos is not collapsed into the first video', () => {
  const dynamic = scrapedItem({
    itemId: 'bilibili_multi_video_dynamic',
    link: 'https://t.bilibili.com/1224473984725155860',
    description: [
      'https://www.bilibili.com/video/BV1d2N16KEh6',
      'https://www.bilibili.com/video/BV1LoN76dEmF',
    ].join(' '),
  })

  assert.equal(resolveCanonicalRSSItemIdentity(dynamic), null)
  assert.equal(normalizeScrapedItemIdentity(dynamic), dynamic)
})
