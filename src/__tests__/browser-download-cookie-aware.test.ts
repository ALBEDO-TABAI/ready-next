import assert from 'node:assert/strict'
import { describe, it, afterEach } from 'node:test'
import { rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { executeBrowserTool } from '../main/modules/tools/browser-tools'
import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ready-dl-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('browser_download_urls cookie-aware routing (WP4)', () => {
  it('routes downloads through the browser session (cookie+Referer), not fetch, when available', async () => {
    const calls: Array<{ url: string; sourcePageUrl?: string | null }> = []
    const dir = tempDir()
    const controller: BrowserController = {
      getActiveTab: () => ({ id: 'tab-1', url: 'https://www.xiaohongshu.com/x', title: 'T', active: true }) as never,
      executeJS: async () => 'https://www.xiaohongshu.com/x',
      downloadUrlToDirectory: async (payload: { url: string; sourcePageUrl?: string | null }) => {
        calls.push({ url: payload.url, sourcePageUrl: payload.sourcePageUrl })
        return { success: true, savePath: `${dir}/img.jpg`, filename: 'img.jpg' }
      },
    } as unknown as BrowserController

    const out = await executeBrowserTool(
      'browser_download_urls',
      { urls: ['https://sns-img.xhscdn.com/a.jpg'], directory: dir },
      controller,
    )
    const parsed = JSON.parse(out)
    assert.equal(calls.length, 1, 'must call the cookie-aware session download path')
    assert.equal(calls[0].url, 'https://sns-img.xhscdn.com/a.jpg')
    assert.equal(calls[0].sourcePageUrl, 'https://www.xiaohongshu.com/x', 'carries the source page as Referer')
    assert.equal(parsed.success, 1)
    assert.equal(parsed.results[0].via, 'browser_session')
  })

  it('falls back to fetch (structured) when the session download path reports failure', async () => {
    const dir = tempDir()
    const controller: BrowserController = {
      getActiveTab: () => ({ id: 'tab-1', url: 'https://www.xiaohongshu.com/x', title: 'T', active: true }) as never,
      executeJS: async () => 'https://www.xiaohongshu.com/x',
      downloadUrlToDirectory: async () => ({ success: false, error: 'download did not start' }),
    } as unknown as BrowserController

    const out = await executeBrowserTool(
      'browser_download_urls',
      { urls: ['https://no-such-host.invalid/a.jpg'], directory: dir },
      controller,
    )
    const parsed = JSON.parse(out)
    // Session path failed → fell back to fetch → structured failure (not silent).
    assert.equal(parsed.results[0].via, 'fetch')
    assert.equal(parsed.results[0].success, false)
    assert.ok(parsed.failed >= 1)
  })
})
