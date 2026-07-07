'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const { check } = require('../check-overlay-snapshot-flat-order.cjs')

const RAIL = 'src/renderer/components/browser/VerticalTabRail.tsx'
const HELPER = 'src/renderer/components/browser/vertical-rail-overlay-snapshot.ts'

const GOOD_RAIL = `
export default function VerticalTabRail() {
  const buildSnapshot = useCallback(() => {
    const overlayTabs = buildOverlaySnapshotTabs(t, aId, sId, marks)
    return { tabs: overlayTabs, groups: g }
  }, [])
  const pushSnapshot = useCallback(() => {}, [])
}
`
const GOOD_HELPER = `
export function buildOverlaySnapshotTabs(tabs, activeTabId, splitTabId, bookmarkedUrls) {
  return tabs.map((tab) => ({ id: tab.id, groupId: tab.groupId ?? null }))
}
`

function writeFixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'ready-overlay-flatorder-gate-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  return root
}

test('flat-order gate passes the current workspace', () => {
  assert.equal(check().ok, true, check().errors.join('\n'))
})

test('passes a synthetic all-correct fixture', () => {
  const root = writeFixture({ [RAIL]: GOOD_RAIL, [HELPER]: GOOD_HELPER })
  assert.equal(check({ root }).ok, true, check({ root }).errors.join('\n'))
})

test('rejects a buildSnapshot that re-introduces the global pair hoist', () => {
  const root = writeFixture({
    [RAIL]: `
export default function VerticalTabRail() {
  const buildSnapshot = useCallback(() => {
    const overlayTabs = getActiveTabPairOrder(t, aId, sId).map(({ tab }) => tab)
    return { tabs: overlayTabs }
  }, [])
  const pushSnapshot = useCallback(() => {}, [])
}
`,
    [HELPER]: GOOD_HELPER,
  })
  const { ok, errors } = check({ root })
  assert.equal(ok, false)
  assert.ok(errors.includes('rail_still_references_getActiveTabPairOrder'))
  assert.ok(errors.includes('buildSnapshot_uses_global_pair_hoist'))
})

test('rejects a helper that does not map the raw tabs array', () => {
  const root = writeFixture({
    [RAIL]: GOOD_RAIL,
    [HELPER]: `export function buildOverlaySnapshotTabs(tabs) { return [] }`,
  })
  const { ok, errors } = check({ root })
  assert.equal(ok, false)
  assert.ok(errors.includes('flat_helper_does_not_map_raw_tabs'))
})

test('fail-closed when buildSnapshot is missing', () => {
  const root = writeFixture({ [RAIL]: 'export default function VerticalTabRail() {}', [HELPER]: GOOD_HELPER })
  const { ok, errors } = check({ root })
  assert.equal(ok, false)
  assert.ok(errors.includes('buildSnapshot_not_found'))
})
