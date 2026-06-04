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

test('history entries with placeholder titles fall back to a readable URL instead of showing "Loading…"/"New Tab"', () => {
  const model = buildBrowserUtilityMenuModel('more', createState({
    history: [
      { id: 'h1', title: 'Loading...', url: 'https://github.com/openai/codex', visited_at: 5 },
      { id: 'h2', title: 'New Tab', url: 'https://example.com/feed?page=2', visited_at: 4 },
      { id: 'h3', title: '加载中…', url: 'https://news.ycombinator.com/', visited_at: 3 },
      { id: 'h4', title: 'Real Title', url: 'https://real.example.com/post', visited_at: 2 },
    ],
  }))
  const historyItem = model.items.find((item) => item.label === '历史记录')
  const labels = (historyItem?.items ?? []).map((i) => i.label)

  // No placeholder strings leak into the menu.
  for (const bad of ['Loading...', 'New Tab', '加载中…']) {
    assert.equal(labels.includes(bad), false, `placeholder "${bad}" must not be shown`)
  }
  // Placeholder rows render their URL (host + path); real titles are kept.
  assert.equal(labels.includes('github.com/openai/codex'), true)
  assert.equal(labels.includes('example.com/feed?page=2'), true)
  assert.equal(labels.includes('news.ycombinator.com'), true)
  assert.equal(labels.includes('Real Title'), true)
})
