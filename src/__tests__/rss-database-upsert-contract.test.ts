import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: RSS database upsert wiring protects SQL call-site integration shape
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('rss item upsert overwrites stale item fields instead of silently ignoring them', () => {
  const database = readWorkspaceFile('src/main/modules/database/rss-store.ts')

  assert.match(database, /INSERT INTO rss_items[\s\S]*ON CONFLICT\(id\) DO UPDATE SET/)
  assert.match(database, /summary = excluded\.summary/)
  assert.match(database, /cover_image = excluded\.cover_image/)
  assert.match(database, /author = excluded\.author/)
  assert.match(database, /published_at = excluded\.published_at/)
  assert.match(database, /fetched_at = unixepoch\(\)/)
})
