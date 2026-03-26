import type { CSSProperties } from 'react'

const SETTINGS_GLASS_BLUR = 'blur(calc(var(--lg-blur-soft) * 0.9)) saturate(calc(var(--surface-saturate) + 12%))'
const SETTINGS_GLASS_PANEL_BG = 'color-mix(in srgb, var(--surface-panel-bg) 64%, transparent)'
const SETTINGS_GLASS_CARD_BG = 'color-mix(in srgb, var(--surface-card-bg) 78%, transparent)'
const SETTINGS_GLASS_FLOATING_BG = 'color-mix(in srgb, var(--surface-floating-bg) 72%, transparent)'
const SETTINGS_GLASS_BORDER = '1px solid color-mix(in srgb, var(--lg-border-soft) 88%, transparent)'
const SETTINGS_GLASS_BORDER_STRONG = '1px solid color-mix(in srgb, var(--lg-border-strong) 84%, transparent)'
const SETTINGS_GLASS_HIGHLIGHT = 'inset 0 1px 0 color-mix(in srgb, var(--lg-border-strong) 42%, transparent)'

export const SETTINGS_CARD_STYLE: CSSProperties = {
  border: SETTINGS_GLASS_BORDER,
  borderRadius: 24,
  background: SETTINGS_GLASS_CARD_BG,
  boxShadow: `var(--lg-shadow-contact), ${SETTINGS_GLASS_HIGHLIGHT}`,
  backdropFilter: SETTINGS_GLASS_BLUR,
  WebkitBackdropFilter: SETTINGS_GLASS_BLUR,
}

export const SETTINGS_MUTED_CARD_STYLE: CSSProperties = {
  border: '1px solid transparent',
  borderRadius: 24,
  background: 'color-mix(in srgb, var(--surface-panel-bg) 30%, transparent)',
  boxShadow: 'none',
}

export const SETTINGS_PLAIN_SECTION_STYLE: CSSProperties = {
  border: '1px solid transparent',
  borderRadius: 24,
  background: 'color-mix(in srgb, var(--surface-panel-bg) 22%, transparent)',
  boxShadow: 'none',
}

export const SETTINGS_SUBTLE_CARD_STYLE: CSSProperties = {
  border: SETTINGS_GLASS_BORDER,
  borderRadius: 20,
  background: SETTINGS_GLASS_PANEL_BG,
  boxShadow: SETTINGS_GLASS_HIGHLIGHT,
  backdropFilter: SETTINGS_GLASS_BLUR,
  WebkitBackdropFilter: SETTINGS_GLASS_BLUR,
}

export const SETTINGS_INPUT_STYLE: CSSProperties = {
  width: '100%',
  border: '1px solid var(--input-slot-border)',
  borderRadius: 18,
  background: SETTINGS_GLASS_FLOATING_BG,
  boxShadow: `var(--input-slot-shadow), ${SETTINGS_GLASS_HIGHLIGHT}`,
  color: 'var(--text-body)',
  padding: '13px 15px',
  fontSize: 13,
  lineHeight: 1.45,
  outline: 'none',
  backdropFilter: SETTINGS_GLASS_BLUR,
  WebkitBackdropFilter: SETTINGS_GLASS_BLUR,
}

export const SETTINGS_TEXTAREA_STYLE: CSSProperties = {
  ...SETTINGS_INPUT_STYLE,
  minHeight: 220,
  resize: 'vertical',
}

export const SETTINGS_READONLY_STYLE: CSSProperties = {
  ...SETTINGS_INPUT_STYLE,
  background: 'color-mix(in srgb, var(--surface-panel-bg) 66%, var(--bg-canvas) 34%)',
  color: 'var(--text-muted)',
}

const BUTTON_BASE: CSSProperties = {
  minWidth: 108,
  padding: '12px 18px',
  borderRadius: 18,
  fontSize: 13,
  fontWeight: 600,
  lineHeight: 1.35,
  transition: 'transform 160ms ease, filter 160ms ease, opacity 160ms ease, background 160ms ease',
  backdropFilter: SETTINGS_GLASS_BLUR,
  WebkitBackdropFilter: SETTINGS_GLASS_BLUR,
  boxShadow: `var(--lg-shadow-contact), ${SETTINGS_GLASS_HIGHLIGHT}`,
}

export const SETTINGS_PRIMARY_BUTTON_STYLE: CSSProperties = {
  ...BUTTON_BASE,
  border: '1px solid transparent',
  background: 'color-mix(in srgb, var(--color-blue) 84%, var(--surface-floating-bg) 16%)',
  color: '#fff',
}

export const SETTINGS_SECONDARY_BUTTON_STYLE: CSSProperties = {
  ...BUTTON_BASE,
  border: SETTINGS_GLASS_BORDER,
  background: SETTINGS_GLASS_CARD_BG,
  color: 'var(--text-body)',
}

export const SETTINGS_DANGER_BUTTON_STYLE: CSSProperties = {
  ...BUTTON_BASE,
  border: '1px solid color-mix(in srgb, var(--color-red) 34%, var(--lg-border-soft) 66%)',
  background: 'color-mix(in srgb, var(--color-red-light) 70%, var(--surface-card-bg) 30%)',
  color: 'var(--color-red)',
}

export const SETTINGS_BADGE_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '5px 10px',
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 600,
  lineHeight: 1,
}

export const SETTINGS_FIELD_LABEL_STYLE: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--text-title)',
  marginBottom: 6,
}

export const SETTINGS_FIELD_HINT_STYLE: CSSProperties = {
  fontSize: 11,
  lineHeight: 1.6,
  color: 'var(--text-muted)',
}

export const SETTINGS_TITLE_STYLE: CSSProperties = {
  fontSize: 16,
  fontWeight: 700,
  color: 'var(--text-title)',
}

export const SETTINGS_SECTION_LEAD_STYLE: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.7,
  color: 'var(--text-muted)',
}

export function settingsNoticeStyle(kind: 'error' | 'success'): CSSProperties {
  return {
    ...SETTINGS_SUBTLE_CARD_STYLE,
    padding: '12px 14px',
    border: `1px solid ${kind === 'error'
      ? 'color-mix(in srgb, var(--color-red) 22%, transparent)'
      : 'color-mix(in srgb, var(--color-green) 24%, transparent)'}`,
    color: kind === 'error' ? 'var(--color-red)' : 'var(--color-green)',
    background: kind === 'error'
      ? 'color-mix(in srgb, var(--color-red-light) 68%, var(--surface-card-bg) 32%)'
      : 'color-mix(in srgb, var(--color-green-light) 68%, var(--surface-card-bg) 32%)',
  }
}

export function settingsListItemStyle(active: boolean): CSSProperties {
  return {
    padding: '14px 8px',
    borderRadius: 18,
    background: 'transparent',
    border: '1px solid transparent',
    boxShadow: 'none',
    backdropFilter: 'none',
    WebkitBackdropFilter: 'none',
    opacity: active ? 1 : 0.9,
  }
}
