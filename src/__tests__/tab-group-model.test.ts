import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { TabGroup, TabGroupColor } from '../shared/tab-groups'
import {
  addToGroup,
  createGroupFromDrop,
  createGroupWithTab,
  disbandGroup,
  type GroupModelState,
  normalizeGroupState,
  recolorGroup,
  removeFromGroup,
  renameGroup,
  reorderTab,
  segmentIntoRuns,
  setGroupCollapsed,
} from '../shared/tab-group-model'

function grp(id: string, color: TabGroupColor = 'blue', collapsed = false): TabGroup {
  return { id, name: id, color, collapsed }
}

// Build a state from a compact spec: order + { tabId: groupId } (absent = ungrouped).
function st(order: string[], groupOf: Record<string, string | null>, groups: TabGroup[]): GroupModelState {
  const full: Record<string, string | null> = {}
  for (const id of order) full[id] = groupOf[id] ?? null
  return { order, groupOf: full, groups }
}

// Assert I1 (contiguity), I2 is structural (derived), I3 (no orphans / dangling refs).
function assertInvariants(s: GroupModelState): void {
  const groupIds = new Set(s.groups.map((g) => g.id))
  const memberCount = new Map<string, number>()
  for (const id of s.order) {
    const g = s.groupOf[id] ?? null
    if (g !== null) {
      assert.ok(groupIds.has(g), `I3: groupOf ${id}->${g} must point to an existing group`)
      memberCount.set(g, (memberCount.get(g) ?? 0) + 1)
    }
  }
  for (const g of s.groups) {
    assert.ok((memberCount.get(g.id) ?? 0) >= 1, `I3: group ${g.id} must have >=1 member`)
  }
  // I1: no group may appear in two separate runs.
  const seen = new Set<string>()
  let prev: string | null = null
  for (const id of s.order) {
    const g = s.groupOf[id] ?? null
    if (g !== prev) {
      if (g !== null) {
        assert.ok(!seen.has(g), `I1: group ${g} must be contiguous (reappeared after a gap)`)
        seen.add(g)
      }
    }
    prev = g
  }
}

const G1 = grp('g1', 'blue')
const G2 = grp('g2', 'green')

// A diverse corpus of pre-normalized states for fuzzing every op against.
function corpus(): GroupModelState[] {
  return [
    st(['a', 'b', 'c'], {}, []),
    st(['a', 'b', 'c'], { a: 'g1', b: 'g1' }, [G1]),
    st(['a', 'b', 'c', 'd'], { a: 'g1', c: 'g1' }, [G1]), // non-contiguous input
    st(['a', 'b', 'c', 'd'], { a: 'g1', b: 'g2', c: 'g1', d: 'g2' }, [G1, G2]), // interleaved
    st(['a'], { a: 'g1' }, [G1]),
    st(['a', 'b'], { a: 'g1', b: 'g2' }, [G1, G2]),
    st(['a', 'b', 'c'], { a: 'gX' }, []), // dangling group ref
    st(['a', 'b', 'c'], {}, [G1]), // empty group (orphan)
  ]
}

describe('normalizeGroupState enforces I1–I3', () => {
  it('every corpus state normalizes to a valid state and is idempotent', () => {
    for (const s of corpus()) {
      const n = normalizeGroupState(s)
      assertInvariants(n)
      const again = normalizeGroupState(n)
      assert.deepEqual(again, n, 'normalize must be idempotent')
    }
  })

  it('gathers interleaved members into contiguous runs at the first-member anchor', () => {
    const n = normalizeGroupState(st(['a', 'b', 'c', 'd'], { a: 'g1', b: 'g2', c: 'g1', d: 'g2' }, [G1, G2]))
    assert.deepEqual(n.order, ['a', 'c', 'b', 'd'])
  })

  it('drops empty groups and clears dangling group refs', () => {
    const orphan = normalizeGroupState(st(['a', 'b'], {}, [G1]))
    assert.deepEqual(orphan.groups, [])
    const dangling = normalizeGroupState(st(['a'], { a: 'gX' }, []))
    assert.equal(dangling.groupOf.a, null)
  })
})

