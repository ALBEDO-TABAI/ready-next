import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { BrowserDownloadService } from '../main/modules/browser-engine/download-service'
import type { BrowserDataService } from '../main/modules/browser-engine/data-service'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('browser-download-service declares transitive sqlite coverage', (t) => {
  if (skipIfSqliteUnavailable(t, 'browser-download-service transitive sqlite guard')) return
})

class FakeDownloadItem extends EventEmitter {
  private savePath = ''
  private receivedBytes = 128
  private cancelled = false

  constructor(
    private readonly url: string,
    private readonly filename: string,
    private readonly mimeType = 'image/jpeg',
    private readonly contentDisposition = '',
  ) {
    super()
  }

  getFilename(): string {
    return this.filename
  }

  getContentDisposition(): string {
    return this.contentDisposition
  }

  getTotalBytes(): number {
    return 128
  }

  getMimeType(): string {
    return this.mimeType
  }

  canResume(): boolean {
    return false
  }

  getURL(): string {
    return this.url
  }

  getURLChain(): string[] {
    return [this.url]
  }

  getSavePath(): string {
    return this.savePath
  }

  setSavePath(path: string): void {
    this.savePath = path
  }

  getReceivedBytes(): number {
    return this.receivedBytes
  }

  cancel(): void {
    this.cancelled = true
  }

  isCancelled(): boolean {
    return this.cancelled
  }

  finish(state: 'completed' | 'cancelled' | 'interrupted'): void {
    if (state === 'completed' && this.savePath) {
      writeFileSync(this.savePath, Buffer.alloc(this.receivedBytes, 1))
    }
    this.emit('done', {}, state)
  }
}

class FakeSession extends EventEmitter {
  downloadedUrl: string | null = null
  downloadOptions: unknown = null

  downloadURL(url: string, options?: unknown): void {
    this.downloadedUrl = url
    this.downloadOptions = options || null
  }
}

function createDownloadService(): BrowserDownloadService {
  const dataService = {
    addDownload: () => undefined,
    updateDownloadProgress: () => undefined,
    updateDownloadState: () => undefined,
  } as unknown as BrowserDataService
  return new BrowserDownloadService({
    dataService,
    sendToRenderer: () => undefined,
  })
}

