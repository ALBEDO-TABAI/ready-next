export const VERTICAL_RAIL_FLYOUT_PAD_Y = 6
export const VERTICAL_RAIL_FLYOUT_ROW_HEIGHT = 38
export const VERTICAL_RAIL_FLYOUT_ROW_GAP = 4
export const VERTICAL_RAIL_FLYOUT_RADIUS = 14
export const VERTICAL_RAIL_FLYOUT_ROW_RADIUS = 10
export const VERTICAL_RAIL_FLYOUT_MIN_HEIGHT =
  VERTICAL_RAIL_FLYOUT_PAD_Y * 2 + VERTICAL_RAIL_FLYOUT_ROW_HEIGHT

// Group headers in the flyout are shorter than tab rows (Edge-style pill row).
export const VERTICAL_RAIL_FLYOUT_GROUP_HEADER_HEIGHT = 28

// Height of the flyout content when it holds group headers + (non-collapsed) tab
// rows + the trailing new-tab action. Headers and tab rows have different heights,
// so the flat tabCount×ROW_HEIGHT model above cannot be reused for grouped rails.
export function resolveGroupedFlyoutContentHeight(visibleTabRows: number, headerRows: number): number {
  const tabRows = Math.max(0, Math.floor(visibleTabRows)) + 1 // + trailing new-tab action
  const headers = Math.max(0, Math.floor(headerRows))
  const totalRows = tabRows + headers
  return (
    VERTICAL_RAIL_FLYOUT_PAD_Y * 2 +
    tabRows * VERTICAL_RAIL_FLYOUT_ROW_HEIGHT +
    headers * VERTICAL_RAIL_FLYOUT_GROUP_HEADER_HEIGHT +
    Math.max(0, totalRows - 1) * VERTICAL_RAIL_FLYOUT_ROW_GAP
  )
}

export const VERTICAL_RAIL_FLYOUT_SURFACE_BACKGROUND =
  'var(--chat-menu-frost-bg, rgba(236, 239, 243, 0.92))'

// Opaque variant for CHILD-WINDOW surfaces (the browser rail's hover flyout): a
// transparent BrowserWindow cannot backdrop-blur the screen behind it, so the frost
// tint alone lets the live page bleed through the panel. Layer the tint over a solid
// content background instead — same hue, no bleed.
export const VERTICAL_RAIL_FLYOUT_SURFACE_BACKGROUND_OPAQUE =
  `linear-gradient(${VERTICAL_RAIL_FLYOUT_SURFACE_BACKGROUND}, ${VERTICAL_RAIL_FLYOUT_SURFACE_BACKGROUND}), var(--bg-content)`

export const VERTICAL_RAIL_FLYOUT_SURFACE_BORDER =
  '0.5px solid var(--chat-menu-frost-border, rgba(255, 255, 255, 0.42))'

export const VERTICAL_RAIL_FLYOUT_SURFACE_SHADOW =
  'var(--chat-menu-shadow, 0 24px 48px rgba(31, 36, 46, 0.16))'

export const VERTICAL_RAIL_FLYOUT_SURFACE_BACKDROP =
  'blur(calc(var(--lg-blur-strong, 24px) * 1.12)) saturate(calc(var(--surface-saturate, 132%) + 8%)) contrast(1.02)'

export function resolveVerticalRailFlyoutContentHeight(tabCount: number): number {
  const rows = Math.max(0, Math.floor(tabCount)) + 1
  return (
    VERTICAL_RAIL_FLYOUT_PAD_Y * 2 +
    rows * VERTICAL_RAIL_FLYOUT_ROW_HEIGHT +
    Math.max(0, rows - 1) * VERTICAL_RAIL_FLYOUT_ROW_GAP
  )
}

export function resolveVerticalRailFlyoutHeight(tabCount: number, maxHeight: number): number {
  const desiredHeight = resolveVerticalRailFlyoutContentHeight(tabCount)
  const boundedMaxHeight = Math.max(VERTICAL_RAIL_FLYOUT_MIN_HEIGHT, Math.round(maxHeight))
  return Math.min(boundedMaxHeight, desiredHeight)
}

export function resolveVerticalRailFlyoutScrollOffset(scrollTop: number, tabCount: number, renderedHeight: number): number {
  const maxOffset = Math.max(0, resolveVerticalRailFlyoutContentHeight(tabCount) - Math.round(renderedHeight))
  return Math.max(0, Math.min(Math.round(scrollTop), maxOffset))
}
