import type { BrowserOperationId, BrowserOperationMode } from './browser-capability-registry'

export type BrowserDispatchState = 'accepted' | 'rejected' | 'unknown'
export type BrowserDeliveryState = 'not_applicable' | 'delivered' | 'not_delivered' | 'unknown'
export type BrowserEffectState = 'not_applicable' | 'observed' | 'unknown'

export type BrowserActionTargetIdentity = {
  documentState: 'document'
  tabId: string
  physicalTargetToken: string
  frameId: string
  frameDocumentToken: string
  targetRef: string | null
} | {
  documentState: 'no_document'
  tabId: null
  physicalTargetToken: null
  frameId: null
  frameDocumentToken: null
  targetRef: null
}

export function isCompleteBrowserIdentity(
  value: unknown,
): value is Extract<BrowserActionTargetIdentity, { documentState: 'document' }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const identity = value as Record<string, unknown>
  return identity.documentState === 'document'
    && ['tabId', 'physicalTargetToken', 'frameId', 'frameDocumentToken']
      .every((key) => typeof identity[key] === 'string' && Boolean(String(identity[key]).trim()))
    && (identity.targetRef === null || typeof identity.targetRef === 'string')
}

export function isNoDocumentBrowserIdentity(
  value: unknown,
): value is Extract<BrowserActionTargetIdentity, { documentState: 'no_document' }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const identity = value as Record<string, unknown>
  return identity.documentState === 'no_document'
    && ['tabId', 'physicalTargetToken', 'frameId', 'frameDocumentToken', 'targetRef']
      .every((key) => identity[key] === null)
}

/** Compatibility never treats missing identity as a match. */
export function browserDocumentIdentityCompatible(left: unknown, right: unknown): boolean {
  if (!isCompleteBrowserIdentity(left) || !isCompleteBrowserIdentity(right)) return false
  if (
    left.tabId !== right.tabId
    || left.physicalTargetToken !== right.physicalTargetToken
    || left.frameId !== right.frameId
    || left.frameDocumentToken !== right.frameDocumentToken
  ) return false
  return !left.targetRef || !right.targetRef || left.targetRef === right.targetRef
}

export interface BrowserActionOutcome {
  actionId: string
  actionSeq: number
  taskId: string
  ownerRunId: string
  operationId: BrowserOperationId
  mode: BrowserOperationMode
  dispatch: BrowserDispatchState
  delivery: BrowserDeliveryState
  effect: BrowserEffectState
  needsObservation: boolean
  mayHaveCommitted: boolean
  /** Page identity before the transport was dispatched. */
  identity: BrowserActionTargetIdentity
  /** Page identity read back after the transport returned. */
  successorIdentity: BrowserActionTargetIdentity
  /** Exact tab created or followed by the transport before document identity was available. */
  postActionTabId?: string
  search?: {
    searchActionId: string
    queryDigest: string
    fillActionId: string | null
    submitActionId: string | null
    phase: 'not_submitted' | 'submitted_needs_observation' | 'effect_observed'
    submitted: boolean
    effectObserved: boolean
  }
}
