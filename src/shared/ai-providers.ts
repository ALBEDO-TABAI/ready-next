/**
 * AI Provider definitions and model presets.
 * Shared between main process and renderer.
 */

import type { CapabilityModeMap } from './ai-capability-groups'
import { normalizeCapabilityModeMap } from './ai-capability-groups'
import type { MultiTurnThinkingPolicy } from './ai-providers/types'

// Stage S (PR-S3): the 7 inline provider literals were extracted into
// per-provider sub-modules under `./ai-providers/`. The umbrella file
// now imports each sub-module and assembles `AI_PROVIDERS[]` from
// `{ ...def, capabilityClass }`. PR-S4 wires the patcher entry +
// profile resolver into the 6 execution-client serialization points.
import * as moonshotModule from './ai-providers/moonshot'
import * as anthropicModule from './ai-providers/anthropic'
import * as foxModule from './ai-providers/fox'
import * as openaiModule from './ai-providers/openai'
import * as geminiModule from './ai-providers/gemini'
import * as volcengineModule from './ai-providers/volcengine'
import * as openaiCompatibleModule from './ai-providers/openai-compatible'

// ---------------------------------------------------------------------------
// Core Types
// ---------------------------------------------------------------------------

export type AIProviderType =
  | 'moonshot'      // Kimi / Moonshot AI
  | 'anthropic'     // Claude / Anthropic
  | 'openai'        // GPT / Codex / OpenAI
  | 'fox'           // FoxCode / NewCLI Codex
  | 'gemini'        // Google Gemini
  | 'volcengine'    // ByteDance Volcano Engine (Seedance / Seedream)
  | 'openai-compatible' // Generic OpenAI-compatible endpoint

export type AIModelCategory = 'chat' | 'image' | 'video'
export type AIWireAPI = 'chat/completions' | 'responses'
export type AIReasoningEffort = 'minimal' | 'low' | 'medium' | 'high'
export type AIAgentProtocol = 'anthropic' | 'openai'
export type AICapabilityMode = 'auto' | 'on' | 'off'
export type AIToolCallTransport = 'native' | 'text' | 'none'

export interface AIModelDef {
  id: string
  label: string
  category: AIModelCategory
  contextWindow?: number
  description?: string
  /**
   * Stage S (PR-S2): per-model capability overrides applied on top of
   * the provider-level `capabilityClass` defaults. Three-layer merge
   * (model overrides > provider class > legacy heuristics) lands in PR-S5.
   */
  capabilityOverrides?: {
    supportsVision?: boolean
    supportsNativeVideo?: boolean
    supportsThinking?: boolean
    supportsLongContext?: boolean
    multiTurnThinkingPolicy?: MultiTurnThinkingPolicy
  }
}

export interface AIProviderDef {
  id: AIProviderType
  label: string
  labelEn: string
  icon: string          // emoji or short label
  baseUrl: string
  authHeader: string    // header name for the API key
  authPrefix: string    // e.g. "Bearer " or "" (for x-api-key)
  extraHeaders?: Record<string, string>
  agentProtocol?: AIAgentProtocol
  wireApi?: AIWireAPI
  defaultReasoningEffort?: AIReasoningEffort
  models: AIModelDef[]
  apiKeyPlaceholder: string
  helpUrl: string
  /**
   * Stage S (PR-S2): provider-level capability defaults. Acts as the
   * middle layer of the three-layer merge introduced in PR-S5.
   */
  capabilityClass?: {
    supportsVision?: boolean
    supportsNativeVideo?: boolean
    supportsThinking?: boolean
    supportsLongContext?: boolean
    multiTurnThinkingPolicy?: MultiTurnThinkingPolicy
  }
}

export interface AIModelConfig {
  provider: AIProviderType
  baseUrl: string
  apiKey: string
  model: string
  modelIds?: string[]
  agentProtocol?: AIAgentProtocol
  wireApi?: AIWireAPI
  reasoningEffort?: AIReasoningEffort
  toolUseMode?: AICapabilityMode
  visionMode?: AICapabilityMode
  nativeVideoMode?: AICapabilityMode
  /** Volcano Engine specific: endpoint ID */
  endpointId?: string
  /** 配置命名槽 - 在前台显示的名称 */
  displayName?: string
  /** Optional user override for this model's context window, in tokens. */
  contextWindowOverride?: number
  /** 业务能力分组开关 */
  capabilityModes?: CapabilityModeMap
  /**
   * Stage S (PR-S2): independent thinking-mode toggle (auto/on/off).
   * Not part of `CapabilityModeMap` because that map's keys are
   * restricted to `CapabilityGroupId`. Three-layer merge in PR-S5.
   */
  thinkingMode?: AICapabilityMode
  /**
   * Stage S (PR-S2): independent long-context toggle (auto/on/off).
   * See `thinkingMode` for rationale.
   */
  longContextMode?: AICapabilityMode
}

