import type { ReactNode } from 'react'
import { AlertCircle, AlertTriangle, Info } from 'lucide-react'

// 设置页自己的版式（W2 §3.2、W1 §5）：分组、卡片、行、状态与提示。样式在 settings.css，只用 --rn-*；
// 按钮、输入、开关、分段、标签、复选框、对话框一律用 components/ui 的共用基元，这里不再有私有控件。

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

/** 一组设置的卡片（纸，DL2）。title 存在时渲染卡头，children 通常是若干 SettingsRow。 */
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

/** 带一段可见文字的开关（“启用”“已启用”）：文字只是说明，开关本身是共用的 Switch。 */
export function SettingsSwitchLabel({ text, children }: { text: ReactNode; children: ReactNode }) {
  return (
    <span className="sx-switch-label">
      <span aria-hidden>{text}</span>
      {children}
    </span>
  )
}

export type SettingsTone = 'neutral' | 'accent' | 'ink' | 'danger' | 'warning' | 'muted'

/** 状态圆点 + 文字。当前/已连接/可用用 ok 色点（tone 'accent'，V5：信号色不表示状态），空闲用中性灰点。 */
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
    <span className={`sx-status ${tone === 'danger' ? 'sx-text-danger' : ''} ${className}`.trim()}>
      <span className={`sx-dot ${tone === 'neutral' ? '' : `sx-dot--${tone}`}`.trim()} aria-hidden />
      {children}
    </span>
  )
}

/** 提示条：一层安静的填充，danger 用红色图标与标题，不铺粉红色块。 */
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
      <Icon strokeWidth={1.75} />
      <div className="min-w-0 flex-1">
        {title && <div className="sx-notice__title">{title}</div>}
        {children && <div className={title ? 'sx-notice__body mt-0.5' : 'sx-notice__body sx-notice__body--solo'}>{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  )
}
