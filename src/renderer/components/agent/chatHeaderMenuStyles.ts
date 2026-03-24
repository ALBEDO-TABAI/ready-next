import type { CSSProperties } from 'react'

export const CHAT_HEADER_MENU_SECTION_LABEL_STYLE: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: '0.04em',
  color: 'var(--text-light)',
  padding: '4px 8px 6px',
}

export const CHAT_HEADER_MENU_META_STYLE: CSSProperties = {
  fontSize: 10.5,
  color: 'var(--text-light)',
  marginTop: 3,
  lineHeight: 1.35,
}

export const CHAT_HEADER_MENU_DELETE_BUTTON_STYLE: CSSProperties = {
  width: 20,
  height: 20,
  borderRadius: 10,
  opacity: 0.72,
  color: 'var(--text-light)',
  background: 'transparent',
  border: 'none',
  flexShrink: 0,
}

export function buildChatHeaderFloatingMenuStyle(width: number): CSSProperties {
  return {
    width,
    maxHeight: 340,
    overflowY: 'auto',
    background: 'color-mix(in srgb, var(--surface-floating-bg) 88%, rgba(255,255,255,0.18))',
    border: '1px solid color-mix(in srgb, var(--border-default) 76%, rgba(255,255,255,0.45))',
    borderRadius: 16,
    boxShadow: '0 18px 48px rgba(15, 23, 42, 0.16), 0 2px 10px rgba(15, 23, 42, 0.06)',
    padding: 8,
    zIndex: 240,
    pointerEvents: 'auto',
  }
}

export function buildChatHeaderMenuItemStyle(options?: {
  selected?: boolean
}): CSSProperties {
  const selected = Boolean(options?.selected)

  return {
    padding: '10px 12px',
    minHeight: 52,
    borderRadius: 12,
    border: selected
      ? '1px solid var(--chat-menu-selected-border, rgba(222,228,236,0.34))'
      : '1px solid transparent',
    background: selected
      ? 'var(--chat-menu-selected-bg, rgba(239,242,246,0.5))'
      : 'transparent',
    cursor: 'pointer',
    textAlign: 'left',
    width: '100%',
  }
}
