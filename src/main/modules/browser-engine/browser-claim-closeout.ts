import { logAgentMetric } from '../agent-control/metrics'
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
