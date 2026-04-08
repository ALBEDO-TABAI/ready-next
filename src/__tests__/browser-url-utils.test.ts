import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_BROWSER_URL,
  SEARCH_URL,
  extractBrowserDomain,
  isSupportedBrowserNavigationUrl,
  isLikelyAbsolutePath,
  normalizeBrowserUrlInput,
} from '../renderer/modules/browser/url-utils'

test('extractBrowserDomain handles regular urls and invalid input safely', () => {
  assert.equal(extractBrowserDomain('https://sub.example.com/path'), 'example.com')
  assert.equal(extractBrowserDomain('not-a-url'), '')
})

test('isLikelyAbsolutePath detects unix windows and UNC paths', () => {
  assert.equal(isLikelyAbsolutePath('/Users/demo/file.txt'), true)
  assert.equal(isLikelyAbsolutePath('C:\\\\demo\\\\file.txt'), true)
  assert.equal(isLikelyAbsolutePath('\\\\server\\share\\file.txt'), true)
  assert.equal(isLikelyAbsolutePath('example.com'), false)
})

test('normalizeBrowserUrlInput preserves urls, maps paths, and falls back to search/default', () => {
  const toFileUrl = (path: string) => `file://${path}`

  assert.equal(normalizeBrowserUrlInput('', toFileUrl), DEFAULT_BROWSER_URL)
  assert.equal(normalizeBrowserUrlInput('https://openai.com', toFileUrl), 'https://openai.com')
  assert.equal(normalizeBrowserUrlInput('/tmp/demo.txt', toFileUrl), 'file:///tmp/demo.txt')
  assert.equal(normalizeBrowserUrlInput('example.com', toFileUrl), 'https://example.com')
  assert.equal(normalizeBrowserUrlInput('hello world', toFileUrl), `${SEARCH_URL}hello%20world`)
})

test('isSupportedBrowserNavigationUrl only allows web urls', () => {
  assert.equal(isSupportedBrowserNavigationUrl('https://openai.com'), true)
  assert.equal(isSupportedBrowserNavigationUrl('http://example.com'), true)
  assert.equal(isSupportedBrowserNavigationUrl('file:///tmp/demo.txt'), false)
  assert.equal(isSupportedBrowserNavigationUrl('local-file:///tmp/demo.txt'), false)
})
