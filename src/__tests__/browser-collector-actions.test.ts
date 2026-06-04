import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { collectNote, type NoteCollectFacade } from '../main/modules/browser-engine/browser-collector-actions'

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

const imagesJson = JSON.stringify({ count: 2, images: [{ url: 'https://img.xhscdn.com/a.jpg' }, { url: 'https://img.xhscdn.com/b.jpg' }] })

describe('collectNote (per-note sequence via facade)', () => {
  it('navigates, collects images, downloads to the note folder, and reports success', async () => {
    const { facade, calls } = facadeFrom({
      browser_collect_images: () => imagesJson,
      browser_download_urls: () => JSON.stringify({ total: 2, success: 2, failed: 0 }),
    })
    const res = await collectNote(facade, { noteUrl: 'https://www.xiaohongshu.com/note/1', title: '笔记一', outputDir: '/out' }, join)
    assert.equal(res.success, true)
    assert.equal(res.imageCount, 2)
    assert.equal(res.savedDir, '/out/笔记一')
    assert.deepEqual(calls.map((c) => c.tool), ['browser_navigate', 'browser_collect_images', 'browser_download_urls'])
    assert.deepEqual(calls[2].args.urls, ['https://img.xhscdn.com/a.jpg', 'https://img.xhscdn.com/b.jpg'])
    assert.equal(calls[2].args.directory, '/out/笔记一')
  })

  it('fails the note (does not throw) when navigate is blocked by the facade', async () => {
    const { facade, calls } = facadeFrom({
      browser_navigate: () => JSON.stringify({ ok: false, errorCode: 'lease_takeover', message: 'frozen' }),
    })
    const res = await collectNote(facade, { noteUrl: 'https://x', outputDir: '/out' }, join)
    assert.equal(res.success, false)
    assert.equal(res.reason, 'navigate:lease_takeover')
    assert.equal(calls.length, 1, 'must not proceed past a blocked navigate')
  })

  it('fails with no_images when the note page yields no image candidates', async () => {
    const { facade } = facadeFrom({ browser_collect_images: () => JSON.stringify({ count: 0, images: [] }) })
    const res = await collectNote(facade, { noteUrl: 'https://x', outputDir: '/out' }, join)
    assert.equal(res.success, false)
    assert.equal(res.reason, 'no_images')
  })

  it('fails when all downloads fail (success count 0)', async () => {
    const { facade } = facadeFrom({
      browser_collect_images: () => imagesJson,
      browser_download_urls: () => JSON.stringify({ total: 2, success: 0, failed: 2 }),
    })
    const res = await collectNote(facade, { noteUrl: 'https://x', outputDir: '/out' }, join)
    assert.equal(res.success, false)
    assert.equal(res.reason, 'download_failed')
  })

  it('falls back to the note URL for the folder name when no title is given', async () => {
    const { facade } = facadeFrom({
      browser_collect_images: () => imagesJson,
      browser_download_urls: () => JSON.stringify({ success: 2 }),
    })
    const res = await collectNote(facade, { noteUrl: 'https://www.xiaohongshu.com/note/xyz', outputDir: '/out' }, join)
    assert.equal(res.success, true)
    assert.ok(res.savedDir.startsWith('/out/'))
  })
})
