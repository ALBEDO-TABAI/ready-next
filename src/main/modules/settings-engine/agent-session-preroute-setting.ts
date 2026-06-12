/**
 * EP4-A5 — `agent_auto_routing` cross-process setting (04 档位二), same
 * repository pattern as the C2.4 auto-narration switch. Closed union with
 * a safe default: anything unreadable resolves to 'suggest'.
 */

export const AGENT_SESSION_PREROUTE_SETTING_KEY = 'agent.sessionPrerouteMode'

export type AgentSessionPrerouteMode = 'off' | 'suggest' | 'auto'

const MODES: ReadonlyArray<AgentSessionPrerouteMode> = ['off', 'suggest', 'auto']

export interface AgentSessionPrerouteSettingRepository {
  getSetting(key: string): string | undefined
  setSetting?(key: string, value: string): void
}

export function readAgentSessionPrerouteMode(
  repository: Pick<AgentSessionPrerouteSettingRepository, 'getSetting'>,
): AgentSessionPrerouteMode {
  const raw = repository.getSetting(AGENT_SESSION_PREROUTE_SETTING_KEY)
  return (MODES as readonly string[]).includes(String(raw)) ? (raw as AgentSessionPrerouteMode) : 'suggest'
}

export function writeAgentSessionPrerouteMode(
  repository: AgentSessionPrerouteSettingRepository,
  mode: AgentSessionPrerouteMode,
): void {
  if (!(MODES as readonly string[]).includes(mode)) {
    throw new Error(`[session-preroute-setting] illegal mode: ${String(mode)}`)
  }
  repository.setSetting?.(AGENT_SESSION_PREROUTE_SETTING_KEY, mode)
}
