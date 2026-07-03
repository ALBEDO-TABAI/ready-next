import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

import { BrowserCapabilityService } from '../main/modules/browser-engine/capability-service'

test('structured extraction keeps candidate structure context at rawFields.structure', async () => {
  const sourceUrl = 'https://www.xiaohongshu.com/user/profile/5e31b693000000000100bb06'
  const service = new BrowserCapabilityService({
    openForCaptureTarget: async () => ({ success: true, tabId: 'tab-1' }),
    createTab: async () => ({ success: true, tabId: 'tab-1' }),
    navigate: async () => ({ success: true }),
    getActiveTab: () => ({ id: 'tab-1', url: sourceUrl }),
    executeJS: async (_tabId: string | null, code: string) => {
      if (code === 'location.href') return sourceUrl
      return [
        {
          sourceUrl,
          title: '今天的笔记',
          link: 'https://www.xiaohongshu.com/explore/665f5a23000000001e03a123?xsec_token=abc',
          rawFields: {
            structure: {
              inMainContentRegion: true,
              nearestTagName: 'section',
            },
          },
        },
      ]
    },
  })

  const result = await service.extractStructured('tab-1', { template: 'card_list' })

  assert.equal(result.items.length, 1)
  assert.deepEqual(result.items[0].rawFields?.structure, {
    inMainContentRegion: true,
    nearestTagName: 'section',
  })
})

test('structured extraction does not mark content cards inside side-named layouts as sidebar', async () => {
  const sourceUrl = 'https://www.xiaohongshu.com/user/profile/5d32b406000000001102ac8f'
  const dom = new JSDOM(`
    <main class="content-side-layout">
      <section class="note-item">
        <a href="https://www.xiaohongshu.com/user/profile/5d32b406000000001102ac8f/6928017e000000001e0334f4?xsec_token=abc&xsec_source=pc_user">
          <img src="https://sns-webpic-qc.xhscdn.com/a.webp" alt="日常的一点静物" />
          <span>日常的一点静物</span>
        </a>
      </section>
    </main>
  `, { url: sourceUrl, runScripts: 'outside-only' })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ width: 320, height: 200, top: 0, left: 0, right: 320, bottom: 200, x: 0, y: 0, toJSON: () => ({}) }),
  })
  const service = new BrowserCapabilityService({
    openForCaptureTarget: async () => ({ success: true, tabId: 'tab-1' }),
    createTab: async () => ({ success: true, tabId: 'tab-1' }),
    navigate: async () => ({ success: true }),
    getActiveTab: () => ({ id: 'tab-1', url: sourceUrl }),
    executeJS: async (_tabId: string | null, code: string) => {
      if (code === 'location.href') return sourceUrl
      return dom.window.eval(code)
    },
  })

  const result = await service.extractStructured('tab-1', { template: 'card_list' })
  const structure = result.items[0].rawFields?.structure as Record<string, unknown> | undefined

  assert.equal(result.items.length, 1)
  assert.equal(structure?.inSidebarRegion, false)
  assert.equal(structure?.nearestTagName, 'section')
  assert.equal(structure?.containerClass, 'note-item')
})
