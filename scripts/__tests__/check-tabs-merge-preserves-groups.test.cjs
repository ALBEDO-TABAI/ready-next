'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const { check } = require('../check-tabs-merge-preserves-groups.cjs')

function writeFixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'ready-merge-groups-gate-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  return root
}

const STORE = 'src/renderer/stores/useBrowserTabs.ts'
const ACTIONS = 'src/renderer/modules/browser/useBrowserTabActions.ts'
const EFFECTS = 'src/renderer/modules/browser/useBrowserRuntimeEffects.ts'

const GOOD_STORE = `
export function mergeBackendTabsPreservingGroups(localTabs, backendTabs) {
  const merged = []
  for (const local of localTabs) {
    const backend = backendTabs.find((t) => t.id === local.id)
    merged.push({ ...backend, groupId: local.groupId ?? null })
  }
  return merged
}
`
const GOOD_ACTIONS = `
setTabs(mergeBackendTabsPreservingGroups(useBrowserTabs.getState().tabs, hydratedTabs))
`
const GOOD_EFFECTS = `
const recoveredTab = { ...tab, id: result.tabId }
store.setTabs(recoveredTabs)
store.setTabs(mergeBackendTabsPreservingGroups(store.tabs, hydratedTabs))
`

test('merge-preserves-groups gate passes the current workspace', () => {
  assert.equal(check().ok, true, check().errors.join('\n'))
})

test('gate passes a synthetic all-correct fixture (two merged reconcile paths)', () => {
  const root = writeFixture({ [STORE]: GOOD_STORE, [ACTIONS]: GOOD_ACTIONS, [EFFECTS]: GOOD_EFFECTS })
  assert.equal(check({ root }).ok, true, check({ root }).errors.join('\n'))
})

test('gate rejects the fully-broken reconcile (no merge helper, raw setTabs at both id paths)', () => {
  const root = writeFixture({
    [STORE]: 'const nothing = 1',
    [ACTIONS]: 'setTabs(hydratedTabs)',
    [EFFECTS]: 'const recoveredTab = { id: result.tabId }\nstore.setTabs(recoveredTabs)\nstore.setTabs(hydratedTabs)',
  })
  const { ok, errors } = check({ root })
  assert.equal(ok, false)
  assert.ok(errors.includes('merge_helper_missing_or_not_exported'))
  assert.ok(errors.includes('merge_helper_does_not_preserve_local_groupId'))
  assert.ok(errors.includes('rebuild_does_not_preserve_groupid_via_spread'))
  assert.ok(errors.some((e) => e.startsWith('unclassified_setTabs_call_site:')))
  assert.ok(errors.includes('fewer_than_two_merged_reconcile_paths'))
})

test('gate catches a lone revert of one id-matching path to raw setTabs', () => {
  const root = writeFixture({
    [STORE]: GOOD_STORE,
    [ACTIONS]: 'setTabs(hydratedTabs)', // reverted
    [EFFECTS]: GOOD_EFFECTS,
  })
  const { ok, errors } = check({ root })
  assert.equal(ok, false)
  assert.ok(errors.some((e) => e.startsWith('unclassified_setTabs_call_site:')))
  assert.ok(errors.includes('fewer_than_two_merged_reconcile_paths'), 'only 1 merged path remains')
})

test('gate catches the rebuild path dropping the groupId-preserving spread', () => {
  const root = writeFixture({
    [STORE]: GOOD_STORE,
    [ACTIONS]: GOOD_ACTIONS,
    [EFFECTS]: 'const recoveredTab = { id: result.tabId }\nstore.setTabs(recoveredTabs)\nstore.setTabs(mergeBackendTabsPreservingGroups(store.tabs, hydratedTabs))',
  })
  const { ok, errors } = check({ root })
  assert.equal(ok, false)
  assert.ok(errors.includes('rebuild_does_not_preserve_groupid_via_spread'))
})

test('FAIL-CLOSED drift: a brand-new backend→renderer setTabs path is rejected (finding #4)', () => {
  const root = writeFixture({
    [STORE]: GOOD_STORE,
    [ACTIONS]: GOOD_ACTIONS,
    [EFFECTS]: GOOD_EFFECTS,
    // A 4th reconcile added in a new file with a novel (unclassified) backend var.
    'src/renderer/modules/browser/newReconcile.ts': 'store.setTabs(serverTabs)',
  })
  const { ok, errors } = check({ root })
  assert.equal(ok, false)
  assert.ok(
    errors.some((e) => e === 'unclassified_setTabs_call_site:src/renderer/modules/browser/newReconcile.ts'),
    'an unrecognized setTabs site must fail-closed rather than pass silently',
  )
})

test('gate does NOT false-fail on identifier renames in the merge helper / rebuild spread', () => {
  const root = writeFixture({
    [STORE]: `
export function mergeBackendTabsPreservingGroups(locals, backends) {
  return locals.map((l) => ({ ...b, groupId: l.groupId ?? null }))
}
`,
    [ACTIONS]: GOOD_ACTIONS,
    [EFFECTS]: 'const recoveredTab = { ...persisted, id: result.tabId }\nstore.setTabs(recoveredTabs)\nstore.setTabs(mergeBackendTabsPreservingGroups(store.tabs, hydratedTabs))',
  })
  assert.equal(check({ root }).ok, true, check({ root }).errors.join('\n'))
})
