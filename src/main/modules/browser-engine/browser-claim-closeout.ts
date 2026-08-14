import { logAgentMetric } from '../agent-control/metrics'
import type {
  CodexFailureCoreCloseoutInput,
  CodexFailureCoreCloseoutResult,
} from '../repositories/agent-session-checkpoint-closeout'
import type { AgentSessionCheckpointRepository } from '../repositories/agent-session-checkpoint-repository'
import { getBrowserTargetClaimService } from './browser-target-claim-singleton'

export function reconcileReleasedBrowserClaims(ownerRunId: string): void {
  try {
    getBrowserTargetClaimService().acknowledgeExternalRelease(ownerRunId)
  } catch (error) {
    logAgentMetric('browser_claim_release_reconcile_failed', {
      runId: ownerRunId,
      reason: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Production failure closeout: persist the TX, then acknowledge page-state side effects. */
export async function commitCodexFailureCoreCloseoutAndReconcileClaims(
  repository: Pick<AgentSessionCheckpointRepository, 'commitCodexFailureCoreCloseout'>,
  input: CodexFailureCoreCloseoutInput,
): Promise<CodexFailureCoreCloseoutResult> {
  const committed = await repository.commitCodexFailureCoreCloseout(input)
  reconcileReleasedBrowserClaims(input.ownerRunId)
  return committed.value
}
