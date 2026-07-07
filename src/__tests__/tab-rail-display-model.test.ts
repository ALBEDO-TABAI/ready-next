import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { TabGroup } from '../shared/tab-groups'
import { buildTabRailRows, resolveReorderDrop } from '../renderer/components/tabs/tab-rail-display-model'
import { resolveTabDropIntent } from '../renderer/components/tabs/tab-group-visuals'

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

  it('computes before/after ranks with the forward-move off-by-one', () => {
    // move a (rank 0) to after c (rank 2): remove a shifts c to 1 → insert after → 2.
    assert.equal(resolveReorderDrop(order, ungrouped, 'a', 'c', 'after').toRank, 2)
    // move d (rank 3) to before b (rank 1): no shift (moved after target) → 1.
    assert.equal(resolveReorderDrop(order, ungrouped, 'd', 'b', 'before').toRank, 1)
  })

  it('inherits the group only when inserting strictly inside the run', () => {
    // g1 = [b, c]; dropping a AFTER b (between b and c, both g1) → joins g1.
    const groupOf = { a: null, b: 'g1', c: 'g1', d: null }
    assert.equal(resolveReorderDrop(order, groupOf, 'a', 'b', 'after').intoGroupId, 'g1')
    // dropping a BEFORE b (b is the group's first member; neighbour is ungrouped a) → no group.
    assert.equal(resolveReorderDrop(order, groupOf, 'd', 'b', 'before').intoGroupId, null)
    // dropping AFTER c (group's last member; neighbour d ungrouped) → no group.
    assert.equal(resolveReorderDrop(order, groupOf, 'a', 'c', 'after').intoGroupId, null)
  })
})

describe('resolveTabDropIntent', () => {
  it('maps the pointer band to onto / before / after', () => {
    assert.equal(resolveTabDropIntent(2, 40), 'before')
    assert.equal(resolveTabDropIntent(20, 40), 'onto')
    assert.equal(resolveTabDropIntent(38, 40), 'after')
  })
})
