import { useAgent } from '../../stores/useAgent'

/**
 * AgentTagRow — displays @Agent tags for currently selected agents.
 * Shown above the input field in TaskPanel.
 */
export default function AgentTagRow() {
  const { agents } = useAgent()
  const selectedAgents = agents.filter(a => a.selected)

  if (selectedAgents.length === 0) return null

  return (
    <div className="flex items-center flex-wrap" style={{ gap: 4 }}>
      <span style={{ fontSize: 11, color: '#8A8A8A' }}>@</span>
      {selectedAgents.map(agent => (
        <span
          key={agent.name}
          className="flex items-center"
          style={{
            padding: '2px 6px',
            borderRadius: 10,
            fontSize: 10,
            background: 'var(--color-green-light)',
            color: 'var(--color-green)',
            gap: 2
          }}
        >
          {agent.avatar} {agent.displayName}
        </span>
      ))}
    </div>
  )
}
