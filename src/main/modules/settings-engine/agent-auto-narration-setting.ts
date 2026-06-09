export const AGENT_AUTO_NARRATION_CONTINUATION_SETTING_KEY = 'agent.autoNarrationContinuation'

export interface AgentAutoNarrationSettingRepository {
  getSetting(key: string): string | undefined
  setSetting?(key: string, value: string): void
}

export function readAgentAutoNarrationContinuationSetting(
  repository: Pick<AgentAutoNarrationSettingRepository, 'getSetting'>,
): boolean {
  return repository.getSetting(AGENT_AUTO_NARRATION_CONTINUATION_SETTING_KEY) !== 'false'
}

export function writeAgentAutoNarrationContinuationSetting(
  repository: AgentAutoNarrationSettingRepository,
  enabled: boolean,
): void {
  repository.setSetting?.(AGENT_AUTO_NARRATION_CONTINUATION_SETTING_KEY, enabled ? 'true' : 'false')
}
