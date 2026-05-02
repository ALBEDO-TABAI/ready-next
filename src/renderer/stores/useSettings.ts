import { create } from 'zustand'
import {
  createConfigFromProvider,
  createCustomAIProviderProfile,
  createDefaultAIWorkspace,
  getActiveAIConfig,
  getActiveAIProfile,
  getModelShortLabel,
  getProviderDef,
  getProviderShortLabel,
  normalizeAIConfig,
  normalizeAIWorkspace,
  type AIModelConfig,
  type AIProviderCategory,
  type AIProviderProfile,
  type AIProviderType,
  type AIProviderWorkspace,
} from '../../shared/ai-providers'
import type { CapabilityGroupId, CapabilityMode } from '../../shared/ai-capability-groups'

const SETTINGS_SAVE_DEBOUNCE_MS = 300

let pendingSaveTimer: ReturnType<typeof setTimeout> | null = null
let pendingWorkspaceSave: AIProviderWorkspace | null = null
let flushHandlersRegistered = false
let loadConfigPromise: Promise<void> | null = null

function clearPendingWorkspaceSave(): void {
  if (pendingSaveTimer) {
    clearTimeout(pendingSaveTimer)
    pendingSaveTimer = null
  }
  pendingWorkspaceSave = null
}

function flushPendingWorkspaceSave(get: () => AISettingsState): void {
  const workspaceToPersist = pendingWorkspaceSave
  const selectedProfileId = get().selectedProfileId
  clearPendingWorkspaceSave()
  if (!workspaceToPersist) return
  void get().saveWorkspace(workspaceToPersist, { selectedProfileId })
}

function deriveSavedConfigs(workspace: AIProviderWorkspace): Partial<Record<AIProviderType, AIModelConfig>> {
  return workspace.profiles.reduce<Partial<Record<AIProviderType, AIModelConfig>>>((acc, profile) => {
    if (!acc[profile.config.provider]) {
      acc[profile.config.provider] = profile.config
    }
    return acc
  }, {})
}

function getProfileById(workspace: AIProviderWorkspace, profileId?: string | null): AIProviderProfile | null {
  const resolvedId = profileId || workspace.activeProfileId
  return workspace.profiles.find((profile) => profile.id === resolvedId) || null
}

function buildStateFromWorkspace(workspace: AIProviderWorkspace, selectedProfileId?: string | null) {
  const normalizedWorkspace = normalizeAIWorkspace(workspace)
  const activeConfig = getActiveAIConfig(normalizedWorkspace) || createConfigFromProvider('openai')
  const nextSelectedProfileId = normalizedWorkspace.profiles.some((profile) => profile.id === selectedProfileId)
    ? selectedProfileId || normalizedWorkspace.activeProfileId
    : normalizedWorkspace.activeProfileId

  return {
    workspace: normalizedWorkspace,
    config: activeConfig,
    selectedProfileId: nextSelectedProfileId,
    savedConfigs: deriveSavedConfigs(normalizedWorkspace),
  }
}

function formatSettingsPersistenceError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error || '未知错误')
}

function assertIPCSuccess(result: { success?: boolean; error?: string } | undefined, fallbackMessage: string): void {
  if (result && result.success === false) {
    throw new Error(result.error || fallbackMessage)
  }
}

interface AISettingsState {
  config: AIModelConfig
  workspace: AIProviderWorkspace
  selectedProfileId: string | null
  loaded: boolean
  testStatus: 'idle' | 'testing' | 'success' | 'error'
  testMessage: string
  testLatency: number | null
  remoteModels: string[]
  savedConfigs: Partial<Record<AIProviderType, AIModelConfig>>
  saveStatus: 'idle' | 'saving' | 'error'
  saveMessage: string

  loadConfig: () => Promise<void>
  saveConfig: (config: AIModelConfig) => Promise<void>
  saveWorkspace: (workspace: AIProviderWorkspace, options?: { selectedProfileId?: string | null }) => Promise<void>
  updateField: <K extends keyof AIModelConfig>(key: K, value: AIModelConfig[K]) => void
  updateCapabilityMode: (groupId: CapabilityGroupId, mode: CapabilityMode) => void
  switchProvider: (provider: AIProviderType) => void
  selectProfile: (profileId: string) => void
  activateProfile: (profileId: string) => void
  renameProfile: (profileId: string, name: string) => void
  setProfileVisibility: (profileId: string, visible: boolean) => void
  addCustomProfile: (initialConfig?: Partial<AIModelConfig>) => string
  removeCustomProfile: (profileId: string) => void
  addModelId: (modelId: string, options?: { makeDefault?: boolean }) => void
  removeModelId: (modelId: string) => void
  testConnection: (profileId?: string) => Promise<void>

