import assert from 'node:assert/strict'
import test from 'node:test'
import { captureLegacyDrafts, LEGACY_HANDOFF_KEY, migrateLegacyDrafts, TAB_METADATA_KEY } from '../renderer/modules/document/drafts/migration'
import { createDraftFixture } from './helpers/ready-drafts-fixture'

// FX2: verified synchronous handoff owns all legacy sources before metadata can
// be written. Only verified Main readback consumes an item; retry is idempotent.
test('handoff preserves raw metadata and v1 bodies, including overlapping and orphan drafts', async () => {
  const f = createDraftFixture()
  const raw = JSON.stringify({ version: 3, state: { tabs: [
    { id: 'a', path: '/vault/a.md', title: 'A', content: 'embedded\r\n正文', isDirty: true },
    { id: 'b', path: null, title: 'B', content: 'older', isDirty: true },
  ], activeTabId: 'a', splitRatio: 63 } })
  f.storage.setItem(TAB_METADATA_KEY, raw)
  f.storage.setItem('ready-doc-tab-draft-v1:b', '')
  f.storage.setItem('ready-doc-tab-draft-v1:orphan%20id', 'orphan body')
  captureLegacyDrafts(f.storage)
  const handoff = f.storage.getItem(LEGACY_HANDOFF_KEY)!
  assert.deepEqual(JSON.parse(handoff), { version: 1, metadata: raw, drafts: {
    'ready-doc-tab-draft-v1:b': '', 'ready-doc-tab-draft-v1:orphan%20id': 'orphan body',
  } })
  captureLegacyDrafts(f.storage)
  assert.equal(f.storage.getItem(LEGACY_HANDOFF_KEY), handoff)
  const metadata = f.storage.getItem(TAB_METADATA_KEY)
  await migrateLegacyDrafts(f.storage, f.api)
  assert.equal(f.storage.getItem(TAB_METADATA_KEY), metadata, 'async migration must never write tab state')
  assert.equal(f.storage.getItem(LEGACY_HANDOFF_KEY), null)
  assert.deepEqual([...f.drafts.values()].map(d => [d.tabId, d.content]).sort(), [
    ['a', 'embedded\r\n正文'], ['b', ''], ['orphan id', 'orphan body'],
  ])
  captureLegacyDrafts(f.storage)
  await migrateLegacyDrafts(f.storage, f.api)
  assert.equal(f.storage.getItem(LEGACY_HANDOFF_KEY), null)
  assert.equal(f.drafts.size, 3)
})

test('failed handoff write or readback leaves every original source untouched', () => {
  for (const failure of ['throw', 'mismatch']) {
    const f = createDraftFixture()
    const raw = '{"version":3,"state":{"tabs":[{"id":"a","content":"body"}]}}'
    f.storage.setItem(TAB_METADATA_KEY, raw)
    f.storage.setItem('ready-doc-tab-draft-v1:b', 'other')
    const set = f.storage.setItem
    f.storage.setItem = (key, value) => {
      if (key !== LEGACY_HANDOFF_KEY) return set(key, value)
      if (failure === 'throw') throw new Error('quota')
    }
    assert.throws(() => captureLegacyDrafts(f.storage))
    assert.equal(f.storage.getItem(TAB_METADATA_KEY), raw)
    assert.equal(f.storage.getItem('ready-doc-tab-draft-v1:b'), 'other')
  }
})

test('restart after Main committed but its reply was interrupted consumes only verified items', async () => {
  const f = createDraftFixture()
  f.storage.setItem('ready-doc-tab-draft-v1:a', 'first')
  f.storage.setItem('ready-doc-tab-draft-v1:b', 'second')
  captureLegacyDrafts(f.storage)
  const importLegacy = f.api.importLegacy
  f.api.importLegacy = async items => {
    const result = await importLegacy(items)
    if (items[0].tabId === 'b') throw new Error('renderer terminated before reply')
    return result
  }
  await assert.rejects(migrateLegacyDrafts(f.storage, f.api), /terminated/)
  assert.equal(f.drafts.size, 2)
  const pending = f.storage.getItem(LEGACY_HANDOFF_KEY)!
  assert.deepEqual(JSON.parse(pending).drafts, { 'ready-doc-tab-draft-v1:b': 'second' })
  f.storage.setItem(TAB_METADATA_KEY, JSON.stringify({ version: 5, state: { tabs: [] } }))
  captureLegacyDrafts(f.storage)
  assert.equal(f.storage.getItem(LEGACY_HANDOFF_KEY), pending)
  f.api.importLegacy = importLegacy
  await migrateLegacyDrafts(f.storage, f.api)
  assert.equal(f.storage.getItem(LEGACY_HANDOFF_KEY), null)
  assert.equal(f.drafts.size, 2)
})
