import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { readRendererStyles } from '../utils/read-renderer-styles'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('rss feed rows no longer rely on divider lines or per-row borders between items', () => {
  const rssFeed = readWorkspaceFile('src/renderer/components/rss/RSSFeed.tsx')
  const styles = readRendererStyles()
  const card = styles.match(/\.rss-news-card \{[^}]*\}/)?.[0] || ''

  assert.match(rssFeed, /className="rss-feed-list"/)
  assert.match(rssFeed, /className=\{`rss-news-card rss-item-row/)
  assert.doesNotMatch(rssFeed, /divide-y divide-\[var\(--border-default\)\]/)
  assert.doesNotMatch(rssFeed, /rounded-\[14px\] border/)
  assert.doesNotMatch(rssFeed, /border: '1px solid var\(--border-default\)'/)
  assert.doesNotMatch(rssFeed, /borderColor:\s*isSelected/)
  // Selection is a raised fill, never an outline or an inset accent bar.
  assert.ok(card && !/\bborder\s*:/.test(card), 'rss card has no border')
  assert.match(styles, /\.rss-news-card\.is-selected \{\s*background: var\(--sx-raised-bg\);\s*box-shadow: var\(--sx-raised-shadow\);/)
  assert.doesNotMatch(rssFeed, /inset 2px 0 0 var\(--color-blue\)/)
})
