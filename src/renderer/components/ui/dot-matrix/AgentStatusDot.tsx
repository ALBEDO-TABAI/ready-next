import type { TaskCardVisualState } from '../../../modules/agent/task-status-vocabulary'
import { agentStatusGlyph } from './agent-status-glyph'
import { DotGlyph } from './DotGlyph'

export interface AgentStatusDotProps {
  state: TaskCardVisualState
  size?: number
}

/**
 * Task-card status glyph: resolves the unified state machine and renders the
 * matching dot-matrix glyph. The colour lands on the signal glyph only — the
 * adjacent status label stays its neutral grey.
 */
export function AgentStatusDot({ state, size = 11 }: AgentStatusDotProps) {
  const status = agentStatusGlyph(state)
  return (
    <DotGlyph
      name={status.glyph}
      tone={status.tone}
      pulse={status.pulse}
      size={size}
      title={status.label}
    />
  )
}
