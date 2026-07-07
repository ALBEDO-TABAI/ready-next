import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { TabGroup } from '../shared/tab-groups'
import { buildTabRailRows, resolveReorderDrop } from '../renderer/components/tabs/tab-rail-display-model'
import { reorderTab } from '../shared/tab-group-model'
import { resolveTabDropIntent } from '../renderer/components/tabs/tab-group-visuals'

function visualTabIds(rows: ReturnType<typeof buildTabRailRows>['rows']): string[] {
  return rows.filter((r) => r.kind === 'tab').map((r) => (r as { id: string }).id)
}

function grp(id: string, collapsed = false): TabGroup {
  return { id, name: id, color: 'blue', collapsed }
}

function tabIds(rows: ReturnType<typeof buildTabRailRows>['rows']): string[] {
  return rows.filter((r) => r.kind === 'tab').map((r) => (r as { id: string }).id)
}

// Assert every group's member rows form one contiguous run in the emitted rows (I-DISPLAY).
function assertDisplayContiguity(rows: ReturnType<typeof buildTabRailRows>['rows']): void {
  const seen = new Set<string>()
  let prev: string | null = null
  for (const row of rows) {
    if (row.kind !== 'tab') { prev = null; continue }
    const g = row.groupId
    if (g !== prev && g !== null) {
      assert.ok(!seen.has(g), `group ${g} must stay contiguous in display order`)
      seen.add(g)
    }
    prev = g
  }
}

describe('buildTabRailRows', () => {
  it('ungrouped tabs render in order with no headers', () => {
    const { rows, flatOrder } = buildTabRailRows(['a', 'b', 'c'], { a: null, b: null, c: null }, [], null, null)
    assert.deepEqual(flatOrder, ['a', 'b', 'c'])
    assert.deepEqual(tabIds(rows), ['a', 'b', 'c'])
    assert.equal(rows.filter((r) => r.kind === 'group-header').length, 0)
  })

  it('emits a group header followed by its contiguous members', () => {
    const rows = buildTabRailRows(['a', 'b', 'c'], { a: 'g1', b: 'g1', c: null }, [grp('g1')], null, null).rows
    assert.equal(rows[0].kind, 'group-header')
    if (rows[0].kind === 'group-header') assert.deepEqual(rows[0].memberIds, ['a', 'b'])
    assert.deepEqual(tabIds(rows), ['a', 'b', 'c'])
    assertDisplayContiguity(rows)
  })

  it('hoists split next to active WITHIN the same group run', () => {
    // g1 = [a, b, c]; active=a, split=c → c hoisted to just after a, still inside g1.
    const rows = buildTabRailRows(['a', 'b', 'c'], { a: 'g1', b: 'g1', c: 'g1' }, [grp('g1')], 'a', 'c').rows
    assert.deepEqual(tabIds(rows), ['a', 'c', 'b'])
    assertDisplayContiguity(rows)
  })

  it('hoists split next to active among ungrouped singles', () => {
    const rows = buildTabRailRows(['a', 'b', 'c', 'd'], { a: null, b: null, c: null, d: null }, [], 'a', 'd').rows
    assert.deepEqual(tabIds(rows), ['a', 'd', 'b', 'c'])
  })

  it('does NOT hoist a cross-group split (contiguity wins)', () => {
    // active=a in g1, split=d in g2 → d must NOT be pulled into g1's run.
    const rows = buildTabRailRows(
      ['a', 'b', 'c', 'd'],
      { a: 'g1', b: 'g1', c: 'g2', d: 'g2' },
      [grp('g1'), grp('g2')],
      'a',
      'd',
    ).rows
    assert.deepEqual(tabIds(rows), ['a', 'b', 'c', 'd'])
    assertDisplayContiguity(rows)
  })

  it('emits collapsed group members too (collapse is a render concern)', () => {
    const rows = buildTabRailRows(['a', 'b', 'c'], { a: 'g1', b: 'g1', c: null }, [grp('g1', true)], null, null).rows
    assert.deepEqual(tabIds(rows), ['a', 'b', 'c'], 'members are present; the flyout hides them at render')
  })
})

