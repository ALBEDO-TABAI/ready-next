import type { TabGroupColor } from '../../../shared/tab-groups'

// Map the closed group-color set to existing --color-* CSS variables. Shared by the
// document rail (P2) and the browser overlay (P3) so both surfaces read identically.
// cyan/yellow/pink have no theme token yet — the hex fallbacks keep the nine swatches
// DISTINCT (they used to alias blue/orange/red, collapsing the picker to six colors).
export const TAB_GROUP_COLOR_VAR: Record<TabGroupColor, string> = {
  blue: 'var(--color-blue)',
  cyan: 'var(--color-cyan, #23B8CE)',
  green: 'var(--color-green)',
  yellow: 'var(--color-yellow, #F0B429)',
  orange: 'var(--color-orange)',
  red: 'var(--color-red)',
  pink: 'var(--color-pink, #EC6BA4)',
  purple: 'var(--color-purple)',
  gray: 'var(--text-gray)',
}

export function tabGroupColorVar(color: TabGroupColor): string {
  return TAB_GROUP_COLOR_VAR[color] ?? TAB_GROUP_COLOR_VAR.blue
}

// A translucent fill of the group color, for group-run backgrounds / drop targets.
export function tabGroupColorSoft(color: TabGroupColor, percent = 12): string {
  return `color-mix(in srgb, ${tabGroupColorVar(color)} ${percent}%, transparent)`
}

// Text color that keeps contrast on a SOLID pill of the group color (Edge-style header).
export function tabGroupPillTextColor(color: TabGroupColor): string {
  return color === 'yellow' ? 'rgba(66, 47, 0, 0.92)' : '#FFFFFF'
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
