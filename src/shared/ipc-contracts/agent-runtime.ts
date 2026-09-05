import { z } from 'zod'

import type { CanonicalAssistantMessage } from './canonical-message'
import type { ContextUsageSnapshot } from '../context-usage-types'
import {
  lifecycleActionRequestRefSchema,
  type LifecycleActionRequestRef,
  type LifecycleOperationProjectionV2,
} from './agent-lifecycle-snapshot'

export type ProductTurnToolReceipt = {
  callId: string
  toolName: string
  state: 'pending' | 'confirmed' | 'proven_absent' | 'indeterminate' | 'degraded'
  actionReceiptId: string | null
  actionRevision: number | null
  resultDigest: string | null
  deliveryAttemptId: string | null
  deliveryConfirmed: boolean
  summary: string
}

export type ProductTurnArtifactReceipt = {
  relativePath: string
  state: 'required' | 'staged' | 'exported' | 'verified' | 'failed' | 'indeterminate'
  logicalArtifactRef: string | null
  version: string | null
  bytes: number | null
  sha256: string | null
  destinationResourceId: string | null
  evidenceRefs: string[]
}

export type ProductTurnMemoryReceipt = {
  snapshotDigest: string
  stateRevision: number
  revocationRevision: number
  summaryEntryIds: string[]
  readEntryIds: string[]
  readReceiptDigest: string | null
}

export type CodexActionProjectionVersion = {
  scopeEpoch: number
  headGeneration: number
  actionProjectionSequence: number
}

export type CodexActionGate = {
  availability: 'ready' | 'blocked' | 'not_applicable'
  blockers: string[]
  consequence: null | {
    kind: 'supersedes_uncommitted_structured_tail'
    omittedItemCount: number
    resourceReattachItemCount: number
    itemsDigest: string
  }
}

export type CodexHeadActionProjection = {
  kind: 'scope_head'
  scopeId: string
  ownerRunId: null
  historyState:
    | 'same_thread_ready'
    | 'ready'
    | 'fresh_root_ready_for_ingress'
    | 'materializing'
    | 'materialization_unknown'
    | 'terminal_unknown'
    | 'legacy_context_boundary'
    | 'closed'
  actionHeadIdentity: null | {
    aliasId: string
    aliasGeneration: number
    threadBindingId: string
    headRevision: number
  }
  closedByLifecycleRef: null | {
    scopeId: string
    scopeEpoch: number
    closedAt: string
    closeEvidenceDigest: string
  }
  actions: { send_new_message: CodexActionGate }
  actionProjectionVersion: CodexActionProjectionVersion
  evidenceDigest: string
}

export type CodexActionSurfaceEnvelope =
  | {
      state: 'active_head'
      scopeId: string
      scopeEpoch: number
      sourceAliasGeneration: number
      head: CodexHeadActionProjection
      lifecycle: LifecycleOperationProjectionV2
      beginNewContext: CodexBeginNewContextActionRef | null
      contextBoundaries: CodexConversationContextBoundary[]
    }
  | {
      state: 'history_only'
      scopeId: string
      scopeEpoch: number
      sourceAliasGeneration: number
      head: null
      lifecycle: null
      beginNewContext: CodexBeginNewContextActionRef
      contextBoundaries: CodexConversationContextBoundary[]
    }

export type CodexConversationContextBoundary = {
  operationId: string
  scopeId: string
  scopeEpoch: number
  sourceThreadBindingId: string
  sourceAliasGeneration: number
  sourceRevision: number
  targetThreadBindingId: string
  targetAliasGeneration: number
  previousVisibleMessageAnchor: string | null
  preservedContextDigest?: string
  committedAt: string
  receiptDigest: string
}

export type CodexBeginNewContextActionRef = {
  contract: 'codex_begin_new_context_action_v1'
  operationId: string
  scopeId: string
  scopeEpoch: number
  sourceThreadBindingId: string
  sourceAliasGeneration: number
  sourceRevision: number
  sourceEvidenceDigest: string
  candidateEvidenceDigest: string
  consequenceDigest: string
  draftRevision: number | null
  digest: string
}

export type BeginNewContextRequest = {
  actionRef: CodexBeginNewContextActionRef
}

export type BeginNewContextResult = {
  ok: true
  boundary: CodexConversationContextBoundary
  aliasGeneration: number
  actionSurfaceInvalidation: CodexActionSurfaceInvalidation
}

export type CodexActionSurfaceInvalidation = {
  contract: 'codex_action_surface_invalidation_v1'
  scopeId: string
  scopeEpoch: number
  aliasGeneration: number
  actionProjectionSequence: number
}

const codexActionSurfaceInvalidationSchema: z.ZodType<CodexActionSurfaceInvalidation> = z.object({
  contract: z.literal('codex_action_surface_invalidation_v1'),
  scopeId: z.string().min(1),
  scopeEpoch: z.number().int().nonnegative(),
  aliasGeneration: z.number().int().positive().safe(),
  actionProjectionSequence: z.number().int().nonnegative().safe(),
}).strict()

export function parseCodexActionSurfaceInvalidation(
  value: unknown,
): CodexActionSurfaceInvalidation {
  return codexActionSurfaceInvalidationSchema.parse(value)
}

