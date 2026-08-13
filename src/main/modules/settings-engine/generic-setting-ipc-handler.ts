type GenericSettingRepository = {
  setSetting(key: string, value: string): void
}

type GenericSettingIPCResponse = {
  success: boolean
  error?: string
}

const RESERVED_AI_WORKSPACE_SETTING_KEYS = new Set([
  'ai_provider_workspace',
  'ai_model_config',
  'ai_saved_configs',
])

const RETIRED_AGENT_CONTROL_SETTING_KEYS = new Set([
  'agent.sessionPrerouteMode',
  'agent.knowledgeSystemEnabled',
])

export function createGenericSettingIPCHandler(options: {
  repository: GenericSettingRepository
  onSettingChanged?: (key: string, value: string) => void
}): (_event: unknown, payload: { key: string; value: string }) => GenericSettingIPCResponse {
  return (_event, { key, value }) => {
    try {
      if (RESERVED_AI_WORKSPACE_SETTING_KEYS.has(key)) {
        throw new Error('ai_workspace_setting_requires_dedicated_ipc')
      }
      if (RETIRED_AGENT_CONTROL_SETTING_KEYS.has(key)) {
        throw new Error('retired_agent_control_setting')
      }
      options.repository.setSetting(key, value)
      options.onSettingChanged?.(key, value)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
