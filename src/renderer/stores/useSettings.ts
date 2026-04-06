import { create } from 'zustand'
import {
  AIModelConfig,
  AIProviderType,
  getDefaultConfig,
  getProviderDef,
  getModelShortLabel,
  getProviderShortLabel,
  AI_PROVIDERS,
  normalizeAIConfig,
} from '../../shared/ai-providers'

const SETTINGS_SAVE_DEBOUNCE_MS = 300

let pendingSaveTimer: ReturnType<typeof setTimeout> | null = null
let pendingConfigSave: AIModelConfig | null = null

function clearPendingConfigSave(): void {
  if (pendingSaveTimer) {
    clearTimeout(pendingSaveTimer)
    pendingSaveTimer = null
  }
  pendingConfigSave = null
}

interface AISettingsState {
  /** Current AI model config (loaded from backend) */
  config: AIModelConfig
  /** Whether config has been loaded from backend */
  loaded: boolean
  /** Connection test state */
  testStatus: 'idle' | 'testing' | 'success' | 'error'
  testMessage: string
  testLatency: number | null
  /** Available models from test result */
  remoteModels: string[]
  /** Saved configs per provider for memory */
  savedConfigs: Partial<Record<AIProviderType, AIModelConfig>>

  // Actions
  loadConfig: () => Promise<void>
  saveConfig: (config: AIModelConfig) => Promise<void>
  updateField: <K extends keyof AIModelConfig>(key: K, value: AIModelConfig[K]) => void
  switchProvider: (provider: AIProviderType) => void
  testConnection: () => Promise<void>

  // Derived getters (computed from config)
  getShortModelLabel: () => string
  getShortProviderLabel: () => string
}

