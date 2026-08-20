import { AgentStatusDot } from '../../ui/dot-matrix/AgentStatusDot'
import { renderInline } from './markdown'

export function ThinkingIndicator({ message }: { message?: string | null } = {}) {
  const summary = message?.trim() || null
  const label = summary || '思考中'
  return (
    <div
      className="ready-thinking-state"
      data-ready-thinking-state="true"
      data-ready-thinking-summary={summary ? 'true' : undefined}
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      <AgentStatusDot state="running" size={12} />
      <span className="ready-thinking-state-label">{renderInline(label)}</span>
      {!summary ? <span className="ready-thinking-state-trail" aria-hidden="true">···</span> : null}
    </div>
  )
}
