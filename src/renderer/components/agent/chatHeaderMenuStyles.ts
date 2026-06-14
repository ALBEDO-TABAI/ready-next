import type { CSSProperties } from 'react'
import {
  buildFloatingMenuItemStyle,
  buildFloatingMenuSurfaceStyle,
} from '../ui/floatingMenuStyles'

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
  borderRadius: 8,
  opacity: 0.72,
  color: 'var(--text-light)',
  background: 'transparent',
  border: 'none',
  flexShrink: 0,
}

export function buildChatHeaderFloatingMenuStyle(width: number): CSSProperties {
  return buildFloatingMenuSurfaceStyle(width, {
    maxHeight: 340,
    padding: 8,
    zIndex: 240,
  })
}

export function buildChatHeaderMenuItemStyle(options?: {
  selected?: boolean
}): CSSProperties {
  return buildFloatingMenuItemStyle({ selected: options?.selected })
}