export type CodexProductTurnActionProjection =
  | {
      kind: 'product_turn'
      retryEvidenceKind: 'complete'
      ownerRunId: string
      ownerAliasGeneration: number
      ownerTurnRevision: number
      headProjectionRef: {
        version: CodexActionProjectionVersion
        digest: string
      }
      currentReadyMemoryRef: {
        scopeEpoch: number
        stateRevision: number
        revocationRevision: number
        semanticIngressDigest: string
        modelVisiblePayloadEmpty: boolean
        eligibilityDigest: string
      }
      currentTrustedEnvironmentRef: {
        requestedWorkbenchMode: 'browser' | 'document' | 'rss' | 'calendar'
        trustedWorkbenchMode: 'browser' | 'document' | 'rss' | 'calendar'
        modeDigest: string
      }
      productTurnActionProjectionVersion: {
        ownerTurnRevision: number
        headProjectionVersion: CodexActionProjectionVersion
        readyMemoryStateRevision: number
        readyMemoryRevocationRevision: number
        trustedModeDigest: string
        evidenceDigest: string
      }
      retry_failed_task: CodexActionGate
      evidenceDigest: string
    }
  | {
      kind: 'product_turn'
      retryEvidenceKind: 'unavailable_legacy'
      ownerRunId: string
      ownerAliasGeneration: number
      ownerTurnRevision: number
      headProjectionRef: null
      currentReadyMemoryRef: null
      currentTrustedEnvironmentRef: null
      productTurnActionProjectionVersion: {
        ownerTurnRevision: number
        auditDigest: string
      }
      retry_failed_task: CodexActionGate & {
        availability: 'not_applicable'
        blockers: ['legacy_or_evidence_incomplete']
        consequence: null
      }
      evidenceDigest: string
    }

export type ProductTurnReceipt = {
  contract: 'ready_product_turn_receipt_v3'
  readyRunId: string
  readyTaskId: string
  readyScopeId: string
  messageVisibilityEpoch: number
  ownerAliasGeneration: number
  revision: number
  terminal: 'done' | 'error' | 'cancelled' | 'interrupted'
  canonicalMessage: CanonicalAssistantMessage
  canonicalMessageDigest: string
  tools: ProductTurnToolReceipt[]
  artifacts: ProductTurnArtifactReceipt[]
  memory: ProductTurnMemoryReceipt | null
  contextUsage: ContextUsageSnapshot | null
  failure: null | {
    kind: 'transport' | 'protocol' | 'provider' | 'tool_effect_unknown' | 'artifact_delivery' | 'cancelled' | 'persistence'
    effectState: 'none' | 'confirmed' | 'indeterminate'
    evidenceRefs: string[]
  }
  actionProjection: CodexProductTurnActionProjection
  publicationSealDigest: string | null
  presentationDigest: string
}

export const PRE_PERSISTENCE_ERROR_KINDS = [
  'scope_missing',
  'attachment_unavailable',
  'configuration_unavailable',
  'capability_unavailable',
  'external_service_unavailable',
  'host_unavailable',
  'head_unavailable',
  'action_projection_confirmation_required',
  'thread_busy',
  'start_identity_capacity_exhausted',
  'conversation_reset_required',
  'conversation_materializing',
  'explicit_retry_control_invalid',
  'runtime_unverified',
  'runtime_unsupported',
  'model_changed',
  'thread_config_changed',
  'cwd_unavailable',
  'cwd_changed',
  'instruction_contract_changed',
  'native_tool_surface_extension_required',
  'native_tool_definition_changed',
  'ready_tool_execution_contract_changed',
  'current_contract_read_failed',
] as const

export const TERMINAL_ERROR_KINDS = [
  'circuit_break',
  'superseded',
  'checkpoint_budget',
  'blocked_config',
  'blocked_external',
  'context_overflow',
  'blocked_tool_error',
  'adjudication_degraded',
  'browser_transaction_unconfirmed',
  'delivery_failed',
  'tool_unavailable',
  'no_artifact',
  'proof_gap',
  'failed_skill',
  'resume_launch_failed',
  'persistence_failed',
  'cancelled_user',
  'cancelled_runtime',
  'main_no_progress_timeout',
  'unknown',
] as const

export const INGRESS_PERSISTENCE_ERROR_KINDS = [
  'ingress_message_persist_failed',
  'ingress_transaction_failed',
] as const

export type PrePersistenceErrorKind = typeof PRE_PERSISTENCE_ERROR_KINDS[number]
export type TerminalErrorKind = typeof TERMINAL_ERROR_KINDS[number]
export type IngressPersistenceErrorKind = typeof INGRESS_PERSISTENCE_ERROR_KINDS[number]
export type SendScopedErrorKind =
  | PrePersistenceErrorKind
  | TerminalErrorKind
  | IngressPersistenceErrorKind

export type AgentIngressMessageBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; base64: string; mimeType: string }
  | { type: 'video'; base64: string; mimeType: string }

export type SendScopedResourceSelection =
  | {
      kind: 'local_file'
      id: string
      name: string
      path: string
      size: number
      ext: string
      rendererType: 'image' | 'text' | 'spreadsheet' | 'other'
    }
  | {
      kind: 'local_directory'
      id: string
      name: string
      path: string
    }
  | {
      kind: 'skill'
      id: string
      name: string
      path: string
      skillId?: string
    }
  | {
      kind: 'browser_tab'
      id: string
      name: string
      tabId: string
    }
  | {
      kind: 'calendar_event'
      id: string
      name: string
      eventId: string
    }
  | {
      kind: 'quoted_text'
      id: string
      name: string
      text: string
      documentTitle?: string
      sectionTitle?: string
      lineStart?: number
      lineEnd?: number
    }
  | {
      kind: 'rss_item'
      id: string
      name: string
      itemId: string
    }
  | {
      kind: 'rss_source'
      id: string
      name: string
      sourceId: string
    }
  | {
      kind: 'mcp_resource'
      id: string
      name: string
      serverId: string
      uri: string
      catalogGeneration: number
      catalogDigest: string
      contentDigest: string
    }
  | {
      kind: 'calendar_window'
      id: string
      name: string
      start: string
      end: string
      calendarId?: string
    }
  | {
      kind: 'widget_target'
      id: string
      name: string
      logicalResourceId: string
      tabId: string
      widgetId: string
      currentVersion: string
      currentDigest: string
      policyEpoch: number
      incarnationKey: string
    }

export type SendScopedAttachmentConfirmationInput = {
  selectedCount: number
  metadataCount: number
  inputIncludedCount: number
  inputFailedCount: number
}

