import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMigrations } from '../main/modules/migrations'
import { ObjectRegistry } from '../main/modules/object-service/registry'
import { SearchEngine } from '../main/modules/search-engine/indexer'
import { DocumentDraftService } from '../main/modules/document-drafts/service'
import { documentVersion } from '../main/modules/document-engine/document-write-service'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ready-c12-')))
  const root = join(directory, 'vault'); mkdirSync(root)
  const databasePath = join(directory, 'ready.db')
  const open = () => {
    const db = new Database(databasePath); runMigrations(db)
    const registry = new ObjectRegistry(db)
    const engine = new SearchEngine(db, { fts5Available: true })
    engine.getRepository().ensureWorkspace(root)
    const dependencies = { registry, index: async (vaultRoot: string, path: string) => {
      const result = await engine.indexDocument(vaultRoot, path)
      if (!result.ok) throw new Error(result.error ?? 'index failed')
    } }
    return { db, registry, dependencies, service: new DocumentDraftService(db, dependencies),
      close: () => { engine.cancelPendingWorkspaceResolves(); db.close() } }
  }
  return { root, open, cleanup: () => rmSync(directory, { recursive: true, force: true }) }
}

test('C12 restart preserves acknowledged content and rejects late saves and stale discard', (t) => {
  if (skipIfSqliteUnavailable(t, 'Draft hierarchy')) return
  const f = fixture(); let session = f.open()
  try {
    const initial = session.service.create({ tabId: randomUUID(), vaultRoot: f.root, origin: 'new', content: '' })
    assert.equal(initial.contentHash, documentVersion(''))
    const saved = session.service.save(initial.draftId, initial.revision, 'new body', session.service.read(initial.draftId)!.tabId!)
    assert.throws(() => session.service.save(initial.draftId, initial.revision, 'late old body', session.service.read(initial.draftId)!.tabId!), /revision/)
    session.close(); session = f.open()
    assert.equal(session.service.read(initial.draftId)?.content, 'new body')
    assert.equal(session.service.read(initial.draftId)?.revision, saved.revision)
    assert.equal(session.service.list(f.root).length, 1)
    assert.throws(() => session.service.discard(initial.draftId, initial.revision), /revision/)
    session.service.discard(initial.draftId, saved.revision)
    assert.equal(session.service.list(f.root).length, 0)
    assert.equal(session.service.read(initial.draftId)?.state, 'discarded')
    assert.equal(session.service.read('absent'), null)
  } finally { session.close(); f.cleanup() }
})

test('C12 finalize leaves parent bytes intact, registers and indexes once, never overwrites', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Draft hierarchy')) return
  const f = fixture(); let s = f.open()
  try {
    const parent = join(f.root, 'A.md'); writeFileSync(parent, '\uFEFF# Parent\r\n')
    const bytes = readFileSync(parent); const parentId = s.registry.register(parent).id
    const d = s.service.create({ tabId: randomUUID(), vaultRoot: f.root, origin: 'new', content: 'child' })
    const input = { parentObjectId: parentId, title: 'child', operationId: 'op-child' }
    const [receipt, duplicate] = await Promise.all([
      s.service.finalize(d.draftId, d.revision, input), s.service.finalize(d.draftId, d.revision, input),
    ])
    assert.deepEqual(duplicate, receipt)
    assert.deepEqual(readFileSync(parent), bytes)
    assert.equal(receipt.path, join(f.root, 'A', 'child.md'))
    assert.equal(readFileSync(receipt.path, 'utf8'), 'child')
    assert.equal(receipt.contentHash, documentVersion('child'))
    assert.equal(receipt.parentObjectId, parentId)
    assert.equal(s.registry.get(receipt.objectId)?.current_path, receipt.path)
    assert.ok(s.db.prepare('SELECT id FROM documents WHERE object_id=?').get(receipt.objectId))
    s.close(); s = f.open()
    assert.deepEqual(await s.service.finalize(d.draftId, d.revision, input), receipt)
    await assert.rejects(s.service.finalize(d.draftId, d.revision, { ...input, title: 'different' }), /operation/)
    const other = s.service.create({ tabId: randomUUID(), vaultRoot: f.root, origin: 'new', content: 'do not overwrite' })
    await assert.rejects(s.service.finalize(other.draftId, other.revision, { ...input, operationId: 'other' }), (error: unknown) => {
      assert.ok(error instanceof Error && 'candidateNames' in error)
      assert.deepEqual(error.candidateNames, ['child (2)']); return true
    })
    assert.equal(readFileSync(receipt.path, 'utf8'), 'child')
    assert.equal(s.service.read(other.draftId)?.state, 'editing')
    assert.deepEqual(readdirSync(join(f.root, 'A')), ['child.md'])
  } finally { s.close(); f.cleanup() }
})

