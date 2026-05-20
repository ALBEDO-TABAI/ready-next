import { RunCleanupRegistry, type RunCleanupCallback } from '../task-projection/run-cleanup-registry'
import type { SubAgentCleanupHandle } from './sub-agent-types'

export function createSubAgentCleanupHandle(
  lifecycleId: string,
  registry = new RunCleanupRegistry(),
): SubAgentCleanupHandle {
  return {
    register(cleanup: RunCleanupCallback): void {
      registry.register(lifecycleId, cleanup)
    },
    drain(timeoutMs?: number): Promise<void> {
      return registry.drain(lifecycleId, timeoutMs)
    },
  }
}
