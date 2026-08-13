import {
  taskCardVisualStateLabel,
  type TaskCardVisualState,
} from '../../../modules/agent/task-status-vocabulary'
import type { DotGlyphName, DotGlyphTone } from './dot-glyphs'

/**
 * Unified agent status state machine (idle / running / needs-input / done /
 * error) borrowed from the Nothing design discipline: state is expressed by
 * SHAPE + LABEL first, colour second. The `signal` tone (alert red) is reserved
 * for genuine signals — needs-input, over-budget, error. Active and normal
 * states (running / done / idle) never colourise; they invert to the neutral
 * dot, matching "active states don't use the accent".
 */
export type AgentStatusKind = 'idle' | 'running' | 'needs_input' | 'done' | 'error'

export interface AgentStatusGlyph {
  kind: AgentStatusKind
  glyph: DotGlyphName
  tone: DotGlyphTone
  pulse: boolean
  label: string
}

export function agentStatusGlyph(state: TaskCardVisualState): AgentStatusGlyph {
  const label = taskCardVisualStateLabel(state)
  switch (state) {
    case 'running':
    case 'background_running':
      return { kind: 'running', glyph: 'running', tone: 'neutral', pulse: true, label }
    case 'waiting_input':
    case 'waiting_handoff':
      // falls through: over-budget pause is a genuine "needs decision" signal
    case 'budget_paused':
      return { kind: 'needs_input', glyph: 'needs_input', tone: 'signal', pulse: false, label }
    case 'done':
      return { kind: 'done', glyph: 'done', tone: 'neutral', pulse: false, label }
    case 'failed':
      return { kind: 'error', glyph: 'error', tone: 'signal', pulse: false, label }
    default: {
      // Compile-time exhaustiveness over TaskCardVisualState; runtime fallback to idle.
      const _exhaustive: never = state
      void _exhaustive
      return { kind: 'idle', glyph: 'idle', tone: 'neutral', pulse: false, label: '待命' }
    }
  }
}