test('C12 failed publication and failed index survive restart and resume the same intent', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Draft hierarchy')) return
  const f = fixture(); let s = f.open()
  try {
    const d = s.service.create({ tabId: randomUUID(), vaultRoot: f.root, origin: 'new', content: 'recover me' })
    const input = { parentPath: f.root, title: 'recover', operationId: 'recover-op' }
    const fail = new DocumentDraftService(s.db, { ...s.dependencies, beforePublish: () => { throw new Error('injected before publish') } })
    await assert.rejects(fail.finalize(d.draftId, d.revision, input), /injected/)
    assert.equal(fail.list(f.root)[0].content, 'recover me')
    s.close(); s = f.open()
    const failIndex = new DocumentDraftService(s.db, { ...s.dependencies, index: async () => { throw new Error('injected index') } })
    await assert.rejects(failIndex.finalize(d.draftId, d.revision, input), /injected index/)
    assert.equal(readFileSync(join(f.root, 'recover.md'), 'utf8'), 'recover me')
    s.close(); s = f.open()
    const result = await s.service.finalize(d.draftId, d.revision, input)
    assert.equal(result.path, join(f.root, 'recover.md'))
    assert.deepEqual(readdirSync(f.root).filter(p => p.endsWith('.md')), ['recover.md'])
  } finally { s.close(); f.cleanup() }
})

test('C12 changed document base keeps both disk and latest buffer and blocks finalize', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Draft hierarchy')) return
  const f = fixture(); const s = f.open()
  try {
    const path = join(f.root, 'source.md'); writeFileSync(path, 'base')
    const objectId = s.registry.register(path).id
    const create = () => s.service.create({ tabId: randomUUID(), vaultRoot: f.root, origin: 'document', objectId, baseVersion: documentVersion('base'), content: 'buffer' })
    const d = create(); const second = create()
    writeFileSync(path, 'external edit')
    assert.throws(() => s.service.save(d.draftId, d.revision, 'latest buffer', s.service.read(d.draftId)!.tabId!), /base version/)
    assert.equal(s.service.read(d.draftId)?.state, 'conflict')
    assert.equal(s.service.read(d.draftId)?.content, 'latest buffer')
    assert.equal(readFileSync(path, 'utf8'), 'external edit')
    await assert.rejects(s.service.finalize(second.draftId, second.revision, { parentPath: f.root, title: 'copy', operationId: 'conflict-op' }), /base version/)
    assert.equal(s.service.read(second.draftId)?.state, 'conflict')
    assert.equal(s.service.list(f.root).length, 2)
  } finally { s.close(); f.cleanup() }
})

test('C12 legacy import receipts are idempotent even after edits, with empty content preserved', (t) => {
  if (skipIfSqliteUnavailable(t, 'Draft hierarchy')) return
  const f = fixture(); const s = f.open()
  try {
    const items = [{ tabId: 'legacy-tab', migrationKey: 'old-tab', contentHash: documentVersion(''), content: '', title: 'empty' }]
    const first = s.service.importLegacy(f.root, items)
    assert.deepEqual(s.service.importLegacy(f.root, items), first)
    assert.equal(s.service.read(first[0].draftId)?.content, '')
    s.service.save(first[0].draftId, first[0].revision, 'edited after import', 'legacy-tab')
    assert.deepEqual(s.service.importLegacy(f.root, items), first)
    assert.equal(s.service.list(f.root).length, 1)
    assert.throws(() => s.service.importLegacy(f.root, [{ ...items[0], content: 'wrong hash' }]), /hash/)
    assert.throws(() => s.service.importLegacy(f.root, [{ ...items[0], content: 'different', contentHash: documentVersion('different') }]), /migration/)
    assert.equal(s.service.read(first[0].draftId)?.content, 'edited after import')
  } finally { s.close(); f.cleanup() }
})

