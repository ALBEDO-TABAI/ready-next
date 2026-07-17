import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { BrowserCapabilityService } from '../main/modules/browser-engine/capability-service'

function createCapabilityHost() {
  const calls: Array<{ type: string; payload?: unknown }> = []
  let currentUrl = 'https://example.com/feed'
  let lastExtractScript = ''
  let scrollStep = 0

  return {
    calls,
    host: {
      openForCaptureTarget: async (url: string) => {
        calls.push({ type: 'open', payload: url })
        currentUrl = url
        return { success: true, tabId: 'tab-1', reused: true }
      },
      createTab: async (url: string) => {
        calls.push({ type: 'create', payload: url })
        currentUrl = url
        return { success: true, tabId: 'tab-1' }
      },
      getActiveTab: () => ({ id: 'tab-1', url: currentUrl }),
      dispatchMouse: async (_tabId: string | null, payload: Record<string, unknown>) => {
        calls.push({ type: 'mouse', payload })
        if (payload.type === 'mouseWheel') scrollStep = Math.min(3, scrollStep + 1)
      },
      executeJS: async (_tabId: string | null, code: string) => {
        if (code.includes('document.scrollingElement')) {
          return {
            url: currentUrl,
            x: 600,
            y: scrollStep * 600,
            viewport: 667,
            height: 2467,
            maxScroll: 1800,
          }
        }
        if (code.includes('__READY_EXTRACT_TEMPLATE__')) {
          lastExtractScript = code
          return [
            {
              sourceUrl: currentUrl,
              title: 'First post',
              link: 'https://example.com/posts/1',
              summary: 'Alpha',
            },
            {
              sourceUrl: currentUrl,
              title: 'Second post',
              link: 'https://example.com/posts/2',
              summary: 'Beta',
            },
          ]
        }
        if (code.includes('__READY_WAIT_CONDITION__')) {
          return { matched: true, value: true }
        }
        return null
      },
    },
    getLastExtractScript: () => lastExtractScript,
  }
}

describe('BrowserCapabilityService', () => {
  it('extracts structured article items from the active page', async () => {
    const { host } = createCapabilityHost()
    const service = new BrowserCapabilityService(host as any)

    const result = await service.extractStructured('tab-1', {
      template: 'article_list',
      limit: 10,
    })

    assert.strictEqual(result.items.length, 2)
    assert.strictEqual(result.items[0]?.title, 'First post')
    assert.strictEqual(result.items[1]?.link, 'https://example.com/posts/2')
  })

  it('prefers visible card anchors over hidden fallback links in the extraction script', async () => {
    const harness = createCapabilityHost()
    const service = new BrowserCapabilityService(harness.host as any)

    await service.extractStructured('tab-1', { template: 'card_list', limit: 10 })

    const script = harness.getLastExtractScript()
    assert.ok(script.includes("Array.from(node.querySelectorAll('a[href]'))"))
    assert.ok(script.includes('area: isVisible(item)'))
    assert.ok(script.includes('.sort((a, b) => b.area - a.area)'))
  })

  it('waits for a complex condition before extracting from a target url', async () => {
    const { host, calls } = createCapabilityHost()
    const service = new BrowserCapabilityService(host as any)

    const result = await service.extractStructuredFromUrl('https://example.com/feed', {
      openMode: 'prefer_reuse',
      wait: {
        condition: 'content_stable',
        timeoutMs: 2000,
        checkIntervalMs: 100,
      },
      template: 'article_list',
    })

    assert.strictEqual(calls[0]?.type, 'open')
    assert.strictEqual(result.items.length, 2)
  })

  it('scrolls and collects structured items until the page stops growing', async () => {
    const { host } = createCapabilityHost()
    const service = new BrowserCapabilityService(host as any)

    const result = await service.scrollCollect('tab-1', {
      template: 'card_list',
      maxScrolls: 8,
      stableRounds: 1,
      limit: 20,
    })

    assert.strictEqual(result.items.length, 2)
    assert.strictEqual(result.reachedEnd, true)
    assert.strictEqual(result.scrolls, 3)
    assert.equal((host as any).dispatchMouse instanceof Function, true)
  })

  it('resumes a batch download without requesting an already hashed successful URL again', async () => {
    const { host } = createCapabilityHost()
    const requested: string[] = []
    ;(host as any).downloadUrlToDirectory = async ({ url, targetDir }: { url: string; targetDir: string }) => {
      requested.push(url)
      return { success: true, savePath: `${targetDir}/next.bin`, sha256: 'next-hash' }
    }
    const service = new BrowserCapabilityService(host as any)
    const result = await service.batchDownload([
      'https://example.com/already.bin',
      'https://example.com/next.bin',
    ], {
      directory: process.cwd(),
      resumeResults: [{
        url: 'https://example.com/already.bin',
        success: true,
        path: '/tmp/already.bin',
        sha256: 'prior-hash',
      }],
    })

    assert.deepEqual(requested, ['https://example.com/next.bin'])
    assert.equal(result.success, 2)
    assert.equal(result.results.length, 2)
  })
})
