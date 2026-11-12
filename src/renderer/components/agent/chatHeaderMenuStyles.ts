import type { CSSProperties } from 'react'

// The chat header's source/history menu is a FloatPanel: the float material (W1 DL4) comes from the panel, so these
// styles carry layout and --rn-* inks only. Rows take --rn-fill on hover (a class, so no inline background blocks
// it); the selected source sits on --rn-fill-2.
export const CHAT_HEADER_MENU_ROW_CLASS = 'transition-colors hover:bg-[var(--rn-fill)]'

export const CHAT_HEADER_MENU_SECTION_LABEL_STYLE: CSSProperties = {
  fontSize: 'var(--rn-fs-2xs)',
  fontWeight: 600,
  letterSpacing: '0.04em',
  color: 'var(--rn-ink-3)',
  padding: '4px 8px 6px',
}

export const CHAT_HEADER_MENU_META_STYLE: CSSProperties = {
  fontSize: 10.5,
  color: 'var(--rn-ink-3)',
  marginTop: 3,
  lineHeight: 1.35,
}

export function buildChatHeaderFloatingMenuStyle(width: number): CSSProperties {
  return {
    width,
    maxHeight: 340,
    padding: 8,
    zIndex: 240,
    pointerEvents: 'auto',
  }
}

export function buildChatHeaderMenuItemStyle(options?: {
  selected?: boolean
}): CSSProperties {
  return {
    padding: '10px 12px',
    minHeight: 52,
    borderRadius: 8,
    border: '1px solid transparent',
    background: options?.selected ? 'var(--rn-fill-2)' : undefined,
    cursor: 'pointer',
    textAlign: 'left',
    width: '100%',
  }
}