test('C12 filenames preserve display titles and reject traversal, symlink escapes and late collisions', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Draft hierarchy')) return
  const f = fixture(); const s = f.open()
  try {
    const make = () => s.service.create({ tabId: randomUUID(), vaultRoot: f.root, origin: 'new', content: 'body' })
    const d = make()
    const result = await s.service.finalize(d.draftId, d.revision, { parentPath: f.root, title: 'CON:', operationId: 'safe' })
    assert.match(readFileSync(result.path, 'utf8'), /title:.*CON:/)
    assert.notEqual(result.path, join(f.root, 'CON:.md'))
    for (const title of ['../escape', 'a/b', 'a\\b']) {
      const draft = make()
      await assert.rejects(s.service.finalize(draft.draftId, draft.revision, { parentPath: f.root, title, operationId: title }), /title/)
    }
    symlinkSync(tmpdir(), join(f.root, 'outside'))
    const draft = make()
    await assert.rejects(s.service.finalize(draft.draftId, draft.revision, { parentPath: join(f.root, 'outside'), title: 'escape', operationId: 'escape' }), /vault|symbolic/)
    const race = make()
    const racing = new DocumentDraftService(s.db, { ...s.dependencies, beforePublish: () => writeFileSync(join(f.root, 'race.md'), 'someone else') })
    await assert.rejects(racing.finalize(race.draftId, race.revision, { parentPath: f.root, title: 'race', operationId: 'race' }), /exist|collision/)
    assert.equal(readFileSync(join(f.root, 'race.md'), 'utf8'), 'someone else')
    assert.equal(racing.read(race.draftId)?.content, 'body')
  } finally { s.close(); f.cleanup() }
})

test('C12 attachments are hash checked and read back; changed sources cannot publish a document', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Draft hierarchy')) return
  const f = fixture(); const s = f.open()
  try {
    const source = join(f.root, 'image.bin'); const bytes = Buffer.from([0, 1, 255, 42]); writeFileSync(source, bytes)
    const { hashBytes } = await import('../main/modules/document-drafts/files')
    const create = () => s.service.create({ tabId: randomUUID(), vaultRoot: f.root, origin: 'new', content: '![x](child.assets/image.bin)',
      attachments: [{ sourcePath: source, name: 'image.bin', contentHash: hashBytes(bytes) }] })
    const d = create()
    const result = await s.service.finalize(d.draftId, d.revision, { parentPath: f.root, title: 'child', operationId: 'assets' })
    assert.deepEqual(readFileSync(join(f.root, 'child.assets', 'image.bin')), bytes)
    assert.equal(readFileSync(result.path, 'utf8'), '![x](child.assets/image.bin)')
    const changed = create(); writeFileSync(source, 'changed')
    await assert.rejects(s.service.finalize(changed.draftId, changed.revision, { parentPath: f.root, title: 'changed', operationId: 'changed-assets' }), /hash/)
    assert.equal(s.service.read(changed.draftId)?.state, 'editing')
    assert.ok(!readdirSync(f.root).includes('changed.md'))
  } finally { s.close(); f.cleanup() }
})

