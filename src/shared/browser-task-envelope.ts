import type { BrowserOperationId, BrowserPublicToolName } from './browser-capability-registry'

/** Exact, code-owned binding for one admitted browser invocation. */
export interface BrowserTaskEnvelope {
  version: 3
  scopeId: string
  runId: string
  parentTaskId: string
  browserTaskId: string | null
  agentId: string | null
  toolName: BrowserPublicToolName
  operationId: BrowserOperationId
  argsDigest: string
  tabId: string | null
  origin: string | null
  createdAt: number
}
