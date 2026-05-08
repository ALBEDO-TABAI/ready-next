export function isAwaitingUserInteractionState(state: {
  waitingFor?: string | null
  interactionState?: string | null
  terminalReason?: string | null
} | null | undefined): boolean {
  if (!state) return false
  return state.waitingFor === 'input'
    || state.waitingFor === 'confirmation'
    || state.waitingFor === 'agent_result'
    || state.waitingFor === 'clarification'
    || state.interactionState === 'awaiting_clarification'
    || state.interactionState === 'awaiting_confirmation'
    || state.interactionState === 'human_takeover'
    || state.terminalReason === 'blocked_config'
    || state.terminalReason === 'blocked_external'
}
