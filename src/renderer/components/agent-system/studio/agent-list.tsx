import type { AgentSystemStudioAgent, AgentSystemStudioRoutingSimulationAction } from '../../../../shared/agent-system-studio'
import { SETTINGS_FLAT_BUTTON_STYLE } from '../../settings/settings-theme'
import { Chip } from './primitives'

export function RoutingActionChoice({ action }: { action: AgentSystemStudioRoutingSimulationAction }) {
  return (
    <button
      type="button"
      disabled={!action.enabled}
      className="min-w-[132px] flex-1 rounded-lg border px-3 py-2 text-left text-[11px] leading-5 disabled:opacity-55"
      style={{
        ...SETTINGS_FLAT_BUTTON_STYLE,
        background: action.enabled
          ? 'color-mix(in srgb, var(--surface-panel-bg) 46%, transparent)'
          : 'color-mix(in srgb, var(--surface-panel-bg) 28%, transparent)',
      }}
      title={action.description}
    >
      <span className="block font-medium" style={{ color: 'var(--text-title)' }}>{action.label}</span>
      <span className="mt-1 block" style={{ color: 'var(--text-light)' }}>{action.description}</span>
    </button>
  )
}

export function AgentListItem({
  agent,
  selected,
  onSelect,
}: {
  agent: AgentSystemStudioAgent
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="w-full border rounded-lg text-left transition-[border-color,background-color]"
      style={{
        borderColor: selected ? 'color-mix(in srgb, var(--color-blue) 48%, transparent)' : 'var(--border-default)',
        background: selected
          ? 'color-mix(in srgb, var(--color-blue) 9%, transparent)'
          : 'color-mix(in srgb, var(--surface-panel-bg) 38%, transparent)',
        padding: '11px 12px',
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium" style={{ color: 'var(--text-title)' }}>
            {agent.name}
          </div>
          <div className="mt-1 truncate text-[11px]" style={{ color: 'var(--text-light)' }}>
            {agent.id}
          </div>
        </div>
        <Chip>{agent.kind === 'main' ? '主 agent' : agent.status}</Chip>
      </div>
    </button>
  )
}
