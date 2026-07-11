import type { DeliveryPackageState } from '../../../../../shared/dynamic-delivery'

export function isRegisteredContributionAdoptable(
  entry: DeliveryPackageState,
  durableUsedEvidenceRefs: ReadonlySet<string>,
): boolean {
  return entry.binding.kind === 'registered_agent'
    && entry.status === 'completed'
    && entry.evidenceHandleIds.length > 0
    && entry.evidenceHandleIds.every((id) => durableUsedEvidenceRefs.has(id))
}
