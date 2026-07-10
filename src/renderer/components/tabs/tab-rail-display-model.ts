import { segmentIntoRuns, type GroupModelState } from '../../../shared/tab-group-model'
import type { TabGroup } from '../../../shared/tab-groups'

// Pure display model shared by the document rail (P2) and browser overlay (P3). Turns
// a flat id order + grouping into an ordered list of rows: a group header followed by
// its members, or a single ungrouped tab. Group runs stay contiguous (I-DISPLAY); the
// split tab is hoisted next to the active tab ONLY within its own run so grouping is
// never visually broken (D-SPLIT). Collapse is a render concern — every member row is
// emitted here regardless; the render layers hide collapsed members (both the 52px
// strip and the flyout stand a group chip/pill in for them, Edge semantics).

export type TabRailRow =
  | { kind: 'group-header'; group: TabGroup; memberIds: string[] }
  | { kind: 'tab'; id: string; groupId: string | null; flatRank: number }

// Within one id sequence, move split to just after active (only if both are present).
function hoistWithinRun(ids: string[], activeId: string | null, splitId: string | null): string[] {
  if (!activeId || !splitId || activeId === splitId) return ids
  if (!ids.includes(activeId) || !ids.includes(splitId)) return ids
  const rest = ids.filter((id) => id !== splitId)
  rest.splice(rest.indexOf(activeId) + 1, 0, splitId)
  return rest
}

export function buildTabRailRows(
  order: string[],
  groupOf: Record<string, string | null>,
  groups: TabGroup[],
  activeId: string | null,
  splitId: string | null,
): { rows: TabRailRow[]; flatOrder: string[] } {
  const model: GroupModelState = { order, groupOf, groups }
  const runs = segmentIntoRuns(model)
  const flatOrder = runs.flatMap((run) => (run.kind === 'group' ? run.tabIds : [run.tabId]))
  const rankOf = new Map(flatOrder.map((id, i) => [id, i]))

  const rows: TabRailRow[] = []
  let i = 0
  while (i < runs.length) {
    const run = runs[i]
    if (run.kind === 'group') {
      const memberIds = hoistWithinRun(run.tabIds, activeId, splitId)
      rows.push({ kind: 'group-header', group: run.group, memberIds })
      for (const id of memberIds) rows.push({ kind: 'tab', id, groupId: run.group.id, flatRank: rankOf.get(id) ?? 0 })
      i += 1
      continue
    }
    // Gather the maximal block of consecutive ungrouped singles for a local hoist.
    const block: string[] = []
    while (i < runs.length && runs[i].kind === 'tab') {
      block.push((runs[i] as { tabId: string }).tabId)
      i += 1
    }
    for (const id of hoistWithinRun(block, activeId, splitId)) {
      rows.push({ kind: 'tab', id, groupId: null, flatRank: rankOf.get(id) ?? 0 })
    }
  }
  return { rows, flatOrder }
}

// Resolve a drop into a flat destination rank + group. The user drags against the VISUAL
// (hoisted) row order, but reorderTab operates on the FLAT tabs[] order — and the two differ
// whenever the split-hoist has relocated the split tab (D-SPLIT). Resolving purely against
// flatOrder therefore lands the drop in the wrong slot/group in split view. So: derive the
// group from the visual neighbours straddling the insertion point, and derive toRank by
// anchoring to the nearest visual predecessor whose FLAT index is reliable — skipping the
// moved tab and a DISPLACED split tab (the only row the hoist moves). Shared by both rails.
export function resolveReorderDrop(
  visualOrder: string[],
  flatOrder: string[],
  groupOf: Record<string, string | null>,
  movedId: string,
  targetId: string,
  intent: 'before' | 'after',
  splitId: string | null = null,
): { toRank: number; intoGroupId: string | null } {
  const targetVisualIdx = visualOrder.indexOf(targetId)
  if (targetVisualIdx === -1) return { toRank: flatOrder.length, intoGroupId: null }
  const insertionIdx = intent === 'before' ? targetVisualIdx : targetVisualIdx + 1

  // Group inheritance from the visual rows on either side of the insertion point (skip only
  // the moved tab; group membership is position-independent so a hoisted split is fine here).
  const neighbourGroup = (from: number, step: number): string | null => {
    for (let i = from; i >= 0 && i < visualOrder.length; i += step) {
      if (visualOrder[i] !== movedId) return groupOf[visualOrder[i]] ?? null
    }
    return null
  }
  const beforeGroup = neighbourGroup(insertionIdx - 1, -1)
  const afterGroup = neighbourGroup(insertionIdx, 1)
  const intoGroupId = beforeGroup !== null && beforeGroup === afterGroup ? beforeGroup : null

  // Flat toRank: the hoist relocates ONLY the split tab, so its flat index ≠ visual index
  // once hoisted; anchoring to it would misplace the drop. Skip it (and the moved tab).
  const splitDisplaced = splitId !== null && visualOrder.indexOf(splitId) !== flatOrder.indexOf(splitId)
  let anchorId: string | null = null
  for (let i = insertionIdx - 1; i >= 0; i -= 1) {
    const id = visualOrder[i]
    if (id === movedId) continue
    if (splitDisplaced && id === splitId) continue
    anchorId = id
    break
  }
  const withoutMoved = flatOrder.filter((id) => id !== movedId)
  const toRank = anchorId === null ? 0 : withoutMoved.indexOf(anchorId) + 1
  return { toRank, intoGroupId }
}