export type SendScopedUserMessage = {
  id: string
  content: string
  timestamp: string
  meta: Record<string, unknown>
  attachmentConfirmation: SendScopedAttachmentConfirmationInput
}

export type CodexCurrentDocumentAnchor = {
  kind: 'current_document'
  logicalResourceId: string
  tabId: string
  title: string
  pane: 'primary' | 'split'
  pathDigest: string | null
  incarnationKey: string
  currentVersion: string
  currentDigest: string
  supersedesVersion: string | null
  policyEpoch: number
  readScope: {
    operation: 'read_section'
    maxChars: 30_000
  }
}

export type SendScopedRequest = {
  scopeId: string
  requestId: string
  expectedAliasGeneration?: number
  expectedMessageVisibilityEpoch: number
  draftRevision?: number
  message: string | AgentIngressMessageBlock[]
  userMessage: SendScopedUserMessage
  resources?: SendScopedResourceSelection[]
  currentDocumentAnchor?: CodexCurrentDocumentAnchor
  actionAdmissionRef?: {
    headProjectionDigest: string
    actionProjectionVersion: CodexActionProjectionVersion
    actionHeadIdentity: NonNullable<CodexHeadActionProjection['actionHeadIdentity']>
  }
  explicitRetry?: {
    predecessorRunId: string
    predecessorPresentationDigest: string
  }
}

export type PersistedIngress = {
  scope: 'pre-existing'
  message: 'persisted'
  attachments: 'metadata_persisted' | 'metadata_partial' | 'metadata_failed' | 'none'
  inputAttachments: 'included' | 'partial' | 'failed' | 'none'
}

export type SkippedIngress = {
  scope: 'pre-existing' | 'failed'
  message: 'skipped'
  attachments: 'none'
  inputAttachments: 'none'
}

export type FailedIngress = {
  scope: 'pre-existing'
  message: 'failed'
  attachments: 'none'
  inputAttachments: 'none'
}

export type SendScopedResponse =
  | {
      success: true
      disposition: 'terminal_success'
      ownerRunId: string
      aliasGeneration: number
      retryableByUser: false
      persistence: PersistedIngress
      responseText: string
      canonicalMessage: CanonicalAssistantMessage
      canonicalMessageDigest: string
      productTurnReceipt?: ProductTurnReceipt
      error?: never
      errorKind?: never
      admissionEvidenceDigest?: never
      evidenceDigest?: never
      productOutcomeDigest?: never
      acceptedAsSteering?: never
    }
  | {
      success: false
      disposition: 'rejected_before_persistence'
      retryableByUser: boolean
      persistence: SkippedIngress
      error: string
      errorKind: PrePersistenceErrorKind
      admissionEvidenceDigest: string
      recoveryActionRef?: CodexBeginNewContextActionRef
      ownerRunId?: never
      responseText?: never
      canonicalMessage?: never
      canonicalMessageDigest?: never
      evidenceDigest?: never
      productOutcomeDigest?: never
      acceptedAsSteering?: never
    }
  | {
      success: false
      disposition: 'ingress_persistence_failed'
      retryableByUser: true
      persistence: FailedIngress
      error: string
      errorKind: IngressPersistenceErrorKind
      evidenceDigest: string
      ownerRunId?: never
      responseText?: never
      canonicalMessage?: never
      canonicalMessageDigest?: never
      admissionEvidenceDigest?: never
      productOutcomeDigest?: never
      acceptedAsSteering?: never
    }
  | {
      success: false
      disposition: 'terminal_failure_after_persistence'
      ownerRunId: string
      aliasGeneration: number
      retryableByUser: false
      persistence: PersistedIngress
      error: string
      errorKind: TerminalErrorKind
      productOutcomeDigest: string
      responseText: string
      canonicalMessage: CanonicalAssistantMessage
      canonicalMessageDigest: string
      productTurnReceipt?: ProductTurnReceipt
      admissionEvidenceDigest?: never
      evidenceDigest?: never
      acceptedAsSteering?: never
    }

export type SendMessageResult =
  | {
      success: true
      disposition: 'terminal_success'
      errorKind?: never
    }
  | {
      success: false
      disposition: 'rejected_before_persistence'
      errorKind: PrePersistenceErrorKind
      recoveryActionRef?: CodexBeginNewContextActionRef
    }
  | {
      success: false
      disposition: 'ingress_persistence_failed'
      errorKind: IngressPersistenceErrorKind
    }
  | {
      success: false
      disposition: 'terminal_failure_after_persistence'
      errorKind: TerminalErrorKind
    }

export type IngressAdmittedEvent = {
  type: 'ingress_admitted'
  requestId: string
  scopeId: string
  originUserMessageId: string
  aliasGeneration: number
  messageVisibilityEpoch: number
  ingressAdmittedRevision: number
  ingressAdmittedDigest: string
  admittedAt: string
}

export type CreateSessionResult =
  | {
      ok: true
      action: 'create'
      aliasId: string
      aliasGeneration: number
      persistedAt: string
    }
  | {
      ok: false
      action: 'create'
      code: 'binding_conflict' | 'persistence_failed'
      preserveUi: true
      evidenceDigest: string
    }

export type CreateSessionRequest = Record<string, never>

export type LifecycleRequest = {
  aliasId: string
  aliasGeneration: number
  workbenchMode?: 'browser' | 'document' | 'rss' | 'calendar'
  actionRequestRef?: LifecycleActionRequestRef
}

export type StopLifecycleRequest = LifecycleRequest & {
  readyRunId: string
  actionRequestRef?: LifecycleActionRequestRef
}

export type ProductLifecycleRequest = LifecycleRequest & {
  readyRunId: string | null
  actionRequestRef?: LifecycleActionRequestRef
}

export type LifecycleFailureCode =
  | 'no_active_operation'
  | 'thread_busy'
  | 'binding_conflict'
  | 'interrupt_state_unknown'
  | 'compaction_state_unknown'
  | 'native_protocol_error'
  | 'persistence_failed'
  | 'unsupported'

