import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { collectCardNote, collectNote, type NoteCollectFacade } from '../main/modules/browser-engine/browser-collector-actions'

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
    assert.equal(calls[3].args.include_hidden, false)
    assert.deepEqual(calls[4].args.urls, ['https://img.xhscdn.com/a.jpg', 'https://img.xhscdn.com/b.jpg'])
    assert.equal(calls[4].args.directory, '/out/01 - 笔记一/assets')
    assert.equal(calls[4].args.filename_prefix, 'image')
  })

  it('filters page chrome, avatars, tiny images, duplicates, and caps per-note downloads', async () => {
    const noteImages = Array.from({ length: 30 }, (_, index) => ({
      url: `https://sns-webpic-qc.xhscdn.com/notes_pre_post/image-${index}.jpg!nc_n_webp_mw_1`,
      width: 1200,
      height: 1600,
    }))
    const { facade, calls } = facadeFrom({
      browser_collect_images: () => JSON.stringify({
        count: noteImages.length + 4,
        images: [
          { url: 'https://fe-platform.xhscdn.com/platform/logo.webp', width: 240, height: 120 },
          { url: 'https://sns-avatar-qc.xhscdn.com/avatar/user.webp', width: 360, height: 360 },
          { url: 'https://sns-webpic-qc.xhscdn.com/notes_pre_post/image-0.jpg!small', width: 1200, height: 1600 },
          { url: 'https://sns-webpic-qc.xhscdn.com/notes_pre_post/tiny.jpg', width: 64, height: 64 },
          ...noteImages,
        ],
      }),
      browser_download_urls: () => JSON.stringify({ total: 24, success: 24, failed: 0 }),
    })
    const res = await collectNote(facade, { noteUrl: 'https://x', title: '卡片标题', outputDir: '/out' }, join)
    const download = calls.find((call) => call.tool === 'browser_download_urls')!
    const urls = download.args.urls as string[]

    assert.equal(res.success, true)
    assert.equal(res.imageCount, 24)
    assert.equal(urls.length, 24)
    assert.ok(urls.every((url) => !String(url).includes('fe-platform')))
    assert.ok(urls.every((url) => !String(url).includes('sns-avatar')))
    assert.ok(urls.every((url) => !String(url).includes('tiny')))
    assert.equal(urls.includes('https://sns-webpic-qc.xhscdn.com/notes_pre_post/image-0.jpg!small'), true)
    assert.equal(urls.includes('https://sns-webpic-qc.xhscdn.com/notes_pre_post/image-0.jpg!nc_n_webp_mw_1'), false)
  })

  it('filters comment images and protocol duplicates from note downloads', async () => {
    const { facade, calls } = facadeFrom({
      browser_collect_images: () => JSON.stringify({
        count: 6,
        images: [
          { url: 'https://sns-webpic-qc.xhscdn.com/202606061939/a/comment/comment-1!nc_n_webp_mw_1', width: 1200, height: 900 },
          { url: 'http://sns-webpic-qc.xhscdn.com/202606061939/a/comment/comment-1!nc_n_webp_mw_1', width: 1200, height: 900 },
          { url: 'https://sns-webpic-qc.xhscdn.com/202606061939/b/oss-sg/comment/comment-2!nc_n_webp_mw_1', width: 1200, height: 900 },
          { url: 'https://sns-webpic-qc.xhscdn.com/202606061939/c/notes_pre_post/note-1!nd_dft_wlteh_webp_3', width: 1200, height: 1600 },
          { url: 'http://sns-webpic-qc.xhscdn.com/202606061939/c/notes_pre_post/note-1!nd_dft_wlteh_webp_3', width: 1200, height: 1600 },
          { url: 'https://sns-webpic-qc.xhscdn.com/202606061939/d/notes_pre_post/note-2!nd_dft_wlteh_webp_3', width: 1200, height: 1600 },
        ],
      }),
      browser_download_urls: () => JSON.stringify({ total: 2, success: 2, failed: 0 }),
    })
    const res = await collectNote(facade, { noteUrl: 'https://x', title: '卡片标题', outputDir: '/out' }, join)
    const download = calls.find((call) => call.tool === 'browser_download_urls')!
    const urls = download.args.urls as string[]

    assert.equal(res.success, true)
    assert.equal(res.imageCount, 2)
    assert.deepEqual(urls, [
      'https://sns-webpic-qc.xhscdn.com/202606061939/c/notes_pre_post/note-1!nd_dft_wlteh_webp_3',
      'https://sns-webpic-qc.xhscdn.com/202606061939/d/notes_pre_post/note-2!nd_dft_wlteh_webp_3',
    ])
  })

  it('only falls back to hidden images when visible images have no usable note assets', async () => {
    const { facade, calls } = facadeFrom({
      browser_collect_images: (args) => {
        if (args.include_hidden) {
          return JSON.stringify({ count: 1, images: [{ url: 'https://sns-webpic-qc.xhscdn.com/notes_pre_post/hidden.jpg' }] })
        }
        return JSON.stringify({ count: 0, images: [] })
      },
      browser_download_urls: () => JSON.stringify({ total: 1, success: 1, failed: 0 }),
    })
    const res = await collectNote(facade, { noteUrl: 'https://x', title: '卡片标题', outputDir: '/out' }, join)
    const collectCalls = calls.filter((call) => call.tool === 'browser_collect_images')

    assert.equal(res.success, true)
    assert.deepEqual(collectCalls.map((call) => call.args.include_hidden), [false, true])
    assert.deepEqual(calls.find((call) => call.tool === 'browser_download_urls')?.args.urls, [
      'https://sns-webpic-qc.xhscdn.com/notes_pre_post/hidden.jpg',
    ])
  })

  it('uses the structured gallery fallback before saving an under-loaded Xiaohongshu carousel', async () => {
    const urls = Array.from({ length: 10 }, (_, index) =>
      `https://sns-webpic-qc.xhscdn.com/notes_pre_post/image-${index + 1}!nc_n_webp_mw_1`)
    const { facade, calls } = facadeFrom({
      browser_collect_images: () => JSON.stringify({
        count: 1,
        scope: 'xiaohongshu-detail',
        expectedImageCount: 10,
        images: [{ url: urls[0], width: 1200, height: 1600 }],
      }),
      browser_extract_structured: (args) => args.template === 'image_gallery'
        ? JSON.stringify({ items: urls.map((url) => ({ link: url, media: [url] })) })
        : JSON.stringify({ items: [{ title: '多图笔记' }] }),
      browser_download_urls: () => JSON.stringify({ total: 10, success: 10, failed: 0 }),
    })
    const res = await collectNote(
      facade,
      {
        noteUrl: 'https://www.xiaohongshu.com/explore/6a27d9280000000007013982',
        title: '多图笔记',
        outputDir: '/out',
      },
      join,
    )
    const download = calls.find((call) => call.tool === 'browser_download_urls')!

    assert.equal(res.success, true)
    assert.equal(res.imageCount, 10)
    assert.deepEqual(download.args.urls, urls)
    assert.equal(calls.filter((call) => call.tool === 'browser_extract_structured' && call.args.template === 'image_gallery').length, 1)
  })

  it('pauses a Xiaohongshu note before download when the carousel total is still under-collected', async () => {
    const url = 'https://sns-webpic-qc.xhscdn.com/notes_pre_post/image-1!nc_n_webp_mw_1'
    const { facade, calls } = facadeFrom({
      browser_collect_images: () => JSON.stringify({
        count: 1,
        scope: 'xiaohongshu-detail',
        expectedImageCount: 10,
        images: [{ url, width: 1200, height: 1600 }],
      }),
      browser_extract_structured: (args) => args.template === 'image_gallery'
        ? JSON.stringify({ items: [{ link: url, media: [url] }] })
        : JSON.stringify({ items: [{ title: '多图笔记' }] }),
    })
    const res = await collectNote(
      facade,
      {
        noteUrl: 'https://www.xiaohongshu.com/explore/6a27d9280000000007013982',
        title: '多图笔记',
        outputDir: '/out',
      },
      join,
    )

    assert.equal(res.success, false)
    assert.equal(res.reason, 'partial_images:1/10')
    assert.equal(calls.some((call) => call.tool === 'browser_download_urls'), false)
    assert.equal(calls.some((call) => call.tool === 'browser_wait'), true)
  })

  it('marks a Xiaohongshu carousel as partial when only one image is found and total is unknown', async () => {
    const url = 'https://sns-webpic-qc.xhscdn.com/notes_pre_post/image-1!nc_n_webp_mw_1'
    const { facade, calls } = facadeFrom({
      browser_collect_images: () => JSON.stringify({
        count: 1,
        scope: 'xiaohongshu-detail',
        hasCarouselSignal: true,
        images: [{ url, width: 1200, height: 1600 }],
      }),
      browser_extract_structured: (args) => args.template === 'image_gallery'
        ? JSON.stringify({ items: [{ link: url, media: [url] }] })
        : JSON.stringify({ items: [{ title: '多图笔记' }] }),
    })
    const res = await collectNote(
      facade,
      {
        noteUrl: 'https://www.xiaohongshu.com/explore/6a27d9280000000007013982',
        title: '多图笔记',
        outputDir: '/out',
      },
      join,
    )

    assert.equal(res.success, false)
    assert.equal(res.reason, 'partial_images:1/unknown')
    assert.equal(calls.some((call) => call.tool === 'browser_download_urls'), false)
  })

  it('still saves a genuine single-image Xiaohongshu note without carousel signals', async () => {
    const url = 'https://sns-webpic-qc.xhscdn.com/notes_pre_post/single!nc_n_webp_mw_1'
    const { facade, calls } = facadeFrom({
      browser_collect_images: () => JSON.stringify({
        count: 1,
        scope: 'xiaohongshu-detail',
        images: [{ url, width: 1200, height: 1600 }],
      }),
      browser_extract_structured: (args) => args.template === 'image_gallery'
        ? JSON.stringify({ items: [{ link: url, media: [url] }] })
        : JSON.stringify({ items: [{ title: '单图笔记' }] }),
      browser_download_urls: () => JSON.stringify({ total: 1, success: 1, failed: 0 }),
    })
    const res = await collectNote(
      facade,
      {
        noteUrl: 'https://www.xiaohongshu.com/explore/6a27d9280000000007013982',
        title: '单图笔记',
        outputDir: '/out',
      },
      join,
    )

    assert.equal(res.success, true)
    assert.equal(res.imageCount, 1)
    assert.deepEqual(calls.find((call) => call.tool === 'browser_download_urls')?.args.urls, [url])
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

  it('marks Xiaohongshu unavailable notes explicitly instead of no_images', async () => {
    const { facade, calls } = facadeFrom({
      browser_read_page: () => '小红书 - 你访问的页面不见了 当前笔记暂时无法浏览',
      browser_collect_images: () => JSON.stringify({ count: 0, images: [] }),
    })
    const res = await collectNote(facade, { noteUrl: 'https://www.xiaohongshu.com/explore/1', outputDir: '/out' }, join)
    assert.equal(res.success, false)
    assert.equal(res.reason, 'unavailable')
    assert.deepEqual(calls.map((c) => c.tool), ['browser_navigate', 'browser_read_page'])
  })

  it('waits briefly for Xiaohongshu card-loop media before no_images', async () => {
    let collectCalls = 0
    const { facade, calls } = facadeFrom({
      browser_collect_images: () => {
        collectCalls += 1
        if (collectCalls < 3) return JSON.stringify({ count: 0, images: [] })
        return imagesJson
      },
      browser_download_urls: () => JSON.stringify({ total: 2, success: 2, failed: 0 }),
    })
    const res = await collectNote(facade, {
      noteUrl: 'https://www.xiaohongshu.com/explore/1',
      title: '卡片标题',
      outputDir: '/out',
      skipNavigate: true,
    }, join)

    assert.equal(res.success, true)
    assert.equal(res.imageCount, 2)
    assert.ok(calls.some((call) => call.tool === 'browser_wait'))
    assert.equal(calls.filter((call) => call.tool === 'browser_collect_images').length, 3)
  })

  it('downloads video-only notes instead of marking them skipped', async () => {
    const { facade, calls } = facadeFrom({
      browser_collect_images: () => JSON.stringify({
        count: 2,
        images: [
          { url: 'https://sns-webpic-qc.xhscdn.com/202606061939/a/comment/comment-1!nc_n_webp_mw_1', width: 1200, height: 900 },
          { url: 'http://sns-webpic-qc.xhscdn.com/202606061939/a/comment/comment-1!nc_n_webp_mw_1', width: 1200, height: 900 },
        ],
        videoCount: 1,
        videos: [{ url: 'https://sns-video.xhscdn.com/video.mp4', width: 716, height: 378 }],
      }),
      browser_resolve_video: () => JSON.stringify({
        ok: true,
        video: {
          parseStatus: 'not_needed',
          downloadUrl: 'https://sns-video.xhscdn.com/video.mp4',
        },
      }),
      browser_download_urls: () => JSON.stringify({
        total: 1,
        success: 1,
        failed: 0,
        results: [{ success: true, path: '/out/01 - https---x/assets/video-1.mp4' }],
      }),
    })
    const res = await collectNote(facade, { noteUrl: 'https://x', outputDir: '/out' }, join)
    assert.equal(res.success, true)
    assert.equal(res.imageCount, 0)
    assert.equal(res.videoCount, 1)
    assert.equal(res.mediaKind, 'video')
    assert.equal(calls.some((call) => call.tool === 'browser_resolve_video'), true)
    assert.deepEqual(calls.find((call) => call.tool === 'browser_download_urls')?.args.urls, ['https://sns-video.xhscdn.com/video.mp4'])
    assert.equal(calls.find((call) => call.tool === 'browser_download_urls')?.args.filename_prefix, 'video')
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

  it('does not reject a card-loop detail just because the Xiaohongshu profile text remains behind it', async () => {
    const profileAndDetailText = 'Aoi葵 小红书号：95490005330 1.6万 粉丝 10.7万 获赞与收藏 笔记 收藏 门主 #cosplay'
    const { facade, calls } = facadeFrom({
      browser_read_page: () => profileAndDetailText,
      browser_collect_images: () => JSON.stringify({
        count: 2,
        scope: 'xiaohongshu-detail',
        images: [
          { url: 'https://sns-webpic-qc.xhscdn.com/202606061939/a/notes_pre_post/note-1!nd_dft_wlteh_webp_3', width: 1080, height: 1620 },
          { url: 'https://sns-webpic-qc.xhscdn.com/202606061939/b/notes_pre_post/note-2!nd_dft_wlteh_webp_3', width: 1080, height: 1620 },
        ],
      }),
      browser_download_urls: () => JSON.stringify({ total: 2, success: 2, failed: 0 }),
    })
    const res = await collectNote(
      facade,
      {
        noteUrl: 'https://www.xiaohongshu.com/user/profile/u/source-1',
        openUrl: 'https://www.xiaohongshu.com/user/profile/u/source-1',
        title: '门主',
        sourceId: 'source-1',
        skipNavigate: true,
        outputDir: '/out',
      },
      join,
    )

    assert.equal(res.success, true)
    assert.equal(calls.some((c) => c.tool === 'browser_navigate'), false)
    assert.equal(calls.some((c) => c.tool === 'browser_download_urls'), true)
  })

  it('rejects card-loop Xiaohongshu backdrop images without detail media scope', async () => {
    const profileText = 'Aoi葵 小红书号：95490005330 1.6万 粉丝 10.7万 获赞与收藏 笔记 收藏 门主'
    const { facade, calls } = facadeFrom({
      browser_read_page: () => profileText,
      browser_collect_images: () => JSON.stringify({
        count: 2,
        scope: 'document',
        images: [
          { url: 'https://sns-webpic-qc.xhscdn.com/202606061939/a/notes_pre_post/card-1!nd_dft_wlteh_webp_3', width: 360, height: 480 },
          { url: 'https://sns-webpic-qc.xhscdn.com/202606061939/b/notes_pre_post/card-2!nd_dft_wlteh_webp_3', width: 360, height: 480 },
        ],
      }),
    })
    const res = await collectNote(
      facade,
      {
        noteUrl: 'https://www.xiaohongshu.com/user/profile/u/source-1',
        openUrl: 'https://www.xiaohongshu.com/user/profile/u/source-1',
        title: '门主',
        sourceId: 'source-1',
        skipNavigate: true,
        outputDir: '/out',
      },
      join,
    )

    assert.equal(res.success, false)
    assert.equal(res.reason, 'detail_not_opened')
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

  it('writes video note artifacts when a video-only note downloads successfully', async () => {
    const writes: Record<string, string> = {}
    const ensured: string[] = []
    const { facade } = facadeFrom({
      browser_collect_images: () => JSON.stringify({
        count: 0,
        images: [],
        videoCount: 1,
        videos: [{ url: 'https://sns-video.xhscdn.com/video.mp4', width: 720, height: 1280 }],
      }),
      browser_resolve_video: () => JSON.stringify({
        ok: true,
        video: { parseStatus: 'not_needed', downloadUrl: 'https://sns-video.xhscdn.com/video.mp4' },
      }),
      browser_download_urls: () => JSON.stringify({
        total: 1,
        success: 1,
        failed: 0,
        results: [{ success: true, path: '/out/01 - 视频笔记/assets/video-1.mp4' }],
      }),
    })
    const res = await collectNote(
      facade,
      { noteUrl: 'https://www.xiaohongshu.com/explore/69df5244000000001a02a0f8', title: '视频笔记', outputDir: '/out' },
      join,
      {
        ensureDir: async (path) => { ensured.push(path) },
        writeTextFile: async (path, content) => { writes[path] = content },
      },
    )

    assert.equal(res.success, true)
    assert.equal(res.videoCount, 1)
    assert.equal(res.notePath, '/out/01 - 视频笔记/note.md')
    assert.deepEqual(ensured, ['/out/01 - 视频笔记', '/out/01 - 视频笔记/assets'])
    assert.match(writes['/out/01 - 视频笔记/note.md'], /视频数量：1/)
    assert.match(writes['/out/01 - 视频笔记/note.md'], /\[视频文件\]\(assets\/video-1.mp4\)/)
    const manifest = JSON.parse(writes['/out/01 - 视频笔记/manifest.json'])
    assert.equal(manifest.mediaKind, 'video')
    assert.equal(manifest.videoCount, 1)
    assert.deepEqual(manifest.files, ['assets/video-1.mp4'])
    assert.deepEqual(manifest.videoUrls, ['https://sns-video.xhscdn.com/video.mp4'])
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

describe('collectCardNote (visible card loop)', () => {
  it('verifies the opened detail belongs to the target before collecting', async () => {
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
    assert.equal(calls[0].args.href_contains, 'source-1')
    assert.deepEqual(calls.map((c) => c.tool), [
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

  it('does not save profile-grid images when the card click leaves the tab on the list page', async () => {
    const { facade, calls } = facadeFrom({
      browser_get_tabs: () => [
        '▶ [tab-1] 用户主页',
        '    https://www.example.com/user/profile/source-owner',
        '  [tab-2] 详情页',
        '    https://www.example.com/post/source-1',
      ].join('\n'),
      browser_read_page: () => '主页列表：笔记一 source-1',
      browser_collect_images: () => imagesJson,
    })
    const res = await collectCardNote(
      facade,
      { noteUrl: 'https://www.example.com/post/source-1', title: '笔记一', sourceId: 'source-1', outputDir: '/out' },
      join,
    )

    assert.equal(res.success, false)
    assert.equal(res.reason, 'detail_not_opened')
    assert.equal(calls[0].tool, 'browser_click_text')
    assert.ok(calls.filter((c) => c.tool === 'browser_get_tabs').length >= 15)
    assert.equal(calls.at(-1)?.tool, 'browser_go_back')
    assert.equal(calls.some((c) => c.tool === 'browser_download_urls'), false)
  })

  it('collects same-page detail after a card click without falling back to href navigation', async () => {
    const { facade, calls } = facadeFrom({
      browser_click_text: () => JSON.stringify({ ok: true, href: 'https://www.example.com/user/profile/u/source-1?xsec_source=pc_user' }),
      browser_get_tabs: () => '▶ [tab-1] 用户主页\n    https://www.example.com/user/profile/u',
      browser_read_page: () => '详情页：笔记一 source-1',
      browser_collect_images: () => imagesJson,
      browser_download_urls: () => JSON.stringify({ success: 2 }),
    })
    const res = await collectCardNote(
      facade,
      { noteUrl: 'https://www.example.com/explore/source-1', title: '笔记一', sourceId: 'source-1', outputDir: '/out' },
      join,
    )

    assert.equal(res.success, true)
    assert.equal(calls.some((c) => c.tool === 'browser_navigate'), false)
    assert.equal(calls.some((c) => c.tool === 'browser_download_urls'), true)
  })

  it('does not save Xiaohongshu profile-grid images when the URL changes but the detail body is still the profile list', async () => {
    const profileText = 'Aoi葵 小红书号：95490005330 1.6万 粉丝 10.7万 获赞与收藏 已关注 笔记 收藏 摸鱼 Aoi葵 猫儿 Aoi葵'
    const { facade, calls } = facadeFrom({
      browser_click_text: () => JSON.stringify({ ok: true, href: 'https://www.xiaohongshu.com/user/profile/u/source-1?xsec_source=pc_user' }),
      browser_get_tabs: () => '▶ [tab-1] Aoi葵 - 小红书\n    https://www.xiaohongshu.com/explore/source-1?xsec_source=pc_user',
      browser_read_page: () => profileText,
      browser_navigate: () => JSON.stringify({ ok: true }),
      browser_collect_images: () => imagesJson,
    })
    const res = await collectCardNote(
      facade,
      {
        noteUrl: 'https://www.xiaohongshu.com/user/profile/u/source-1?xsec_source=pc_user',
        canonicalUrl: 'https://www.xiaohongshu.com/user/profile/u/source-1?xsec_source=pc_user',
        openUrl: 'https://www.xiaohongshu.com/user/profile/u/source-1?xsec_source=pc_user',
        title: '摸鱼',
        sourceId: 'source-1',
        outputDir: '/out',
      },
      join,
    )

    assert.equal(res.success, false)
    assert.equal(res.reason, 'detail_not_opened')
    assert.equal(calls.some((c) => c.tool === 'browser_download_urls'), false)
  })

  it('uses same-page detail evidence when click output has no href', async () => {
    const { facade, calls } = facadeFrom({
      browser_click_text: () => JSON.stringify({ ok: true }),
      browser_get_tabs: () => '▶ [tab-1] 用户主页\n    https://www.example.com/user/profile/u',
      browser_read_page: () => '详情页：笔记一 source-1',
      browser_collect_images: () => imagesJson,
      browser_download_urls: () => JSON.stringify({ success: 2 }),
    })
    const res = await collectCardNote(
      facade,
      {
        noteUrl: 'https://www.example.com/explore/source-1',
        canonicalUrl: 'https://www.example.com/explore/source-1',
        openUrl: 'https://www.example.com/explore/source-1',
        title: '笔记一',
        sourceId: 'source-1',
        outputDir: '/out',
      },
      join,
    )

    assert.equal(res.success, true)
    assert.equal(calls.some((c) => c.tool === 'browser_navigate'), false)
    assert.equal(calls.some((c) => c.tool === 'browser_download_urls'), true)
  })

  it('marks a card failed when the click opens the wrong detail', async () => {
    let tabReads = 0
    const { facade, calls } = facadeFrom({
      browser_get_tabs: () => {
        tabReads += 1
        return tabReads === 1
          ? '[tab-1] 详情页\n    https://www.example.com/post/source-1'
          : '[tab-1] 详情页\n    https://www.example.com/post/source-2'
      },
      browser_read_page: () => '详情页：别的笔记 wrong-source',
      browser_collect_images: () => imagesJson,
    })
    const res = await collectCardNote(
      facade,
      { noteUrl: 'https://www.example.com/post/source-1', title: '笔记一', sourceId: 'source-1', outputDir: '/out' },
      join,
    )

    assert.equal(res.success, false)
    assert.equal(res.reason, 'detail_mismatch')
    assert.deepEqual(calls.map((c) => c.tool), ['browser_click_text', 'browser_get_tabs', 'browser_read_page', 'browser_get_tabs', 'browser_go_back'])
  })

  it('continues when the target URL is confirmed but the detail text omits the title', async () => {
    const { facade, calls } = facadeFrom({
      browser_get_tabs: () => '[tab-1] 详情页\n    https://www.example.com/post/source-1',
      browser_read_page: () => 'Page content is empty or still loading.',
      browser_collect_images: () => imagesJson,
      browser_download_urls: () => JSON.stringify({ success: 2 }),
    })
    const res = await collectCardNote(
      facade,
      { noteUrl: 'https://www.example.com/post/source-1', title: '笔记一', sourceId: 'source-1', outputDir: '/out' },
      join,
    )

    assert.equal(res.success, true)
    assert.equal(calls.some((c) => c.tool === 'browser_download_urls'), true)
  })

  it('marks a card failed when it cannot return to the list after collecting', async () => {
    const { facade, calls } = facadeFrom({
      browser_get_tabs: () => '[tab-1] 详情页\n    https://www.example.com/post/source-1',
      browser_read_page: () => '详情页：笔记一 source-1',
      browser_collect_images: () => imagesJson,
      browser_download_urls: () => JSON.stringify({ success: 2 }),
      browser_go_back: () => JSON.stringify({ ok: false, errorCode: 'history_empty', message: 'cannot return' }),
    })
    const res = await collectCardNote(
      facade,
      { noteUrl: 'https://www.example.com/post/source-1', title: '笔记一', sourceId: 'source-1', outputDir: '/out' },
      join,
    )

    assert.equal(res.success, false)
    assert.equal(res.reason, 'return_list:history_empty')
    assert.deepEqual(calls.map((c) => c.tool), [
      'browser_click_text',
      'browser_get_tabs',
      'browser_read_page',
      'browser_read_page',
      'browser_extract_structured',
      'browser_collect_images',
      'browser_download_urls',
      'browser_go_back',
    ])
  })
})
