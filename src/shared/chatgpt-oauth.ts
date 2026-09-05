import type {
  AIModelConfig,
  AIProviderWorkspace,
  AIReasoningEffort,
} from './ai-providers'

export const CHATGPT_OAUTH_PROFILE_ID = 'custom-chatgpt-oauth'
export const CHATGPT_OAUTH_PROFILE_NAME = 'ChatGPT OAuth（实验）'
export const CHATGPT_OAUTH_BASE_URL = 'http://127.0.0.1:10532/v1'
export const CHATGPT_OAUTH_REASONING_EFFORTS = [
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
] as const satisfies readonly AIReasoningEffort[]

export type ChatGptOAuthReasoningEffort =
  typeof CHATGPT_OAUTH_REASONING_EFFORTS[number]

export type ChatGptOAuthState = 'signed_out' | 'signed_in' | 'connecting' | 'ready' | 'error'

export type ChatGptOAuthPhase = 'preparing' | 'waiting_browser' | 'exchanging' | 'starting_service' | 'saving_profile' | 'cancelling'

export interface ChatGptOAuthStatus {
  state: ChatGptOAuthState
  connected: boolean
  running: boolean
  baseUrl: string
  models: string[]
  error?: string
  operation?: { id: string; phase: ChatGptOAuthPhase; startedAt: number; canReopen: boolean }
}

export function normalizeChatGptOAuthReasoningEffort(
  value: AIReasoningEffort | null | undefined,
): ChatGptOAuthReasoningEffort {
  if (value === 'none' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh') {
    return value
  }
  if (value === 'minimal') return 'low'
  if (value === 'max') return 'xhigh'
  return 'high'
}

export function isChatGptOAuthConfig(
  config: AIModelConfig | null | undefined
): boolean {
  return config?.authMode === 'chatgpt-oauth'
}

export function isChatGptOAuthConfigContractValid(
  config: AIModelConfig | null | undefined
): boolean {
  return Boolean(
    isChatGptOAuthConfig(config)
    && config?.provider === 'openai'
    && config.baseUrl === CHATGPT_OAUTH_BASE_URL
    && String(config.apiKey || '').trim().length >= 32
    && config.agentProtocol === 'openai'
    && config.wireApi === 'responses'
    && config.toolUseMode === 'on'
    && config.nativeVideoMode === 'off'
  )
}

export function buildChatGptOAuthConfig(
  previous: AIModelConfig | null | undefined,
  models: string[],
  proxyApiKey: string,
): AIModelConfig {
  if (String(proxyApiKey || '').trim().length < 32) {
    throw new Error('ChatGPT OAuth 本机访问口令无效。')
  }
  const modelIds = [...new Set(models.map((model) => String(model || '').trim()).filter(Boolean))]
  const previousModel = String(previous?.model || '').trim()
  const model = modelIds.includes(previousModel) ? previousModel : modelIds[0] || previousModel

  return {
    provider: 'openai',
    baseUrl: CHATGPT_OAUTH_BASE_URL,
    apiKey: proxyApiKey.trim(),
    model,
    modelIds,
    displayName: CHATGPT_OAUTH_PROFILE_NAME,
    authMode: 'chatgpt-oauth',
    agentProtocol: 'openai',
    wireApi: 'responses',
    reasoningEffort: normalizeChatGptOAuthReasoningEffort(previous?.reasoningEffort),
    toolUseMode: 'on',
    visionMode: 'auto',
    nativeVideoMode: 'off',
    capabilityModes: previous?.capabilityModes || {},
  }
}

export function upsertChatGptOAuthProfile(
  workspace: AIProviderWorkspace,
  models: string[],
  proxyApiKey: string,
): AIProviderWorkspace {
  const existing = workspace.profiles.find(
    (profile) => profile.id === CHATGPT_OAUTH_PROFILE_ID || isChatGptOAuthConfig(profile.config)
  )
  const nextConfig = buildChatGptOAuthConfig(existing?.config, models, proxyApiKey)
  const nextProfile = {
    id: CHATGPT_OAUTH_PROFILE_ID,
    category: 'custom' as const,
    name: CHATGPT_OAUTH_PROFILE_NAME,
    builtIn: false,
    showInChatSwitcher: true,
    config: nextConfig,
  }

  return {
    version: 1,
    activeProfileId: CHATGPT_OAUTH_PROFILE_ID,
    profiles: existing
      ? workspace.profiles.map((profile) => (
          profile.id === existing.id ? nextProfile : profile
        ))
      : [...workspace.profiles, nextProfile],
  }
}

export function removeChatGptOAuthProfile(
  workspace: AIProviderWorkspace,
): AIProviderWorkspace {
  const profiles = workspace.profiles.filter(
    (profile) => profile.id !== CHATGPT_OAUTH_PROFILE_ID && !isChatGptOAuthConfig(profile.config)
  )
  const activeProfileId = workspace.activeProfileId === CHATGPT_OAUTH_PROFILE_ID
    || !profiles.some((profile) => profile.id === workspace.activeProfileId)
    ? (profiles.find((profile) => profile.id === 'builtin-openai')?.id || profiles[0]?.id || '')
    : workspace.activeProfileId

  return {
    version: 1,
    activeProfileId,
    profiles,
  }
}