export type LifecycleResult =
  | {
      ok: true
      action: 'reset'
      aliasId: string
      retiredGeneration: number
      newGeneration: number
      transactionDigest: string
    }
  | {
      ok: true
      action: 'stop'
      aliasId: string
      codexThreadId: string
      codexTurnId: string
      terminal: 'completed' | 'interrupted' | 'failed'
      closeoutDigest: string
      fenceReleaseRevision: number
    }
  | {
      ok: true
      action: 'close'
      closeoutDisposition: 'never_started'
      aliasId: string
      retiredGeneration: number
      retirementTransactionDigest: string
      archiveDisposition: 'not_required'
      scopeClosureEvidenceDigest: string
    }
  | {
      ok: true
      action: 'close'
      closeoutDisposition: 'legacy_prepared_contract'
      aliasId: string
      retiredGeneration: number
      retirementTransactionDigest: string
      archiveDisposition: 'not_required'
      scopeClosureEvidenceDigest: string
    }
  | {
      ok: true
      action: 'close'
      closeoutDisposition: 'ready_terminal_no_native_thread'
      aliasId: string
      retiredGeneration: number
      lastCommittedReadyTerminalTransactionDigest: string
      retirementTransactionDigest: string
      archiveDisposition: 'not_required'
      scopeClosureEvidenceDigest: string
    }
  | {
      ok: true
      action: 'close'
      closeoutDisposition: 'native_thread_idle'
      aliasId: string
      retiredGeneration: number
      idleThreadReadDigest: string
      lastCommittedProductTerminalDigest: string
      retirementTransactionDigest: string
      archiveDisposition: 'durable_cleanup_pending'
      archiveIntentDigest: string
      scopeClosureEvidenceDigest: string
    }
  | {
      ok: true
      action: 'close'
      closeoutDisposition: 'completed_active_product_turn'
      aliasId: string
      retiredGeneration: number
      codexThreadId: string
      codexTurnId: string
      terminal: 'completed' | 'interrupted' | 'failed'
      closeoutDigest: string
      retirementTransactionDigest: string
      archiveDisposition: 'durable_cleanup_pending'
      archiveIntentDigest: string
      scopeClosureEvidenceDigest: string
    }
  | {
      ok: true
      action: 'manual_compact'
      aliasId: string
      manualCompactionId: string
      contextCompactionItemId: string
      codexTurnId: string
      threadReadDigest: string
    }
  | {
      ok: false
      action: 'reset' | 'stop' | 'close' | 'manual_compact'
      code: LifecycleFailureCode
      preserveUi: true
      aliasId: string
      aliasGeneration: number
      evidenceDigest: string
    }

const nonEmptyString = z.string().min(1)
const digestString = z.string().min(1)
const JITLESS_PARSE = { jitless: true } as const

const canonicalAssistantMessageSchema = z.object({
  id: nonEmptyString,
  conversationId: nonEmptyString,
  role: z.literal('assistant'),
  content: z.string(),
  timestamp: nonEmptyString,
  meta: z.record(z.string(), z.unknown()),
}).strict()

const agentIngressMessageBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z.object({
    type: z.literal('image'),
    base64: nonEmptyString,
    mimeType: nonEmptyString,
  }).strict(),
  z.object({
    type: z.literal('video'),
    base64: nonEmptyString,
    mimeType: nonEmptyString,
  }).strict(),
])

const sha256Digest = z.string().regex(/^[0-9a-f]{64}$/)
const sha256Version = z.string().regex(/^sha256:[0-9a-f]{64}$/)

export const codexCurrentDocumentAnchorSchema: z.ZodType<CodexCurrentDocumentAnchor> = z.object({
  kind: z.literal('current_document'),
  logicalResourceId: nonEmptyString,
  tabId: nonEmptyString,
  title: z.string(),
  pane: z.enum(['primary', 'split']),
  pathDigest: sha256Digest.nullable(),
  incarnationKey: sha256Digest,
  currentVersion: sha256Version,
  currentDigest: sha256Digest,
  supersedesVersion: sha256Version.nullable(),
  policyEpoch: z.number().int().positive().safe(),
  readScope: z.object({
    operation: z.literal('read_section'),
    maxChars: z.literal(30_000),
  }).strict(),
}).strict()