test('downloadUrlToDirectory sets a unique save path inside the target directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-download-'))
  try {
    writeFileSync(join(dir, 'photo.jpg'), 'existing')
    const service = createDownloadService()
    const session = new FakeSession()
    const promise = service.downloadUrlToDirectory(session as never, {
      url: 'https://cdn.example.com/photo.jpg',
      targetDir: dir,
    })

    assert.equal(session.downloadedUrl, 'https://cdn.example.com/photo.jpg')
    const item = new FakeDownloadItem('https://cdn.example.com/photo.jpg', 'photo.jpg')
    session.emit('will-download', {}, item)
    assert.match(item.getSavePath(), /[\\/]\.ready-[^\\/]+\.part$/)
    item.finish('completed')

    const result = await promise
    assert.equal(result.success, true)
    assert.equal(result.savePath, join(dir, 'photo (2).jpg'))
    assert.equal(result.filename, 'photo (2).jpg')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('targeted downloads preserve disposition and decoded URL names, sanitize them and number collisions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-download-names-'))
  try {
    const service = createDownloadService()
    const session = new FakeSession()
    const cases = [
      { path: '/url.csv', header: 'attachment; filename="fallback.csv"; filename*=UTF-8\'zh\'%E6%8A%A5%E5%91%8A.csv', expected: '报告.csv' },
      { path: '/url.csv', header: 'attachment; filename="report;2026.csv"', expected: 'report;2026.csv' },
      { path: '/url.csv', header: 'attachment; filename*=UTF-8\'\'%ZZ; filename="fallback.csv"', expected: 'fallback.csv' },
      { path: '/downloads/files/report-2026-q3.csv', header: '', expected: 'report-2026-q3.csv' },
      { path: '/%E6%8A%A5%E5%91%8A%20Q3.csv', header: '', expected: '报告 Q3.csv' },
      { path: '/folder%2Fpart%5Cname%00%7F%C2%80.csv', header: '', expected: 'folder-part-name---.csv' },
      { path: '/url.csv', header: `attachment; filename="${'报'.repeat(100)}.csv"`, expected: `${'报'.repeat(58)}.csv` },
      { path: '/', header: '', expected: 'download-8.csv' },
      { path: '/url.csv', header: 'attachment; filename="fallback.csv"', expected: 'fallback (2).csv' },
    ]
    for (const [index, entry] of cases.entries()) {
      const url = `http://127.0.0.1${entry.path}`
      const promise = service.downloadUrlToDirectory(session as never, {
        url, targetDir: dir, fallbackName: `download-${index + 1}`,
      })
      const item = new FakeDownloadItem(url, 'download.csv', 'text/csv', entry.header)
      session.emit('will-download', {}, item)
      item.finish('completed')
      const result = await promise
      assert.equal(result.success, true, result.error)
      assert.equal(result.filename, entry.expected)
      assert.equal(result.savePath, join(dir, entry.expected))
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('downloadUrlToDirectory appends an inferred extension to extensionless suggested names', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-download-'))
  try {
    const service = createDownloadService()
    const session = new FakeSession()
    const promise = service.downloadUrlToDirectory(session as never, {
      url: 'https://sns-webpic-qc.xhscdn.com/notes_pre_post/abc!nc_n_webp_prv_1',
      targetDir: dir,
      suggestedName: 'image-1',
    })

    const item = new FakeDownloadItem(
      'https://sns-webpic-qc.xhscdn.com/notes_pre_post/abc!nc_n_webp_prv_1',
      'abc!nc_n_webp_prv_1',
      'image/webp',
    )
    session.emit('will-download', {}, item)
    assert.match(item.getSavePath(), /[\\/]\.ready-[^\\/]+\.part$/)
    item.finish('completed')

    const result = await promise
    assert.equal(result.success, true)
    assert.equal(result.savePath, join(dir, 'image-1.webp'))
    assert.equal(result.filename, 'image-1.webp')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('downloadUrlToDirectory passes only allowed identity headers to the browser session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-download-'))
  try {
    const service = createDownloadService()
    const session = new FakeSession()
    const promise = service.downloadUrlToDirectory(session as never, {
      url: 'https://v.douyinvod.com/video/tos/cn/tos-cn-ve-15/example',
      targetDir: dir,
      sourcePageUrl: 'https://www.douyin.com/video/7650355790565395731',
      suggestedName: 'douyin-video',
      downloadHeaders: {
        Referer: 'https://www.douyin.com/video/7650355790565395731',
        'User-Agent': 'Mozilla/5.0 Ready Test',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        Accept: 'video/webm,video/ogg,video/*;q=0.9,*/*;q=0.8',
        Cookie: 'secret=must-not-pass',
        'X-Test': 'must-not-pass',
      },
    })

    assert.deepStrictEqual(session.downloadOptions, {
      headers: {
        Referer: 'https://www.douyin.com/video/7650355790565395731',
        'User-Agent': 'Mozilla/5.0 Ready Test',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        Accept: 'video/webm,video/ogg,video/*;q=0.9,*/*;q=0.8',
      },
    })
    const item = new FakeDownloadItem(
      'https://v.douyinvod.com/video/tos/cn/tos-cn-ve-15/example',
      'example',
      'video/mp4',
    )
    session.emit('will-download', {}, item)
    assert.match(item.getSavePath(), /[\\/]\.ready-[^\\/]+\.part$/)
    item.finish('completed')

    const result = await promise
    assert.equal(result.success, true)
    assert.equal(result.filename, 'douyin-video.mp4')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an active page download protects its source tab until the item is done', () => {
  const session = new FakeSession()
  const changes: boolean[] = []
  let service: BrowserDownloadService
  service = new BrowserDownloadService({
    dataService: {
      addDownload: () => undefined,
      updateDownloadProgress: () => undefined,
      updateDownloadState: () => undefined,
    } as unknown as BrowserDataService,
    sendToRenderer: () => undefined,
    resolveTabIdForWebContents: (id) => id === 42 ? 'tab-42' : null,
    onTabDownloadStateChange: (tabId) => changes.push(service.isTabDownloading(tabId)),
  })
  service.ensureRegistered(session as never)
  const item = new FakeDownloadItem('https://cdn.example.com/file.bin', 'file.bin')

  session.emit('will-download', {}, item, { id: 42 })
  assert.equal(service.isTabDownloading('tab-42'), true)
  item.finish('cancelled')

  assert.equal(service.isTabDownloading('tab-42'), false)
  assert.deepEqual(changes, [true, false])
})

test('downloadUrlToDirectory rejects unsupported schemes and missing directories before download starts', async () => {
  const service = createDownloadService()
  const session = new FakeSession()

  const blobResult = await service.downloadUrlToDirectory(session as never, {
    url: 'blob:https://example.com/image',
    targetDir: tmpdir(),
  })
  assert.equal(blobResult.success, false)
  assert.equal(session.downloadedUrl, null)

  const missingDirResult = await service.downloadUrlToDirectory(session as never, {
    url: 'https://cdn.example.com/photo.jpg',
    targetDir: join(tmpdir(), 'ready-missing-download-dir'),
  })
  assert.equal(missingDirResult.success, false)
  assert.equal(session.downloadedUrl, null)
})
