import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('rss feed and preview show optional author metadata between source and publish time', () => {
  const rssWarmLoader = readWorkspaceFile('src/renderer/modules/rss/rssWarmLoader.ts')
  const rssFeed = readWorkspaceFile('src/renderer/components/rss/RSSFeed.tsx')
  const previewBrowser = readWorkspaceFile('src/renderer/components/rss/PreviewBrowser.tsx')

  assert.match(rssWarmLoader, /author:\s*item\.author \?\? ''/)
  assert.match(rssFeed, /author:\s*string/)
  assert.match(rssFeed, /item\.author && item\.author !== item\.source/)
  assert.match(previewBrowser, /item\.author && item\.author !== item\.source/)
})