export const sendScopedRequestSchema: z.ZodType<SendScopedRequest> = z.object({
  scopeId: nonEmptyString,
  requestId: nonEmptyString,
  expectedAliasGeneration: z.number().int().positive().optional(),
  expectedMessageVisibilityEpoch: z.number().int().nonnegative(),
  draftRevision: z.number().int().nonnegative().safe().optional(),
  message: z.union([z.string(), z.array(agentIngressMessageBlockSchema).min(1)]),
  userMessage: z.object({
    id: nonEmptyString,
    content: z.string(),
    timestamp: nonEmptyString,
    meta: z.record(z.string(), z.unknown()),
    attachmentConfirmation: z.object({
      selectedCount: z.number().int().nonnegative(),
      metadataCount: z.number().int().nonnegative(),
      inputIncludedCount: z.number().int().nonnegative(),
      inputFailedCount: z.number().int().nonnegative(),
    }).strict(),
  }).strict(),
  resources: z.array(z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('local_file'),
      id: nonEmptyString,
      name: nonEmptyString,
      path: nonEmptyString,
      size: z.number().int().nonnegative().safe(),
      ext: z.string(),
      rendererType: z.enum(['image', 'text', 'spreadsheet', 'other']),
    }).strict(),
    z.object({
      kind: z.literal('local_directory'),
      id: nonEmptyString,
      name: nonEmptyString,
      path: nonEmptyString,
    }).strict(),
    z.object({
      kind: z.literal('skill'),
      id: nonEmptyString,
      name: nonEmptyString,
      path: nonEmptyString,
      skillId: nonEmptyString.optional(),
    }).strict(),
    z.object({
      kind: z.literal('browser_tab'),
      id: nonEmptyString,
      name: nonEmptyString,
      tabId: nonEmptyString,
    }).strict(),
    z.object({
      kind: z.literal('calendar_event'),
      id: nonEmptyString,
      name: nonEmptyString,
      eventId: nonEmptyString,
    }).strict(),
    z.object({
      kind: z.literal('quoted_text'),
      id: nonEmptyString,
      name: nonEmptyString,
      text: z.string().min(1).max(30_000),
      documentTitle: z.string().optional(),
      sectionTitle: z.string().optional(),
      lineStart: z.number().int().positive().safe().optional(),
      lineEnd: z.number().int().positive().safe().optional(),
    }).strict(),
    z.object({
      kind: z.literal('rss_item'),
      id: nonEmptyString,
      name: nonEmptyString,
      itemId: nonEmptyString,
    }).strict(),
    z.object({
      kind: z.literal('rss_source'),
      id: nonEmptyString,
      name: nonEmptyString,
      sourceId: nonEmptyString,
    }).strict(),
    z.object({
      kind: z.literal('mcp_resource'),
      id: nonEmptyString,
      name: nonEmptyString,
      serverId: nonEmptyString,
      uri: nonEmptyString,
      catalogGeneration: z.number().int().positive().safe(),
      catalogDigest: z.string().regex(/^[a-f0-9]{64}$/),
      contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict(),
    z.object({
      kind: z.literal('calendar_window'),
      id: nonEmptyString,
      name: nonEmptyString,
      start: nonEmptyString,
      end: nonEmptyString,
      calendarId: nonEmptyString.optional(),
    }).strict(),
    z.object({
      kind: z.literal('widget_target'),
      id: nonEmptyString,
      name: nonEmptyString,
      logicalResourceId: nonEmptyString,
      tabId: nonEmptyString,
      widgetId: nonEmptyString,
      currentVersion: sha256Version,
      currentDigest: sha256Digest,
      policyEpoch: z.number().int().positive().safe(),
      incarnationKey: sha256Digest,
    }).strict(),
  ])).max(32).optional(),
  currentDocumentAnchor: codexCurrentDocumentAnchorSchema.optional(),
  actionAdmissionRef: z.object({
    headProjectionDigest: sha256Digest,
    actionProjectionVersion: z.object({
      scopeEpoch: z.number().int().nonnegative().safe(),
      headGeneration: z.number().int().positive().safe(),
      actionProjectionSequence: z.number().int().nonnegative().safe(),
    }).strict(),
    actionHeadIdentity: z.object({
      aliasId: nonEmptyString,
      aliasGeneration: z.number().int().positive().safe(),
      threadBindingId: nonEmptyString,
      headRevision: z.number().int().positive().safe(),
    }).strict(),
  }).strict().optional(),
  explicitRetry: z.object({
    predecessorRunId: nonEmptyString,
    predecessorPresentationDigest: sha256Digest,
  }).strict().optional(),
}).strict()

export const ingressAdmittedEventSchema: z.ZodType<IngressAdmittedEvent> = z.object({
  type: z.literal('ingress_admitted'),
  requestId: nonEmptyString,
  scopeId: nonEmptyString,
  originUserMessageId: nonEmptyString,
  aliasGeneration: z.number().int().positive(),
  messageVisibilityEpoch: z.number().int().nonnegative(),
  ingressAdmittedRevision: z.number().int().positive(),
  ingressAdmittedDigest: digestString,
  admittedAt: nonEmptyString,
}).strict()

const persistedIngressSchema = z.object({
  scope: z.literal('pre-existing'),
  message: z.literal('persisted'),
  attachments: z.enum(['metadata_persisted', 'metadata_partial', 'metadata_failed', 'none']),
  inputAttachments: z.enum(['included', 'partial', 'failed', 'none']),
}).strict()

const skippedIngressSchema = z.object({
  scope: z.enum(['pre-existing', 'failed']),
  message: z.literal('skipped'),
  attachments: z.literal('none'),
  inputAttachments: z.literal('none'),
}).strict()

const failedIngressSchema = z.object({
  scope: z.literal('pre-existing'),
  message: z.literal('failed'),
  attachments: z.literal('none'),
  inputAttachments: z.literal('none'),
}).strict()

const codexBeginNewContextActionRefSchema: z.ZodType<CodexBeginNewContextActionRef> = z.object({
  contract: z.literal('codex_begin_new_context_action_v1'),
  operationId: nonEmptyString,
  scopeId: nonEmptyString,
  scopeEpoch: z.number().int().nonnegative().safe(),
  sourceThreadBindingId: nonEmptyString,
  sourceAliasGeneration: z.number().int().positive().safe(),
  sourceRevision: z.number().int().positive().safe(),
  sourceEvidenceDigest: digestString,
  candidateEvidenceDigest: digestString,
  consequenceDigest: digestString,
  draftRevision: z.number().int().nonnegative().safe().nullable(),
  digest: digestString,
}).strict()

const codexConversationContextBoundarySchema: z.ZodType<CodexConversationContextBoundary> = z.object({
  operationId: nonEmptyString,
  scopeId: nonEmptyString,
  scopeEpoch: z.number().int().nonnegative().safe(),
  sourceThreadBindingId: nonEmptyString,
  sourceAliasGeneration: z.number().int().positive().safe(),
  sourceRevision: z.number().int().positive().safe(),
  targetThreadBindingId: nonEmptyString,
  targetAliasGeneration: z.number().int().positive().safe(),
  previousVisibleMessageAnchor: nonEmptyString.nullable(),
  preservedContextDigest: digestString.optional(),
  committedAt: nonEmptyString,
  receiptDigest: digestString,
}).strict()

const beginNewContextRequestSchema: z.ZodType<BeginNewContextRequest> = z.object({
  actionRef: codexBeginNewContextActionRefSchema,
}).strict()