test('C12 failed database writes cannot acknowledge content; legacy missing paths remain recoverable', (t) => {
  if (skipIfSqliteUnavailable(t, 'Draft hierarchy')) return
  const f = fixture(); const s = f.open()
  try {
    const d = s.service.create({ tabId: randomUUID(), vaultRoot: f.root, origin: 'new', content: 'confirmed' })
    s.db.exec("CREATE TRIGGER fail_draft_save BEFORE UPDATE OF content ON document_drafts BEGIN SELECT RAISE(ABORT,'injected database failure'); END")
    assert.throws(() => s.service.save(d.draftId, d.revision, 'not confirmed', s.service.read(d.draftId)!.tabId!), /injected database/)
    assert.equal(s.service.read(d.draftId)?.content, 'confirmed')
    assert.equal(s.service.read(d.draftId)?.revision, d.revision)
    s.db.exec('DROP TRIGGER fail_draft_save')
    const [imported] = s.service.importLegacy(f.root, [{ tabId: 'legacy-tab', migrationKey: 'missing', content: 'saved buffer', contentHash: documentVersion('saved buffer'), path: join(f.root, 'missing.md') }])
    assert.equal(s.service.read(imported.draftId)?.content, 'saved buffer')
    assert.equal(s.service.read(imported.draftId)?.state, 'conflict')
  } finally { s.close(); f.cleanup() }
})

test('C12 registered IPC validates inputs, scopes drafts to the current vault and retains structured errors', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Draft hierarchy')) return
  const f = fixture(); const s = f.open()
  try {
    const { registerDocumentDraftIPC } = await import('../main/modules/document-drafts/ipc')
    const handlers = new Map<string, (_event: unknown, ...args: unknown[]) => unknown>()
    registerDocumentDraftIPC({ handle: (channel, handler) => { handlers.set(channel, handler) } }, s.service,
      () => ({ status: 'ready', root: f.root, defaultSuggestion: f.root }))
    const invoke = async (channel: string, ...args: unknown[]) => {
      const handler = handlers.get(channel); assert.ok(handler)
      return await handler({}, ...args) as import('../shared/document-drafts').DraftResult<unknown>
    }
    const invalid = await invoke('documentDrafts:create', { vaultRoot: f.root, origin: 'document', content: '' })
    assert.equal(invalid.ok, false)
    const d = s.service.create({ tabId: randomUUID(), vaultRoot: f.root, origin: 'new', content: '' })
    assert.deepEqual(await invoke('documentDrafts:save', d.draftId, d.revision, 'saved', s.service.read(d.draftId)!.tabId!), {
      ok: true, value: { draftId: d.draftId, revision: d.revision + 1, contentHash: documentVersion('saved') },
    })
    assert.partialDeepStrictEqual(await invoke('documentDrafts:save', d.draftId, d.revision, 'stale', s.service.read(d.draftId)!.tabId!), { ok: false, code: 'revision_conflict' })
    const other = join(f.root, 'another-vault'); mkdirSync(other)
    const outside = s.service.create({ tabId: randomUUID(), vaultRoot: other, origin: 'new', content: 'private' })
    assert.partialDeepStrictEqual(await invoke('documentDrafts:read', outside.draftId), { ok: false, code: 'wrong_vault' })
  } finally { s.close(); f.cleanup() }
})

test('C12 finalizing freezes its snapshot and saving a document as a new file does not copy its identity', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Draft hierarchy')) return
  const f = fixture(); const s = f.open()
  try {
    const path = join(f.root, 'source.md')
    const original = '---\nready_id: source-id\ntitle: Source\n---\nbody'
    writeFileSync(path, original)
    const source = s.registry.register(path)
    const draft = s.service.create({ tabId: randomUUID(), vaultRoot: f.root, origin: 'document', objectId: source.id,
      baseVersion: documentVersion(original), content: original })
    const service = new DocumentDraftService(s.db, { ...s.dependencies, beforePublish: () => {
      assert.throws(() => service.save(draft.draftId, draft.revision, 'late buffer', service.read(draft.draftId)!.tabId!), /not editable/)
      assert.throws(() => service.discard(draft.draftId, draft.revision), /cannot be discarded/)
    } })
    const result = await service.finalize(draft.draftId, draft.revision, { parentPath: f.root, title: 'copy', operationId: 'copy' })
    assert.notEqual(result.objectId, source.id)
    assert.equal(readFileSync(path, 'utf8'), original)
    assert.equal(readFileSync(result.path, 'utf8'), '---\ntitle: Source\n---\nbody')
    assert.equal(service.read(draft.draftId)?.content, original)
  } finally { s.close(); f.cleanup() }
})
