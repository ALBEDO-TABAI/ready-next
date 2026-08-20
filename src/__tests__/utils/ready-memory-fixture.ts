import {
  digestReadyMemoryValue,
  READY_MEMORY_SNAPSHOT_CONTRACT,
  READY_MEMORY_SUMMARY_BUDGET_CHARS,
  type ReadyMemorySnapshot,
} from '../../main/modules/agent-control/ready-memory'

export function disabledReadyMemorySnapshot(
  frozenAt = '2026-08-20T00:00:00.000Z',
): ReadyMemorySnapshot {
  const core = {
    contract: READY_MEMORY_SNAPSHOT_CONTRACT,
    enabled: false,
    stateRevision: 1,
    revocationRevision: 0,
    lastRevocationReason: null,
    frozenAt,
    summaryBudgetChars: READY_MEMORY_SUMMARY_BUDGET_CHARS,
    summaryChars: 0,
    summary: '',
    summaryEntryIds: [],
    entries: [],
    sourceRefs: [],
    truncated: false,
  } as const
  return { ...core, snapshotDigest: digestReadyMemoryValue(core) }
}
