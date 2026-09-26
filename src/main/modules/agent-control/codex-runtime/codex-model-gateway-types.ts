import type { JsonObject } from './codex-model-gateway-common'
import type {
  CodexModelGatewayFailureEvidence,
  CodexModelGatewayRequestEvidence,
  CodexModelGatewayRequestKind,
  CodexModelGatewayResponseEvidence,
  CodexUpstreamProfileSnapshot,
} from './codex-model-gateway-contract'
import type { CodexDeliveredUserTail } from './codex-turn-input-builder'

export type CodexModelGatewayBinding = {
  kind: CodexModelGatewayRequestKind
  codexModel: string
  snapshot: CodexUpstreamProfileSnapshot
  snapshotDigest: string
  toolSurfaceDigest: string
  turnContractDigest: string | null
  instructionContractDigest: string
  additionalContextDigest: string | null
  deliveredUserTail: readonly CodexDeliveredUserTail[]
  forceToolFreeFinalization: boolean
  allowedToolNames: readonly string[] | null
}

export type CodexModelGatewayMetadata = {
  requestKind: string
  threadId: string
  turnId: string
  readyRunId: string | null
  toolSurfaceDigest: string | null
  turnContractDigest: string | null
  upstreamProfileSnapshotDigest: string | null
  raw: JsonObject
}

export type CodexModelGatewayToolResponseCall = Readonly<{
  codexCallId: string
  toolName: string
  argsDigest: string
}>

export type CodexModelGatewayPreparedRequestReceipt = Readonly<{
  requestDigest: string
  requestEvidence: CodexModelGatewayRequestEvidence
}>

export interface CodexModelGatewayAuthority {
  resolve(input: {
    metadata: CodexModelGatewayMetadata
    receivedAt: string
    validate(binding: CodexModelGatewayBinding): ReadonlySet<string>
    prepareRequestReceipt(): CodexModelGatewayPreparedRequestReceipt
  }): Promise<CodexModelGatewayBinding>
  admitToolResponse?(input: {
    metadata: CodexModelGatewayMetadata
    requestDigest: string
    calls: readonly CodexModelGatewayToolResponseCall[]
    admittedAt: string
  }): Promise<void>
  recordResponseEvidence?(input: {
    metadata: CodexModelGatewayMetadata
    requestDigest: string
    responseEvidence: CodexModelGatewayResponseEvidence
    completedAt: string
  }): Promise<void>
  recordResponseFailureEvidence?(input: {
    metadata: CodexModelGatewayMetadata
    requestDigest: string
    failureEvidence: CodexModelGatewayFailureEvidence
    failedAt: string
  }): void
}

export interface CodexModelGatewayCredentialStore {
  resolve(input: {
    credentialReferenceId: string
    snapshot: CodexUpstreamProfileSnapshot
  }): string | Promise<string>
}

export type CodexModelGatewayAddress = {
  url: string
  bearerToken: string
}

export type CodexModelGatewaySpawnCapability = CodexModelGatewayAddress & {
  sidecarSpawnInstanceId: string
}

export type CodexModelGatewayValidatedRequestCapture = {
  capturedAt: string
  requestKind: CodexModelGatewayRequestKind
  readyRunId: string | null
  threadId: string
  turnId: string
  requestDigest: string
  sidecarRequestDigest: string
  bodyBytes: number
  instructionDigest: string
  inputDigest: string
  sidecarInputDigest: string
  providerInputDigest: string
  memoryHistoryRedactionDigest: string
  memoryHistoryRedactedItemCount: number
  toolsDigest: string
  toolNames: string[]
  toolCount: number
  readyResourceReferenceCount: number
  proofSentinelDigest: string | null
  proofSentinelOccurrences: number
  proofSentinels: Array<{
    digest: string
    occurrences: number
  }>
  inputItems: Array<{
    index: number
    type: string | null
    role: string | null
    id: string | null
    stringCount: number
    totalStringCharacters: number
    maxStringCharacters: number
    digest: string
  }>
}

export type CodexModelGatewayOriginalRequestCapture = Omit<
  CodexModelGatewayValidatedRequestCapture,
  | 'sidecarRequestDigest'
  | 'sidecarInputDigest'
  | 'providerInputDigest'
  | 'memoryHistoryRedactionDigest'
  | 'memoryHistoryRedactedItemCount'
>
