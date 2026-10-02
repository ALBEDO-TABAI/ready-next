import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: RSS metadata persistence wiring is a source-surface contract
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('rss feed keeps optional author metadata between source and publish time', () => {
  const queryMapping = readWorkspaceFile('src/renderer/modules/rss/workspace-query.ts')
  const rssFeed = readWorkspaceFile('src/renderer/components/rss/RSSFeed.tsx')

  assert.match(queryMapping, /author: item\.author \|\| ''/)
  assert.match(rssFeed, /author:\s*string/)
  assert.match(rssFeed, /item\.author && item\.author !== item\.source/)
})
