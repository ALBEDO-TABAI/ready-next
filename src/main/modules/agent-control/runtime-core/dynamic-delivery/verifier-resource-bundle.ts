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
  mechanicalIssues?: VerifierMechanicalIssue[]
}

export interface VerifierMechanicalIssue {
  code: string
  description: string
  targetRefId?: string
}

export function assertVerifierResourceBundle(bundle: VerifierResourceBundle): void {
  if (bundle.version !== 1) throw new Error('[dynamic-delivery] verifier bundle version must be 1')
  for (const item of bundle.items) {
    if (!item.refId || !item.digest || !item.provenance || !item.excerpt) {
      throw new Error('[dynamic-delivery] verifier resource must be materialized with provenance')
    }
  }
  for (const issue of bundle.mechanicalIssues ?? []) {
    if (!issue.code || !issue.description) {
      throw new Error('[dynamic-delivery] verifier mechanical issue must have code and description')
    }
  }
}
