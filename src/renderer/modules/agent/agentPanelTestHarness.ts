import { createAgentPanelTestHarness, shouldEnableHarness } from './agent-panel-test-harness-driver'
import type { AgentPanelTestHarness, StoreLike } from './agent-panel-test-harness-types'

export * from './agent-panel-test-harness-types'
export { createAgentPanelSnapshot } from './agent-panel-test-harness-snapshot'
export { diagnoseAgentPanelSnapshot } from './agent-panel-test-harness-diagnostics'
export { createAgentPanelTestHarness } from './agent-panel-test-harness-driver'

export function installAgentPanelTestHarness(
  store: StoreLike,
  options: { force?: boolean } = {},
): AgentPanelTestHarness | null {
  if (typeof window === 'undefined') return null
  if (!options.force && !shouldEnableHarness()) return null
  if (window.__READY_AGENT_TEST__) return window.__READY_AGENT_TEST__
  const harness = createAgentPanelTestHarness(store)
  window.__READY_AGENT_TEST__ = harness
  return harness
}
