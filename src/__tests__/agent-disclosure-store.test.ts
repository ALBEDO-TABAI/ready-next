import { describe, it } from 'node:test'
import assert from 'node:assert'

const storage = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
  removeItem: (key: string) => { storage.delete(key) },
}
;(globalThis as any).document = {
  documentElement: {
    setAttribute: () => undefined,
    getAttribute: () => null,
  },
}
;(globalThis as any).matchMedia = () => ({
  matches: false,
  addListener: () => undefined,
  removeListener: () => undefined,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
})
if (typeof (globalThis as any).window === 'undefined') {
  ;(globalThis as any).window = globalThis
}

const { useAgent } = await import('../renderer/stores/useAgent')

describe('agent disclosure store', () => {
  it('remembers expanded state per task section', () => {
    useAgent.setState({
      taskDisclosureState: {},
    } as unknown as Partial<ReturnType<typeof useAgent.getState>>)

    useAgent.getState().setTaskSectionExpanded('scope-1', 'details', true)
    assert.strictEqual(useAgent.getState().taskDisclosureState['scope-1']?.details, true)

    useAgent.getState().toggleTaskSection('scope-1', 'details')
    assert.strictEqual(useAgent.getState().taskDisclosureState['scope-1']?.details, false)
  })
})