describe('resolveReorderDrop', () => {
  const order = ['a', 'b', 'c', 'd']
  const ungrouped = { a: null, b: null, c: null, d: null }

  it('computes before/after ranks with the forward-move off-by-one (no split)', () => {
    // move a (rank 0) to after c (rank 2): remove a shifts c to 1 → insert after → 2.
    assert.equal(resolveReorderDrop(order, order, ungrouped, 'a', 'c', 'after').toRank, 2)
    // move d (rank 3) to before b (rank 1): no shift (moved after target) → 1.
    assert.equal(resolveReorderDrop(order, order, ungrouped, 'd', 'b', 'before').toRank, 1)
  })

  it('inherits the group only when inserting strictly inside the run (no split)', () => {
    // g1 = [b, c]; dropping a AFTER b (between b and c, both g1) → joins g1.
    const groupOf = { a: null, b: 'g1', c: 'g1', d: null }
    assert.equal(resolveReorderDrop(order, order, groupOf, 'a', 'b', 'after').intoGroupId, 'g1')
    // dropping a BEFORE b (b is the group's first member; neighbour is ungrouped a) → no group.
    assert.equal(resolveReorderDrop(order, order, groupOf, 'd', 'b', 'before').intoGroupId, null)
    // dropping AFTER c (group's last member; neighbour d ungrouped) → no group.
    assert.equal(resolveReorderDrop(order, order, groupOf, 'a', 'c', 'after').intoGroupId, null)
  })

  it('resolves the drop in VISUAL order when the split tab is hoisted (D-SPLIT)', () => {
    // flat [a,b,c,d]; active=a, split=d → visual [a,d,b,c] (d hoisted to just after a).
    const flat = ['a', 'b', 'c', 'd']
    const visual = visualTabIds(buildTabRailRows(flat, ungrouped, [], 'a', 'd').rows)
    assert.deepEqual(visual, ['a', 'd', 'b', 'c'])
    // Drag c to BEFORE b (visually between d and b). A flat-based resolver would put c at
    // rank 0 (top of the strip); the visual resolver anchors past the hoisted split to a → 1.
    const { toRank } = resolveReorderDrop(visual, flat, ungrouped, 'c', 'b', 'before', 'd')
    assert.equal(toRank, 1)
    // Round-trip: reorderTab + re-hoist lands c between d and b — the slot the user dropped on.
    const next = reorderTab({ order: flat, groupOf: ungrouped, groups: [] }, 'c', toRank, null)
    assert.deepEqual(visualTabIds(buildTabRailRows(next.order, next.groupOf, [], 'a', 'd').rows), ['a', 'd', 'c', 'b'])
  })

  it('inherits the group across a hoisted split boundary (Repro C)', () => {
    // g1 = [A,X,S] contiguous + ungrouped T; active=A, split=S → visual [A,S,X,T].
    const flat = ['A', 'X', 'S', 'T']
    const groupOf = { A: 'g1', X: 'g1', S: 'g1', T: null }
    const visual = visualTabIds(buildTabRailRows(flat, groupOf, [grp('g1')], 'A', 'S').rows)
    assert.deepEqual(visual, ['A', 'S', 'X', 'T'])
    // Drag T to AFTER S (visually inside g1, between S and X) → T joins g1 (the flat-based
    // resolver saw T itself as the after-neighbour and silently kept it ungrouped).
    assert.equal(resolveReorderDrop(visual, flat, groupOf, 'T', 'S', 'after', 'S').intoGroupId, 'g1')
  })
})

describe('resolveTabDropIntent', () => {
  it('maps the pointer band to onto / before / after', () => {
    assert.equal(resolveTabDropIntent(2, 40), 'before')
    assert.equal(resolveTabDropIntent(20, 40), 'onto')
    assert.equal(resolveTabDropIntent(38, 40), 'after')
  })
})