describe('group ops keep the state valid (fuzz over the corpus)', () => {
  it('every op on every corpus state satisfies I1–I3', () => {
    for (const s of corpus()) {
      const base = normalizeGroupState(s)
      const ids = base.order
      const groupIds = base.groups.map((g) => g.id)
      // createGroupFromDrop for each ordered pair of distinct ids
      for (const a of ids) {
        for (const b of ids) {
          if (a === b) continue
          assertInvariants(createGroupFromDrop(base, a, b, grp('gNew', 'red')))
        }
      }
      // addToGroup / removeFromGroup / reorderTab for each tab
      for (const id of ids) {
        for (const gid of groupIds) assertInvariants(addToGroup(base, id, gid))
        assertInvariants(removeFromGroup(base, id))
        for (let rank = 0; rank <= ids.length; rank += 1) {
          assertInvariants(reorderTab(base, id, rank, null))
          for (const gid of groupIds) assertInvariants(reorderTab(base, id, rank, gid))
        }
      }
      // group-meta + disband
      for (const gid of groupIds) {
        assertInvariants(renameGroup(base, gid, 'x'))
        assertInvariants(recolorGroup(base, gid, 'purple'))
        assertInvariants(setGroupCollapsed(base, gid, true))
        assertInvariants(disbandGroup(base, gid))
      }
    }
  })
})

describe('createGroupFromDrop', () => {
  it('groups target+dragged at the target position', () => {
    const s = normalizeGroupState(st(['a', 'b', 'c', 'd'], {}, []))
    const n = createGroupFromDrop(s, 'd', 'b', grp('g1', 'blue'))
    assert.deepEqual(n.order, ['a', 'b', 'd', 'c'])
    assert.equal(n.groupOf.b, 'g1')
    assert.equal(n.groupOf.d, 'g1')
    assert.equal(n.groups.length, 1)
  })
})

describe('createGroupWithTab', () => {
  it('makes a one-tab group where the tab is', () => {
    const s = normalizeGroupState(st(['a', 'b', 'c'], {}, []))
    const n = createGroupWithTab(s, 'b', grp('g9', 'green'))
    assert.deepEqual(n.order, ['a', 'b', 'c'])
    assert.deepEqual(n.groups.map((g) => g.id), ['g9'])
    assert.equal(n.groupOf.b, 'g9')
  })

  it('a grouped tab leaves its old group, which is dropped once empty', () => {
    const s = normalizeGroupState(st(['a', 'b'], { a: 'g1' }, [G1]))
    const n = createGroupWithTab(s, 'a', grp('g9', 'green'))
    assert.deepEqual(n.groups.map((g) => g.id), ['g9'])
    assert.equal(n.groupOf.a, 'g9')
  })

  it('an unknown tab changes nothing', () => {
    const s = normalizeGroupState(st(['a'], {}, []))
    assert.deepEqual(createGroupWithTab(s, 'zz', grp('g9', 'green')).groups, [])
  })
})

