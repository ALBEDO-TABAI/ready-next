import type { DeliveryVerificationVerdict } from './delivery-verifier'

export type DeliveryRepairKind = 'none' | 'text_only' | 'artifact_targeted' | 'non_repairable_action'

export function classifyDeliveryRepair(
  verdict: DeliveryVerificationVerdict,
  allowedTargetRefIds: ReadonlySet<string>,
): DeliveryRepairKind {
  if (verdict.verdict === 'accept') return 'none'
  if (verdict.gaps.some((gap) => gap.kind === 'external_action')) return 'non_repairable_action'
  if (verdict.gaps.some((gap) => gap.kind === 'artifact')) {
    const targetsValid = verdict.gaps
      .filter((gap) => gap.kind === 'artifact')
      .every((gap) => Boolean(gap.targetRefId && allowedTargetRefIds.has(gap.targetRefId)))
    return targetsValid ? 'artifact_targeted' : 'non_repairable_action'
  }
  return 'text_only'
}
