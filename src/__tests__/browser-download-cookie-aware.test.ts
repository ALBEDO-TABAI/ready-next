import assert from 'node:assert/strict'
import { describe, it, afterEach, test } from 'node:test'
import { rmSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { executeBrowserTool } from '../main/modules/tools/browser-tools'
import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import { attachBrowserWorkflowFixture } from './utils/browser-workflow-fixture'
import { createBrowserDownloadFixture } from './utils/browser-download-fixture'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('browser-download-cookie-aware declares transitive sqlite ABI guard', (t) => {
  if (skipIfSqliteUnavailable(t, 'browser-download-cookie-aware transitive sqlite load')) return
})

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ready-dl-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function parseToolOutput(out: unknown): Record<string, unknown> {
  if (typeof out === 'string') return JSON.parse(out) as Record<string, unknown>
  if (out && typeof out === 'object') {
    const value = out as { data?: unknown; text?: unknown }
    if (value.data !== undefined && value.data !== null) return value.data as Record<string, unknown>
    if (typeof value.text === 'string') return JSON.parse(value.text) as Record<string, unknown>
  }
  return JSON.parse(String(out)) as Record<string, unknown>
}

describe('browser_download cookie-aware routing (WP4)', () => {
  it('routes downloads through the browser session (cookie+Referer), not fetch, when available', async () => {
    const calls: Array<{ url: string; sourcePageUrl?: string | null }> = []
    const dir = tempDir()
    const download = createBrowserDownloadFixture()
    const fixture = attachBrowserWorkflowFixture({
      ...download.methods,
      getActiveTab: () => ({ id: 'tab-1', url: 'https://www.xiaohongshu.com/x', title: 'T', active: true }) as never,
      executeJS: async () => 'https://www.xiaohongshu.com/x',
      downloadUrlToDirectory: async (payload: { url: string; targetDir: string; sourcePageUrl?: string | null }) => {
        calls.push({ url: payload.url, sourcePageUrl: payload.sourcePageUrl })
        const bytes = Buffer.from([1, 2, 3])
        const savePath = join(payload.targetDir, 'img.jpg')
        writeFileSync(savePath, bytes)
        return { success: true, savePath, filename: 'img.jpg', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
      },
    } as unknown as BrowserController)

    const out = await executeBrowserTool(
      'browser_download',
      { mode: 'urls', urls: ['https://sns-img.xhscdn.com/a.jpg'], directory: dir },
      fixture.controller,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { ...fixture.context, workspaceRoots: [dir] },
    )
    const parsed = parseToolOutput(out)
    const results = parsed.results as Array<Record<string, unknown>>
    assert.equal(parsed.errorKind, undefined, JSON.stringify(parsed))
    assert.equal(calls.length, 1, 'must call the cookie-aware session download path')
    assert.equal(calls[0].url, 'https://sns-img.xhscdn.com/a.jpg')
    assert.equal(calls[0].sourcePageUrl, 'https://www.xiaohongshu.com/x', 'carries the source page as Referer')
    assert.equal(parsed.success, 1)
    assert.equal(results[0].via, 'browser_session')
    assert.deepEqual(parsed.downloadReceipts, download.receipts)
    assert.equal(download.receipts.length, 1)
    assert.equal(download.receipts[0].browserTaskId, fixture.context.browserTaskId)
    assert.equal(download.receipts[0].ownerRunId, fixture.context.ownerRunId)
  })

  it('adds a media Accept header for browser-session video downloads', async () => {
    const calls: Array<{ url: string; downloadHeaders?: Record<string, string> | null }> = []
    const dir = tempDir()
    const fixture = attachBrowserWorkflowFixture({
      ...createBrowserDownloadFixture().methods,
      getActiveTab: () => ({ id: 'tab-1', url: 'https://www.douyin.com/video/7650355790565395731', title: 'T', active: true }) as never,
      executeJS: async () => 'https://www.douyin.com/video/7650355790565395731',
      downloadUrlToDirectory: async (payload: {
        url: string
        targetDir: string
        downloadHeaders?: Record<string, string> | null
      }) => {
        calls.push({ url: payload.url, downloadHeaders: payload.downloadHeaders })
        const bytes = Buffer.from([4, 5, 6])
        const savePath = join(payload.targetDir, 'video.mp4')
        writeFileSync(savePath, bytes)
        return { success: true, savePath, filename: 'video.mp4', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
      },
    } as unknown as BrowserController)

    const out = await executeBrowserTool(
      'browser_download',
      { mode: 'urls', urls: ['https://v.douyinvod.com/video/tos/cn/example?mime_type=video_mp4'], directory: dir },
      fixture.controller,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { ...fixture.context, workspaceRoots: [dir] },
    )
    const parsed = parseToolOutput(out)
    assert.equal(parsed.errorKind, undefined, JSON.stringify(parsed))
    assert.equal(parsed.success, 1)
    assert.equal(calls.length, 1)
    assert.equal(
      calls[0].downloadHeaders?.Accept,
      'video/webm,video/ogg,video/*;q=0.9,audio/*;q=0.8,*/*;q=0.8',
    )
  })

  it('keeps browser-session failure structured without falling back to Node fetch', async (t) => {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Node fetch must not be used') })
    const dir = tempDir()
    const fixture = attachBrowserWorkflowFixture({
      ...createBrowserDownloadFixture().methods,
      getActiveTab: () => ({ id: 'tab-1', url: 'https://www.xiaohongshu.com/x', title: 'T', active: true }) as never,
      executeJS: async () => 'https://www.xiaohongshu.com/x',
      downloadUrlToDirectory: async () => ({ success: false, error: 'download did not start' }),
    } as unknown as BrowserController)

    const out = await executeBrowserTool(
      'browser_download',
      { mode: 'urls', urls: ['https://no-such-host.invalid/a.jpg'], directory: dir },
      fixture.controller,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { ...fixture.context, workspaceRoots: [dir] },
    )
    const parsed = parseToolOutput(out)
    const results = parsed.results as Array<Record<string, unknown>>
    assert.equal(results[0].via, 'browser_session')
    assert.equal(results[0].success, false)
    assert.equal(results[0].error, 'download did not start')
    assert.deepEqual(parsed.downloadReceipts, [])
    assert.ok(Number(parsed.failed) >= 1)
    assert.equal(fetchMock.mock.callCount(), 0)
  })
})
