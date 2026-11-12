import type { TabGroupColor } from '../../../shared/tab-groups'

// A tab group's colour is a colour the person gave their own content, so it comes from the user-content
// palette (modules/document/content-palette.css, `--doc-<colour>-fg/-bg`, W1 §6), not from the interface
// tokens. The palette has no cyan; it is the blue–green midpoint so the nine swatches stay distinct.
// Shared by the browser's tab list and the group edit menu; TabGroupHeaderRow loads the palette.
export const TAB_GROUP_COLOR_VAR: Record<TabGroupColor, string> = {
  blue: 'var(--doc-blue-fg)',
  cyan: 'color-mix(in srgb, var(--doc-blue-fg), var(--doc-green-fg))',
  green: 'var(--doc-green-fg)',
  yellow: 'var(--doc-yellow-fg)',
  orange: 'var(--doc-orange-fg)',
  red: 'var(--doc-red-fg)',
  pink: 'var(--doc-pink-fg)',
  purple: 'var(--doc-purple-fg)',
  gray: 'var(--doc-gray-fg)',
}

// The quiet fill of each colour (the palette's tag background, light and dark).
const TAB_GROUP_COLOR_BG: Record<TabGroupColor, string> = {
  blue: 'var(--doc-blue-bg)',
  cyan: 'color-mix(in srgb, var(--doc-blue-bg), var(--doc-green-bg))',
  green: 'var(--doc-green-bg)',
  yellow: 'var(--doc-yellow-bg)',
  orange: 'var(--doc-orange-bg)',
  red: 'var(--doc-red-bg)',
  pink: 'var(--doc-pink-bg)',
  purple: 'var(--doc-purple-bg)',
  gray: 'var(--doc-gray-bg)',
}

export function tabGroupColorVar(color: TabGroupColor): string {
  return TAB_GROUP_COLOR_VAR[color] ?? TAB_GROUP_COLOR_VAR.blue
}

// A translucent fill of the group color, for group-run backgrounds / drop targets.
export function tabGroupColorSoft(color: TabGroupColor, percent = 12): string {
  return `color-mix(in srgb, ${tabGroupColorVar(color)} ${percent}%, transparent)`
}

// The group header is a tag in its colour, the way the palette draws a database option: the colour's
// quiet fill with the colour as text (readable in both themes, no white-on-yellow).
export function tabGroupPillBackground(color: TabGroupColor): string {
  return TAB_GROUP_COLOR_BG[color] ?? TAB_GROUP_COLOR_BG.blue
}

export function tabGroupPillTextColor(color: TabGroupColor): string {
  return tabGroupColorVar(color)
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