const beginNewContextResultSchema: z.ZodType<BeginNewContextResult> = z.object({
  ok: z.literal(true),
  boundary: codexConversationContextBoundarySchema,
  aliasGeneration: z.number().int().positive().safe(),
  actionSurfaceInvalidation: codexActionSurfaceInvalidationSchema,
}).strict().refine((result) => result.aliasGeneration === result.actionSurfaceInvalidation.aliasGeneration
  && result.boundary.scopeId === result.actionSurfaceInvalidation.scopeId
  && result.boundary.scopeEpoch === result.actionSurfaceInvalidation.scopeEpoch
  && result.aliasGeneration >= result.boundary.targetAliasGeneration, 'begin_new_context_result_inconsistent')

const productTurnToolReceiptSchema = z.object({
  callId: nonEmptyString,
  toolName: nonEmptyString,
  state: z.enum(['pending', 'confirmed', 'proven_absent', 'indeterminate', 'degraded']),
  actionReceiptId: nonEmptyString.nullable(),
  actionRevision: z.number().int().positive().nullable(),
  resultDigest: digestString.nullable(),
  deliveryAttemptId: nonEmptyString.nullable(),
  deliveryConfirmed: z.boolean(),
  summary: z.string(),
}).strict()

const productTurnArtifactReceiptSchema = z.object({
  relativePath: nonEmptyString,
  state: z.enum(['required', 'staged', 'exported', 'verified', 'failed', 'indeterminate']),
  logicalArtifactRef: nonEmptyString.nullable(),
  version: nonEmptyString.nullable(),
  bytes: z.number().int().nonnegative().nullable(),
  sha256: digestString.nullable(),
  destinationResourceId: nonEmptyString.nullable(),
  evidenceRefs: z.array(nonEmptyString),
}).strict()

const productTurnMemoryReceiptSchema = z.object({
  snapshotDigest: digestString,
  stateRevision: z.number().int().positive(),
  revocationRevision: z.number().int().nonnegative(),
  summaryEntryIds: z.array(nonEmptyString).max(64),
  readEntryIds: z.array(nonEmptyString).max(64),
  readReceiptDigest: digestString.nullable(),
}).strict()

const codexActionProjectionVersionSchema = z.object({
  scopeEpoch: z.number().int().nonnegative().safe(),
  headGeneration: z.number().int().positive().safe(),
  actionProjectionSequence: z.number().int().nonnegative().safe(),
}).strict()

const codexActionGateSchema = z.object({
  availability: z.enum(['ready', 'blocked', 'not_applicable']),
  blockers: z.array(nonEmptyString),
  consequence: z.object({
    kind: z.literal('supersedes_uncommitted_structured_tail'),
    omittedItemCount: z.number().int().nonnegative().safe(),
    resourceReattachItemCount: z.number().int().nonnegative().safe(),
    itemsDigest: sha256Digest,
  }).strict().nullable(),
}).strict()

const completeProductTurnActionProjectionSchema = z.object({
  kind: z.literal('product_turn'),
  retryEvidenceKind: z.literal('complete'),
  ownerRunId: nonEmptyString,
  ownerAliasGeneration: z.number().int().positive().safe(),
  ownerTurnRevision: z.number().int().positive().safe(),
  headProjectionRef: z.object({
    version: codexActionProjectionVersionSchema,
    digest: sha256Digest,
  }).strict(),
  currentReadyMemoryRef: z.object({
    scopeEpoch: z.number().int().nonnegative().safe(),
    stateRevision: z.number().int().positive().safe(),
    revocationRevision: z.number().int().nonnegative().safe(),
    semanticIngressDigest: sha256Digest,
    modelVisiblePayloadEmpty: z.boolean(),
    eligibilityDigest: sha256Digest,
  }).strict(),
  currentTrustedEnvironmentRef: z.object({
    requestedWorkbenchMode: z.enum(['browser', 'document', 'rss', 'calendar']),
    trustedWorkbenchMode: z.enum(['browser', 'document', 'rss', 'calendar']),
    modeDigest: sha256Digest,
  }).strict(),
  productTurnActionProjectionVersion: z.object({
    ownerTurnRevision: z.number().int().positive().safe(),
    headProjectionVersion: codexActionProjectionVersionSchema,
    readyMemoryStateRevision: z.number().int().positive().safe(),
    readyMemoryRevocationRevision: z.number().int().nonnegative().safe(),
    trustedModeDigest: sha256Digest,
    evidenceDigest: sha256Digest,
  }).strict(),
  retry_failed_task: codexActionGateSchema,
  evidenceDigest: sha256Digest,
}).strict()

const unavailableProductTurnActionProjectionSchema = z.object({
  kind: z.literal('product_turn'),
  retryEvidenceKind: z.literal('unavailable_legacy'),
  ownerRunId: nonEmptyString,
  ownerAliasGeneration: z.number().int().positive().safe(),
  ownerTurnRevision: z.number().int().positive().safe(),
  headProjectionRef: z.null(),
  currentReadyMemoryRef: z.null(),
  currentTrustedEnvironmentRef: z.null(),
  productTurnActionProjectionVersion: z.object({
    ownerTurnRevision: z.number().int().positive().safe(),
    auditDigest: sha256Digest,
  }).strict(),
  retry_failed_task: z.object({
    availability: z.literal('not_applicable'),
    blockers: z.tuple([z.literal('legacy_or_evidence_incomplete')]),
    consequence: z.null(),
  }).strict(),
  evidenceDigest: sha256Digest,
}).strict()

