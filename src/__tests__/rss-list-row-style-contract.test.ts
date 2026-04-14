import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('rss feed rows no longer rely on divider lines or per-row borders between items', () => {
  const rssFeed = readWorkspaceFile('src/renderer/components/rss/RSSFeed.tsx')

  assert.match(rssFeed, /className="rss-feed-list rss-feed-scroll flex-1 overflow-auto transition-all duration-300"/)
  assert.doesNotMatch(rssFeed, /divide-y divide-\[var\(--border-default\)\]/)
  assert.doesNotMatch(rssFeed, /rounded-\[14px\] border/)
  assert.doesNotMatch(rssFeed, /borderColor:\s*isSelected/)
})
