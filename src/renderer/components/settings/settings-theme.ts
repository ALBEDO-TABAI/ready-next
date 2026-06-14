import type { CSSProperties } from 'react'

// Settings 设计 token，与工作台尺度对齐：
// 圆角 16（分区卡片）/ 12（嵌套面、输入框、按钮）/ 10（紧凑控件）；
// 字号 11/12/13/15/20；过渡统一走 --duration-fast。

const SETTINGS_GLASS_BLUR = 'blur(calc(var(--lg-blur-soft) * 0.9)) saturate(calc(var(--surface-saturate) + 12%))'
const SETTINGS_GLASS_PANEL_BG = 'color-mix(in srgb, var(--surface-panel-bg) 64%, transparent)'
const SETTINGS_GLASS_CARD_BG = 'color-mix(in srgb, var(--surface-card-bg) 78%, transparent)'
const SETTINGS_GLASS_FLOATING_BG = 'color-mix(in srgb, var(--surface-floating-bg) 72%, transparent)'
const SETTINGS_GLASS_BORDER = '1px solid color-mix(in srgb, var(--lg-border-soft) 88%, transparent)'
const SETTINGS_GLASS_HIGHLIGHT = 'inset 0 1px 0 color-mix(in srgb, var(--lg-border-strong) 42%, transparent)'

export const SETTINGS_RADIUS_CARD = 16
export const SETTINGS_RADIUS_CONTROL = 12

const SETTINGS_CONTROL_TRANSITION =
  'transform var(--duration-fast) ease, filter var(--duration-fast) ease, opacity var(--duration-fast) ease, background var(--duration-fast) ease, border-color var(--duration-fast) ease'

export const SETTINGS_CARD_STYLE: CSSProperties = {
  border: SETTINGS_GLASS_BORDER,
  borderRadius: SETTINGS_RADIUS_CARD,
  background: SETTINGS_GLASS_CARD_BG,
  boxShadow: `var(--lg-shadow-contact), ${SETTINGS_GLASS_HIGHLIGHT}`,
  backdropFilter: SETTINGS_GLASS_BLUR,
  WebkitBackdropFilter: SETTINGS_GLASS_BLUR,
}

export const SETTINGS_MUTED_CARD_STYLE: CSSProperties = {
  border: '1px solid transparent',
  borderRadius: SETTINGS_RADIUS_CARD,
  background: 'color-mix(in srgb, var(--surface-panel-bg) 30%, transparent)',
  boxShadow: 'none',
}

export const SETTINGS_PLAIN_SECTION_STYLE: CSSProperties = {
  border: '1px solid transparent',
  borderRadius: SETTINGS_RADIUS_CARD,
  background: 'color-mix(in srgb, var(--surface-panel-bg) 22%, transparent)',
  boxShadow: 'none',
}

export const SETTINGS_SUBTLE_CARD_STYLE: CSSProperties = {
  border: SETTINGS_GLASS_BORDER,
  borderRadius: SETTINGS_RADIUS_CONTROL,
  background: SETTINGS_GLASS_PANEL_BG,
  boxShadow: SETTINGS_GLASS_HIGHLIGHT,
  backdropFilter: SETTINGS_GLASS_BLUR,
  WebkitBackdropFilter: SETTINGS_GLASS_BLUR,
}

export const SETTINGS_FLAT_CARD_STYLE: CSSProperties = {
  border: '1px solid color-mix(in srgb, var(--surface-border) 58%, transparent)',
  borderRadius: SETTINGS_RADIUS_CONTROL,
  background: 'color-mix(in srgb, var(--surface-card-bg) 82%, var(--bg-content) 18%)',
  boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--lg-border-strong) 26%, transparent)',
  backdropFilter: 'none',
  WebkitBackdropFilter: 'none',
}

export const SETTINGS_FLAT_CHIP_STYLE: CSSProperties = {
  border: '1px solid color-mix(in srgb, var(--surface-border) 62%, transparent)',
  background: 'color-mix(in srgb, var(--surface-floating-bg) 72%, var(--bg-content) 28%)',
  boxShadow: 'none',
  backdropFilter: 'none',
  WebkitBackdropFilter: 'none',
}

export const SETTINGS_FLAT_INPUT_STYLE: CSSProperties = {
  width: '100%',
  border: '1px solid var(--input-slot-border)',
  borderRadius: SETTINGS_RADIUS_CONTROL,
  background: 'color-mix(in srgb, var(--surface-floating-bg) 78%, var(--bg-editor) 22%)',
  boxShadow: 'var(--input-slot-shadow)',
  color: 'var(--text-body)',
  padding: '9px 12px',
  fontSize: 13,
  lineHeight: 1.45,
  outline: 'none',
  backdropFilter: 'none',
  WebkitBackdropFilter: 'none',
}

export const SETTINGS_FLAT_BUTTON_STYLE: CSSProperties = {
  padding: '6px 12px',
  borderRadius: 8,
  fontSize: 12,
  fontWeight: 500,
  lineHeight: 1.4,
  transition: SETTINGS_CONTROL_TRANSITION,
  border: '1px solid color-mix(in srgb, var(--surface-border) 58%, transparent)',
  background: 'color-mix(in srgb, var(--surface-card-bg) 76%, var(--bg-content) 24%)',
  color: 'var(--text-body)',
  boxShadow: 'none',
  backdropFilter: 'none',
  WebkitBackdropFilter: 'none',
}

export const SETTINGS_INPUT_STYLE: CSSProperties = {
  width: '100%',
  border: '1px solid var(--input-slot-border)',
  borderRadius: SETTINGS_RADIUS_CONTROL,
  background: SETTINGS_GLASS_FLOATING_BG,
  boxShadow: `var(--input-slot-shadow), ${SETTINGS_GLASS_HIGHLIGHT}`,
  color: 'var(--text-body)',
  padding: '9px 12px',
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
  padding: '8px 16px',
  borderRadius: SETTINGS_RADIUS_CONTROL,
  fontSize: 13,
  fontWeight: 500,
  lineHeight: 1.4,
  transition: SETTINGS_CONTROL_TRANSITION,
  backdropFilter: SETTINGS_GLASS_BLUR,
  WebkitBackdropFilter: SETTINGS_GLASS_BLUR,
  boxShadow: `var(--lg-shadow-contact), ${SETTINGS_GLASS_HIGHLIGHT}`,
}

export const SETTINGS_PRIMARY_BUTTON_STYLE: CSSProperties = {
  ...BUTTON_BASE,
  fontWeight: 600,
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
  padding: '4px 10px',
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 600,
  lineHeight: 1.4,
}

export const SETTINGS_FIELD_LABEL_STYLE: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--text-title)',
  marginBottom: 6,
}

export const SETTINGS_FIELD_HINT_STYLE: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.6,
  color: 'var(--text-muted)',
}

export const SETTINGS_TITLE_STYLE: CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
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
    padding: '10px 14px',
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
    borderRadius: 16,
    // 不写 background，让 hover 类生效（inline 样式会盖掉 :hover）。
    border: '1px solid transparent',
    boxShadow: 'none',
    backdropFilter: 'none',
    WebkitBackdropFilter: 'none',
    opacity: active ? 1 : 0.9,
  }
}
