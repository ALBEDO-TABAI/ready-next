import type { AgentInputItem, MemorySession } from '@openai/agents'

import { compactAgentInputItems } from '../compaction/compact-agent-input'
import { estimateInputItemTokens } from '../../../../shared/context-budget-types'
import type { AgentSdkSession, CompactSessionResult } from './agent-sdk-types'
// W3 — single source of truth: dedup must match the live catalog header verbatim,
// otherwise this becomes silent dead code if the reminder text ever changes.
import {
  CATALOG_HEADER as SKILL_CATALOG_HEADER,
  SKILL_CATALOG_REMINDER_MARKER
} from '../system-reminders/skill-catalog-reminder'

function isSkillCatalogReminderItem(item: AgentInputItem): boolean {
  if (!item || typeof item !== 'object') return false
  const record = item as Record<string, unknown>
  if (record.role !== 'system') return false
  try {
    const content = JSON.stringify(record.content ?? '')
    return content.includes(SKILL_CATALOG_REMINDER_MARKER) && content.includes(SKILL_CATALOG_HEADER)
  } catch {
    // silent-catch: non-serializable content (e.g. circular) is never a catalog reminder.
    return false
  }
}

export function dedupeSkillCatalogReminderItems(items: AgentInputItem[]): {
  items: AgentInputItem[]
  droppedItems: number
} {
  let latest = -1
  for (let index = 0; index < items.length; index += 1) {
    if (isSkillCatalogReminderItem(items[index])) latest = index
  }
  if (latest < 0) return { items, droppedItems: 0 }
  const deduped = items.filter(
    (item, index) => index === latest || !isSkillCatalogReminderItem(item)
  )
  return { items: deduped, droppedItems: items.length - deduped.length }
}

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
    const catalogDeduped = dedupeSkillCatalogReminderItems(result.items)
    if (!result.compacted && catalogDeduped.droppedItems === 0) {
      return { status: 'noop', report: result.report }
    }
    await sdkSession.clearSession()
    await sdkSession.addItems(catalogDeduped.items)
    return {
      status: 'compacted',
      report: {
        ...result.report,
        afterTokens: estimateInputItemTokens(catalogDeduped.items),
        droppedItems: result.report.droppedItems + catalogDeduped.droppedItems
      }
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
