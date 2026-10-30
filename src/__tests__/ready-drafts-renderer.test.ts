import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DraftController } from '../renderer/modules/document/drafts/controller'
import { migrateLegacyDrafts } from '../renderer/modules/document/drafts/migration'
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
  assert.equal(controller.status('tab')?.status, 'pending')
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
  f.failImport = true
  await assert.rejects(migrateLegacyDrafts(storage, f.api))
  assert.equal(JSON.parse(storage.getItem('ready-doc-tabs-v2')!).state.tabs[0].content, '')
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
  const read = f.api.read
  f.api.read = async id => {
    const result = await read(id)
    return result.ok && result.value?.content === 'second' ? { ok: true, value: { ...result.value, content: 'corrupt' } } : result
  }
  await assert.rejects(migrateLegacyDrafts(f.storage, f.api), /回读不一致/)
  assert.equal(f.storage.getItem('ready-doc-tab-draft-v1:a'), null)
  assert.equal(f.storage.getItem('ready-doc-tab-draft-v1:b'), 'second')
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
