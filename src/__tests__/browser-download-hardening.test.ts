import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import {
  BrowserDownloadService,
  isBrowserLocalNetworkUrl,
  rejectsPublicToLocalDownloadRedirect,
} from '../main/modules/browser-engine/download-service'
import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import {
  DEFAULT_BROWSER_DOWNLOAD_DIRECTORY,
  downloadPageScopedUrlToDirectory,
  downloadUrlsToDirectory,
  resolveAuthorizedBrowserDownloadDirectory,
} from '../main/modules/tools/browser-media-download'

test('download redirect policy permits explicit local tasks but rejects public-to-local pivots', () => {
  assert.equal(isBrowserLocalNetworkUrl('http://localhost:8080/file'), true)
  assert.equal(isBrowserLocalNetworkUrl('http://192.168.1.4/file'), true)
  assert.equal(isBrowserLocalNetworkUrl('https://example.com/file'), false)
  assert.equal(rejectsPublicToLocalDownloadRedirect(
    'https://example.com/file',
    ['https://example.com/file', 'http://127.0.0.1/private'],
  ), true)
  assert.equal(rejectsPublicToLocalDownloadRedirect(
    'http://localhost:8080/file',
    ['http://localhost:8080/file'],
  ), false)
})

test('download directory authority accepts task roots and rejects invented absolute paths', () => {
  assert.equal(resolveAuthorizedBrowserDownloadDirectory('/tmp/invented-by-model').ok, false)
  const explicit = resolveAuthorizedBrowserDownloadDirectory('/tmp/user-picked', {
    trustedRoots: ['/tmp/user-picked'],
  })
  assert.equal(explicit.ok, true)
  const taskBound = resolveAuthorizedBrowserDownloadDirectory('/tmp/task-root/assets', {
    trustedRoots: ['/tmp/task-root'],
  })
  assert.equal(taskBound.ok, true)
  assert.equal(resolveAuthorizedBrowserDownloadDirectory(process.cwd()).ok, false)
  assert.equal(resolveAuthorizedBrowserDownloadDirectory('/', { currentUserText: '保存到 /' }).ok, false)
  assert.equal(resolveAuthorizedBrowserDownloadDirectory(process.env.HOME, {
    currentUserText: `保存到 ${process.env.HOME}`,
  }).ok, false)
  assert.equal(resolveAuthorizedBrowserDownloadDirectory('/tmp/from-packaged-cwd', {
    trustedRoots: ['/'],
  }).ok, false)
})

test('download directory authority uses the Ready-owned default when no path is supplied', () => {
  const resolved = resolveAuthorizedBrowserDownloadDirectory(undefined)
  assert.equal(resolved.ok, true)
  if (resolved.ok) {
    assert.equal(resolved.authority, 'ready_default')
    assert.equal(resolved.directory, DEFAULT_BROWSER_DOWNLOAD_DIRECTORY)
  }
})

