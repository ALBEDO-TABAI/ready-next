import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DraftController } from '../renderer/modules/document/drafts/controller'
import { contentHash as contentHashForTest, captureLegacyDrafts, LEGACY_HANDOFF_KEY, migrateLegacyDrafts } from '../renderer/modules/document/drafts/migration'
import { createDraftFixture } from './helpers/ready-drafts-fixture'

// C12: confirmation belongs to the submitted snapshot; closing is not discarding.
test('typing is persisted, old acknowledgement cannot confirm new typing, close retains draft', async () => {
  const f = createDraftFixture()
  const controller = new DraftController(f.port)
  f.tabs[0].content = 'first'; f.tabs[0].isDirty = true
  controller.changed(f.tabs[0])
  const gate = f.holdCreate()
  const pending = controller.flush('tab')
  await gate.started
  f.tabs[0].content = 'second'; controller.changed(f.tabs[0])
  gate.release()
  await pending
  assert.equal(controller.status('tab')?.status, 'confirmed')
  await controller.flush('tab')
  assert.equal(controller.status('tab')?.status, 'confirmed')
  assert.equal(f.saved.at(-1), 'second')
  f.tabs = []
  await controller.flushAll()
  assert.equal(f.drafts.size, 1)
  assert.equal(f.discarded.length, 0)
})

test('saved snapshot cannot discard newer typing; a restarted controller restores it', async () => {
  const f = createDraftFixture()
  const controller = new DraftController(f.port)
  f.tabs[0].content = 'first'; f.tabs[0].isDirty = true; controller.changed(f.tabs[0])
  await controller.flush('tab')
  f.tabs[0].content = 'later'; controller.changed(f.tabs[0])
  await controller.saved('tab', 'first')
  await controller.flushAll()
  const activeId = f.tabs[0].draftId!
  assert.ok(!f.discarded.includes(activeId))
  assert.equal(f.drafts.get(activeId)?.content, 'later')
  const restarted = new DraftController(f.port)
  await restarted.restore()
  assert.equal(f.tabs[0].content, 'later')
  assert.equal(f.tabs[0].isDirty, true)
})

test('legacy migration keeps failed source, verifies readback and retries without duplicate drafts', async () => {
  const f = createDraftFixture()
  const storage = f.storage
  storage.setItem('ready-doc-tabs-v2', JSON.stringify({ version: 3, state: { tabs: [{ id: 'tab', path: null, content: '', isDirty: true }] } }))
  captureLegacyDrafts(storage)
  f.failImport = true
  await assert.rejects(migrateLegacyDrafts(storage, f.api))
  assert.equal(JSON.parse(JSON.parse(storage.getItem(LEGACY_HANDOFF_KEY)!).metadata).state.tabs[0].content, '')
  f.failImport = false
  await migrateLegacyDrafts(storage, f.api)
  await migrateLegacyDrafts(storage, f.api)
  assert.equal(f.drafts.size, 1)
  assert.equal([...f.drafts.values()][0].content, '')
  assert.equal(JSON.parse(storage.getItem('ready-doc-tabs-v2')!).state.tabs[0].content, undefined)
})

test('failed acknowledgement retains text and can be retried', async () => {
  const f = createDraftFixture(); const controller = new DraftController(f.port)
  f.tabs[0].content = 'retained'; f.tabs[0].isDirty = true; controller.changed(f.tabs[0])
  const create = f.api.create
  f.api.create = async () => ({ ok: false, code: 'disk_full', message: 'disk full' })
  await assert.rejects(controller.flush('tab'), /disk full/)
  assert.equal(controller.status('tab')?.status, 'failed')
  assert.equal(f.tabs[0].content, 'retained')
  f.api.create = create
  await controller.flush('tab')
  assert.equal(controller.status('tab')?.status, 'confirmed')
})

