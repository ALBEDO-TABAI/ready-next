import { useMode } from '../../stores/useMode'
import type { AgentPanelTestHarness, StoreLike } from './agent-panel-test-harness-types'

const settle = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Test-only helpers: a message shown without a model, and a direct mode switch. Never persisted. */
export function createHarnessFixtures(store: StoreLike): Pick<AgentPanelTestHarness, 'addMessageFixture' | 'setWorkbenchMode'> {
  return {
    addMessageFixture: async ({ content, type = 'agent' }) => {
      const add = store.getState().addMessage
      if (!add) return { ok: false, error: 'addMessage not available' }
      const id = `fixture-${Date.now().toString(36)}`
      add({ id, agent: store.getState().currentAgent, content, type, timestamp: new Date(), meta: { transient: true } })
      await settle(50)
      return { ok: store.getState().messages.some((message) => message.id === id), id }
    },
    setWorkbenchMode: async (mode) => {
      useMode.getState().setAppMode('workbench')
      useMode.getState().setWorkbenchMode(mode)
      await settle(50)
      return { ok: useMode.getState().workbenchMode === mode, mode }
    },
  }
}