const productTurnReceiptSchema: z.ZodType<ProductTurnReceipt> = z.object({
  contract: z.literal('ready_product_turn_receipt_v3'),
  readyRunId: nonEmptyString,
  actionRequestRef: lifecycleActionRequestRefSchema.optional(),
  readyTaskId: nonEmptyString,
  readyScopeId: nonEmptyString,
  messageVisibilityEpoch: z.number().int().nonnegative(),
  ownerAliasGeneration: z.number().int().positive().safe(),
  revision: z.number().int().positive(),
  terminal: z.enum(['done', 'error', 'cancelled', 'interrupted']),
  canonicalMessage: canonicalAssistantMessageSchema,
  canonicalMessageDigest: digestString,
  tools: z.array(productTurnToolReceiptSchema).max(100),
  artifacts: z.array(productTurnArtifactReceiptSchema),
  memory: productTurnMemoryReceiptSchema.nullable(),
  contextUsage: z.object({
    usedInputTokens: z.number().int().positive(),
    windowTokens: z.number().int().positive().nullable(),
    ratio: z.number().nonnegative().nullable(),
    windowSource: z.enum(['explicit', 'model', 'fallback']).nullable(),
    source: z.literal('last_model_request'),
    timestamp: nonEmptyString,
  }).strict().nullable(),
  failure: z.object({
    kind: z.enum(['transport', 'protocol', 'provider', 'tool_effect_unknown', 'artifact_delivery', 'cancelled', 'persistence']),
    effectState: z.enum(['none', 'confirmed', 'indeterminate']),
    evidenceRefs: z.array(nonEmptyString),
  }).strict().nullable(),
  actionProjection: z.union([
    completeProductTurnActionProjectionSchema,
    unavailableProductTurnActionProjectionSchema,
  ]),
  publicationSealDigest: digestString.nullable(),
  presentationDigest: digestString,
}).strict()

export const sendScopedResponseSchema: z.ZodType<SendScopedResponse> = z.union([
  z.object({
    success: z.literal(true),
    disposition: z.literal('terminal_success'),
    ownerRunId: nonEmptyString,
    aliasGeneration: z.number().int().positive(),
    retryableByUser: z.literal(false),
    persistence: persistedIngressSchema,
    responseText: z.string(),
    canonicalMessage: canonicalAssistantMessageSchema,
    canonicalMessageDigest: digestString,
    productTurnReceipt: productTurnReceiptSchema.optional(),
  }).strict(),
  z.object({
    success: z.literal(false),
    disposition: z.literal('rejected_before_persistence'),
    retryableByUser: z.boolean(),
    persistence: skippedIngressSchema,
    error: nonEmptyString,
    errorKind: z.enum(PRE_PERSISTENCE_ERROR_KINDS),
    admissionEvidenceDigest: digestString,
    recoveryActionRef: codexBeginNewContextActionRefSchema.optional(),
  }).strict(),
  z.object({
    success: z.literal(false),
    disposition: z.literal('ingress_persistence_failed'),
    retryableByUser: z.literal(true),
    persistence: failedIngressSchema,
    error: nonEmptyString,
    errorKind: z.enum(INGRESS_PERSISTENCE_ERROR_KINDS),
    evidenceDigest: digestString,
  }).strict(),
  z.object({
    success: z.literal(false),
    disposition: z.literal('terminal_failure_after_persistence'),
    ownerRunId: nonEmptyString,
    aliasGeneration: z.number().int().positive(),
    retryableByUser: z.literal(false),
    persistence: persistedIngressSchema,
    error: nonEmptyString,
    errorKind: z.enum(TERMINAL_ERROR_KINDS),
    productOutcomeDigest: digestString,
    responseText: z.string(),
    canonicalMessage: canonicalAssistantMessageSchema,
    canonicalMessageDigest: digestString,
    productTurnReceipt: productTurnReceiptSchema.optional(),
  }).strict(),
])

export function parseSendScopedResponse(value: unknown): SendScopedResponse {
  return sendScopedResponseSchema.parse(value, JITLESS_PARSE)
}

export function parseSendScopedRequest(value: unknown): SendScopedRequest {
  return sendScopedRequestSchema.parse(value, JITLESS_PARSE)
}

export function parseIngressAdmittedEvent(value: unknown): IngressAdmittedEvent {
  return ingressAdmittedEventSchema.parse(value, JITLESS_PARSE)
}

export const createSessionResultSchema: z.ZodType<CreateSessionResult> = z.union([
  z.object({
    ok: z.literal(true),
    action: z.literal('create'),
    aliasId: nonEmptyString,
    aliasGeneration: z.number().int().positive(),
    persistedAt: nonEmptyString,
  }).strict(),
  z.object({
    ok: z.literal(false),
    action: z.literal('create'),
    code: z.enum(['binding_conflict', 'persistence_failed']),
    preserveUi: z.literal(true),
    evidenceDigest: digestString,
  }).strict(),
])

export const createSessionRequestSchema: z.ZodType<CreateSessionRequest> = z.object({}).strict()

export const lifecycleRequestSchema: z.ZodType<LifecycleRequest> = z.object({
  aliasId: nonEmptyString,
  aliasGeneration: z.number().int().positive(),
  workbenchMode: z.enum(['browser', 'document', 'rss', 'calendar']).optional(),
  actionRequestRef: lifecycleActionRequestRefSchema.optional(),
}).strict()

export const stopLifecycleRequestSchema: z.ZodType<StopLifecycleRequest> = z.object({
  aliasId: nonEmptyString,
  aliasGeneration: z.number().int().positive(),
  workbenchMode: z.enum(['browser', 'document', 'rss', 'calendar']).optional(),
  readyRunId: nonEmptyString,
  actionRequestRef: lifecycleActionRequestRefSchema.optional(),
}).strict()

export const productLifecycleRequestSchema: z.ZodType<ProductLifecycleRequest> = z.object({
  aliasId: nonEmptyString,
  aliasGeneration: z.number().int().positive(),
  workbenchMode: z.enum(['browser', 'document', 'rss', 'calendar']).optional(),
  readyRunId: nonEmptyString.nullable(),
  actionRequestRef: lifecycleActionRequestRefSchema.optional(),
}).strict()