test('browser downloads preserve exact URLs and only remove exact duplicates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ready-download-url-'))
  const requested: string[] = []
  try {
    const output = await downloadUrlsToDirectory({
      executeJS: async () => 'https://source.example.test/page',
      downloadUrlToDirectory: async (params) => {
        requested.push(params.url)
        return {
          success: true,
          savePath: join(directory, `asset-${requested.length}.jpg`),
          filename: `asset-${requested.length}.jpg`,
          size: 3,
          mimeType: 'image/jpeg',
        }
      },
    } as unknown as BrowserController, {
      urls: [
        'https://cdn.example.test/474x/a.jpg',
        'https://cdn.example.test/474x/a.jpg',
        'https://cdn.example.test/originals/a.jpg',
      ],
      directory,
      mutationBoundary: {
        invokeTransport: async (run: () => unknown) => await run(),
        recordMechanicalFact: () => undefined,
      } as never,
    })
    const body = JSON.parse(typeof output === 'string' ? output : output.text) as { success: number }
    assert.equal(body.success, 2)
    assert.deepEqual(requested, [
      'https://cdn.example.test/474x/a.jpg',
      'https://cdn.example.test/originals/a.jpg',
    ])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

function pageStreamController(chunks: Buffer[]): BrowserController {
  let cursor = 0
  return {
    executeJS: async (_tabId, code) => {
      if (code.includes('response.body.getReader')) {
        return { id: 'stream-1', contentType: 'application/octet-stream', contentLength: chunks.reduce((n, chunk) => n + chunk.length, 0) }
      }
      if (code.includes('state.reader.read')) {
        const chunk = chunks[cursor++]
        return chunk ? { done: false, chunk: chunk.toString('base64') } : { done: true, chunk: '' }
      }
      return null
    },
  } as unknown as BrowserController
}

test('blob/data downloads stream bounded chunks to a verified atomic file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ready-page-download-'))
  try {
    const bytes = Buffer.from('page scoped bytes')
    const result = await downloadPageScopedUrlToDirectory(pageStreamController([
      bytes.subarray(0, 5),
      bytes.subarray(5),
    ]), {
      url: 'blob:https://example.test/asset',
      directory,
      suggestedName: 'asset',
      maxBytes: 1024,
    })
    assert.equal(result.success, true)
    assert.equal(result.size, bytes.length)
    assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'))
    assert.deepEqual(await readFile(result.savePath!), bytes)
    assert.ok((await readdir(directory)).every((name) => !name.endsWith('.part')))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('page-scoped download byte budget cancels and removes partial files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ready-page-download-budget-'))
  try {
    const result = await downloadPageScopedUrlToDirectory(pageStreamController([Buffer.from('too large')]), {
      url: 'data:text/plain;base64,dG9vIGxhcmdl',
      directory,
      suggestedName: 'asset',
      maxBytes: 3,
    })
    assert.equal(result.success, false)
    assert.match(String(result.error), /download_byte_budget_exceeded/)
    assert.deepEqual(await readdir(directory), [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

class FakeDownloadItem extends EventEmitter {
  savePath = ''
  cancelled = false
  received = 0

  constructor(
    readonly url: string,
    readonly chain: string[],
    readonly bytes: Buffer,
    readonly totalBytes = bytes.length,
  ) { super() }

  getURLChain() { return this.chain }
  getURL() { return this.url }
  getSavePath() { return this.savePath }
  getFilename() { return 'fixture.bin' }
  getContentDisposition() { return '' }
  getMimeType() { return 'application/octet-stream' }
  getTotalBytes() { return this.totalBytes }
  getReceivedBytes() { return this.received }
  canResume() { return false }
  setSavePath(path: string) { this.savePath = path }
  cancel() {
    this.cancelled = true
    queueMicrotask(() => this.emit('done', {}, 'cancelled'))
  }
}

class FakeSession extends EventEmitter {
  nextItem: FakeDownloadItem | null = null

  downloadURL(): void {
    const item = this.nextItem!
    queueMicrotask(async () => {
      this.emit('will-download', {}, item)
      if (item.cancelled) return
      await writeFile(item.savePath, item.bytes)
      item.received = item.bytes.length
      item.emit('updated', {}, 'progressing')
      item.emit('done', {}, 'completed')
    })
  }
}

test('browser-session downloads hash a temp file and atomically publish the final name', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ready-session-download-'))
  const targetSession = new FakeSession()
  const bytes = Buffer.from('session download bytes')
  targetSession.nextItem = new FakeDownloadItem('https://example.test/file', ['https://example.test/file'], bytes)
  const dataService = {
    addDownload: () => undefined,
    updateDownloadProgress: () => undefined,
    updateDownloadState: () => undefined,
  }
  const service = new BrowserDownloadService({ dataService: dataService as never, sendToRenderer: () => undefined })
  try {
    const result = await service.downloadUrlToDirectory(targetSession as never, {
      url: 'https://example.test/file',
      targetDir: directory,
      suggestedName: 'fixture',
      maxBytes: 1024,
    })
    assert.equal(result.success, true)
    assert.equal(result.size, bytes.length)
    assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'))
    assert.deepEqual(await readFile(result.savePath!), bytes)
    assert.ok((await readdir(directory)).every((name) => !name.endsWith('.part')))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('browser-session download rejects declared files beyond the task byte budget', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ready-session-download-budget-'))
  const targetSession = new FakeSession()
  targetSession.nextItem = new FakeDownloadItem('https://example.test/huge', ['https://example.test/huge'], Buffer.from('x'), 10_000)
  const service = new BrowserDownloadService({
    dataService: { addDownload: () => undefined, updateDownloadProgress: () => undefined, updateDownloadState: () => undefined } as never,
    sendToRenderer: () => undefined,
  })
  try {
    const result = await service.downloadUrlToDirectory(targetSession as never, {
      url: 'https://example.test/huge',
      targetDir: directory,
      maxBytes: 100,
    })
    assert.equal(result.success, false)
    assert.equal(result.error, 'download_byte_budget_exceeded')
    assert.equal(targetSession.nextItem.cancelled, true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('aborting a browser-session download cancels the DownloadItem and removes reservations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ready-session-download-abort-'))
  const targetSession = new FakeSession()
  const item = new FakeDownloadItem('https://example.test/slow', ['https://example.test/slow'], Buffer.from('never committed'))
  targetSession.nextItem = item
  const service = new BrowserDownloadService({
    dataService: { addDownload: () => undefined, updateDownloadProgress: () => undefined, updateDownloadState: () => undefined } as never,
    sendToRenderer: () => undefined,
  })
  const abort = new AbortController()
  try {
    const pending = service.downloadUrlToDirectory(targetSession as never, {
      url: 'https://example.test/slow',
      targetDir: directory,
      suggestedName: 'slow',
      maxBytes: 1024,
      signal: abort.signal,
    })
    abort.abort(new Error('turn_cancelled'))
    const result = await pending
    assert.equal(result.success, false)
    assert.equal(result.error, 'download_aborted')
    assert.equal(item.cancelled, true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(await readdir(directory), [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
