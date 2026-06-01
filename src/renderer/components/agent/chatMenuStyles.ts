import type { CSSProperties } from 'react'

export const chatMenuSurfaceStyle: CSSProperties = {
  background: 'var(--chat-menu-frost-bg, color-mix(in srgb, var(--bg-primary) 90%, transparent))',
  border: '1px solid var(--chat-menu-frost-border, var(--border-default))',
  borderRadius: 14,
  boxShadow: 'var(--chat-menu-shadow, 0 18px 36px rgba(0,0,0,0.24))',
  padding: 6,
  backgroundClip: 'padding-box',
  backdropFilter: 'blur(calc(var(--lg-blur-strong, 24px) * 1.12)) saturate(calc(var(--surface-saturate, 132%) + 8%)) contrast(1.02)',
  WebkitBackdropFilter: 'blur(calc(var(--lg-blur-strong, 24px) * 1.12)) saturate(calc(var(--surface-saturate, 132%) + 8%)) contrast(1.02)',
}

export const chatMenuItemStyle: CSSProperties = {
  padding: '7px 10px',
  borderRadius: 6,
  border: '1px solid transparent',
  background: 'transparent',
  cursor: 'pointer',
}