const lifecycleFailureSchema = z.object({
  ok: z.literal(false),
  action: z.enum(['reset', 'stop', 'close', 'manual_compact']),
  code: z.enum([
    'no_active_operation',
    'thread_busy',
    'binding_conflict',
    'interrupt_state_unknown',
    'compaction_state_unknown',
    'native_protocol_error',
    'persistence_failed',
    'unsupported',
  ]),
  preserveUi: z.literal(true),
  aliasId: nonEmptyString,
  aliasGeneration: z.number().int().positive(),
  evidenceDigest: digestString,
}).strict()

export const lifecycleResultSchema: z.ZodType<LifecycleResult> = z.union([
  z.object({
    ok: z.literal(true),
    action: z.literal('reset'),
    aliasId: nonEmptyString,
    retiredGeneration: z.number().int().positive(),
    newGeneration: z.number().int().positive(),
    transactionDigest: digestString,
  }).strict(),
  z.object({
    ok: z.literal(true),
    action: z.literal('stop'),
    aliasId: nonEmptyString,
    codexThreadId: nonEmptyString,
    codexTurnId: nonEmptyString,
    terminal: z.enum(['completed', 'interrupted', 'failed']),
    closeoutDigest: digestString,
    fenceReleaseRevision: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    ok: z.literal(true),
    action: z.literal('close'),
    closeoutDisposition: z.literal('never_started'),
    aliasId: nonEmptyString,
    retiredGeneration: z.number().int().positive(),
    retirementTransactionDigest: digestString,
    archiveDisposition: z.literal('not_required'),
    scopeClosureEvidenceDigest: digestString,
  }).strict(),
  z.object({
    ok: z.literal(true),
    action: z.literal('close'),
    closeoutDisposition: z.literal('legacy_prepared_contract'),
    aliasId: nonEmptyString,
    retiredGeneration: z.number().int().positive(),
    retirementTransactionDigest: digestString,
    archiveDisposition: z.literal('not_required'),
    scopeClosureEvidenceDigest: digestString,
  }).strict(),
  z.object({
    ok: z.literal(true),
    action: z.literal('close'),
    closeoutDisposition: z.literal('ready_terminal_no_native_thread'),
    aliasId: nonEmptyString,
    retiredGeneration: z.number().int().positive(),
    lastCommittedReadyTerminalTransactionDigest: digestString,
    retirementTransactionDigest: digestString,
    archiveDisposition: z.literal('not_required'),
    scopeClosureEvidenceDigest: digestString,
  }).strict(),
  z.object({
    ok: z.literal(true),
    action: z.literal('close'),
    closeoutDisposition: z.literal('native_thread_idle'),
    aliasId: nonEmptyString,
    retiredGeneration: z.number().int().positive(),
    idleThreadReadDigest: digestString,
    lastCommittedProductTerminalDigest: digestString,
    retirementTransactionDigest: digestString,
    archiveDisposition: z.literal('durable_cleanup_pending'),
    archiveIntentDigest: digestString,
    scopeClosureEvidenceDigest: digestString,
  }).strict(),
  z.object({
    ok: z.literal(true),
    action: z.literal('close'),
    closeoutDisposition: z.literal('completed_active_product_turn'),
    aliasId: nonEmptyString,
    retiredGeneration: z.number().int().positive(),
    codexThreadId: nonEmptyString,
    codexTurnId: nonEmptyString,
    terminal: z.enum(['completed', 'interrupted', 'failed']),
    closeoutDigest: digestString,
    retirementTransactionDigest: digestString,
    archiveDisposition: z.literal('durable_cleanup_pending'),
    archiveIntentDigest: digestString,
    scopeClosureEvidenceDigest: digestString,
  }).strict(),
  z.object({
    ok: z.literal(true),
    action: z.literal('manual_compact'),
    aliasId: nonEmptyString,
    manualCompactionId: nonEmptyString,
    contextCompactionItemId: nonEmptyString,
    codexTurnId: nonEmptyString,
    threadReadDigest: digestString,
  }).strict(),
  lifecycleFailureSchema,
])

export function parseCreateSessionResult(value: unknown): CreateSessionResult {
  return createSessionResultSchema.parse(value, JITLESS_PARSE)
}

export function parseCreateSessionRequest(value: unknown): CreateSessionRequest {
  return createSessionRequestSchema.parse(value, JITLESS_PARSE)
}

export function parseLifecycleResult(value: unknown): LifecycleResult {
  return lifecycleResultSchema.parse(value, JITLESS_PARSE)
}

export function parseLifecycleRequest(value: unknown): LifecycleRequest {
  return lifecycleRequestSchema.parse(value, JITLESS_PARSE)
}

export function parseStopLifecycleRequest(value: unknown): StopLifecycleRequest {
  return stopLifecycleRequestSchema.parse(value, JITLESS_PARSE)
}

export function parseBeginNewContextRequest(value: unknown): BeginNewContextRequest {
  return beginNewContextRequestSchema.parse(value, JITLESS_PARSE)
}

export function parseBeginNewContextResult(value: unknown): BeginNewContextResult {
  return beginNewContextResultSchema.parse(value, JITLESS_PARSE)
}

export function parseProductLifecycleRequest(value: unknown): ProductLifecycleRequest {
  return productLifecycleRequestSchema.parse(value, JITLESS_PARSE)
}

function assertNever(value: never): never {
  throw new Error(`unhandled_send_scoped_disposition:${String(value)}`)
}

export function mapSendScopedResponseToMessageResult(response: SendScopedResponse): SendMessageResult {
  switch (response.disposition) {
    case 'terminal_success':
      return {
        success: true,
        disposition: response.disposition,
      }
    case 'rejected_before_persistence':
      return {
        success: false,
        disposition: response.disposition,
        errorKind: response.errorKind,
        ...(response.recoveryActionRef ? { recoveryActionRef: response.recoveryActionRef } : {}),
      }
    case 'ingress_persistence_failed':
      return {
        success: false,
        disposition: response.disposition,
        errorKind: response.errorKind,
      }
    case 'terminal_failure_after_persistence':
      return {
        success: false,
        disposition: response.disposition,
        errorKind: response.errorKind,
      }
    default:
      return assertNever(response)
  }
}
