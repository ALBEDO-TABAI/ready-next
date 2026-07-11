export interface VerifierResourceItem {
  refId: string
  digest: string
  provenance: string
  excerpt: string
  kind: 'artifact' | 'resource' | 'action_receipt'
}

export interface VerifierResourceBundle {
  version: 1
  items: VerifierResourceItem[]
}

export function assertVerifierResourceBundle(bundle: VerifierResourceBundle): void {
  if (bundle.version !== 1) throw new Error('[dynamic-delivery] verifier bundle version must be 1')
  for (const item of bundle.items) {
    if (!item.refId || !item.digest || !item.provenance || !item.excerpt) {
      throw new Error('[dynamic-delivery] verifier resource must be materialized with provenance')
    }
  }
}
