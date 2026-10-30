import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMigrations, __getMigrationNamesForTests, __runMigrationForTests } from '../main/modules/migrations'
import { DocumentDraftService } from '../main/modules/document-drafts/service'
import { ObjectRegistry } from '../main/modules/object-service/registry'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('tab migration preserves unbound old drafts; tab query survives reopen and orders by revision', t => {
  if (skipIfSqliteUnavailable(t, 'Draft tab identity')) return
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ready-draft-tab-')))
  let db = new Database(join(directory, 'ready.db'))
  try {
    const names = __getMigrationNamesForTests()
    const migration = names.find(name => name.endsWith('_document_draft_tabs'))!
    assert.ok(migration)
    for (const name of names.slice(0, names.indexOf(migration))) __runMigrationForTests(name, db)
    db.prepare(`INSERT INTO document_drafts (draft_id,vault_root,revision,content,content_hash,origin,attachments_json,title,state,created_at,updated_at)
      VALUES ('legacy',?,1,'old',?,'new','[]','','editing',0,0)`).run(directory, '0'.repeat(64))
    __runMigrationForTests(migration, db)
    let service = new DocumentDraftService(db, { registry: new ObjectRegistry(db), index: async () => {} })
    assert.equal(service.read('legacy')?.tabId, null)
    assert.equal(service.read('legacy')?.content, 'old')
    const a = service.create({ tabId: 'tab', vaultRoot: directory, origin: 'new', content: 'a' })
    const b = service.create({ tabId: 'tab', vaultRoot: directory, origin: 'new', content: 'b' })
    const saved = service.save(a.draftId, a.revision, 'latest', 'tab')
    assert.ok(saved.revision > b.revision)
    assert.throws(() => service.save(a.draftId, saved.revision, 'bad', ''), /./)
    db.close(); db = new Database(join(directory, 'ready.db'))
    service = new DocumentDraftService(db, { registry: new ObjectRegistry(db), index: async () => {} })
    assert.equal(service.list(directory, 'tab')[0].content, 'latest')
    assert.equal(service.list(directory, 'tab').length, 2)
    assert.equal(service.list(directory, 'other').length, 0)
    assert.equal(service.list(directory).length, 3)
    service.discard(a.draftId, saved.revision)
    assert.equal(service.list(directory, 'tab')[0].state, 'discarded', 'an older duplicate must not revive after saving/discarding the latest')
    assert.equal(service.list(directory).length, 2)
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('fresh migration chain can be applied twice with tab identity intact', t => {
  if (skipIfSqliteUnavailable(t, 'Draft tab fresh migration')) return
  const db = new Database(':memory:')
  try {
    runMigrations(db); runMigrations(db)
    assert.ok(db.prepare('PRAGMA table_info(document_drafts)').all<{ name: string }>().some(row => row.name === 'tab_id'))
  } finally { db.close() }
})
