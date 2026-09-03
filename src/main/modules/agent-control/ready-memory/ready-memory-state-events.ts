import { createHash } from 'node:crypto'

import type { ReadyMemoryStateChange } from '../../../../shared/ready-memory'

type Revision = { stateRevision: number; revocationRevision: number }

export function publishReadyMemoryStateChangeIfAdvanced(input: {
  before: Revision
  after: Revision
  reason: ReadyMemoryStateChange['reason']
  publish?: (event: ReadyMemoryStateChange) => void
  onError?: (error: unknown) => void
}): void {
  if (input.after.stateRevision === input.before.stateRevision
    && input.after.revocationRevision === input.before.revocationRevision) return
  const unsigned = {
    contract: 'ready_memory_state_change_v1' as const,
    reason: input.reason,
    stateRevision: input.after.stateRevision,
    revocationRevision: input.after.revocationRevision,
  }
  const event = {
    ...unsigned,
    evidenceDigest: createHash('sha256').update(JSON.stringify(unsigned)).digest('hex'),
  }
  try { input.publish?.(event) }
  catch (error) { input.onError?.(error) }
}
