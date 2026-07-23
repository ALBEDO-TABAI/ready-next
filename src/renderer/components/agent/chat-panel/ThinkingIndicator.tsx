import { AgentStatusDot } from '../../ui/dot-matrix/AgentStatusDot'

export function ThinkingIndicator() {
  return (
    <div
      className="ready-thinking-state"
      data-ready-thinking-state="true"
      role="status"
      aria-live="polite"
      aria-label="思考中"
    >
      <AgentStatusDot state="running" size={12} />
      <span className="ready-thinking-state-label">思考中</span>
      <span className="ready-thinking-state-trail" aria-hidden="true">···</span>
    </div>
  )
}
