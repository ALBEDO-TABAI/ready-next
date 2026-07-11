export interface WorkerResourceExcerpt {
  refId: string
  digest: string
  provenance: string
  excerpt: string
}

export interface WorkerResourceBundle {
  version: 1
  resources: WorkerResourceExcerpt[]
  ownerArtifactSummaries: Array<{ refId: string; digest: string; summary: string }>
  skillMethodSummary: string | null
}

export function assertWorkerResourceBundle(bundle: WorkerResourceBundle): void {
  if (bundle.version !== 1) throw new Error('[dynamic-delivery] worker resource bundle version must be 1')
  for (const resource of bundle.resources) {
    if (!resource.refId || !resource.digest || !resource.provenance) {
      throw new Error('[dynamic-delivery] worker resource is missing provenance')
    }
  }
}
