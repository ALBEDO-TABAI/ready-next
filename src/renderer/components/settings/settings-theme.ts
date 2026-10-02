import type { CSSProperties } from 'react'

// Settings 设计 token 的 inline 兼容层。
// 真值在 styles/settings-surfaces.css（根上的 --sx-* 变量与 sx-* 组件类）：
//   分组卡 sx-card → 凹陷槽 slot（输入）/ 浮起 control（按钮）/ 轨道 track（分段、开关）；
//   全部用填充与投影区分层次，不画深色描边。
// 新代码优先用 sx-* 类与 settings-shared.tsx 的组件（hover / focus / active 只能在类上统一）；
// 这里的常量只给仍需 inline 组合的场景，取值全部指向同一组 --sx-* 变量，保证材质一致。
// 圆角 16（分组卡）/ 12（嵌套面）/ 10（输入、按钮）；字号 11/12/13/14/20。

const SX_CONTROL_EDGE = '0.5px solid var(--sx-control-edge)'

export const SETTINGS_RADIUS_CARD = 16
export const SETTINGS_RADIUS_CONTROL = 10

const SETTINGS_CONTROL_TRANSITION =
  'transform var(--duration-fast) ease, opacity var(--duration-fast) ease, background-color var(--duration-fast) ease, border-color var(--duration-fast) ease, color var(--duration-fast) ease'

export const SETTINGS_CARD_STYLE: CSSProperties = {
  border: 'none',
  borderRadius: SETTINGS_RADIUS_CARD,
  background: 'var(--sx-card-bg)',
  boxShadow: 'var(--sx-card-shadow)',
}

export const SETTINGS_MUTED_CARD_STYLE: CSSProperties = {
  border: 'none',
  borderRadius: SETTINGS_RADIUS_CARD,
  background: 'var(--sx-inset-bg)',
  boxShadow: 'none',
}

export const SETTINGS_PLAIN_SECTION_STYLE: CSSProperties = {
  border: 'none',
  borderRadius: SETTINGS_RADIUS_CARD,
  background: 'transparent',
  boxShadow: 'none',
}

export const SETTINGS_SUBTLE_CARD_STYLE: CSSProperties = {
  border: 'none',
  borderRadius: 12,
  background: 'var(--sx-inset-bg)',
  boxShadow: 'none',
}

export const SETTINGS_FLAT_CARD_STYLE: CSSProperties = {
  ...SETTINGS_SUBTLE_CARD_STYLE,
}

export const SETTINGS_FLAT_CHIP_STYLE: CSSProperties = {
  border: SX_CONTROL_EDGE,
  background: 'var(--sx-control-bg)',
  boxShadow: 'none',
}

export const SETTINGS_INPUT_STYLE: CSSProperties = {
  width: '100%',
  border: 'none',
  borderRadius: SETTINGS_RADIUS_CONTROL,
  background: 'var(--sx-slot-bg)',
  boxShadow: 'var(--sx-slot-inset)',
  color: 'var(--sx-body)',
  padding: '8px 12px',
  fontSize: 13,
  lineHeight: 1.45,
  outline: 'none',
}

export const SETTINGS_FLAT_INPUT_STYLE: CSSProperties = {
  ...SETTINGS_INPUT_STYLE,
}

export const SETTINGS_TEXTAREA_STYLE: CSSProperties = {
  ...SETTINGS_INPUT_STYLE,
  minHeight: 220,
  resize: 'vertical',
}

export const SETTINGS_READONLY_STYLE: CSSProperties = {
  ...SETTINGS_INPUT_STYLE,
  background: 'var(--sx-inset-bg)',
  boxShadow: 'none',
  border: 'none',
  color: 'var(--sx-muted)',
}

const BUTTON_BASE: CSSProperties = {
  padding: '7px 14px',
  borderRadius: SETTINGS_RADIUS_CONTROL,
  fontSize: 12.5,
  fontWeight: 500,
  lineHeight: 1.4,
  transition: SETTINGS_CONTROL_TRANSITION,
}

export const SETTINGS_FLAT_BUTTON_STYLE: CSSProperties = {
  ...BUTTON_BASE,
  padding: '6px 12px',
  border: SX_CONTROL_EDGE,
  background: 'var(--sx-control-bg)',
  boxShadow: 'var(--sx-control-shadow)',
  color: 'var(--sx-body)',
}

export const SETTINGS_PRIMARY_BUTTON_STYLE: CSSProperties = {
  ...BUTTON_BASE,
  fontWeight: 600,
  border: 'none',
  background: 'var(--sx-ink)',
  boxShadow: '0 1px 2px rgba(15, 18, 24, 0.18)',
  color: 'var(--sx-on-ink)',
}

export const SETTINGS_SECONDARY_BUTTON_STYLE: CSSProperties = {
  ...BUTTON_BASE,
  border: SX_CONTROL_EDGE,
  background: 'var(--sx-control-bg)',
  boxShadow: 'var(--sx-control-shadow)',
  color: 'var(--sx-body)',
}

export const SETTINGS_DANGER_BUTTON_STYLE: CSSProperties = {
  ...BUTTON_BASE,
  border: SX_CONTROL_EDGE,
  background: 'var(--sx-control-bg)',
  boxShadow: 'var(--sx-control-shadow)',
  color: 'var(--sx-danger-text)',
}

export const SETTINGS_BADGE_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 10px',
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 500,
  lineHeight: 1.4,
}

export const SETTINGS_FIELD_LABEL_STYLE: CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--sx-body)',
  marginBottom: 6,
}

export const SETTINGS_FIELD_HINT_STYLE: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.6,
  color: 'var(--sx-muted)',
}

export const SETTINGS_TITLE_STYLE: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--sx-title)',
}

export const SETTINGS_SECTION_LEAD_STYLE: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.7,
  color: 'var(--sx-muted)',
}

export function settingsNoticeStyle(kind: 'error' | 'success'): CSSProperties {
  return {
    border: 'none',
    borderRadius: 12,
    padding: '10px 14px',
    background: kind === 'error' ? 'var(--sx-danger-wash)' : 'var(--sx-inset-bg)',
    boxShadow: 'none',
    color: kind === 'error' ? 'var(--sx-danger-text)' : 'var(--sx-body)',
  }
}

export function settingsListItemStyle(active: boolean): CSSProperties {
  return {
    // 不写 background，让 sx-nav-item 的 hover / aria-current 类规则生效（inline 样式会盖掉 :hover）。
    opacity: active ? 1 : 0.94,
  }
}
