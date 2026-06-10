import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { collectCardNote, type NoteCollectFacade } from '../main/modules/browser-engine/browser-collector-actions'

const join = (...parts: string[]) => parts.join('/')

function facadeFrom(handlers: Record<string, (args: Record<string, unknown>) => string>): {
  facade: NoteCollectFacade
  calls: Array<{ tool: string; args: Record<string, unknown> }>
} {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  const facade: NoteCollectFacade = {
    run: async (tool, args = {}) => {
      calls.push({ tool, args })
      return (handlers[tool] ?? (() => JSON.stringify({ ok: true })))(args)
    },
  }
  return { facade, calls }
}

function carouselFacade(frameCount: number): {
  facade: NoteCollectFacade
  calls: Array<{ tool: string; args: Record<string, unknown> }>
  urls: string[]
} {
  const urls = Array.from({ length: frameCount }, (_, index) =>
    `https://sns-webpic-qc.xhscdn.com/notes_pre_post/carousel-${index + 1}!nc_n_webp_mw_1`)
  let frame = 0
  const result = facadeFrom({
    browser_get_tabs: () => '▶ [tab-1] 详情页\n    https://www.xiaohongshu.com/explore/source-1',
    browser_read_page: () => '详情页：多图笔记 source-1',
    browser_wait_for_condition: () => JSON.stringify({ matched: true, elapsedMs: 1, value: true }),
    browser_collect_images: () => {
      const index = Math.min(frame, urls.length - 1)
      return JSON.stringify({
        count: 1,
        scope: 'xiaohongshu-detail',
        images: [{ url: urls[index], width: 1200, height: 1600 }],
      })
    },
    browser_click: () => {
      if (frame >= urls.length - 1) return 'Element not found: next'
      frame += 1
      return 'Clicked: BUTTON "Next"'
    },
    browser_extract_structured: () => JSON.stringify({ items: [{ title: '多图笔记' }] }),
    browser_download_urls: (args) => JSON.stringify({
      total: Array.isArray(args.urls) ? args.urls.length : 0,
      success: Array.isArray(args.urls) ? args.urls.length : 0,
      failed: 0,
    }),
  })
  return { ...result, urls }
}

describe('collectCardNote carousel image collection', () => {
  it('collects all 10 images from a 10-frame carousel', async () => {
    const { facade, calls, urls } = carouselFacade(10)
    const res = await collectCardNote(
      facade,
      {
        noteUrl: 'https://www.xiaohongshu.com/explore/source-1',
        canonicalUrl: 'https://www.xiaohongshu.com/explore/source-1',
        openUrl: 'https://www.xiaohongshu.com/explore/source-1',
        title: '多图笔记',
        sourceId: 'source-1',
        outputDir: '/out',
      },
      join,
    )

    const download = calls.find((call) => call.tool === 'browser_download_urls')!
    assert.equal(res.success, true)
    assert.equal(res.imageCount, 10)
    assert.deepEqual(download.args.urls, urls)
    assert.equal(calls.filter((call) => call.tool === 'browser_collect_images').length, 10)
  })

  it('keeps the non-carousel card path unchanged', async () => {
    const imagesJson = JSON.stringify({
      count: 2,
      images: [{ url: 'https://img.example.com/a.jpg' }, { url: 'https://img.example.com/b.jpg' }],
    })
    const { facade, calls } = facadeFrom({
      browser_get_tabs: () => '[tab-1] 详情页\n    https://www.example.com/post/source-1',
      browser_read_page: () => '详情页：笔记一 source-1',
      browser_collect_images: () => imagesJson,
      browser_download_urls: () => JSON.stringify({ success: 2 }),
    })
    const res = await collectCardNote(
      facade,
      { noteUrl: 'https://www.example.com/post/source-1', title: '笔记一', sourceId: 'source-1', outputDir: '/out' },
      join,
    )

    assert.equal(res.success, true)
    assert.deepEqual(calls.map((call) => call.tool), [
      'browser_click_text',
      'browser_get_tabs',
      'browser_read_page',
      'browser_read_page',
      'browser_extract_structured',
      'browser_collect_images',
      'browser_download_urls',
      'browser_go_back',
      'browser_wait',
    ])
  })

  it('stops carousel frame collection at max_images', async () => {
    const { facade, calls, urls } = carouselFacade(10)
    const res = await collectCardNote(
      facade,
      {
        noteUrl: 'https://www.xiaohongshu.com/explore/source-1',
        canonicalUrl: 'https://www.xiaohongshu.com/explore/source-1',
        openUrl: 'https://www.xiaohongshu.com/explore/source-1',
        title: '多图笔记',
        sourceId: 'source-1',
        outputDir: '/out',
        max_images: 4,
      },
      join,
    )

    const download = calls.find((call) => call.tool === 'browser_download_urls')!
    assert.equal(res.success, true)
    assert.equal(res.imageCount, 4)
    assert.deepEqual(download.args.urls, urls.slice(0, 4))
    assert.equal(calls.filter((call) => call.tool === 'browser_collect_images').length, 4)
  })
})
