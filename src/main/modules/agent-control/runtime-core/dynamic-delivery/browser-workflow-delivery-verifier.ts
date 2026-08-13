import type { BrowserWorkflowVerifierBundle } from '../../../repositories/agent-session-checkpoint-types'
import { workflowDigest } from '../../../repositories/browser-workflow-codec'
import { buildBrowserWorkflowVerifierEvidenceView } from '../../../browser-engine/browser-workflow-verifier-view'
import { materializeDeliveryArtifacts } from './delivery-artifact-readback'
import type { VerifierResourceBundle } from './verifier-resource-bundle'

export function materializeBrowserWorkflowDeliveryVerifierResources(input: {
  bundle: BrowserWorkflowVerifierBundle
  projection: {
    proofRefs?: ReadonlyArray<unknown> | null
    recentArtifacts?: ReadonlyArray<unknown> | null
    expectedOutputs?: ReadonlyArray<string> | null
  }
  requestEnvelope?: unknown
  currentRunId: string
  runStartedAtMs: number
}): VerifierResourceBundle {
  const resources = materializeDeliveryArtifacts({
    proofRefs: input.projection.proofRefs,
    recentArtifacts: input.projection.recentArtifacts,
    expectedOutputs: input.projection.expectedOutputs,
    userRequestVerbatim: input.bundle.requestText,
    requestEnvelope: input.requestEnvelope,
    currentRunId: input.currentRunId,
    runStartedAtMs: input.runStartedAtMs,
  })
  const evidenceView = buildBrowserWorkflowVerifierEvidenceView(input.bundle.evidence)
  return {
    ...resources,
    items: [
      ...resources.items,
      {
        refId: `browser-workflow-evidence:${input.bundle.browserTaskId}`,
        digest: workflowDigest({
          journal: input.bundle.evidence.journal,
          researchState: input.bundle.evidence.researchState,
          researchAssessment: input.bundle.evidence.researchAssessment,
        }),
        provenance: `browser_workflow_request:${input.bundle.requestDigest}`,
        excerpt: evidenceView.journalExcerpt,
        kind: 'action_receipt' as const,
      },
      ...evidenceView.resources.map(({ resource, excerpt }) => ({
        refId: resource.resourceId,
        digest: workflowDigest({
          contentDigest: resource.contentDigest,
          provenanceDigest: resource.provenanceDigest,
        }),
        provenance: `browser_observation:${resource.provenanceDigest}`,
        excerpt,
        kind: 'action_receipt' as const,
      })),
    ],
  }
}
