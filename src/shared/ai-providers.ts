/**
 * AI Provider definitions and model presets.
 * Shared between main process and renderer.
 */

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
}

export interface AIModelConfig {
  provider: AIProviderType
  baseUrl: string
  apiKey: string
  model: string
  agentProtocol?: AIAgentProtocol
  wireApi?: AIWireAPI
  reasoningEffort?: AIReasoningEffort
  toolUseMode?: AICapabilityMode
  visionMode?: AICapabilityMode
  nativeVideoMode?: AICapabilityMode
  /** Volcano Engine specific: endpoint ID */
  endpointId?: string
}

// ---------------------------------------------------------------------------
// Provider Registry
// ---------------------------------------------------------------------------

export const AI_PROVIDERS: AIProviderDef[] = [
  // ── Moonshot / Kimi ──────────────────────────────────────────────────
  {
    id: 'moonshot',
    label: 'Kimi (月之暗面)',
    labelEn: 'Moonshot AI',
    icon: '🌙',
    baseUrl: 'https://api.moonshot.cn/v1',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    agentProtocol: 'openai',
    models: [
      { id: 'kimi-for-coding', label: 'Kimi For Coding', category: 'chat', description: 'Coding 专用（第三方 Agent 兼容）' },
      { id: 'moonshot-v1-128k', label: 'Moonshot V1 128K', category: 'chat', contextWindow: 128000, description: '超长上下文' },
      { id: 'moonshot-v1-32k', label: 'Moonshot V1 32K', category: 'chat', contextWindow: 32768 },
      { id: 'moonshot-v1-8k', label: 'Moonshot V1 8K', category: 'chat', contextWindow: 8192 },
      { id: 'kimi-latest', label: 'Kimi Latest', category: 'chat', description: '最新版本' },
    ],
    apiKeyPlaceholder: 'sk-...',
    helpUrl: 'https://platform.moonshot.cn/docs',
  },

  // ── Anthropic / Claude ───────────────────────────────────────────────
  {
    id: 'anthropic',
    label: 'Claude (Anthropic)',
    labelEn: 'Anthropic',
    icon: '🤖',
    baseUrl: 'https://api.anthropic.com',
    authHeader: 'x-api-key',
    authPrefix: '',
    agentProtocol: 'anthropic',
    extraHeaders: { 'anthropic-version': '2023-06-01' },
    models: [
      { id: 'claude-opus-4-20250514', label: 'Claude Opus 4', category: 'chat', description: '最强推理' },
      { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4', category: 'chat', description: '均衡性能' },
      { id: 'claude-haiku-3-5-20241022', label: 'Claude Haiku 3.5', category: 'chat', description: '快速低成本' },
      { id: '__custom__', label: '自定义模型 ID', category: 'chat', description: '手动输入，如 kimi-for-coding' },
    ],
    apiKeyPlaceholder: 'sk-ant-...',
    helpUrl: 'https://docs.anthropic.com',
  },

  // ── FoxCode / NewCLI Codex ───────────────────────────────────────────
  {
    id: 'fox',
    label: 'FoxCode Codex',
    labelEn: 'FoxCode / NewCLI Codex',
    icon: '🦊',
    baseUrl: 'https://code.newcli.com/codex/v1',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    agentProtocol: 'openai',
    wireApi: 'responses',
    defaultReasoningEffort: 'high',
    models: [
      { id: 'gpt-5.4', label: 'GPT-5.4', category: 'chat', description: 'FoxCode 推荐模型' },
      { id: 'gpt-5', label: 'GPT-5', category: 'chat', description: 'Codex 通道' },
      { id: 'gpt-5-codex', label: 'GPT-5 Codex', category: 'chat', description: 'Codex 优化变体' },
      { id: '__custom__', label: '自定义模型 ID', category: 'chat', description: '手动输入，如 gpt-5.4' },
    ],
    apiKeyPlaceholder: 'sk-ant-...',
    helpUrl: 'https://foxcode.rjj.cc/api-keys',
  },

  // ── OpenAI / GPT ─────────────────────────────────────────────────────
  {
    id: 'openai',
    label: 'OpenAI',
    labelEn: 'OpenAI',
    icon: '⚡',
    baseUrl: 'https://api.openai.com/v1',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    agentProtocol: 'openai',
    models: [
      { id: 'gpt-5.4', label: 'GPT-5.4', category: 'chat', description: '自定义新增模型' },
      { id: 'gpt-4o', label: 'GPT-4o', category: 'chat', description: '旗舰多模态' },
      { id: 'gpt-4o-mini', label: 'GPT-4o Mini', category: 'chat', description: '高性价比' },
      { id: 'o3-mini', label: 'o3-mini', category: 'chat', description: '高效推理' },
      { id: 'gpt-4-turbo', label: 'GPT-4 Turbo', category: 'chat', contextWindow: 128000 },
      { id: 'codex-mini-latest', label: 'Codex Mini', category: 'chat', description: '代码优化' },
      { id: '__custom__', label: '自定义模型 ID', category: 'chat', description: '手动输入，如 gpt-5.4-custom' },
    ],
    apiKeyPlaceholder: 'sk-...',
    helpUrl: 'https://platform.openai.com/docs/api-reference',
  },

  // ── Google Gemini ────────────────────────────────────────────────────
  {
    id: 'gemini',
    label: 'Gemini (Google)',
    labelEn: 'Google Gemini',
    icon: '💎',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    agentProtocol: 'openai',
    models: [
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', category: 'chat', description: '最新旗舰，支持思考' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', category: 'chat', description: '快速思考' },
      { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', category: 'chat', description: '快速多模态' },
      { id: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro', category: 'chat', contextWindow: 2000000, description: '200万上下文' },
    ],
    apiKeyPlaceholder: 'AIza...',
    helpUrl: 'https://ai.google.dev/gemini-api/docs',
  },

  // ── Volcano Engine (Seedance + Seedream) ─────────────────────────────
  {
    id: 'volcengine',
    label: '火山方舟 (豆包)',
    labelEn: 'Volcano Engine',
    icon: '🌋',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    agentProtocol: 'openai',
    models: [
      { id: 'doubao-1.5-pro-32k', label: '豆包 1.5 Pro', category: 'chat', contextWindow: 32768, description: '通用对话' },
      { id: 'doubao-1.5-lite-32k', label: '豆包 1.5 Lite', category: 'chat', contextWindow: 32768, description: '轻量对话' },
      { id: 'seedance-1.0-pro', label: 'Seedance 1.0 Pro', category: 'video', description: '文本转视频' },
      { id: 'seedance-1.0-lite', label: 'Seedance 1.0 Lite', category: 'video', description: '快速视频生成' },
      { id: 'seedream-3.0', label: 'Seedream 3.0', category: 'image', description: '文本转图像' },
      { id: 'seedream-2.0', label: 'Seedream 2.0', category: 'image', description: '图像生成' },
    ],
    apiKeyPlaceholder: 'ark-...',
    helpUrl: 'https://www.volcengine.com/docs/82379',
  },

  // ── OpenAI Compatible ────────────────────────────────────────────────
  {
    id: 'openai-compatible',
    label: '自定义 (OpenAI 兼容)',
    labelEn: 'OpenAI Compatible',
    icon: '🔧',
    baseUrl: '',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    agentProtocol: 'openai',
    models: [
      { id: 'newcli-codex', label: 'NewCLI Codex', category: 'chat', description: 'FoxCode / NewCLI Codex 通道' },
      { id: 'free-codex', label: 'Free Codex', category: 'chat', description: 'FoxCode 免费 Codex 通道' },
      { id: 'newcli-codex-claude-sonnet', label: 'NewCLI Codex Claude Sonnet', category: 'chat', description: 'Claude Sonnet 风格 Codex 通道' },
      { id: 'newcli-codex-qwen-coder', label: 'NewCLI Codex Qwen Coder', category: 'chat', description: 'Qwen Coder 风格 Codex 通道' },
      { id: 'custom', label: '自定义模型', category: 'chat', description: '手动输入模型 ID' },
    ],
    apiKeyPlaceholder: 'sk-...',
    helpUrl: '',
  },
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
  const nextConfig: AIModelConfig = {
    ...config,
    provider: providerId,
    wireApi: config.wireApi || provider?.wireApi || config.wireApi,
    reasoningEffort: config.reasoningEffort || provider?.defaultReasoningEffort || config.reasoningEffort,
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

export function resolveAIConfigCapabilities(config: AIModelConfig | null | undefined): AIResolvedCapabilities | null {
  const normalizedConfig = normalizeAIConfig(config)
  if (!normalizedConfig) return null

  const baseUrl = String(normalizedConfig.baseUrl || '').trim().replace(/\/+$/, '')
  const provider = getProviderDef(normalizedConfig.provider, baseUrl)
  const explicitProtocol = normalizeAgentProtocol(normalizedConfig.agentProtocol)
  const inferredProtocol = (() => {
    if (provider?.agentProtocol) return provider.agentProtocol
    if (baseUrl.includes('api.kimi.com/coding')) return 'anthropic'
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
    supportsVision: applyCapabilityMode(normalizeCapabilityMode(normalizedConfig.visionMode), agentProtocol === 'anthropic' || agentProtocol === 'openai'),
    supportsNativeVideo: applyCapabilityMode(
      normalizeCapabilityMode(normalizedConfig.nativeVideoMode),
      isKimiCoding || (agentProtocol === 'openai' && !baseUrl.includes('/coding'))
    ),
    supportsToolChoice: agentProtocol === 'anthropic' || wireApi === 'chat/completions',
    isKimiCoding,
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
