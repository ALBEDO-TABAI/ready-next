import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AIModelConfig, AIProviderWorkspace } from '../shared/ai-providers'

const storage = new Map<string, string>()
const listeners = new Map<string, Set<(event: { type: string }) => void>>()

const localStorageMock = {
  getItem: (key: string): string | null => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
  removeItem: (key: string) => { storage.delete(key) },
  clear: () => { storage.clear() },
}

const matchMediaMock = () => ({
  matches: false,
  media: '(prefers-color-scheme: dark)',
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
})

const documentMock = {
  documentElement: {
    setAttribute: () => {},
    getAttribute: () => null,
  },
}

type SettingsApiMock = {
  getAIWorkspace: () => Promise<{ success: boolean; data?: AIProviderWorkspace }>
  getAIConfig: () => Promise<{ success: boolean; data?: AIModelConfig | null }>
  setAIWorkspace: (workspace: AIProviderWorkspace) => Promise<{ success: boolean; error?: string }>
  setAIConfig: () => Promise<{ success: boolean }>
  get: () => Promise<{ success: boolean }>
  set: () => Promise<{ success: boolean }>
  testAIConnection: () => Promise<{ success: boolean; error?: string }>
}

type MockWindow = typeof globalThis & {
  matchMedia: typeof matchMediaMock
  electronAPI: {
    settings: SettingsApiMock
  }
}

type MockGlobal = typeof globalThis & {
  localStorage: typeof localStorageMock
  document: typeof documentMock
  matchMedia: typeof matchMediaMock
  addEventListener: (type: string, cb: (event: { type: string }) => void) => void
  removeEventListener: (type: string, cb: (event: { type: string }) => void) => void
  dispatchEvent: (event: { type: string }) => boolean
  window: MockWindow
}

const testGlobal = globalThis as unknown as MockGlobal

testGlobal.localStorage = localStorageMock
testGlobal.document = documentMock
testGlobal.matchMedia = matchMediaMock
testGlobal.addEventListener = (type: string, cb: (event: { type: string }) => void) => {
  const set = listeners.get(type) || new Set()
  set.add(cb)
  listeners.set(type, set)
}
testGlobal.removeEventListener = (type: string, cb: (event: { type: string }) => void) => {
  listeners.get(type)?.delete(cb)
}
testGlobal.dispatchEvent = (event: { type: string }) => {
  listeners.get(event.type)?.forEach((cb) => cb(event))
  return true
}
if (typeof testGlobal.window === 'undefined') {
  testGlobal.window = testGlobal as unknown as MockWindow
}
testGlobal.window.matchMedia = matchMediaMock

const { createDefaultAIWorkspace, getActiveAIConfig } = await import('../shared/ai-providers')
const { useSettings } = await import('../renderer/stores/useSettings')

describe('settings workspace persistence', () => {
  beforeEach(() => {
    storage.clear()
    const workspace = createDefaultAIWorkspace()
    testGlobal.window.electronAPI = {
      settings: {
        getAIWorkspace: async () => ({ success: true, data: workspace }),
        getAIConfig: async () => ({ success: true, data: getActiveAIConfig(workspace) }),
        setAIWorkspace: async () => ({ success: true }),
        setAIConfig: async () => ({ success: true }),
        get: async () => ({ success: false }),
        set: async () => ({ success: true }),
        testAIConnection: async () => ({ success: false, error: 'not configured' }),
      },
    }

    useSettings.setState({
      config: getActiveAIConfig(workspace)!,
      workspace,
      selectedProfileId: workspace.activeProfileId,
      loaded: true,
      testStatus: 'idle',
      testMessage: '',
      testLatency: null,
      remoteModels: [],
      savedConfigs: {},
      saveStatus: 'idle',
      saveMessage: '',
    })
  })

  it('flushes pending preset edits before window unload', async () => {
    const calls: AIProviderWorkspace[] = []
    testGlobal.window.electronAPI.settings.setAIWorkspace = async (workspace) => {
      calls.push(workspace)
      return { success: true }
    }

    useSettings.getState().updateField('apiKey', 'buffered-kimi-key')
    testGlobal.dispatchEvent({ type: 'beforeunload' })

    await new Promise((resolve) => setTimeout(resolve, 20))

    const persistedWorkspace = calls[0]
    const profile = persistedWorkspace?.profiles?.find((item) => item.id === persistedWorkspace.activeProfileId)
    assert.equal(profile?.config?.apiKey, 'buffered-kimi-key')
  })

  it('rolls back optimistic workspace changes when persistence fails', async () => {
    const initialWorkspace = useSettings.getState().workspace
    const initialProfile = initialWorkspace.profiles.find((item) => item.id === initialWorkspace.activeProfileId)!
    const originalConsoleError = console.error
    console.error = () => {}
    testGlobal.window.electronAPI.settings.setAIWorkspace = async () => ({
      success: false,
      error: 'Database not available',
    })

    const failedWorkspace = {
      ...initialWorkspace,
      profiles: initialWorkspace.profiles.map((profile) => (
        profile.id === initialProfile.id
          ? {
            ...profile,
            config: {
              ...profile.config,
              apiKey: 'should-not-stick',
            },
          }
          : profile
      )),
    }

    try {
      await useSettings.getState().saveWorkspace(failedWorkspace)
    } finally {
      console.error = originalConsoleError
    }

    const state = useSettings.getState()
    const restoredProfile = state.workspace.profiles.find((item) => item.id === state.workspace.activeProfileId)!
    assert.equal(restoredProfile.config.apiKey, initialProfile.config.apiKey)
    assert.equal(state.saveStatus, 'error')
    assert.match(state.saveMessage, /保存失败/)
  })
})
