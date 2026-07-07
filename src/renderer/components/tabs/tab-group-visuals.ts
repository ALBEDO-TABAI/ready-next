import type { TabGroupColor } from '../../../shared/tab-groups'

// Map the closed group-color set to existing --color-* CSS variables. Shared by the
// document rail (P2) and the browser overlay (P3) so both surfaces read identically.
export const TAB_GROUP_COLOR_VAR: Record<TabGroupColor, string> = {
  blue: 'var(--color-blue)',
  cyan: 'var(--color-cyan, var(--color-blue))',
  green: 'var(--color-green)',
  yellow: 'var(--color-yellow, var(--color-orange))',
  orange: 'var(--color-orange)',
  red: 'var(--color-red)',
  pink: 'var(--color-pink, var(--color-red))',
  purple: 'var(--color-purple, var(--color-blue))',
  gray: 'var(--text-gray)',
}

export function tabGroupColorVar(color: TabGroupColor): string {
  return TAB_GROUP_COLOR_VAR[color] ?? TAB_GROUP_COLOR_VAR.blue
}

// A translucent fill of the group color, for group-run backgrounds / drop targets.
export function tabGroupColorSoft(color: TabGroupColor, percent = 12): string {
  return `color-mix(in srgb, ${tabGroupColorVar(color)} ${percent}%, transparent)`
}

// The two drop intents the file-tree-style drag resolves to.
export type TabDropIntent = 'onto' | 'before' | 'after'

// Resolve the drop intent from the pointer's vertical position within a row:
// middle band → onto (group), top/bottom quarters → reorder before/after.
export function resolveTabDropIntent(offsetY: number, rowHeight: number): TabDropIntent {
  if (rowHeight <= 0) return 'onto'
  const ratio = Math.max(0, Math.min(1, offsetY / rowHeight))
  if (ratio < 0.28) return 'before'
  if (ratio > 0.72) return 'after'
  return 'onto'
}
