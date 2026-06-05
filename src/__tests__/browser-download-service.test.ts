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
  skipIfSqliteUnavailable(t, 'browser-download-service transitive sqlite guard')
})

class FakeDownloadItem extends EventEmitter {
  private savePath = ''
  private receivedBytes = 128
  private cancelled = false

  constructor(
    private readonly url: string,
    private readonly filename: string,
    private readonly mimeType = 'image/jpeg',
  ) {
    super()
  }

  getFilename(): string {
    return this.filename
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
    this.emit('done', {}, state)
  }
}

class FakeSession extends EventEmitter {
  downloadedUrl: string | null = null

  downloadURL(url: string): void {
    this.downloadedUrl = url
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
    assert.equal(item.getSavePath(), join(dir, 'photo (1).jpg'))
    item.finish('completed')

    const result = await promise
    assert.equal(result.success, true)
    assert.equal(result.savePath, join(dir, 'photo (1).jpg'))
    assert.equal(result.filename, 'photo (1).jpg')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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
    assert.equal(item.getSavePath(), join(dir, 'image-1.webp'))
    item.finish('completed')

    const result = await promise
    assert.equal(result.success, true)
    assert.equal(result.savePath, join(dir, 'image-1.webp'))
    assert.equal(result.filename, 'image-1.webp')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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
