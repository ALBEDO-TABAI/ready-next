import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildBrowserUtilityMenuModel,
  type BrowserUtilityMenuState,
} from '../main/modules/browser-engine/utility-menu-model'

function createState(overrides: Partial<BrowserUtilityMenuState> = {}): BrowserUtilityMenuState {
  return {
    currentTab: {
      id: 'tab-1',
      url: 'https://example.com/article',
      title: 'Example article',
      domain: 'example.com',
    },
    bookmarks: [],
    downloads: [],
    history: [],
    adblockEnabled: true,
    adblockDomainWhitelisted: false,
    currentDomain: 'example.com',
    ...overrides,
  }
}

test('bookmark utility menu keeps actions in a front-layer menu instead of requiring a layout side panel', () => {
  const model = buildBrowserUtilityMenuModel('bookmarks', createState())

  assert.equal(model.kind, 'bookmarks')
  assert.equal(model.items[0]?.label, '收藏当前页面')
  assert.equal(model.items.some((item) => item.label === '暂无收藏' && item.enabled === false), true)
  assert.equal(model.items.some((item) => item.label === '导入收藏夹…'), true)
  assert.equal(model.items.some((item) => item.label === '导出收藏夹…'), true)
})

test('downloads utility menu exposes recent downloads without borrowing browser layout width', () => {
  const model = buildBrowserUtilityMenuModel('downloads', createState({
    downloads: [
      {
        id: 'download-1',
        filename: 'report.pdf',
        url: 'https://example.com/report.pdf',
        save_path: '/tmp/report.pdf',
        total_bytes: 1024,
        received_bytes: 1024,
        state: 'completed',
        created_at: 1,
      },
    ],
  }))

  assert.equal(model.kind, 'downloads')
  assert.equal(model.items[0]?.label, 'report.pdf')
  assert.equal(model.items[0]?.action, 'open-download')
  assert.equal(model.items.some((item) => item.label === '清空下载记录'), true)
})

test('more utility menu nests recent history inside the menu tree instead of opening a separate right rail', () => {
  const model = buildBrowserUtilityMenuModel('more', createState({
    history: [
      {
        id: 'history-1',
        title: 'OpenAI Docs',
        url: 'https://platform.openai.com/docs',
        visited_at: 1,
      },
    ],
  }))

  const historyItem = model.items.find((item) => item.label === '历史记录')

  assert.equal(model.kind, 'more')
  assert.equal(historyItem?.type, 'submenu')
  assert.equal(historyItem?.items?.[0]?.label, 'OpenAI Docs')
  assert.equal(historyItem?.items?.[0]?.action, 'open-history-entry')
  assert.equal(model.items.some((item) => item.label === '打印'), true)
  assert.equal(model.items.some((item) => item.label === '外部浏览器打开'), true)
})
