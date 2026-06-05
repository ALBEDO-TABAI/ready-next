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
    assert.equal(res.savedDir, '/out/01 - 笔记一')
    assert.deepEqual(calls.map((c) => c.tool), ['browser_navigate', 'browser_read_page', 'browser_extract_structured', 'browser_collect_images', 'browser_download_urls'])
    assert.equal(calls[3].args.include_hidden, true)
    assert.deepEqual(calls[4].args.urls, ['https://img.xhscdn.com/a.jpg', 'https://img.xhscdn.com/b.jpg'])
    assert.equal(calls[4].args.directory, '/out/01 - 笔记一/assets')
    assert.equal(calls[4].args.filename_prefix, 'image')
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

  it('stops before download when the page asks for login or QR verification', async () => {
    const { facade, calls } = facadeFrom({
      browser_read_page: () => '请扫码登录后继续查看内容',
      browser_collect_images: () => imagesJson,
    })
    const res = await collectNote(facade, { noteUrl: 'https://x', title: '卡片标题', outputDir: '/out' }, join)
    assert.equal(res.success, false)
    assert.equal(res.reason, 'needs_verification')
    assert.deepEqual(calls.map((c) => c.tool), ['browser_navigate', 'browser_read_page'])
  })

  it('does not treat account placeholder images as collected note images', async () => {
    const { facade, calls } = facadeFrom({
      browser_read_page: () => 'Page content is empty or still loading.',
      browser_extract_structured: () => JSON.stringify({ items: [{ title: '消息' }] }),
      browser_collect_images: () => JSON.stringify({
        count: 2,
        images: [
          { url: 'https://fe-platform.example.com/platform/login-a.webp', width: 198, height: 198 },
          { url: 'https://fe-platform.example.com/platform/login-b.webp', width: 198, height: 198 },
        ],
      }),
    })
    const res = await collectNote(facade, { noteUrl: 'https://x', title: '卡片标题', outputDir: '/out' }, join)
    assert.equal(res.success, false)
    assert.equal(res.reason, 'needs_verification')
    assert.equal(calls.some((c) => c.tool === 'browser_download_urls'), false)
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

  it('writes note.md, manifest.json, and assets with the frozen title as the folder name', async () => {
    const writes: Record<string, string> = {}
    const ensured: string[] = []
    const { facade } = facadeFrom({
      browser_extract_structured: () => JSON.stringify({ items: [{ title: '真实标题', summary: '正文摘要' }] }),
      browser_collect_images: () => imagesJson,
      browser_download_urls: () => JSON.stringify({
        total: 2,
        success: 2,
        failed: 0,
        results: [
          { success: true, path: '/out/01 - 卡片标题/assets/image-1.webp' },
          { success: true, path: '/out/01 - 卡片标题/assets/image-2.webp' },
        ],
      }),
    })
    const res = await collectNote(
      facade,
      { noteUrl: 'https://www.example.com/post/1', title: '卡片标题', outputDir: '/out' },
      join,
      {
        ensureDir: async (path) => { ensured.push(path) },
        writeTextFile: async (path, content) => { writes[path] = content },
      },
    )

    assert.equal(res.success, true)
    assert.equal(res.title, '卡片标题')
    assert.equal(res.notePath, '/out/01 - 卡片标题/note.md')
    assert.equal(res.manifestPath, '/out/01 - 卡片标题/manifest.json')
    assert.deepEqual(ensured, ['/out/01 - 卡片标题', '/out/01 - 卡片标题/assets'])
    assert.match(writes['/out/01 - 卡片标题/note.md'], /来源链接/)
    assert.match(writes['/out/01 - 卡片标题/note.md'], /!\[图片\]\(assets\/image-1.webp\)/)
    const manifest = JSON.parse(writes['/out/01 - 卡片标题/manifest.json'])
    assert.equal(manifest.imageCount, 2)
    assert.deepEqual(manifest.files, ['assets/image-1.webp', 'assets/image-2.webp'])
  })

  it('keeps zero-image failures out of ordinary note folders when file ops are provided', async () => {
    const writes: Record<string, string> = {}
    const ensured: string[] = []
    const { facade } = facadeFrom({ browser_collect_images: () => JSON.stringify({ count: 0, images: [] }) })
    const res = await collectNote(
      facade,
      { noteUrl: 'https://www.example.com/post/empty', title: '空图', sourceId: 'empty', outputDir: '/out' },
      join,
      {
        ensureDir: async (path) => { ensured.push(path) },
        writeTextFile: async (path, content) => { writes[path] = content },
      },
    )

    assert.equal(res.success, false)
    assert.equal(res.reason, 'no_images')
    assert.equal(res.savedDir, '/out/_failed')
    assert.equal(res.manifestPath, '/out/_failed/01-empty.json')
    assert.deepEqual(ensured, ['/out/_failed'])
    assert.equal(Boolean(writes['/out/01 - 空图/note.md']), false)
  })
})
