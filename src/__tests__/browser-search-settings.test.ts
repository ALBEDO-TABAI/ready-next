import assert from 'node:assert/strict'
import test from 'node:test'
import { createGenericSettingIPCHandler } from '../main/modules/settings-engine/generic-setting-ipc-handler'
import { readBrowserSearchSettings, resolveSearchEngine, SEARCH_ENGINES, SEARCH_ENGINE_KEY, SEARCH_SUGGESTIONS_KEY } from '../shared/search-engines'
import { normalizeBrowserUrlInput } from '../renderer/modules/browser/url-utils'
import { getBrowserSearchSettings, initializeBrowserSearchSettings } from '../renderer/modules/browser/search-settings'

test('search setting uses existing write boundary, rejects malformed templates without writing or notifying', () => {
  const settings = new Map<string, string>(), notices: string[] = []
  const write = createGenericSettingIPCHandler({ repository: { setSetting: (key, value) => { settings.set(key, value) } }, onSettingChanged: key => { notices.push(key) } })
  assert.deepEqual(readBrowserSearchSettings(key => settings.get(key)), { searchEngine: 'google', searchSuggestions: false })
  for (const value of ['javascript:%s', 'file:///%s', 'https://search.test/no-template', 'unknown', 'https://user:pass@example.test/?q=%s']) {
    assert.equal(write(null, { key: SEARCH_ENGINE_KEY, value }).success, false)
  }
  assert.equal(write(null, { key: SEARCH_SUGGESTIONS_KEY, value: 'yes' }).success, false)
  assert.equal(settings.size, 0)
  assert.deepEqual(notices, [])
  for (const value of [...Object.keys(SEARCH_ENGINES), 'https://search.test/?q=%s']) {
    assert.equal(write(null, { key: SEARCH_ENGINE_KEY, value }).success, true)
    assert.ok(resolveSearchEngine(settings.get(SEARCH_ENGINE_KEY)).search.includes('%s'))
    assert.equal(normalizeBrowserUrlInput('中文 & query', () => '', value), resolveSearchEngine(value).search.replace('%s', encodeURIComponent('中文 & query')))
  }
  assert.equal(write(null, { key: SEARCH_SUGGESTIONS_KEY, value: 'true' }).success, true)
  assert.equal(readBrowserSearchSettings(key => settings.get(key)).searchSuggestions, true)
})

test('renderer loads once and observes saves; initial read cannot overwrite a newer setting', async () => {
  let handler: ((data: { key: string; value: string }) => void) | undefined
  let reads = 0, removed = 0
  let resolve!: (value: { success: boolean; data: Record<string, string> }) => void
  const pending = new Promise<{ success: boolean; data: Record<string, string> }>(done => { resolve = done })
  const initialized = initializeBrowserSearchSettings({
    settings: { getAll: () => { reads++; return pending } },
    browser: { onSearchSettingsChanged: callback => { handler = callback; return () => { removed++ } } },
  })
  handler!({ key: SEARCH_ENGINE_KEY, value: 'bing' })
  resolve({ success: true, data: { [SEARCH_ENGINE_KEY]: 'google' } })
  const unsubscribe = await initialized
  assert.equal(reads, 1)
  assert.equal(normalizeBrowserUrlInput('find me', () => ''), 'https://www.bing.com/search?q=find%20me')
  handler!({ key: SEARCH_ENGINE_KEY, value: 'https://mine.test/?term=%s' })
  assert.equal(normalizeBrowserUrlInput('a b', () => ''), 'https://mine.test/?term=a%20b')
  assert.equal(normalizeBrowserUrlInput('https://example.test/', () => ''), 'https://example.test/')
  assert.equal(getBrowserSearchSettings().searchSuggestions, false)
  unsubscribe()
  assert.equal(removed, 1)
})
