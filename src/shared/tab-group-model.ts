// Pure, dependency-free tab-group model shared by the browser and document tab
// stores. It operates on a minimal payload — a flat id order, a tabId→groupId map,
// and the group list — so each store can adapt its own Tab[] to it. Every mutation
// returns an already-normalized next state.
//
// Invariants enforced by normalizeGroupState (the tail of every op):
//   I1 (contiguity): the members of a group form one contiguous run in `order`.
//   I2 (group order):  a group's visual position is that of its earliest member —
//                      derived from `order`, never stored separately (single source).
//   I3 (no orphans):   every group in `groups` has >=1 member, and every groupOf
//                      value points to a group that exists (else it is cleared).
//
// delete-tab / new-tab are NOT here: they cross the id layer (removing/creating
// tabs, and for the browser store issuing IPC). The store owns those and calls
// into this model for the id-level group bookkeeping (see plan §9.4 / §11.1).

import type { TabGroup } from './tab-groups'

export interface GroupModelState {
  order: string[] // flat tab id order (= the store's tabs[] id projection)
  groupOf: Record<string, string | null> // tabId -> groupId (null/absent = ungrouped)
  groups: TabGroup[]
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

// Enforce I1/I2/I3. Idempotent: normalize(normalize(x)) deep-equals normalize(x).
export function normalizeGroupState(state: GroupModelState): GroupModelState {
  const groupById = new Map(state.groups.map((group) => [group.id, group]))

  // I3 (part 1): a groupOf pointing at a non-existent group is cleared to null.
  const groupOf: Record<string, string | null> = {}
  for (const id of state.order) {
    const raw = state.groupOf[id]
    groupOf[id] = raw && groupById.has(raw) ? raw : null
  }

  // Collect each group's members in their current relative order.
  const membersByGroup = new Map<string, string[]>()
  for (const id of state.order) {
    const groupId = groupOf[id]
    if (!groupId) continue
    const bucket = membersByGroup.get(groupId)
    if (bucket) bucket.push(id)
    else membersByGroup.set(groupId, [id])
  }

  // I1/I2: re-lay `order` so each group's members are one contiguous block placed
  // at the position of the group's earliest member; ungrouped tabs keep their slot.
  const emitted = new Set<string>()
  const nextOrder: string[] = []
  for (const id of state.order) {
    const groupId = groupOf[id]
    if (!groupId) {
      nextOrder.push(id)
      continue
    }
    if (emitted.has(groupId)) continue
    emitted.add(groupId)
    for (const member of membersByGroup.get(groupId) ?? []) nextOrder.push(member)
  }

  // I3 (part 2): drop empty groups; preserve declared group objects otherwise.
  const groups = state.groups.filter((group) => membersByGroup.has(group.id))

  return { order: nextOrder, groupOf, groups }
}

function moveAdjacent(order: string[], movedId: string, anchorId: string): string[] {
  if (movedId === anchorId) return [...order]
  const without = order.filter((id) => id !== movedId)
  const anchorIndex = without.indexOf(anchorId)
  if (anchorIndex === -1) return [...order]
  without.splice(anchorIndex + 1, 0, movedId)
  return without
}

// Create a new group containing {target, dragged}, anchored at target's position.
// Precondition (from the drag layer): target is currently ungrouped (a drop onto a
// grouped tab routes to addToGroup instead). newGroup is fully formed by the store
// (id + color chosen there); the model stays color/id-generation agnostic.
export function createGroupFromDrop(
  state: GroupModelState,
  draggedId: string,
  targetId: string,
  newGroup: TabGroup,
): GroupModelState {
  if (draggedId === targetId) return normalizeGroupState(state)
  if (!state.order.includes(draggedId) || !state.order.includes(targetId)) {
    return normalizeGroupState(state)
  }
  const groups = [...state.groups, newGroup]
  const groupOf = { ...state.groupOf, [targetId]: newGroup.id, [draggedId]: newGroup.id }
  const order = moveAdjacent(state.order, draggedId, targetId)
  return normalizeGroupState({ order, groupOf, groups })
}

// Create a new group holding one tab, where the tab already is (the tab's menu: 添加到新分组). A grouped
// tab leaves its old group for the new one; normalize drops the old group if that emptied it.
export function createGroupWithTab(state: GroupModelState, tabId: string, newGroup: TabGroup): GroupModelState {
  if (!state.order.includes(tabId)) return normalizeGroupState(state)
  const groups = [...state.groups, newGroup]
  const groupOf = { ...state.groupOf, [tabId]: newGroup.id }
  return normalizeGroupState({ order: state.order, groupOf, groups })
}

// Add a tab to an existing group; it lands at the END of the group's run. The tab
// is explicitly relocated to just after the group's current last member BEFORE
// normalizing — otherwise, when the added tab currently sits before the group in
// flat order, it would become the group's earliest member and normalize would
// teleport the whole group to the tab's slot, displacing intervening ungrouped tabs.
export function addToGroup(state: GroupModelState, tabId: string, groupId: string): GroupModelState {
  if (!state.order.includes(tabId) || !state.groups.some((g) => g.id === groupId)) {
    return normalizeGroupState(state)
  }
  const groupOf = { ...state.groupOf, [tabId]: groupId }
  const members = state.order.filter((id) => id !== tabId && state.groupOf[id] === groupId)
  if (members.length === 0) {
    return normalizeGroupState({ order: state.order, groupOf, groups: state.groups })
  }
  const without = state.order.filter((id) => id !== tabId)
  const anchorIndex = without.indexOf(members[members.length - 1])
  without.splice(anchorIndex + 1, 0, tabId)
  return normalizeGroupState({ order: without, groupOf, groups: state.groups })
}

// Remove a tab from its group; it settles just outside the group's run.
export function removeFromGroup(state: GroupModelState, tabId: string): GroupModelState {
  if (!(tabId in state.groupOf) && !state.order.includes(tabId)) {
    return normalizeGroupState(state)
  }
  const groupOf = { ...state.groupOf, [tabId]: null }
  return normalizeGroupState({ order: state.order, groupOf, groups: state.groups })
}

// Move a tab to a flat rank and (re)assign its group by the drop geometry.
// toRank is in FLAT order space among the OTHER tabs: the moved tab is removed
// first, then inserted at clamp(toRank, 0, others.length). intoGroupId=null drops
// it from any group. normalize then gathers group runs.
export function reorderTab(
  state: GroupModelState,
  movedId: string,
  toRank: number,
  intoGroupId: string | null,
): GroupModelState {
  if (!state.order.includes(movedId)) return normalizeGroupState(state)
  const without = state.order.filter((id) => id !== movedId)
  const insertAt = clamp(toRank, 0, without.length)
  without.splice(insertAt, 0, movedId)
  const resolvedGroup = intoGroupId && state.groups.some((g) => g.id === intoGroupId) ? intoGroupId : null
  const groupOf = { ...state.groupOf, [movedId]: resolvedGroup }
  return normalizeGroupState({ order: without, groupOf, groups: state.groups })
}

export function renameGroup(state: GroupModelState, groupId: string, name: string): GroupModelState {
  const groups = state.groups.map((group) => (group.id === groupId ? { ...group, name } : group))
  return normalizeGroupState({ order: state.order, groupOf: state.groupOf, groups })
}

export function recolorGroup(
  state: GroupModelState,
  groupId: string,
  color: TabGroup['color'],
): GroupModelState {
  const groups = state.groups.map((group) => (group.id === groupId ? { ...group, color } : group))
  return normalizeGroupState({ order: state.order, groupOf: state.groupOf, groups })
}

export function setGroupCollapsed(
  state: GroupModelState,
  groupId: string,
  collapsed: boolean,
): GroupModelState {
  const groups = state.groups.map((group) => (group.id === groupId ? { ...group, collapsed } : group))
  return normalizeGroupState({ order: state.order, groupOf: state.groupOf, groups })
}

// Disband a group: clear its members' groupId and drop the group. Tabs are kept in
// place (they were contiguous; they simply become ungrouped).
export function disbandGroup(state: GroupModelState, groupId: string): GroupModelState {
  const groupOf: Record<string, string | null> = {}
  for (const id of state.order) {
    groupOf[id] = state.groupOf[id] === groupId ? null : state.groupOf[id] ?? null
  }
  const groups = state.groups.filter((group) => group.id !== groupId)
  return normalizeGroupState({ order: state.order, groupOf, groups })
}

export type TabRun =
  | { kind: 'group'; group: TabGroup; tabIds: string[] }
  | { kind: 'tab'; tabId: string }

// Render model: contiguous group runs (with the group meta, incl. collapsed) and
// single ungrouped tabs, in flat order. Normalizes first so callers never segment a
// non-contiguous order.
export function segmentIntoRuns(state: GroupModelState): TabRun[] {
  const norm = normalizeGroupState(state)
  const groupById = new Map(norm.groups.map((group) => [group.id, group]))
  const runs: TabRun[] = []
  let i = 0
  while (i < norm.order.length) {
    const id = norm.order[i]
    const groupId = norm.groupOf[id]
    if (!groupId) {
      runs.push({ kind: 'tab', tabId: id })
      i += 1
      continue
    }
    const tabIds: string[] = []
    while (i < norm.order.length && norm.groupOf[norm.order[i]] === groupId) {
      tabIds.push(norm.order[i])
      i += 1
    }
    const group = groupById.get(groupId)
    if (group) runs.push({ kind: 'group', group, tabIds })
    else for (const tabId of tabIds) runs.push({ kind: 'tab', tabId })
  }
  return runs
}
