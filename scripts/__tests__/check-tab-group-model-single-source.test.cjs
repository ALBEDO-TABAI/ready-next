'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const { check } = require('../check-tab-group-model-single-source.cjs')

function writeFixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'ready-group-single-source-gate-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  return root
}

const BROWSER = 'src/renderer/stores/useBrowserTabs.ts'
const DOC = 'src/renderer/stores/useDocTabs.ts'

const GOOD_BROWSER = `
import { normalizeGroupState, createGroupFromDrop } from '../../shared/tab-group-model'
function sanitizeSnapshot(snapshot) {
  const model = normalizeGroupState(toGroupModel(rawTabs, rawGroups))
  return model
}
function readBrowserTabsSnapshot() { return sanitizeSnapshot({}) }
createTabGroupFromDrop: (a, b) => set((state) => applyOp(state, createGroupFromDrop(m, a, b, g))),
`
const GOOD_DOC = `
import { normalizeGroupState, createGroupFromDrop } from '../../shared/tab-group-model'
function normalizeDocGroups(tabs, tabGroups) {
  return applyDocGroupModel(tabs, normalizeGroupState(toDocGroupModel(tabs, tabGroups)))
}
interface DocTabsState {
    closeTab: (id: string) => void
    reorderTabs: (fromIndex: number, toIndex: number) => void
}
    closeTab: (id) => {
        const normalized = normalizeDocGroups(remaining, tabGroups)
        set({ tabs: normalized.tabs })
    },
    reorderTabs: (fromIndex, toIndex) => {
        const normalized = normalizeDocGroups(tabs, tabGroups)
        set({ tabs: normalized.tabs })
    },
    createTabGroupFromDrop: (a, b) => {
        set(applyDocGroupOp(state, createGroupFromDrop(m, a, b, g)))
    },
`

test('model-single-source gate passes the current workspace', () => {
  assert.equal(check().ok, true, check().errors.join('\n'))
})

test('gate passes a synthetic all-correct fixture', () => {
  const root = writeFixture({ [BROWSER]: GOOD_BROWSER, [DOC]: GOOD_DOC })
  assert.equal(check({ root }).ok, true, check({ root }).errors.join('\n'))
})

test('gate rejects stores that bypass the pure model', () => {
  const root = writeFixture({
    [BROWSER]: 'function sanitizeSnapshot(s) { return s }',
    [DOC]: 'const nothing = 1',
  })
  const { ok, errors } = check({ root })
  assert.equal(ok, false)
  assert.ok(errors.includes('browser_store_not_importing_tab_group_model'))
  assert.ok(errors.includes('browser_sanitize_snapshot_does_not_normalize'))
  assert.ok(errors.includes('doc_store_not_importing_tab_group_model'))
  assert.ok(errors.includes('doc_store_missing_normalize_choke'))
  assert.ok(errors.includes('browser_group_formation_not_delegated'))
  assert.ok(errors.includes('doc_group_formation_not_delegated'))
})

test('gate catches a doc member-removal that forgets to normalize (the §5.2 orphan bug)', () => {
  const root = writeFixture({
    [BROWSER]: GOOD_BROWSER,
    [DOC]: `
import { normalizeGroupState, createGroupFromDrop } from '../../shared/tab-group-model'
function normalizeDocGroups(tabs, tabGroups) { return normalizeGroupState(x) }
interface DocTabsState { closeTab: (id: string) => void; reorderTabs: (a: number, b: number) => void }
    closeTab: (id) => {
        const remaining = tabs.filter((t) => t.id !== id)
        set({ tabs: remaining })
    },
    reorderTabs: (a, b) => { const n = normalizeDocGroups(tabs, tabGroups); set({ tabs: n.tabs }) },
    createTabGroupFromDrop: (a, b) => { set(createGroupFromDrop(m, a, b, g)) },
`,
  })
  const { ok, errors } = check({ root })
  assert.equal(ok, false)
  assert.ok(errors.includes('doc_closeTab_does_not_normalize'))
})

test('FAIL-CLOSED: a renamed/absent removal mutator is an error, not a silent skip (finding #5)', () => {
  const root = writeFixture({
    [BROWSER]: GOOD_BROWSER,
    [DOC]: `
import { normalizeGroupState, createGroupFromDrop } from '../../shared/tab-group-model'
function normalizeDocGroups(tabs, tabGroups) { return normalizeGroupState(x) }
interface DocTabsState { reorderTabs: (a: number, b: number) => void }
    reorderTabs: (a, b) => { const n = normalizeDocGroups(tabs, tabGroups); set({ tabs: n.tabs }) },
    createTabGroupFromDrop: (a, b) => { set(createGroupFromDrop(m, a, b, g)) },
`, // closeTab renamed away
  })
  const { ok, errors } = check({ root })
  assert.equal(ok, false)
  assert.ok(
    errors.includes('doc_closeTab_mutator_not_found'),
    'a removal mutator the gate cannot locate must fail-closed',
  )
})

test('does NOT false-fail when the mutator normalizes via a helper (spec §5.2 reducer, finding #8)', () => {
  const root = writeFixture({
    [BROWSER]: GOOD_BROWSER,
    [DOC]: `
import { normalizeGroupState, createGroupFromDrop } from '../../shared/tab-group-model'
function normalizeDocGroups(tabs, tabGroups) { return normalizeGroupState(x) }
function commitNormalizedGroups(next) { return normalizeDocGroups(next.tabs, next.tabGroups) }
interface DocTabsState { closeTab: (id: string) => void; reorderTabs: (a: number, b: number) => void }
    closeTab: (id) => {
        set(commitNormalizedGroups({ tabs: remaining, tabGroups }))
    },
    reorderTabs: (a, b) => {
        set(commitNormalizedGroups({ tabs: reordered, tabGroups }))
    },
    createTabGroupFromDrop: (a, b) => { set(createGroupFromDrop(m, a, b, g)) },
`,
  })
  assert.equal(check({ root }).ok, true, check({ root }).errors.join('\n'))
})
