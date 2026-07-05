import type { ReactNode } from 'react'

export interface SettingSection {
  id: string
  title: string
  icon: React.ElementType
  description: string
  settings: SettingItem[]
}

export interface SettingItem {
  id: string
  label: string
  description?: string
  type: 'toggle' | 'select' | 'text' | 'button' | 'readonly'
  value?: boolean | string
  options?: { value: string; label: string }[]
  buttonLabel?: string
  buttonVariant?: 'default' | 'danger' | 'primary'
}

// 设置行右侧控件的统一最小宽度：上下相邻的按钮/只读值/下拉对齐成一列，
// 允许小幅宽度浪费换取整洁（2026-06-10 用户标准）。
export const SETTINGS_ROW_CONTROL_MIN_WIDTH = 136

export function AISettingsFieldCard({
  title,
  description,
  control,
  wide = false,
}: {
  title: string
  description: ReactNode
  control: ReactNode
  wide?: boolean
}) {
  return (
    <div
      className={`settings-ai-light-card ${wide ? 'md:col-span-2' : ''}`}
      style={{
        borderBottom: '1px solid color-mix(in srgb, var(--surface-border) 12%, transparent)',
        padding: '0 0 18px',
      }}
    >
      <div className="min-w-0">
        <div className="text-[13px] font-semibold" style={{ color: 'var(--text-title)' }}>{title}</div>
        <div className="mt-1.5 text-[12px] leading-5" style={{ color: 'var(--text-light)', maxWidth: 560 }}>{description}</div>
      </div>
      <div className="mt-3.5 min-w-0">{control}</div>
    </div>
  )
}

export function SettingsSwitch({
  checked,
  onChange,
  label,
  stopPropagation = false,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
  stopPropagation?: boolean
}) {
  return (
    <label
      className="group/switch inline-flex cursor-pointer items-center gap-2 text-[11px] font-medium"
      style={{ color: 'var(--text-light)' }}
      onClick={(event) => {
        if (stopPropagation) event.stopPropagation()
      }}
    >
      {label && <span>{label}</span>}
      <span
        className="relative inline-flex h-6 w-11 shrink-0 rounded-full border transition-[background-color,border-color,filter] group-hover/switch:brightness-[0.96]"
        style={{
          borderColor: checked
            ? 'color-mix(in srgb, var(--color-blue) 42%, transparent)'
            : 'color-mix(in srgb, var(--surface-border) 68%, transparent)',
          background: checked
            ? 'color-mix(in srgb, var(--color-blue) 78%, var(--surface-floating-bg) 22%)'
            : 'color-mix(in srgb, var(--surface-floating-bg) 72%, var(--bg-content) 28%)',
        }}
      >
        <span
          className="absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform"
          style={{ transform: checked ? 'translateX(20px)' : 'translateX(3px)' }}
        />
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="sr-only"
      />
    </label>
  )
}
