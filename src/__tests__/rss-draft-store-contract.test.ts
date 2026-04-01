import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('rss draft store schema and helpers support inbox visibility plus source reset state', () => {
  const migrations = readWorkspaceFile('src/main/modules/migrations.ts')
  const database = readWorkspaceFile('src/main/modules/database.ts')
  const repository = readWorkspaceFile('src/main/modules/repositories/rss-repository.ts')

  assert.match(migrations, /inbox_visible INTEGER DEFAULT 1/)
  assert.match(migrations, /draft_seeded INTEGER DEFAULT 0/)
  assert.match(database, /dismissRSSItemsFromInbox/)
  assert.match(database, /clearRSSDraftStore/)
  assert.match(database, /getRSSDraftStoreSources/)
  assert.match(database, /WHERE(?:[\s\S])*inbox_visible = 1(?:[\s\S])*OR(?:[\s\S])*starred = 1/)
  assert.match(repository, /dismissRSSItemsFromInbox/)
  assert.match(repository, /clearRSSDraftStore/)
  assert.match(repository, /getRSSDraftStoreSources/)
})
