// Shared tab-group value types for the browser and document vertical tab rails.
// Groups are renderer-only (the main process never learns about them); this file
// carries no React/electron dependency so both zustand stores and the pure
// tab-group-model can import it.

export type TabGroupColor =
  | 'blue'
  | 'cyan'
  | 'green'
  | 'yellow'
  | 'orange'
  | 'red'
  | 'pink'
  | 'purple'
  | 'gray'

// Closed color set (maps to --color-* CSS variables at the UI layer). Order is
// the rotation used by pickNextGroupColor.
export const TAB_GROUP_COLORS: readonly TabGroupColor[] = [
  'blue',
  'cyan',
  'green',
  'yellow',
  'orange',
  'red',
  'pink',
  'purple',
  'gray',
]

export interface TabGroup {
  id: string // 'grp-<n>', renderer-generated
  name: string // may be '' → UI shows a placeholder; the raw value is persisted
  color: TabGroupColor
  collapsed: boolean
}

export function isTabGroupColor(value: unknown): value is TabGroupColor {
  return typeof value === 'string' && (TAB_GROUP_COLORS as readonly string[]).includes(value)
}

// Deterministically choose the next group color: the first color in the rotation
// with the fewest existing uses. Deterministic (no randomness) so it is safe in
// pure/test contexts and produces stable, spread-out colors as groups are added.
export function pickNextGroupColor(used: readonly TabGroupColor[]): TabGroupColor {
  const counts = new Map<TabGroupColor, number>(TAB_GROUP_COLORS.map((color) => [color, 0]))
  for (const color of used) {
    if (counts.has(color)) counts.set(color, (counts.get(color) ?? 0) + 1)
  }
  let best: TabGroupColor = TAB_GROUP_COLORS[0]
  let bestCount = Number.POSITIVE_INFINITY
  for (const color of TAB_GROUP_COLORS) {
    const count = counts.get(color) ?? 0
    if (count < bestCount) {
      bestCount = count
      best = color
    }
  }
  return best
}
