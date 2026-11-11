import type { ReactNode } from 'react'
import { AlertCircle, AlertTriangle, Info } from 'lucide-react'

export interface SettingSection {
  id: string
  title: string
  icon: React.ElementType
  description: string
  group: SettingsNavGroup
  settings: SettingItem[]
}

export type SettingsNavGroup = 'general' | 'intelligence' | 'content' | 'privacy' | 'about'

export const SETTINGS_NAV_GROUP_LABELS: Record<SettingsNavGroup, string> = {
  general: '通用',
  intelligence: '助手',
  content: '内容',
  privacy: '隐私与数据',
  about: '关于',
}

export interface SettingItem {
  id: string
  label: string
  description?: string
  type: 'toggle' | 'button' | 'readonly'
  value?: boolean | string
  options?: { value: string; label: string }[]
  buttonLabel?: string
  buttonVariant?: 'default' | 'danger' | 'primary'
}

// 设置行右侧控件的统一最小宽度：上下相邻的按钮/只读值/下拉对齐成一列，
// 允许小幅宽度浪费换取整洁（2026-06-10 用户标准）。
export const SETTINGS_ROW_CONTROL_MIN_WIDTH = 136

export type SettingsButtonVariant = 'secondary' | 'primary' | 'ghost' | 'accent' | 'danger' | 'danger-ghost' | 'danger-quiet'

/**
 * 设置页按钮的唯一类名入口（样式见 styles/settings-surfaces.css 的 sx-btn）。
 * primary = 墨色关键行动（每个视图一个）；secondary = 玻璃次要行动；ghost = 行内安静操作；
 * accent = 强调色文字的玻璃按钮；danger / danger-ghost = 破坏性操作（红字，不铺红块）；
 * danger-quiet = 行内删除/解绑：平时与 ghost 相同，hover 才露红。
 */
export function settingsButtonClass(
  variant: SettingsButtonVariant = 'secondary',
  options: { size?: 'md' | 'sm'; icon?: boolean; block?: boolean; className?: string } = {},
): string {
  const classes = ['sx-btn']
  if (variant === 'primary') classes.push('sx-btn--primary')
  if (variant === 'ghost') classes.push('sx-btn--ghost')
  if (variant === 'accent') classes.push('sx-btn--accent')
  if (variant === 'danger') classes.push('sx-btn--danger')
  if (variant === 'danger-ghost') classes.push('sx-btn--danger', 'sx-btn--ghost')
  if (variant === 'danger-quiet') classes.push('sx-btn--ghost', 'sx-btn--quiet-danger')
  if (options.size === 'sm') classes.push('sx-btn--sm')
  if (options.icon) classes.push('sx-btn--icon')
  if (options.block) classes.push('sx-btn--block')
  if (options.className) classes.push(options.className)
  return classes.join(' ')
}

