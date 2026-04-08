import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { BrowserCapabilityService } from '../main/modules/browser-engine/capability-service'

function createCapabilityHost() {
  const calls: Array<{ type: string; payload?: unknown }> = []
  let currentUrl = 'https://example.com/feed'

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
      executeJS: async (_tabId: string | null, code: string) => {
        if (code.includes('__READY_SCROLL_COLLECT__')) {
          return {
            items: [
              { sourceUrl: currentUrl, title: 'Card 1', link: 'https://example.com/card-1' },
              { sourceUrl: currentUrl, title: 'Card 2', link: 'https://example.com/card-2' },
            ],
            reachedEnd: true,
            scrolls: 3,
          }
        }
        if (code.includes('__READY_EXTRACT_TEMPLATE__')) {
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
      limit: 20,
    })

    assert.strictEqual(result.items.length, 2)
    assert.strictEqual(result.reachedEnd, true)
    assert.strictEqual(result.scrolls, 3)
  })
})
