import { createHmac, randomUUID } from 'node:crypto'

export type DeliveryEvidenceKind = 'artifact' | 'resource' | 'tool_receipt' | 'task_event'

export interface DeliveryEvidenceHandle {
  version: 1
  handleId: string
  childTaskId: string
  canonicalRef: string
  kind: DeliveryEvidenceKind
  digest: string
  issuedAt: string
  previewLocator: string
  signature: string
}

export interface DeliveryEvidenceIssuer {
  issue(input: Omit<DeliveryEvidenceHandle, 'version' | 'handleId' | 'issuedAt' | 'signature'>): DeliveryEvidenceHandle
  verifySignature(handle: DeliveryEvidenceHandle): boolean
}

function signingPayload(handle: Omit<DeliveryEvidenceHandle, 'signature'>): string {
  return JSON.stringify([
    handle.version,
    handle.handleId,
    handle.childTaskId,
    handle.canonicalRef,
    handle.kind,
    handle.digest,
    handle.issuedAt,
    handle.previewLocator,
  ])
}

export function createDeliveryEvidenceIssuer(options: {
  secret: string
  now?: () => Date
  idFactory?: () => string
}): DeliveryEvidenceIssuer {
  if (!options.secret) throw new Error('[delivery-evidence] issuer secret is required')
  const sign = (value: Omit<DeliveryEvidenceHandle, 'signature'>): string => createHmac('sha256', options.secret)
    .update(signingPayload(value))
    .digest('hex')

  return {
    issue(input) {
      const unsigned: Omit<DeliveryEvidenceHandle, 'signature'> = {
        version: 1,
        handleId: (options.idFactory ?? randomUUID)(),
        childTaskId: input.childTaskId,
        canonicalRef: input.canonicalRef,
        kind: input.kind,
        digest: input.digest,
        issuedAt: (options.now ?? (() => new Date()))().toISOString(),
        previewLocator: input.previewLocator,
      }
      return { ...unsigned, signature: sign(unsigned) }
    },
    verifySignature(handle) {
      const { signature, ...unsigned } = handle
      return typeof signature === 'string' && signature === sign(unsigned)
    },
  }
}
