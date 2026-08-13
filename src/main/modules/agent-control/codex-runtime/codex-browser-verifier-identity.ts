import type { TaskProjectionRecord } from '../contracts/run-contracts'
import type { BrowserWorkflowVerifierBundle } from '../../repositories/agent-session-checkpoint-types'
import { digestCanonicalJson } from './codex-model-gateway-contract'

export type CodexBrowserVerifierIdentityProduct = {
  readyRunId: string
  readyTaskId: string
  readyScopeId: string
  readyAliasId: string
  aliasGeneration: number
  threadBindingId: string
  codexThreadId: string | null
  codexTurnId: string | null
  turnRequestId: string
  toolSurfaceDigest: string
  turnContractDigest: string
  upstreamProfileSnapshotRef: string
  upstreamProfileSnapshotDigest: string
  codexModel: string
}

export type CodexBrowserVerifierIdentityProjection = Pick<
  TaskProjectionRecord,
  | 'taskId'
  | 'runId'
  | 'revision'
  | 'requestAnchor'
  | 'criteria'
  | 'modelCriteria'
  | 'proofRefs'
  | 'recentArtifacts'
  | 'expectedOutputs'
>

export function codexBrowserVerifierFrozenIdentityDigest(input: {
  product: CodexBrowserVerifierIdentityProduct
  workflowBundle: BrowserWorkflowVerifierBundle
  projection: CodexBrowserVerifierIdentityProjection
}): string {
  return digestCanonicalJson(input)
}
