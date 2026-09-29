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

  it('stops scrolling immediately after the owning run is aborted', async () => {
    const { host, calls } = createCapabilityHost()
    const controller = new AbortController()
    ;(host as any).dispatchMouse = async (_tabId: string | null, payload: Record<string, unknown>) => {
      calls.push({ type: 'mouse', payload })
      controller.abort(new Error('owner_stopped'))
    }
    const service = new BrowserCapabilityService(host as any)

    await assert.rejects(
      service.scrollCollect('tab-1', {
        template: 'card_list',
        maxScrolls: 8,
        stableRounds: 2,
        limit: 20,
      }, controller.signal),
      /owner_stopped/,
    )
    assert.equal(calls.filter((call) => call.type === 'mouse').length, 1)
  })
})
