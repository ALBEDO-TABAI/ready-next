import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { readRendererStyles } from './utils/read-renderer-styles'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('document and rss first-row typography matches the browser tab baseline', () => {
  const browserTabRail = readWorkspaceFile('src/renderer/components/browser/TabRail.tsx')
  const documentTabRail = readWorkspaceFile('src/renderer/components/document/DocumentTabRail.tsx')
  const rssFeed = readWorkspaceFile('src/renderer/components/rss/RSSFeed.tsx')

  assert.match(browserTabRail, /text-\[12px\]/)

  assert.match(documentTabRail, /text-\[12px\]/)

  // RSS's first row is its panel head row's location label, sized like the tab labels (12px, --rn-t-meta).
  assert.match(rssFeed, /<RSSTopbarTools/)
  assert.match(readRendererStyles(), /\.rss-topbar__lead \{[^}]*font-size: var\(--rn-t-meta\);/)

})
