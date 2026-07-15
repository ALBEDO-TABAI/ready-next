import type { AgentInputItem, MemorySession } from '@openai/agents'

import { compactAgentInputItems } from '../compaction/compact-agent-input'
import type { AgentSdkSession, CompactSessionResult } from './agent-sdk-types'

/**
 * Pure session compaction primitive, extracted from AgentSdkRuntime (V3 Phase 2).
 *
 * The compactor does NOT hold the session Map or any lock — callers that need
 * mutual exclusion acquire the session lock (owned by the runtime / session
 * manager) and then delegate the actual compaction here. It only ever touches
 * the `MemorySession` / `AgentSdkSession` objects it is handed.
 */
export class AgentSdkCompactor {
  async compactMemorySession(
    sdkSession: MemorySession,
    windowTokens: number,
    baseItems?: AgentInputItem[],
    force = false
  ): Promise<CompactSessionResult> {
    const sourceItems = baseItems ?? (await sdkSession.getItems())
    const result = await compactAgentInputItems(sourceItems, { windowTokens, force })
    if (!result.compacted) {
      return { status: 'noop', report: result.report }
    }
    await sdkSession.clearSession()
    await sdkSession.addItems(result.items)
    return {
      status: 'compacted',
      report: result.report
    }
  }

  /** Drain any compaction queued while a run held the session. Caller must hold the session lock. */
  async drainPendingCompact(session: AgentSdkSession): Promise<void> {
    while (session.pendingCompact) {
      const pending = session.pendingCompact
      session.pendingCompact = null
      await this.compactMemorySession(
        session.sdkSession,
        session.contextWindowTokens,
        undefined,
        pending.reason === 'manual'
      )
    }
  }
}