  getSelectedProfile: () => AIProviderProfile | null
  getActiveProfile: () => AIProviderProfile | null
  getShortModelLabel: (profileId?: string) => string
  getShortProviderLabel: (profileId?: string) => string
}

const defaultWorkspace = createDefaultAIWorkspace()
const defaultState = buildStateFromWorkspace(defaultWorkspace, defaultWorkspace.activeProfileId)

function scheduleWorkspaceSave(get: () => AISettingsState, workspace: AIProviderWorkspace, selectedProfileId?: string | null): void {
  pendingWorkspaceSave = normalizeAIWorkspace(workspace)
  if (pendingSaveTimer) {
    clearTimeout(pendingSaveTimer)
  }
  pendingSaveTimer = setTimeout(() => {
    const workspaceToPersist = pendingWorkspaceSave
    clearPendingWorkspaceSave()
    if (!workspaceToPersist) return
    void get().saveWorkspace(workspaceToPersist, { selectedProfileId })
  }, SETTINGS_SAVE_DEBOUNCE_MS)
}

function ensureWorkspaceFlushHandlers(get: () => AISettingsState): void {
  if (flushHandlersRegistered || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
  const flush = () => flushPendingWorkspaceSave(get)
  window.addEventListener('beforeunload', flush)
  window.addEventListener('pagehide', flush)
  flushHandlersRegistered = true
}

export const useSettings = create<AISettingsState>((set, get) => ({
  config: defaultState.config,
  workspace: defaultState.workspace,
  selectedProfileId: defaultState.selectedProfileId,
  loaded: false,
  testStatus: 'idle',
  testMessage: '',
  testLatency: null,
  remoteModels: [],
  savedConfigs: defaultState.savedConfigs,
  saveStatus: 'idle',
  saveMessage: '',

  loadConfig: async () => {
    if (loadConfigPromise) return loadConfigPromise
    loadConfigPromise = (async () => {
      try {
        if (typeof window !== 'undefined' && window.electronAPI?.settings) {
          const workspaceResult = await window.electronAPI.settings.getAIWorkspace?.()
          if (workspaceResult) {
            if (workspaceResult.success && workspaceResult.data) {
              set({
                ...buildStateFromWorkspace(workspaceResult.data as AIProviderWorkspace),
                loaded: true,
                saveStatus: 'idle',
                saveMessage: '',
              })
              return
            }
            throw new Error(workspaceResult.error || 'AI 设置读取失败')
          }

          const configResult = await window.electronAPI.settings.getAIConfig()
          if (configResult.success && configResult.data) {
            const workspace = normalizeAIWorkspace({
              ...createDefaultAIWorkspace(),
              profiles: createDefaultAIWorkspace().profiles.map((profile) => (
                profile.id === createDefaultAIWorkspace().activeProfileId
                  ? {
                    ...profile,
                    config: normalizeAIConfig(configResult.data as AIModelConfig),
                  }
                  : profile
              )),
            })
            set({
              ...buildStateFromWorkspace(workspace),
              loaded: true,
              saveStatus: 'idle',
              saveMessage: '',
            })
            return
          }
        }
      } catch (error) {
        const message = formatSettingsPersistenceError(error)
        console.error('Failed to load AI workspace:', error)
        set({
          saveStatus: 'error',
          saveMessage: `设置读取失败：${message}`,
          loaded: true,
        })
        return
      }

      set({
        ...defaultState,
        loaded: true,
        saveStatus: 'idle',
        saveMessage: '',
      })
    })()
    try {
      await loadConfigPromise
    } finally {
      loadConfigPromise = null
    }
  },

  saveConfig: async (config: AIModelConfig) => {
    clearPendingWorkspaceSave()
    try {
      if (typeof window !== 'undefined' && window.electronAPI?.settings?.setAIConfig) {
        const result = await window.electronAPI.settings.setAIConfig(normalizeAIConfig(config))
        assertIPCSuccess(result, 'AI 设置保存失败')
      }
      await get().loadConfig()
    } catch (error) {
      const message = formatSettingsPersistenceError(error)
      console.error('Failed to save AI config:', error)
      set({
        saveStatus: 'error',
        saveMessage: `设置保存失败：${message}`,
      })
    }
  },

  saveWorkspace: async (workspace, options) => {
    clearPendingWorkspaceSave()
    const previousState = get()
    const normalizedWorkspace = normalizeAIWorkspace(workspace)
    set({
      ...buildStateFromWorkspace(normalizedWorkspace, options?.selectedProfileId),
      saveStatus: 'saving',
      saveMessage: '',
    })
    try {
      if (typeof window !== 'undefined' && window.electronAPI?.settings?.setAIWorkspace) {
        const result = await window.electronAPI.settings.setAIWorkspace(normalizedWorkspace)
        assertIPCSuccess(result, 'AI 设置保存失败')
      } else if (typeof window !== 'undefined' && window.electronAPI?.settings?.setAIConfig) {
        const activeConfig = getActiveAIConfig(normalizedWorkspace)
        if (activeConfig) {
          const result = await window.electronAPI.settings.setAIConfig(activeConfig)
          assertIPCSuccess(result, 'AI 设置保存失败')
        }
      }
      set({ saveStatus: 'idle', saveMessage: '' })
    } catch (error) {
      const message = formatSettingsPersistenceError(error)
      console.error('Failed to save AI workspace:', error)
      set({
        ...buildStateFromWorkspace(previousState.workspace, previousState.selectedProfileId),
        testStatus: previousState.testStatus,
        testMessage: previousState.testMessage,
        testLatency: previousState.testLatency,
        remoteModels: previousState.remoteModels,
        loaded: previousState.loaded,
        saveStatus: 'error',
        saveMessage: `设置保存失败：${message}`,
      })
    }
  },

  updateField: (key, value) => {
    const state = get()
    const targetProfile = getProfileById(state.workspace, state.selectedProfileId)
    if (!targetProfile) return

    const nextConfig: AIModelConfig = {
      ...targetProfile.config,
      [key]: value,
    }

    if (
      key === 'apiKey'
      && targetProfile.config.provider === 'moonshot'
      && typeof value === 'string'
      && value.trim().startsWith('sk-kimi-')
    ) {
      nextConfig.baseUrl = 'https://api.kimi.com/coding/'
      nextConfig.agentProtocol = 'anthropic'
      if (!nextConfig.model || nextConfig.model.startsWith('moonshot-') || nextConfig.model === 'kimi-latest') {
        nextConfig.model = 'kimi-for-coding'
      }
    }

    if (key === 'baseUrl' && typeof value === 'string' && value.trim().replace(/\/+$/, '').includes('api.kimi.com/coding')) {
      nextConfig.agentProtocol = 'anthropic'
    }

    const nextWorkspace = normalizeAIWorkspace({
      ...state.workspace,
      profiles: state.workspace.profiles.map((profile) => {
        if (profile.id !== targetProfile.id) return profile
        const nextName = key === 'displayName'
          ? String(value || '').trim() || profile.name
          : profile.name
        return {
          ...profile,
          name: nextName,
          config: normalizeAIConfig({
            ...nextConfig,
            displayName: nextName,
          }),
        }
      }),
    })

    set({
      ...buildStateFromWorkspace(nextWorkspace, state.selectedProfileId),
      testStatus: 'idle',
      testMessage: '',
      saveStatus: 'idle',
      saveMessage: '',
      remoteModels: [],
    })
    scheduleWorkspaceSave(get, nextWorkspace, state.selectedProfileId)
  },

  updateCapabilityMode: (groupId, mode) => {
    const state = get()
    const targetProfile = getProfileById(state.workspace, state.selectedProfileId)
    if (!targetProfile) return

    const nextWorkspace = normalizeAIWorkspace({
      ...state.workspace,
      profiles: state.workspace.profiles.map((profile) => (
        profile.id === targetProfile.id
          ? {
            ...profile,
            config: normalizeAIConfig({
              ...profile.config,
              capabilityModes: {
                ...(profile.config.capabilityModes || {}),
                [groupId]: mode,
              },
            }),
          }
          : profile
      )),
    })

    set({
      ...buildStateFromWorkspace(nextWorkspace, state.selectedProfileId),
      testStatus: 'idle',
      testMessage: '',
    })
    scheduleWorkspaceSave(get, nextWorkspace, state.selectedProfileId)
  },

  switchProvider: (provider) => {
    const state = get()
    const providerDef = getProviderDef(provider)
    if (!providerDef) return
    flushPendingWorkspaceSave(get)

    const builtinTargetId = provider === 'openai'
      ? 'builtin-openai'
      : provider === 'anthropic'
        ? 'builtin-anthropic'
        : provider === 'gemini'
          ? 'builtin-gemini'
          : null

    if (builtinTargetId) {
      const nextWorkspace = {
        ...state.workspace,
        activeProfileId: builtinTargetId,
      }
      set({
        ...buildStateFromWorkspace(nextWorkspace, builtinTargetId),
        testStatus: 'idle',
        testMessage: '',
        remoteModels: [],
      })
      void get().saveWorkspace(nextWorkspace, { selectedProfileId: builtinTargetId })
      return
    }

    let nextWorkspace = state.workspace
    let targetProfile = state.workspace.profiles.find((profile) => (
      !profile.builtIn && profile.config.provider === provider
    )) || null

    if (!targetProfile) {
      targetProfile = createCustomAIProviderProfile(createConfigFromProvider(provider), {
        name: providerDef.label.split('(')[0]?.trim() || providerDef.label,
        showInChatSwitcher: true,
      })
      nextWorkspace = {
        ...state.workspace,
        profiles: [...state.workspace.profiles, targetProfile],
      }
    }

    nextWorkspace = {
      ...nextWorkspace,
      activeProfileId: targetProfile.id,
    }

    set({
      ...buildStateFromWorkspace(nextWorkspace, targetProfile.id),
      testStatus: 'idle',
      testMessage: '',
      remoteModels: [],
    })
    void get().saveWorkspace(nextWorkspace, { selectedProfileId: targetProfile.id })
  },

  selectProfile: (profileId) => {
    const state = get()
    if (!state.workspace.profiles.some((profile) => profile.id === profileId)) return
    set({
      ...buildStateFromWorkspace(state.workspace, profileId),
      testStatus: 'idle',
      testMessage: '',
      remoteModels: [],
    })
  },

  activateProfile: (profileId) => {
    const state = get()
    if (!state.workspace.profiles.some((profile) => profile.id === profileId)) return
    const nextWorkspace = {
      ...state.workspace,
      activeProfileId: profileId,
    }
    set({
      ...buildStateFromWorkspace(nextWorkspace, profileId),
      testStatus: 'idle',
      testMessage: '',
      remoteModels: [],
    })
    void get().saveWorkspace(nextWorkspace, { selectedProfileId: profileId })
  },

  renameProfile: (profileId, name) => {
    const trimmedName = String(name || '').trim()
    if (!trimmedName) return
    const state = get()
    const nextWorkspace = normalizeAIWorkspace({
      ...state.workspace,
      profiles: state.workspace.profiles.map((profile) => (
        profile.id === profileId
          ? {
            ...profile,
            name: trimmedName,
            config: {
              ...profile.config,
              displayName: trimmedName,
            },
          }
          : profile
      )),
    })

    set({
      ...buildStateFromWorkspace(nextWorkspace, state.selectedProfileId === profileId ? profileId : state.selectedProfileId),
    })
    scheduleWorkspaceSave(get, nextWorkspace, state.selectedProfileId)
  },

  setProfileVisibility: (profileId, visible) => {
    const state = get()
    const nextWorkspace = normalizeAIWorkspace({
      ...state.workspace,
      profiles: state.workspace.profiles.map((profile) => (
        profile.id === profileId
          ? {
            ...profile,
            showInChatSwitcher: visible,
          }
          : profile
      )),
    })

    set({
      ...buildStateFromWorkspace(nextWorkspace, state.selectedProfileId),
    })
    scheduleWorkspaceSave(get, nextWorkspace, state.selectedProfileId)
  },

  addCustomProfile: (initialConfig) => {
    const state = get()
    const nextProfile = createCustomAIProviderProfile(initialConfig, {
      showInChatSwitcher: true,
    })
    const nextWorkspace = normalizeAIWorkspace({
      ...state.workspace,
      profiles: [...state.workspace.profiles, nextProfile],
    })

    set({
      ...buildStateFromWorkspace(nextWorkspace, nextProfile.id),
      testStatus: 'idle',
      testMessage: '',
      remoteModels: [],
    })
    scheduleWorkspaceSave(get, nextWorkspace, nextProfile.id)
    return nextProfile.id
  },

  removeCustomProfile: (profileId) => {
    const state = get()
    const targetProfile = state.workspace.profiles.find((profile) => profile.id === profileId)
    if (!targetProfile || targetProfile.builtIn) return

    const remainingProfiles = state.workspace.profiles.filter((profile) => profile.id !== profileId)
    const nextActiveProfileId = state.workspace.activeProfileId === profileId
      ? remainingProfiles[0]?.id || defaultWorkspace.activeProfileId
      : state.workspace.activeProfileId
    const nextSelectedProfileId = state.selectedProfileId === profileId
      ? nextActiveProfileId
      : state.selectedProfileId
    const nextWorkspace = normalizeAIWorkspace({
      ...state.workspace,
      activeProfileId: nextActiveProfileId,
      profiles: remainingProfiles,
    })

    set({
      ...buildStateFromWorkspace(nextWorkspace, nextSelectedProfileId),
      testStatus: 'idle',
      testMessage: '',
      remoteModels: [],
    })
    scheduleWorkspaceSave(get, nextWorkspace, nextSelectedProfileId)
  },

  addModelId: (modelId, options) => {
    const trimmedModelId = String(modelId || '').trim()
    if (!trimmedModelId) return
    const state = get()
    const targetProfile = getProfileById(state.workspace, state.selectedProfileId)
    if (!targetProfile) return

    const nextModelIds = [
      ...(targetProfile.config.modelIds || []),
      trimmedModelId,
    ].filter(Boolean)

    const nextWorkspace = normalizeAIWorkspace({
      ...state.workspace,
      profiles: state.workspace.profiles.map((profile) => (
        profile.id === targetProfile.id
          ? {
            ...profile,
            config: normalizeAIConfig({
              ...profile.config,
              model: options?.makeDefault || !profile.config.model ? trimmedModelId : profile.config.model,
              modelIds: nextModelIds,
            }),
          }
          : profile
      )),
    })

    set({
      ...buildStateFromWorkspace(nextWorkspace, state.selectedProfileId),
      testStatus: 'idle',
      testMessage: '',
      remoteModels: [],
    })
    scheduleWorkspaceSave(get, nextWorkspace, state.selectedProfileId)
  },

  removeModelId: (modelId) => {
    const trimmedModelId = String(modelId || '').trim()
    if (!trimmedModelId) return
    const state = get()
    const targetProfile = getProfileById(state.workspace, state.selectedProfileId)
    if (!targetProfile) return

    const remainingModelIds = (targetProfile.config.modelIds || []).filter((value) => value !== trimmedModelId)
    const nextPrimaryModel = targetProfile.config.model === trimmedModelId
      ? (remainingModelIds[0] || '')
      : targetProfile.config.model

    const nextWorkspace = normalizeAIWorkspace({
      ...state.workspace,
      profiles: state.workspace.profiles.map((profile) => (
        profile.id === targetProfile.id
          ? {
            ...profile,
            config: normalizeAIConfig({
              ...profile.config,
              model: nextPrimaryModel,
              modelIds: remainingModelIds,
            }),
          }
          : profile
      )),
    })

    set({
      ...buildStateFromWorkspace(nextWorkspace, state.selectedProfileId),
      testStatus: 'idle',
      testMessage: '',
      remoteModels: [],
    })
    scheduleWorkspaceSave(get, nextWorkspace, state.selectedProfileId)
  },

  testConnection: async (profileId) => {
    const state = get()
    const targetProfile = getProfileById(state.workspace, profileId || state.selectedProfileId)
    const config = targetProfile?.config || state.config

    if (!config.apiKey) {
      set({ testStatus: 'error', testMessage: '请先填写 API Key', testLatency: null })
      return
    }

    set({ testStatus: 'testing', testMessage: '正在连接...', testLatency: null })

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
            remoteModels: [],
          })
        }
        return
      }

      await new Promise((resolve) => setTimeout(resolve, 800))
      set({
        testStatus: 'success',
        testMessage: '模拟模式: 连接成功',
        testLatency: 42,
        remoteModels: [],
      })
    } catch (error) {
      set({
        testStatus: 'error',
        testMessage: error instanceof Error ? error.message : '连接失败',
        testLatency: null,
        remoteModels: [],
      })
    }
  },

  getSelectedProfile: () => getProfileById(get().workspace, get().selectedProfileId),
  getActiveProfile: () => getActiveAIProfile(get().workspace),
  getShortModelLabel: (profileId) => {
    const profile = getProfileById(get().workspace, profileId)
    return getModelShortLabel(profile?.config || get().config)
  },
  getShortProviderLabel: (profileId) => {
    const profile = getProfileById(get().workspace, profileId)
    if (profile) return profile.name
    return getProviderShortLabel(get().config)
  },
}))

ensureWorkspaceFlushHandlers(() => useSettings.getState())

export { AI_PROVIDERS, createCustomAIProviderProfile, getProviderDef, getDefaultConfig, listChatSwitcherProfiles } from '../../shared/ai-providers'
export type { AIModelConfig, AIProviderCategory, AIProviderProfile, AIProviderType, AIProviderWorkspace }