test('finalize retains newer input in a successor draft and binds the published object', async () => {
  const f = createDraftFixture(); const controller = new DraftController(f.port)
  f.tabs[0].content = 'published'; f.tabs[0].isDirty = true; controller.changed(f.tabs[0])
  await controller.flush('tab')
  const finalize = f.api.finalize
  let release!: () => void; let started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const signal = new Promise<void>(resolve => { started = resolve })
  f.api.finalize = async (...args) => { started(); await gate; return finalize(...args) }
  const pending = controller.finalize('tab', { parentPath: '/vault', title: 'Test', operationId: 'stable-id' })
  await signal
  f.tabs[0].content = 'later'; controller.changed(f.tabs[0])
  await new Promise(resolve => setTimeout(resolve, 350))
  assert.equal(controller.status('tab')?.status, 'pending', 'active finalization is not a failed persistence attempt')
  release()
  const receipt = await pending
  assert.equal(receipt.content, 'published')
  assert.equal(f.tabs[0].objectId, 'object')
  assert.equal(f.tabs[0].content, 'later')
  assert.equal(f.drafts.get(f.tabs[0].draftId!)?.content, 'later')
  assert.equal(controller.status('tab')?.status, 'confirmed')
})

test('migration mismatch never deletes legacy source and unrelated drafts survive an interrupted batch', async () => {
  const f = createDraftFixture()
  f.storage.setItem('ready-doc-tab-draft-v1:a', 'first')
  f.storage.setItem('ready-doc-tab-draft-v1:b', 'second')
  captureLegacyDrafts(f.storage)
  const read = f.api.read
  f.api.read = async id => {
    const result = await read(id)
    return result.ok && result.value?.content === 'second' ? { ok: true, value: { ...result.value, content: 'corrupt' } } : result
  }
  await assert.rejects(migrateLegacyDrafts(f.storage, f.api), /回读不一致/)
  assert.equal(JSON.parse(f.storage.getItem(LEGACY_HANDOFF_KEY)!).drafts['ready-doc-tab-draft-v1:a'], undefined)
  assert.equal(JSON.parse(f.storage.getItem(LEGACY_HANDOFF_KEY)!).drafts['ready-doc-tab-draft-v1:b'], 'second')
  f.api.read = read
  await migrateLegacyDrafts(f.storage, f.api)
  assert.equal(f.drafts.size, 2)
  assert.equal(f.storage.getItem('ready-doc-tab-draft-v1:b'), null)
})

test('continuous typing still receives periodic persistence, not only a quiet-window flush', async () => {
  const f = createDraftFixture(); const controller = new DraftController(f.port)
  f.tabs[0].isDirty = true
  for (let i = 0; i < 8; i++) {
    f.tabs[0].content = `input ${i}`; controller.changed(f.tabs[0])
    await new Promise(resolve => setTimeout(resolve, 60))
  }
  assert.ok(f.drafts.size > 0, 'first snapshot must already be durable while typing continues')
  await controller.flushAll()
  assert.equal(f.drafts.get(f.tabs[0].draftId!)?.content, 'input 7')
})

test('an earlier receipt from another tab arriving last cannot alter the active tab confirmation', async () => {
  const f = createDraftFixture(); const controller = new DraftController(f.port)
  const gate = f.holdCreate()
  f.tabs[0].content = 'slow'; f.tabs[0].isDirty = true; controller.changed(f.tabs[0])
  const slow = controller.flush('tab'); await gate.started
  f.tabs.push({ id: 'fast', path: null, title: 'Fast', content: 'fast', isDirty: true })
  controller.changed(f.tabs[1]); await controller.flush('fast')
  f.tabs[1].content = 'fast newer'; controller.changed(f.tabs[1])
  gate.release(); await slow
  assert.equal(controller.status('fast')?.status, 'pending')
  assert.equal(f.tabs[1].content, 'fast newer')
  await controller.flushAll()
  assert.equal(f.drafts.get(f.tabs[1].draftId!)?.content, 'fast newer')
})

test('clean default content never creates a draft', async () => {
  const f = createDraftFixture(); const controller = new DraftController(f.port)
  f.tabs[0].content = 'default welcome'; controller.changed(f.tabs[0])
  await controller.flushAll()
  assert.equal(f.drafts.size, 0)
})