export const useSettings = create<AISettingsState>((set, get) => ({
  config: getDefaultConfig(),
  loaded: false,
  testStatus: 'idle',
  testMessage: '',
  testLatency: null,
  remoteModels: [],
  savedConfigs: {},

  loadConfig: async () => {
    try {
      if (typeof window !== 'undefined' && window.electronAPI?.settings) {
        const result = await window.electronAPI.settings.getAIConfig()
        // Also load saved per-provider configs
        const savedResult = await window.electronAPI.settings.get('ai_saved_configs')
        let savedConfigs: Partial<Record<AIProviderType, AIModelConfig>> = {}
        if (savedResult.success && savedResult.data) {
          try {
            const parsed = JSON.parse(savedResult.data) as Partial<Record<AIProviderType, AIModelConfig>>
            savedConfigs = Object.fromEntries(
              Object.entries(parsed).map(([providerKey, providerConfig]) => [providerKey, normalizeAIConfig(providerConfig as AIModelConfig)])
            ) as Partial<Record<AIProviderType, AIModelConfig>>
          } catch { /* ignore */ }
        }
        if (result.success && result.data) {
          const config = normalizeAIConfig(result.data as AIModelConfig)
          // Also store current config in savedConfigs for its provider
          savedConfigs[config.provider] = config
          set({ config, loaded: true, savedConfigs })
          return
        }
      }
    } catch (e) {
      console.error('Failed to load AI config:', e)
    }
    set({ config: getDefaultConfig(), loaded: true })
  },

  saveConfig: async (config: AIModelConfig) => {
    clearPendingConfigSave()
    const normalizedConfig = normalizeAIConfig(config)
    set({ config: normalizedConfig })
    try {
      if (typeof window !== 'undefined' && window.electronAPI?.settings) {
        await window.electronAPI.settings.setAIConfig(normalizedConfig)
        // Also persist savedConfigs
        const savedConfigs = { ...get().savedConfigs, [normalizedConfig.provider]: normalizedConfig }
        set({ savedConfigs })
        await window.electronAPI.settings.set('ai_saved_configs', JSON.stringify(savedConfigs))
      }
    } catch (e) {
      console.error('Failed to save AI config:', e)
    }
  },

  updateField: (key, value) => {
    const prev = get().config
    const newConfig = { ...prev, [key]: value }
    // Smart preset: Kimi Code keys should default to Kimi coding endpoint/model.
    if (
      key === 'apiKey' &&
      prev.provider === 'moonshot' &&
      typeof value === 'string' &&
      value.trim().startsWith('sk-kimi-')
    ) {
      newConfig.baseUrl = 'https://api.kimi.com/coding'
      if (!newConfig.model || newConfig.model.startsWith('moonshot-') || newConfig.model === 'kimi-latest') {
        newConfig.model = 'kimi-for-coding'
      }
    }
    // Save current config to memory and persist
    const savedConfigs = { ...get().savedConfigs, [prev.provider]: newConfig }
    set({ config: newConfig, savedConfigs, testStatus: 'idle', testMessage: '' })
    pendingConfigSave = normalizeAIConfig(newConfig)
    if (pendingSaveTimer) {
      clearTimeout(pendingSaveTimer)
    }
    pendingSaveTimer = setTimeout(() => {
      const configToPersist = pendingConfigSave
      clearPendingConfigSave()
      if (!configToPersist) return
      void get().saveConfig(configToPersist)
    }, SETTINGS_SAVE_DEBOUNCE_MS)
  },

  switchProvider: (provider: AIProviderType) => {
    const providerDef = getProviderDef(provider)
    if (!providerDef) return

    const pendingConfig = pendingConfigSave
    if (pendingConfig) {
      void get().saveConfig(pendingConfig)
    }

    // Save current config before switching
    const currentConfig = get().config
    const savedConfigs = { ...get().savedConfigs, [currentConfig.provider]: currentConfig }

    // Try to restore saved config for this provider
    const savedConfig = savedConfigs[provider]
    const newConfig: AIModelConfig = savedConfig || {
      provider,
      baseUrl: providerDef.baseUrl,
      apiKey: '',
      model: providerDef.models[0]?.id || '',
      agentProtocol: providerDef.agentProtocol,
      wireApi: providerDef.wireApi,
      reasoningEffort: providerDef.defaultReasoningEffort,
      toolUseMode: 'auto',
      visionMode: 'auto',
      nativeVideoMode: 'auto',
    }

    set({ config: newConfig, savedConfigs, testStatus: 'idle', testMessage: '', remoteModels: [] })
    // Persist both current config and savedConfigs
    get().saveConfig(newConfig)
  },

  testConnection: async () => {
    const { config } = get()
    if (!config.apiKey) {
      set({ testStatus: 'error', testMessage: '请先填写 API Key' })
      return
    }

    set({ testStatus: 'testing', testMessage: '正在连接...' })

    try {
      if (typeof window !== 'undefined' && window.electronAPI?.settings) {
        const result = await window.electronAPI.settings.testAIConnection(config)
        if (result.success && result.data) {
          set({
            testStatus: 'success',
            testMessage: `连接成功 (${result.data.latencyMs}ms)`,
            testLatency: result.data.latencyMs,
            remoteModels: result.data.modelList || [],
          })
        } else {
          set({
            testStatus: 'error',
            testMessage: result.error || '连接失败',
            testLatency: null,
          })
        }
      } else {
        // Mock mode
        await new Promise(r => setTimeout(r, 800))
        set({
          testStatus: 'success',
          testMessage: '模拟模式: 连接成功',
          testLatency: 42,
          remoteModels: [],
        })
      }
    } catch (e) {
      set({
        testStatus: 'error',
        testMessage: e instanceof Error ? e.message : '连接失败',
        testLatency: null,
      })
    }
  },

  getShortModelLabel: () => getModelShortLabel(get().config),
  getShortProviderLabel: () => getProviderShortLabel(get().config),
}))

// Re-export for convenience
export { AI_PROVIDERS, getProviderDef, getDefaultConfig }
export type { AIModelConfig, AIProviderType }