export type AIProviderCategory = 'openai' | 'anthropic' | 'gemini' | 'custom'

export interface AIProviderProfile {
  id: string
  category: AIProviderCategory
  name: string
  builtIn: boolean
  showInChatSwitcher: boolean
  config: AIModelConfig
}

export interface AIProviderWorkspace {
  version: 1
  activeProfileId: string
  profiles: AIProviderProfile[]
}

export interface LegacyAISettingsPayload {
  aiModelConfig?: AIModelConfig | null
  aiSavedConfigs?: Partial<Record<AIProviderType, AIModelConfig>> | null
}

export interface ChatSwitcherProfileGroups {
  currentHiddenProfile: AIProviderProfile | null
  visibleProfiles: AIProviderProfile[]
}

// ---------------------------------------------------------------------------
// Provider Registry
// ---------------------------------------------------------------------------

export const AI_PROVIDERS: AIProviderDef[] = [
  { ...moonshotModule.def, capabilityClass: moonshotModule.capabilityClass },
  { ...anthropicModule.def, capabilityClass: anthropicModule.capabilityClass },
  { ...foxModule.def, capabilityClass: foxModule.capabilityClass },
  { ...openaiModule.def, capabilityClass: openaiModule.capabilityClass },
  { ...geminiModule.def, capabilityClass: geminiModule.capabilityClass },
  { ...volcengineModule.def, capabilityClass: volcengineModule.capabilityClass },
  { ...openaiCompatibleModule.def, capabilityClass: openaiCompatibleModule.capabilityClass },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROVIDER_ALIASES: Record<string, AIProviderType> = {
  'moonshot': 'moonshot',
  'kimi': 'moonshot',
  'anthropic': 'anthropic',
  'claude': 'anthropic',
  'openai': 'openai',
  'fox': 'fox',
  'foxcode': 'fox',
  'newcli': 'fox',
  'newcli-codex': 'fox',
  'gemini': 'gemini',
  'google': 'gemini',
  'volcengine': 'volcengine',
  'volcano': 'volcengine',
  'openai-compatible': 'openai-compatible',
  'openai_compatible': 'openai-compatible',
  'compatible': 'openai-compatible',
}

const BUILTIN_PROFILE_META: Record<Exclude<AIProviderCategory, 'custom'>, { id: string; name: string; provider: AIProviderType }> = {
  openai: { id: 'builtin-openai', name: 'OpenAI', provider: 'openai' },
  anthropic: { id: 'builtin-anthropic', name: 'Anthropic', provider: 'anthropic' },
  gemini: { id: 'builtin-gemini', name: 'Gemini', provider: 'gemini' },
}

function cloneConfig(config: AIModelConfig): AIModelConfig {
  return normalizeAIConfig({
    ...config,
    capabilityModes: normalizeCapabilityModeMap(config.capabilityModes),
  })
}

function normalizeModelIds(model: unknown, modelIds: unknown): string[] | undefined {
  const primaryModel = String(model || '').trim()
  const rawIds = Array.isArray(modelIds) ? modelIds : []
  const ordered = [
    primaryModel,
    ...rawIds.map((value) => String(value || '').trim()),
  ].filter((value) => value && value !== '__custom__' && value !== 'custom')

  if (ordered.length === 0) return undefined

  const deduped: string[] = []
  for (const value of ordered) {
    if (!deduped.includes(value)) deduped.push(value)
  }
  return deduped
}

export function createConfigFromProvider(providerId: AIProviderType, overrides?: Partial<AIModelConfig>): AIModelConfig {
  const provider = getProviderDef(providerId)
  return normalizeAIConfig({
    provider: providerId,
    baseUrl: provider?.baseUrl || '',
    apiKey: '',
    model: provider?.models[0]?.id || '',
    agentProtocol: provider?.agentProtocol,
    wireApi: provider?.wireApi,
    reasoningEffort: provider?.defaultReasoningEffort,
    toolUseMode: 'auto',
    visionMode: 'auto',
    nativeVideoMode: 'auto',
    capabilityModes: {},
    ...(overrides || {}),
  })
}

function resolveCategoryForConfig(config: AIModelConfig | null | undefined): AIProviderCategory {
  if (!config) return 'custom'
  if (config.provider === 'openai') return 'openai'
  if (config.provider === 'anthropic') return 'anthropic'
  if (config.provider === 'gemini') return 'gemini'
  return 'custom'
}

function resolveProfileName(config: AIModelConfig, fallback: string): string {
  const trimmed = String(config.displayName || '').trim()
  if (trimmed) return trimmed
  const provider = getProviderDef(config.provider, config.baseUrl)
  return provider?.label.split('(')[0]?.trim() || fallback
}

function createBuiltinProfile(
  category: Exclude<AIProviderCategory, 'custom'>,
  config?: AIModelConfig,
): AIProviderProfile {
  const meta = BUILTIN_PROFILE_META[category]
  const nextConfig = cloneConfig(config || createConfigFromProvider(meta.provider))
  return {
    id: meta.id,
    category,
    name: resolveProfileName(nextConfig, meta.name),
    builtIn: true,
    showInChatSwitcher: true,
    config: {
      ...nextConfig,
      displayName: resolveProfileName(nextConfig, meta.name),
    },
  }
}

function generateProfileId(prefix: string): string {
  const randomPart = Math.random().toString(36).slice(2, 8)
  return `${prefix}-${Date.now().toString(36)}-${randomPart}`
}

export function createCustomAIProviderProfile(
  config?: Partial<AIModelConfig>,
  options?: Partial<Pick<AIProviderProfile, 'id' | 'name' | 'showInChatSwitcher'>>,
): AIProviderProfile {
  const nextConfig = cloneConfig(createConfigFromProvider('openai-compatible', config))
  const name = String(options?.name || '').trim() || resolveProfileName(nextConfig, '自定义预设')
  return {
    id: options?.id || generateProfileId('custom'),
    category: 'custom',
    name,
    builtIn: false,
    showInChatSwitcher: options?.showInChatSwitcher ?? true,
    config: {
      ...nextConfig,
      displayName: name,
    },
  }
}

export function normalizeProviderId(id: string | undefined | null, baseUrl?: string): AIProviderType | undefined {
  const normalizedId = String(id || '').trim().toLowerCase()
  const normalizedBaseUrl = String(baseUrl || '').trim().toLowerCase()

  if (normalizedId in PROVIDER_ALIASES) {
    return PROVIDER_ALIASES[normalizedId]
  }
  if (normalizedBaseUrl.includes('code.newcli.com/codex') || normalizedBaseUrl.includes('/codex/v1')) {
    return 'fox'
  }
  if (normalizedBaseUrl.includes('api.kimi.com/coding')) {
    return 'anthropic'
  }
  if (normalizedBaseUrl.includes('api.anthropic.com')) {
    return 'anthropic'
  }
  if (normalizedBaseUrl.includes('generativelanguage.googleapis.com')) {
    return 'gemini'
  }
  if (normalizedBaseUrl.includes('volces.com')) {
    return 'volcengine'
  }
  if (normalizedBaseUrl.includes('moonshot.cn') || normalizedBaseUrl.includes('kimi.com')) {
    return 'moonshot'
  }
  if (normalizedBaseUrl.includes('api.openai.com')) {
    return 'openai'
  }

  return undefined
}

export function normalizeAIConfig<T extends AIModelConfig | null | undefined>(config: T): T {
  if (!config) return config
  const providerId = normalizeProviderId(config.provider, config.baseUrl)
  if (!providerId) return config

  const provider = AI_PROVIDERS.find((item) => item.id === providerId)
  const normalizedBaseUrl = String(config.baseUrl || '').trim().replace(/\/+$/, '')
  const isKimiCoding = normalizedBaseUrl.includes('api.kimi.com/coding')
  const normalizedModelIds = normalizeModelIds(config.model, config.modelIds)
  const nextConfig: AIModelConfig = {
    ...config,
    provider: providerId,
    wireApi: config.wireApi || provider?.wireApi || config.wireApi,
    reasoningEffort: config.reasoningEffort || provider?.defaultReasoningEffort || config.reasoningEffort,
    capabilityModes: normalizeCapabilityModeMap(config.capabilityModes),
    modelIds: normalizedModelIds,
  }
  if (isKimiCoding) {
    nextConfig.agentProtocol = 'anthropic'
  }
  return nextConfig as T
}

export interface AIResolvedCapabilities {
  config: AIModelConfig
  provider?: AIProviderDef
  baseUrl: string
  agentProtocol: AIAgentProtocol
  wireApi?: AIWireAPI
  reasoningEffort?: AIReasoningEffort
  supportsToolCalls: boolean
  supportsNativeToolCalls: boolean
  toolCallTransport: AIToolCallTransport
  supportsVision: boolean
  supportsNativeVideo: boolean
  supportsToolChoice: boolean
  isKimiCoding: boolean
  /**
   * Stage S (PR-S2): placeholder fields for the capabilityClass
   * three-layer merge. PR-S5 will replace the `false` defaults with
   * `model.capabilityOverrides ?? provider.capabilityClass ?? legacy`
   * resolution. Required (not optional) so downstream consumers can
   * branch unconditionally once PR-S5 lands.
   */
  supportsThinking: boolean
  supportsLongContext: boolean
  multiTurnThinkingPolicy: MultiTurnThinkingPolicy
}

function normalizeAgentProtocol(value: unknown): AIAgentProtocol | undefined {
  return value === 'anthropic' || value === 'openai' ? value : undefined
}

function normalizeCapabilityMode(value: unknown): AICapabilityMode | undefined {
  return value === 'auto' || value === 'on' || value === 'off' ? value : undefined
}

function applyCapabilityMode(mode: AICapabilityMode | undefined, defaultValue: boolean): boolean {
  if (mode === 'on') return true
  if (mode === 'off') return false
  return defaultValue
}

export function isMultiTurnThinkingPolicySafe(policy: MultiTurnThinkingPolicy): boolean {
  return policy === 'proven_safe' || policy === 'echo_required'
}

function thinkingModeConfigError(policy: MultiTurnThinkingPolicy): string {
  if (policy === 'unsupported') {
    return '当前供应商已确认不支持多轮 thinking 模式，请关闭思考模式或切换供应商。'
  }
  return '当前供应商的多轮 thinking 兼容性未验证，暂不支持手动开启；请关闭思考模式或切换到已验证的供应商。'
}

export interface ThinkingModeValidationResult {
  ok: boolean
  policy: MultiTurnThinkingPolicy
  error?: string
}

export function validateThinkingModeConfig(
  config: AIModelConfig | null | undefined,
): ThinkingModeValidationResult {
  const normalized = normalizeAIConfig(config)
  if (!normalized || normalizeCapabilityMode(normalized.thinkingMode) !== 'on') {
    return { ok: true, policy: 'unknown' }
  }
  const capabilities = resolveAIConfigCapabilities(normalized)
  const policy = capabilities?.multiTurnThinkingPolicy ?? 'unknown'
  if (isMultiTurnThinkingPolicySafe(policy)) {
    return { ok: true, policy }
  }
  return { ok: false, policy, error: thinkingModeConfigError(policy) }
}

export function assertThinkingModeConfigValid(config: AIModelConfig | null | undefined): void {
  const result = validateThinkingModeConfig(config)
  if (!result.ok) {
    throw new Error(result.error || thinkingModeConfigError(result.policy))
  }
}

export function assertAIWorkspaceThinkingModesValid(workspace: AIProviderWorkspace | null | undefined): void {
  const normalized = normalizeAIWorkspace(workspace)
  for (const profile of normalized.profiles) {
    const result = validateThinkingModeConfig(profile.config)
    if (!result.ok) {
      const name = String(profile.name || profile.config.displayName || profile.config.model || '').trim()
      throw new Error(name ? `${name}：${result.error}` : result.error)
    }
  }
}

export function resolveAIConfigCapabilities(config: AIModelConfig | null | undefined): AIResolvedCapabilities | null {
  const normalizedConfig = normalizeAIConfig(config)
  if (!normalizedConfig) return null

  const baseUrl = String(normalizedConfig.baseUrl || '').trim().replace(/\/+$/, '')
  const provider = getProviderDef(normalizedConfig.provider, baseUrl)
  const explicitProtocol = normalizeAgentProtocol(normalizedConfig.agentProtocol)
  const inferredProtocol = (() => {
    if (baseUrl.includes('api.kimi.com/coding')) return 'anthropic'
    if (provider?.agentProtocol) return provider.agentProtocol
    if (baseUrl.includes('api.anthropic.com')) return 'anthropic'
    if (/\/v1\/messages$/i.test(baseUrl)) return 'anthropic'
    return 'openai'
  })()
  const agentProtocol = explicitProtocol || inferredProtocol
  const wireApi = agentProtocol === 'openai'
    ? (normalizedConfig.wireApi || provider?.wireApi || (baseUrl.includes('/codex/v1') ? 'responses' : 'chat/completions'))
    : undefined
  const reasoningEffort = normalizedConfig.reasoningEffort || provider?.defaultReasoningEffort
  const isKimiCoding = baseUrl.includes('api.kimi.com/coding')
  const supportsToolCalls = applyCapabilityMode(normalizeCapabilityMode(normalizedConfig.toolUseMode), true)
  const supportsNativeToolCalls = supportsToolCalls && !(
    provider?.id === 'fox' ||
    baseUrl.includes('code.newcli.com/codex') ||
    /\/codex\/v1(?:$|\/)/i.test(baseUrl)
  )
  const toolCallTransport: AIToolCallTransport = !supportsToolCalls
    ? 'none'
    : (supportsNativeToolCalls ? 'native' : 'text')

  // Stage S (PR-S5 / W4.0): three-layer capability merge.
  //
  // Priority (highest first):
  //   1. model.capabilityOverrides   (per-model)
  //   2. provider.capabilityClass    (per-provider)
  //   3. legacy heuristics fallback  (agentProtocol / contextWindow)
  //
  // Replaces the PR-S2 `false` placeholders for `supportsThinking`
  // and `supportsLongContext`, and now also routes `supportsVision`
  // through the same merge so unsupported providers (fox / volcengine
  // / openai-compatible) default to `false` instead of inferring `true`
  // from `agentProtocol`.
  const providerCap = provider?.capabilityClass ?? {}
  const modelDef = provider?.models.find(m => m.id === normalizedConfig.model)
  const modelCap = modelDef?.capabilityOverrides ?? {}
  const isXiaomiMimoVisionModel = baseUrl.includes('xiaomimimo.com') && normalizedConfig.model.toLowerCase() === 'mimo-v2.5'
  const visionDefault = isXiaomiMimoVisionModel
    ? true
    : (modelCap.supportsVision ?? providerCap.supportsVision ?? (agentProtocol === 'anthropic' || agentProtocol === 'openai'))
  const nativeVideoDefault = isKimiCoding
    || (modelCap.supportsNativeVideo ?? (visionDefault ? providerCap.supportsNativeVideo ?? false : false))
  const thinkingDefault = modelCap.supportsThinking ?? providerCap.supportsThinking ?? false
  const longContextDefault = modelCap.supportsLongContext ?? providerCap.supportsLongContext ?? ((modelDef?.contextWindow ?? 0) >= 128000)
  const multiTurnThinkingPolicy = modelCap.multiTurnThinkingPolicy ?? providerCap.multiTurnThinkingPolicy ?? 'unknown'

  return {
    config: normalizedConfig,
    provider,
    baseUrl,
    agentProtocol,
    wireApi,
    reasoningEffort,
    supportsToolCalls,
    supportsNativeToolCalls,
    toolCallTransport,
    supportsVision: applyCapabilityMode(normalizeCapabilityMode(normalizedConfig.visionMode), visionDefault),
    supportsNativeVideo: applyCapabilityMode(
      normalizeCapabilityMode(normalizedConfig.nativeVideoMode),
      nativeVideoDefault,
    ),
    supportsToolChoice: agentProtocol === 'anthropic' || wireApi === 'chat/completions',
    isKimiCoding,
    supportsThinking: applyCapabilityMode(normalizeCapabilityMode(normalizedConfig.thinkingMode), thinkingDefault),
    supportsLongContext: applyCapabilityMode(normalizeCapabilityMode(normalizedConfig.longContextMode), longContextDefault),
    multiTurnThinkingPolicy,
  }
}

export function getProviderDef(id: AIProviderType | string | undefined | null, baseUrl?: string): AIProviderDef | undefined {
  const normalizedId = normalizeProviderId(id, baseUrl)
  if (!normalizedId) return undefined
  return AI_PROVIDERS.find(p => p.id === normalizedId)
}

export function getDefaultConfig(): AIModelConfig {
  return {
    provider: 'moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKey: '',
    model: 'moonshot-v1-128k',
    agentProtocol: 'openai',
    wireApi: 'chat/completions',
    reasoningEffort: 'medium',
    toolUseMode: 'auto',
    visionMode: 'auto',
    nativeVideoMode: 'auto',
  }
}

export function migrateLegacyAISettingsToWorkspace(payload: LegacyAISettingsPayload): AIProviderWorkspace {
  const currentConfig = normalizeAIConfig(payload.aiModelConfig || getDefaultConfig())
  const savedConfigs = Object.fromEntries(
    Object.entries(payload.aiSavedConfigs || {}).map(([providerId, config]) => [
      providerId,
      normalizeAIConfig(config as AIModelConfig),
    ]),
  ) as Partial<Record<AIProviderType, AIModelConfig>>

  const builtinProfiles = (Object.keys(BUILTIN_PROFILE_META) as Array<Exclude<AIProviderCategory, 'custom'>>).map((category) => {
    const meta = BUILTIN_PROFILE_META[category]
    const nextConfig = currentConfig.provider === meta.provider
      ? currentConfig
      : savedConfigs[meta.provider] || createConfigFromProvider(meta.provider)
    return createBuiltinProfile(category, nextConfig)
  })

  const customByProvider = new Map<AIProviderType, AIModelConfig>()

  for (const [providerId, config] of Object.entries(savedConfigs) as Array<[AIProviderType, AIModelConfig]>) {
    if (resolveCategoryForConfig(config) === 'custom') {
      customByProvider.set(providerId, config)
    }
  }

  if (resolveCategoryForConfig(currentConfig) === 'custom') {
    customByProvider.set(currentConfig.provider, currentConfig)
  }

  const customProfiles = Array.from(customByProvider.entries()).map(([providerId, config]) => {
    const isActive = currentConfig.provider === providerId
      && currentConfig.baseUrl === config.baseUrl
      && currentConfig.model === config.model
    return createCustomAIProviderProfile(config, {
      id: `custom-${providerId}`,
      name: resolveProfileName(config, '自定义预设'),
      showInChatSwitcher: isActive,
    })
  })

  const activeBuiltin = builtinProfiles.find((profile) => profile.config.provider === currentConfig.provider)
  const activeCustom = customProfiles.find((profile) => (
    profile.config.provider === currentConfig.provider
    && profile.config.baseUrl === currentConfig.baseUrl
    && profile.config.model === currentConfig.model
  ))

  return {
    version: 1,
    activeProfileId: activeCustom?.id || activeBuiltin?.id || builtinProfiles[0]?.id || customProfiles[0]?.id || '',
    profiles: [...builtinProfiles, ...customProfiles],
  }
}

export function createDefaultAIWorkspace(): AIProviderWorkspace {
  return {
    version: 1,
    activeProfileId: 'custom-default-moonshot',
    profiles: [
      createBuiltinProfile('openai'),
      createBuiltinProfile('anthropic'),
      createBuiltinProfile('gemini'),
      createCustomAIProviderProfile(getDefaultConfig(), {
        id: 'custom-default-moonshot',
        name: resolveProfileName(getDefaultConfig(), 'Kimi'),
        showInChatSwitcher: true,
      }),
    ],
  }
}

export function deriveLegacyAISettingsPayload(workspace: AIProviderWorkspace | null | undefined): LegacyAISettingsPayload {
  const normalizedWorkspace = normalizeAIWorkspace(workspace)
  const activeConfig = getActiveAIConfig(normalizedWorkspace)
  const activeProfile = getActiveAIProfile(normalizedWorkspace)
  const savedConfigs = normalizedWorkspace.profiles.reduce<Partial<Record<AIProviderType, AIModelConfig>>>((acc, profile) => {
    const providerId = profile.config.provider
    if (!providerId) return acc
    const existing = acc[providerId]
    if (!existing || profile.id === activeProfile?.id) {
      acc[providerId] = cloneConfig({
        ...profile.config,
        displayName: profile.name,
      })
    }
    return acc
  }, {})

  return {
    aiModelConfig: activeConfig || undefined,
    aiSavedConfigs: savedConfigs,
  }
}

export function normalizeAIWorkspace(workspace: AIProviderWorkspace | null | undefined): AIProviderWorkspace {
  const fallback = createDefaultAIWorkspace()
  if (!workspace || !Array.isArray(workspace.profiles) || workspace.profiles.length === 0) {
    return fallback
  }

  const normalizedProfiles = workspace.profiles.map((profile) => {
    const normalizedCategory = profile.category === 'openai' || profile.category === 'anthropic' || profile.category === 'gemini'
      ? profile.category
      : 'custom'
    const baseProfile = normalizedCategory === 'custom'
      ? createCustomAIProviderProfile(profile.config, {
        id: profile.id,
        name: profile.name,
        showInChatSwitcher: profile.showInChatSwitcher,
      })
      : createBuiltinProfile(normalizedCategory, profile.config)

    return {
      ...baseProfile,
      id: profile.id || baseProfile.id,
      name: String(profile.name || '').trim() || baseProfile.name,
      builtIn: normalizedCategory === 'custom' ? false : true,
      showInChatSwitcher: profile.showInChatSwitcher ?? baseProfile.showInChatSwitcher,
      config: {
        ...baseProfile.config,
        ...cloneConfig(profile.config),
        displayName: String(profile.name || '').trim() || baseProfile.name,
      },
    }
  })

  const hasActive = normalizedProfiles.some((profile) => profile.id === workspace.activeProfileId)

  return {
    version: 1,
    activeProfileId: hasActive ? workspace.activeProfileId : normalizedProfiles[0]?.id || fallback.activeProfileId,
    profiles: normalizedProfiles,
  }
}

export function getActiveAIProfile(workspace: AIProviderWorkspace | null | undefined): AIProviderProfile | null {
  const normalizedWorkspace = normalizeAIWorkspace(workspace)
  return normalizedWorkspace.profiles.find((profile) => profile.id === normalizedWorkspace.activeProfileId) || null
}

export function getActiveAIConfig(workspace: AIProviderWorkspace | null | undefined): AIModelConfig | null {
  const activeProfile = getActiveAIProfile(workspace)
  if (!activeProfile) return null
  return cloneConfig({
    ...activeProfile.config,
    displayName: activeProfile.name,
  })
}

export function listChatSwitcherProfiles(workspace: AIProviderWorkspace | null | undefined): ChatSwitcherProfileGroups {
  const normalizedWorkspace = normalizeAIWorkspace(workspace)
  const activeProfile = getActiveAIProfile(normalizedWorkspace)
  const visibleProfiles = normalizedWorkspace.profiles.filter((profile) => profile.showInChatSwitcher)

  if (!activeProfile || activeProfile.showInChatSwitcher) {
    return {
      currentHiddenProfile: null,
      visibleProfiles,
    }
  }

  return {
    currentHiddenProfile: activeProfile,
    visibleProfiles: visibleProfiles.filter((profile) => profile.id !== activeProfile.id),
  }
}

/** Short display label for ChatPanel model picker */
export function getModelShortLabel(config: AIModelConfig): string {
  const provider = getProviderDef(config.provider)
  if (!provider) return config.model
  const model = provider.models.find(m => m.id === config.model)
  return model?.label || config.model
}

/** Provider short label for display */
export function getProviderShortLabel(config: AIModelConfig): string {
  const provider = getProviderDef(config.provider)
  if (!provider) return config.provider
  return provider.label.split(' ')[0] // "Kimi", "Claude", "OpenAI", etc.
}

/**
 * Set a profile's `config.model` to `modelId` and activate that profile in one
 * atomic workspace mutation. No-op when the profile does not exist or when
 * `modelId` is not in the profile's normalized modelIds list.
 */
export function applyProfileActiveModel(
  workspace: AIProviderWorkspace | null | undefined,
  profileId: string,
  modelId: string,
): AIProviderWorkspace {
  const normalized = normalizeAIWorkspace(workspace)
  const trimmedModelId = String(modelId || '').trim()
  const target = normalized.profiles.find((profile) => profile.id === profileId)
  if (!target || !trimmedModelId) return normalized

  const validModelIds = normalizeModelIds(target.config.model, target.config.modelIds) || []
  if (!validModelIds.includes(trimmedModelId)) return normalized

  const nextProfiles = normalized.profiles.map((profile) => (
    profile.id === profileId
      ? {
        ...profile,
        config: normalizeAIConfig({
          ...profile.config,
          model: trimmedModelId,
        }),
      }
      : profile
  ))

  return {
    version: 1,
    activeProfileId: profileId,
    profiles: nextProfiles,
  }
}