test('overlapping flushes during create save the latest input to one monotonically revised draft', async () => {
  const f = createDraftFixture(); const controller = new DraftController(f.port)
  f.tabs[0].isDirty = true; f.tabs[0].content = 'one'; controller.changed(f.tabs[0])
  const gate = f.holdCreate(); const first = controller.flush('tab'); await gate.started
  f.tabs[0].content = 'two'; controller.changed(f.tabs[0]); const second = controller.flush('tab')
  f.tabs[0].content = 'three'; controller.changed(f.tabs[0]); gate.release()
  await Promise.all([first, second])
  assert.equal(f.drafts.size, 1)
  const draft = [...f.drafts.values()][0]
  assert.equal(draft.content, 'three'); assert.equal(draft.revision, 2)
  assert.equal(draft.tabId, 'tab'); assert.equal(controller.status('tab')?.status, 'confirmed')
})

test('Main tab identity restores the newest revision without local draftId and labels older duplicates', async () => {
  const f = createDraftFixture(); const controller = new DraftController(f.port)
  const older = await f.api.create({ tabId: 'tab', origin: 'new', vaultRoot: '/vault', content: 'old' })
  const newer = await f.api.create({ tabId: 'tab', origin: 'new', vaultRoot: '/vault', content: 'new' })
  assert.ok(older.ok && newer.ok)
  await f.api.save(newer.value.draftId, newer.value.revision, 'newest', 'tab')
  f.tabs[0].draftId = older.value.draftId
  await controller.restore()
  assert.equal(f.tabs[0].content, 'newest')
  assert.equal(controller.recoveryLabel(older.value.draftId), '同一标签的较早版本')
  assert.equal(f.drafts.size, 2)
  delete f.tabs[0].draftId; f.tabs[0].content = ''
  await new DraftController(f.port).restore()
  assert.equal(f.tabs[0].content, 'newest')
  f.tabs = []; const detached = new DraftController(f.port); await detached.restore()
  assert.equal(detached.recovery.length, 2)
  const latest = f.drafts.get(newer.value.draftId)!
  await f.api.discard(latest.draftId, latest.revision)
  const afterDiscard = new DraftController(f.port); await afterDiscard.restore()
  assert.equal(afterDiscard.recoveryLabel(older.value.draftId), '同一标签的较早版本')
})

test('overwrite uses the compared disk version, retains draft on conflict or bad readback, then discards after success', async () => {
  const f = createDraftFixture(); const controller = new DraftController(f.port)
  f.tabs[0].path = '/vault/Test.md'; f.tabs[0].content = 'mine'; f.tabs[0].isDirty = true
  controller.changed(f.tabs[0], 'old'); await controller.flushAll()
  const id = f.tabs[0].draftId!
  let disk = 'seen'; f.port.read = async () => disk
  const conflict = await controller.overwrite('tab', 'seen', async input => {
    assert.equal(input.expectedVersion, await contentHashForTest('seen'))
    disk = 'changed again'; return { ok: false, code: 'version_conflict', message: 'changed' }
  })
  assert.deepEqual(conflict, { status: 'conflict', disk: 'changed again' })
  assert.equal(f.discarded.length, 0)
  await assert.rejects(controller.overwrite('tab', disk, async () => ({ ok: true, value: {
    path: '/vault/Test.md', beforeVersion: '', afterVersion: await contentHashForTest('mine'), committedAt: 1,
  } })), /回读/)
  assert.equal(f.discarded.length, 0)
  const result = await controller.overwrite('tab', disk, async input => {
    disk = input.content
    return { ok: true, value: { path: input.path, beforeVersion: input.expectedVersion, afterVersion: await contentHashForTest(disk), committedAt: 1 } }
  })
  assert.deepEqual(result, { status: 'saved' })
  assert.deepEqual(f.discarded, [id]); assert.equal(f.tabs[0].isDirty, false)
})

test('reopening a closed draft transfers its single save owner to the recovery tab', async () => {
  const f = createDraftFixture(); const controller = new DraftController(f.port)
  f.tabs[0].content = 'retained'; f.tabs[0].isDirty = true; controller.changed(f.tabs[0])
  await controller.flushAll()
  const draft = controller.recovery[0]
  f.tabs = [{ id: 'reopened', path: null, title: 'Recovered', content: '', isDirty: false }]
  await controller.attach('reopened', draft)
  await controller.discard(draft.draftId)
  assert.equal(f.tabs[0].draftId, undefined)
  assert.equal(controller.status('tab'), undefined)
  assert.equal(controller.status('reopened'), undefined)
})