describe('addToGroup / removeFromGroup', () => {
  it('addToGroup appends the tab to the group run', () => {
    const s = normalizeGroupState(st(['a', 'b', 'c'], { a: 'g1', b: 'g1' }, [G1]))
    const n = addToGroup(s, 'c', 'g1')
    assert.deepEqual(n.order, ['a', 'b', 'c'])
    assert.equal(n.groupOf.c, 'g1')
  })

  it('addToGroup on a tab BEFORE the group tail-appends without teleporting the group', () => {
    // order [x, u1, u2, a, b] with g1={a,b}; adding x must NOT make x the earliest
    // member (which would teleport the whole group to index 0 and shove u1,u2 past it).
    const s = normalizeGroupState(st(['x', 'u1', 'u2', 'a', 'b'], { a: 'g1', b: 'g1' }, [G1]))
    const n = addToGroup(s, 'x', 'g1')
    assert.deepEqual(n.order, ['u1', 'u2', 'a', 'b', 'x'], 'group stays put; x appended to its tail')
    assert.equal(n.groupOf.x, 'g1')
    assertInvariants(n)
  })

  it('removeFromGroup drops the tab just outside the run', () => {
    const s = normalizeGroupState(st(['a', 'b', 'c'], { a: 'g1', b: 'g1', c: 'g1' }, [G1]))
    const n = removeFromGroup(s, 'b')
    assert.deepEqual(n.order, ['a', 'c', 'b'])
    assert.equal(n.groupOf.b, null)
  })

  it('removing the last member disbands the (now empty) group', () => {
    const s = normalizeGroupState(st(['a', 'b'], { a: 'g1' }, [G1]))
    const n = removeFromGroup(s, 'a')
    assert.deepEqual(n.groups, [])
    assert.equal(n.groupOf.a, null)
  })
})

describe('reorderTab', () => {
  it('reorders within the flat order among the other tabs', () => {
    const s = normalizeGroupState(st(['a', 'b', 'c', 'd'], {}, []))
    assert.deepEqual(reorderTab(s, 'a', 2, null).order, ['b', 'c', 'a', 'd'])
    assert.deepEqual(reorderTab(s, 'd', 0, null).order, ['d', 'a', 'b', 'c'])
  })

  it('assigns the moved tab into the drop group and re-gathers the run', () => {
    const s = normalizeGroupState(st(['a', 'b', 'c', 'd'], { a: 'g1', b: 'g1' }, [G1]))
    const n = reorderTab(s, 'd', 1, 'g1')
    assert.equal(n.groupOf.d, 'g1')
    assertInvariants(n)
    // d joins g1's run (contiguous with a,b)
    const dIdx = n.order.indexOf('d')
    assert.ok(n.order.slice(0, 3).includes('d'), `d should be inside the g1 run: ${n.order.join(',')}`)
    assert.ok(dIdx >= 0)
  })
})

describe('disband / rename / recolor / collapse', () => {
  it('disband keeps the tabs, drops the group', () => {
    const s = normalizeGroupState(st(['a', 'b', 'c'], { a: 'g1', b: 'g1' }, [G1]))
    const n = disbandGroup(s, 'g1')
    assert.deepEqual(n.order, ['a', 'b', 'c'])
    assert.deepEqual(n.groups, [])
    assert.equal(n.groupOf.a, null)
    assert.equal(n.groupOf.b, null)
  })

  it('rename/recolor/collapse update only the group meta', () => {
    const s = normalizeGroupState(st(['a', 'b'], { a: 'g1', b: 'g1' }, [G1]))
    assert.equal(renameGroup(s, 'g1', 'Docs').groups[0].name, 'Docs')
    assert.equal(recolorGroup(s, 'g1', 'orange').groups[0].color, 'orange')
    assert.equal(setGroupCollapsed(s, 'g1', true).groups[0].collapsed, true)
  })
})

describe('segmentIntoRuns', () => {
  it('produces group runs and single-tab runs in flat order', () => {
    const s = normalizeGroupState(st(['a', 'b', 'c', 'd'], { b: 'g1', c: 'g1' }, [grp('g1', 'green', true)]))
    const runs = segmentIntoRuns(s)
    assert.equal(runs.length, 3)
    assert.deepEqual(runs[0], { kind: 'tab', tabId: 'a' })
    assert.equal(runs[1].kind, 'group')
    if (runs[1].kind === 'group') {
      assert.deepEqual(runs[1].tabIds, ['b', 'c'])
      assert.equal(runs[1].group.collapsed, true)
    }
    assert.deepEqual(runs[2], { kind: 'tab', tabId: 'd' })
  })
})
