import { useAgent } from '../../stores/useAgent'

/**
 * AgentSelector — checkbox list with avatar + name + status indicator.
 * Each row toggles agent participation in the current conversation.
 */
export default function AgentSelector() {
  const { agents, toggleAgentSelection } = useAgent()

  const statusColor = (status: string) => {
    switch (status) {
      case 'idle': return 'var(--color-green)'
      case 'working': return 'var(--color-blue)'
      case 'done': return 'var(--color-green)'
      case 'error': return 'var(--color-red)'
      default: return 'var(--text-light)'
    }
  }

  const statusLabel = (status: string) => {
    switch (status) {
      case 'idle': return '在线'
      case 'working': return '工作中'
      case 'done': return '完成'
      case 'error': return '错误'
      default: return '离线'
    }
  }

  return (
    <div className="flex flex-col" style={{ gap: 2 }}>
      {agents.map((agent) => (
        <button
          key={agent.name}
          onClick={() => toggleAgentSelection(agent.name)}
          className="flex items-center w-full rounded-lg hover:bg-black/5 transition-colors text-left"
          style={{ padding: '6px 10px', gap: 8 }}
        >
          {/* Checkbox */}
          <div
            className="flex items-center justify-center flex-shrink-0"
            style={{
              width: 16, height: 16,
              borderRadius: 4,
              border: agent.selected
                ? '1.5px solid var(--color-green)'
                : '1.5px solid var(--border-input)',
              background: agent.selected ? 'var(--color-green)' : 'transparent',
              transition: 'all 0.15s ease'
            }}
          >
            {agent.selected && (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M2 5L4.5 7.5L8 3" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </div>

          {/* Avatar */}
          <div
            className="flex items-center justify-center flex-shrink-0"
            style={{
              width: 22, height: 22,
              borderRadius: 6,
              background: '#E8E8E8',
              fontSize: 11
            }}
          >
            {agent.avatar}
          </div>

          {/* Name */}
          <span className="flex-1 truncate" style={{ fontSize: 12, color: 'var(--text-body)' }}>
            {agent.displayName}
          </span>

          {/* Status indicator */}
          <div className="flex items-center flex-shrink-0" style={{ gap: 4 }}>
            <div
              style={{
                width: 6, height: 6,
                borderRadius: '50%',
                background: statusColor(agent.status),
                boxShadow: agent.status === 'working' ? `0 0 4px ${statusColor(agent.status)}` : 'none'
              }}
            />
            <span style={{ fontSize: 10, color: 'var(--text-light)' }}>
              {statusLabel(agent.status)}
            </span>
          </div>
        </button>
      ))}
    </div>
  )
}
