import type { DeliveryEvidenceHandle, DeliveryEvidenceIssuer } from './delivery-evidence-issuer'

const DIGEST_PATTERN = /^[a-f0-9]{64}$/i

export function validateDeliveryEvidenceHandle(input: {
  handle: DeliveryEvidenceHandle
  expectedChildTaskId: string
  issuer: Pick<DeliveryEvidenceIssuer, 'verifySignature'>
  isCanonicalRefReachable: (canonicalRef: string) => boolean
}): DeliveryEvidenceHandle {
  const { handle } = input
  if (!handle || handle.version !== 1) throw new Error('[delivery-evidence] invalid handle version')
  if (!handle.handleId || !handle.childTaskId) throw new Error('[delivery-evidence] handle identity is incomplete')
  if (handle.childTaskId !== input.expectedChildTaskId) throw new Error('[delivery-evidence] child ownership mismatch')
  if (!handle.canonicalRef || !/^[a-z][a-z0-9_-]*:[^\s]+$/i.test(handle.canonicalRef)) {
    throw new Error('[delivery-evidence] canonical reference is invalid')
  }
  if (!DIGEST_PATTERN.test(handle.digest)) throw new Error('[delivery-evidence] digest must be sha256')
  if (!Number.isFinite(Date.parse(handle.issuedAt))) throw new Error('[delivery-evidence] issuedAt is invalid')
  if (!handle.previewLocator || handle.previewLocator.length > 300) throw new Error('[delivery-evidence] preview locator is invalid')
  if (!input.issuer.verifySignature(handle)) throw new Error('[delivery-evidence] forged or mutated handle')
  if (!input.isCanonicalRefReachable(handle.canonicalRef)) throw new Error('[delivery-evidence] canonical reference is unreachable')
  return handle
}