/** 一组设置的玻璃卡片。title 存在时渲染卡头，children 通常是若干 SettingsRow。 */
export function SettingsCard({
  title,
  description,
  actions,
  children,
  padded = false,
  className = '',
  ...rest
}: {
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  padded?: boolean
  className?: string
} & Omit<React.HTMLAttributes<HTMLElement>, 'title'>) {
  return (
    <section className={`sx-card ${padded ? 'sx-card--pad' : ''} ${className}`.trim()} {...rest}>
      {(title || actions) && (
        <div className="sx-card__header">
          <div className="min-w-0">
            {title && <h3 className="sx-card-title">{title}</h3>}
            {description && <p className="sx-card-desc">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  )
}

/** 卡片里的一行：左侧标题与说明，右侧控件。stack=true 时控件换到下方整宽。 */
export function SettingsRow({
  label,
  description,
  children,
  stack = false,
  className = '',
  ...rest
}: {
  label: ReactNode
  description?: ReactNode
  children?: ReactNode
  stack?: boolean
  className?: string
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`sx-row ${stack ? 'sx-row--stack' : ''} ${className}`.trim()} {...rest}>
      <div className="sx-row__text">
        <div className="sx-row__label">{label}</div>
        {description && <div className="sx-row__desc">{description}</div>}
      </div>
      {children !== undefined && children !== null && (
        <div className={stack ? 'min-w-0' : 'sx-row__control'}>{children}</div>
      )}
    </div>
  )
}

/** 卡片上方的分组小标题。 */
export function SettingsGroup({
  label,
  hint,
  children,
  className = '',
}: {
  label?: ReactNode
  hint?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div className={`sx-group ${className}`.trim()}>
      {label && (
        <div className="sx-group-label">
          <span>{label}</span>
          {hint && <small>{hint}</small>}
        </div>
      )}
      {children}
    </div>
  )
}

export interface SettingsSegmentedOption<T extends string> {
  value: T
  label: ReactNode
  icon?: React.ElementType
  count?: ReactNode
  disabled?: boolean
  title?: string
}

/** 分段控件：凹槽轨道 + 白色玻璃滑块。kind='tabs' 输出 tablist 语义，否则为 radiogroup。 */
export function SettingsSegmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  kind = 'radio',
  block = false,
  className = '',
}: {
  options: readonly SettingsSegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  ariaLabel: string
  kind?: 'radio' | 'tabs'
  block?: boolean
  className?: string
}) {
  return (
    <div
      role={kind === 'tabs' ? 'tablist' : 'radiogroup'}
      aria-label={ariaLabel}
      className={`sx-seg ${block ? 'sx-seg--block' : ''} ${className}`.trim()}
    >
      {options.map((option) => {
        const active = option.value === value
        const Icon = option.icon
        return (
          <button
            key={option.value}
            type="button"
            role={kind === 'tabs' ? 'tab' : 'radio'}
            {...(kind === 'tabs' ? { 'aria-selected': active } : { 'aria-checked': active })}
            disabled={option.disabled}
            title={option.title}
            className="sx-seg__item"
            onClick={() => onChange(option.value)}
          >
            {Icon && <Icon strokeWidth={1.9} />}
            {option.label}
            {option.count !== undefined && <span className="sx-seg__count">{option.count}</span>}
          </button>
        )
      })}
    </div>
  )
}

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
    <div className={`settings-ai-light-card sx-field ${wide ? 'md:col-span-2' : ''}`}>
      <div className="min-w-0">
        <div className="sx-row__label">{title}</div>
        <div className="sx-row__desc">{description}</div>
      </div>
      <div className="mt-1.5 min-w-0">{control}</div>
    </div>
  )
}

/** 开关：button[role=switch] + aria-checked；「开」是墨色轨道（与主按钮同源），不用强调色铺面。 */
export function SettingsSwitch({
  checked,
  onChange,
  label,
  stopPropagation = false,
  disabled = false,
  ariaLabel,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
  stopPropagation?: boolean
  disabled?: boolean
  ariaLabel?: string
}) {
  const control = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel ?? label}
      disabled={disabled}
      className="sx-switch"
      data-checked={checked ? 'true' : 'false'}
      onClick={(event) => {
        if (stopPropagation) event.stopPropagation()
        onChange(!checked)
      }}
    />
  )
  if (!label) return control
  return (
    <span className="inline-flex items-center gap-2 text-[12px] font-medium" style={{ color: 'var(--sx-muted)' }}>
      <span aria-hidden>{label}</span>
      {control}
    </span>
  )
}

export type SettingsTone = 'neutral' | 'accent' | 'ink' | 'danger' | 'warning' | 'muted'

/** 状态圆点 + 文字。设置页不用绿色表达成功：当前/已连接用强调色点，空闲用中性灰点。 */
export function SettingsStatus({
  tone = 'neutral',
  children,
  className = '',
}: {
  tone?: SettingsTone
  children: ReactNode
  className?: string
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-[12px] ${className}`.trim()} style={{ color: tone === 'danger' ? 'var(--sx-danger-text)' : 'var(--sx-body)' }}>
      <span className={`sx-dot ${tone === 'neutral' ? '' : `sx-dot--${tone}`}`.trim()} aria-hidden />
      {children}
    </span>
  )
}

/** 提示条：danger 用红色发丝边 + 图标，不铺粉红色块。 */
export function SettingsNotice({
  tone = 'info',
  title,
  children,
  action,
  icon,
  className = '',
}: {
  tone?: 'info' | 'accent' | 'warning' | 'danger' | 'plain'
  title?: ReactNode
  children?: ReactNode
  action?: ReactNode
  icon?: React.ElementType
  className?: string
}) {
  const Icon = icon ?? (tone === 'danger' ? AlertCircle : tone === 'warning' ? AlertTriangle : Info)
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={`sx-notice ${tone !== 'info' ? `sx-notice--${tone}` : ''} ${className}`.trim()}>
      <Icon strokeWidth={1.9} />
      <div className="min-w-0 flex-1">
        {title && <div className="sx-notice__title">{title}</div>}
        {children && <div className={title ? 'mt-0.5' : ''} style={{ color: title ? 'var(--sx-muted)' : 'var(--sx-body)' }}>{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  )
}
