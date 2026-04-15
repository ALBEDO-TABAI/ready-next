import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'

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

;(globalThis as any).localStorage = localStorageMock
;(globalThis as any).document = documentMock
;(globalThis as any).matchMedia = matchMediaMock
;(globalThis as any).addEventListener = (type: string, cb: (event: { type: string }) => void) => {
  const set = listeners.get(type) || new Set()
  set.add(cb)
  listeners.set(type, set)
}
;(globalThis as any).removeEventListener = (type: string, cb: (event: { type: string }) => void) => {
  listeners.get(type)?.delete(cb)
}
;(globalThis as any).dispatchEvent = (event: { type: string }) => {
  listeners.get(event.type)?.forEach((cb) => cb(event))
  return true
}
if (typeof (globalThis as any).window === 'undefined') {
  ;(globalThis as any).window = globalThis
}
;(globalThis as any).window.matchMedia = matchMediaMock

const { createDefaultAIWorkspace, getActiveAIConfig } = await import('../shared/ai-providers')
const { useSettings } = await import('../renderer/stores/useSettings')

describe('settings workspace persistence', () => {
  beforeEach(() => {
    storage.clear()
    const workspace = createDefaultAIWorkspace()
    ;(globalThis as any).window.electronAPI = {
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
    })
  })

  it('flushes pending preset edits before window unload', async () => {
    const calls: any[] = []
    ;(globalThis as any).window.electronAPI.settings.setAIWorkspace = async (workspace: unknown) => {
      calls.push(workspace)
      return { success: true }
    }

    useSettings.getState().updateField('apiKey', 'buffered-kimi-key')
    ;(globalThis as any).dispatchEvent({ type: 'beforeunload' })

    await new Promise((resolve) => setTimeout(resolve, 20))

    const persistedWorkspace = calls[0]
    const profile = persistedWorkspace?.profiles?.find((item: any) => item.id === persistedWorkspace.activeProfileId)
    assert.equal(profile?.config?.apiKey, 'buffered-kimi-key')
  })
})
