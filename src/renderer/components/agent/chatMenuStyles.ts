import type { CSSProperties } from 'react'

// The assistant's in-place menus (the @ and slash lists that follow typing, the authorization, model and project
// pickers) sit in a FloatPanel, which brings the float material (W1 DL4); they add no surface styling of their own.
// Rows look like the shared menu's items: --rn-fill-2 on hover and when highlighted (`data-highlighted="true"`: the
// keyboard choice or the current option). The look lives in classes, not inline backgrounds, so hover still applies.
export const chatMenuSurfaceStyle: CSSProperties = {
  padding: 6,
}

export const chatMenuItemStyle: CSSProperties = {
  padding: '7px 10px',
  borderRadius: 8,
  border: '1px solid transparent',
  cursor: 'pointer',
}

export const CHAT_MENU_ITEM_CLASS =
  'w-full bg-transparent text-left text-[var(--rn-ink)] transition-colors hover:bg-[var(--rn-fill-2)] data-[highlighted=true]:bg-[var(--rn-fill-2)] disabled:cursor-default disabled:opacity-45'
