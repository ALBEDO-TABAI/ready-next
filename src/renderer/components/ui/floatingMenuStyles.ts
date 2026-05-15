import type { CSSProperties } from 'react'

interface FloatingMenuSurfaceOptions {
  maxHeight?: number
  minWidth?: number
  padding?: number
  zIndex?: number
}

interface FloatingMenuItemOptions {
  compact?: boolean
  selected?: boolean
}

export function buildFloatingMenuSurfaceStyle(
  width: number,
  options?: FloatingMenuSurfaceOptions,
): CSSProperties {
  return {
    width,
    minWidth: options?.minWidth,
    maxHeight: options?.maxHeight ?? 340,
    overflowY: 'auto',
    background: 'var(--chat-menu-frost-bg, color-mix(in srgb, var(--surface-floating-bg) 94%, rgba(255,255,255,0.2)))',
    border: '1px solid var(--chat-menu-frost-border, color-mix(in srgb, var(--border-default) 78%, rgba(255,255,255,0.48)))',
    borderRadius: 16,
    boxShadow:
      'var(--chat-menu-shadow, 0 14px 32px rgba(24, 39, 77, 0.10), 0 4px 10px rgba(24, 39, 77, 0.04), inset 0 1px 0 rgba(255,255,255,0.38))',
    padding: options?.padding ?? 8,
    zIndex: options?.zIndex ?? 240,
    pointerEvents: 'auto',
  }
}

export function buildFloatingMenuItemStyle(options?: FloatingMenuItemOptions): CSSProperties {
  const compact = Boolean(options?.compact)
  const selected = Boolean(options?.selected)

  return {
    padding: compact ? '8px 12px' : '10px 12px',
    minHeight: compact ? 36 : 52,
    borderRadius: compact ? 10 : 12,
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

export function buildFloatingMenuCheckStyle(checked: boolean): CSSProperties {
  return {
    width: 14,
    height: 14,
    borderRadius: 4,
    border: checked
      ? '1px solid color-mix(in srgb, var(--text-light) 34%, var(--surface-border) 66%)'
      : '1px solid color-mix(in srgb, var(--border-default) 88%, transparent)',
    background: checked
      ? 'color-mix(in srgb, var(--surface-floating-bg) 84%, var(--text-light) 16%)'
      : 'color-mix(in srgb, var(--surface-floating-bg) 62%, transparent)',
    boxShadow: checked
      ? '0 4px 10px rgba(24, 39, 77, 0.08), inset 0 1px 0 color-mix(in srgb, var(--text-light) 18%, transparent)'
      : 'inset 0 1px 0 color-mix(in srgb, var(--surface-border) 24%, transparent)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--text-body)',
    fontSize: 10,
    lineHeight: 1,
    flexShrink: 0,
  }
}
