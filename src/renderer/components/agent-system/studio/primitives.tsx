import type { ReactNode } from 'react'
import type { AgentSystemStudioRoutingCard, AgentSystemStudioRoutingDisabledReason } from '../../../../shared/agent-system-studio'
import type { SpecialistAgentBlueprint } from '../../../../shared/agent-specialist-blueprint'
import {
  SETTINGS_FLAT_CHIP_STYLE,
  SETTINGS_SUBTLE_CARD_STYLE,
} from '../../settings/settings-theme'

const disabledReasonLabel: Record<AgentSystemStudioRoutingDisabledReason, string> = {
  card_staged: '待确认',
  missing_triggers: '缺触发词',
  target_inactive: '目标不可用',
  invalid_card: '卡片无效',
}


export function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md text-[11px] leading-4" style={{ ...SETTINGS_FLAT_CHIP_STYLE, padding: '4px 10px' }}>
      {children}
    </span>
  )
}

export type BlueprintStatusTone = 'ready' | 'pending' | 'adopted' | 'inactive'

const BLUEPRINT_TONE_STYLE: Record<BlueprintStatusTone, { color: string; background: string; borderColor: string }> = {
  ready: { color: 'var(--color-blue)', background: 'color-mix(in srgb, var(--color-blue) 12%, transparent)', borderColor: 'color-mix(in srgb, var(--color-blue) 30%, transparent)' },
  pending: { color: 'var(--color-orange)', background: 'color-mix(in srgb, var(--color-orange) 13%, transparent)', borderColor: 'color-mix(in srgb, var(--color-orange) 32%, transparent)' },
  adopted: { color: 'var(--color-green)', background: 'color-mix(in srgb, var(--color-green) 13%, transparent)', borderColor: 'color-mix(in srgb, var(--color-green) 32%, transparent)' },
  inactive: { color: 'var(--text-light)', background: 'color-mix(in srgb, var(--surface-panel-bg) 44%, transparent)', borderColor: 'color-mix(in srgb, var(--surface-border) 24%, transparent)' },
}

const boundaryModeLabel: Record<string, string> = { allow: '允许', deny: '禁止', confirm: '需确认' }

export function boundaryLabel(mode: string): string {
  return boundaryModeLabel[mode] ?? mode
}

export function blueprintStatusBadge(blueprint: SpecialistAgentBlueprint): { label: string; tone: BlueprintStatusTone } {
  if (blueprint.adoption) return { label: '已采用', tone: 'adopted' }
  if (blueprint.status === 'confirmed') return { label: '已确认', tone: 'adopted' }
  if (blueprint.status === 'rejected') return { label: '已拒绝', tone: 'inactive' }
  if (blueprint.status === 'expired') return { label: '已过期', tone: 'inactive' }
  if (blueprint.status === 'needs_clarification' || blueprint.admissionVerdict.kind === 'clarify') {
    return { label: '需补齐信息', tone: 'pending' }
  }
  return { label: '待确认', tone: 'ready' }
}

export function StatusBadge({ tone, children }: { tone: BlueprintStatusTone; children: ReactNode }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 rounded-md border text-[11px] font-medium leading-4"
      style={{ ...BLUEPRINT_TONE_STYLE[tone], padding: '4px 10px' }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'currentColor' }} />
      {children}
    </span>
  )
}

export function RouteStateText({ card }: { card: AgentSystemStudioRoutingCard }) {
  const label = card.disabledReason ? disabledReasonLabel[card.disabledReason] : '可用'
  return (
    <span className="shrink-0 text-[11px] font-medium" style={{ color: card.disabledReason ? 'var(--color-orange)' : 'var(--color-green)' }}>
      {label}
    </span>
  )
}

const BLUEPRINT_INPUT_STYLE = {
  borderColor: 'var(--border-default)',
  background: 'color-mix(in srgb, var(--surface-panel-bg) 64%, transparent)',
  color: 'var(--text-title)',
}
export function EmptyLine({ text }: { text: string }) {
  return <div className="text-[12px] leading-5" style={{ color: 'var(--text-light)' }}>{text}</div>
}

export function Section({
  icon,
  title,
  children,
}: {
  icon: ReactNode
  title: string
  children: ReactNode
}) {
  return (
    <section
      className="border rounded-lg"
      style={{
        ...SETTINGS_SUBTLE_CARD_STYLE,
        padding: '16px',
        boxShadow: 'none',
      }}
    >
      <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold" style={{ color: 'var(--text-title)' }}>
        {icon}
        {title}
      </div>
      {children}
    </section>
  )
}

export function Field({
  label,
  value,
  onChange,
  multiline = false,
  rows = 3,
  disabled = false,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  multiline?: boolean
  rows?: number
  disabled?: boolean
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-[11px] font-medium" style={{ color: 'var(--text-light)' }}>
        {label}
      </span>
      {multiline ? (
        <textarea
          aria-label={label}
          value={value}
          rows={rows}
          disabled={disabled}
          onInput={(event) => onChange(event.currentTarget.value)}
          onChange={(event) => onChange(event.currentTarget.value)}
          className="w-full resize-y rounded-lg border px-3 py-2 text-[12px] leading-5 outline-none disabled:opacity-60"
          style={BLUEPRINT_INPUT_STYLE}
        />
      ) : (
        <input
          aria-label={label}
          value={value}
          disabled={disabled}
          onInput={(event) => onChange(event.currentTarget.value)}
          onChange={(event) => onChange(event.currentTarget.value)}
          className="h-9 w-full rounded-lg border px-3 text-[12px] outline-none disabled:opacity-60"
          style={BLUEPRINT_INPUT_STYLE}
        />
      )}
    </label>
  )
}
