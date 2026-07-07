import assert from 'node:assert/strict'
import test from 'node:test'

import { buildOverlaySnapshotTabs } from '../renderer/components/browser/vertical-rail-overlay-snapshot'
import type { BrowserTab } from '../renderer/stores/useBrowserTabs'

function tab(id: string, extra: Partial<BrowserTab> = {}): BrowserTab {
  return {
    id,
    url: `https://${id}.example.com/`,
    title: id.toUpperCase(),
    loading: false,
    canGoBack: false,
    canGoForward: false,
    ...extra,
  }
}

// D-SNAPSHOT: the snapshot tabs are the RAW FLAT order — the overlay does its own
// run-local hoist and resolves toRank against this array, so a pre-hoist here would put
// reorder ranks in display space.
test('emits tabs in raw flat order — no global pair hoist', () => {
  const tabs = [tab('a'), tab('b'), tab('c'), tab('d')]
  // Active is C, split is A: a global pair-hoist would move A to just after C.
  const out = buildOverlaySnapshotTabs(tabs, 'c', 'a', [])
  assert.deepEqual(out.map((t) => t.id), ['a', 'b', 'c', 'd'])
})

test('flags the split tab and marks both active + split as active', () => {
  const out = buildOverlaySnapshotTabs([tab('a'), tab('b'), tab('c')], 'a', 'c', [])
  const byId = new Map(out.map((t) => [t.id, t]))
  assert.equal(byId.get('a')?.active, true)
  assert.equal(byId.get('a')?.split, false)
  assert.equal(byId.get('c')?.active, true) // split renders highlighted too
  assert.equal(byId.get('c')?.split, true)
  assert.equal(byId.get('b')?.active, false)
  assert.equal(byId.get('b')?.split, false)
})

test('passes groupId through and defaults absent groupId to null', () => {
  const tabs = [tab('a', { groupId: 'grp-1' }), tab('b')]
  const out = buildOverlaySnapshotTabs(tabs, 'a', null, [])
  const byId = new Map(out.map((t) => [t.id, t]))
  assert.equal(byId.get('a')?.groupId, 'grp-1')
  assert.equal(byId.get('b')?.groupId, null)
})

test('marks bookmarked tabs by url', () => {
  const tabs = [tab('a'), tab('b')]
  const out = buildOverlaySnapshotTabs(tabs, 'a', null, ['https://b.example.com/'])
  const byId = new Map(out.map((t) => [t.id, t]))
  assert.equal(byId.get('a')?.bookmarked, false)
  assert.equal(byId.get('b')?.bookmarked, true)
})

test('a tab that is BOTH active and split id is treated as active-only (no self-split)', () => {
  const out = buildOverlaySnapshotTabs([tab('a')], 'a', 'a', [])
  assert.equal(out[0].active, true)
  assert.equal(out[0].split, false)
})
