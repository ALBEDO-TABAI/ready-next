import { z } from 'zod'

import type { CanonicalAssistantMessage } from './canonical-message'

export const PRE_PERSISTENCE_ERROR_KINDS = [
  'scope_missing',
  'attachment_unavailable',
  'host_unavailable',
  'thread_busy',
  'start_identity_capacity_exhausted',
  'conversation_reset_required',
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

export type SendScopedRequest = {
  scopeId: string
  requestId: string
  message: string | AgentIngressMessageBlock[]
  userMessage: SendScopedUserMessage
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
      shouldClearInput: true
      preserveInput: false
      retryableByUser: false
      persistence: PersistedIngress
      responseText: string
      canonicalMessage: CanonicalAssistantMessage
      canonicalMessageDigest: string
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
      shouldClearInput: false
      preserveInput: true
      retryableByUser: boolean
      persistence: SkippedIngress
      error: string
      errorKind: PrePersistenceErrorKind
      admissionEvidenceDigest: string
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
      shouldClearInput: false
      preserveInput: true
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
      shouldClearInput: true
      preserveInput: false
      retryableByUser: false
      persistence: PersistedIngress
      error: string
      errorKind: TerminalErrorKind
      productOutcomeDigest: string
      responseText?: never
      canonicalMessage?: never
      canonicalMessageDigest?: never
      admissionEvidenceDigest?: never
      evidenceDigest?: never
      acceptedAsSteering?: never
    }

export type SendMessageResult =
  | {
      success: true
      disposition: 'terminal_success'
      shouldClearInput: true
      preserveInput: false
      errorKind?: never
    }
  | {
      success: false
      disposition: 'rejected_before_persistence'
      shouldClearInput: false
      preserveInput: true
      errorKind: PrePersistenceErrorKind
    }
  | {
      success: false
      disposition: 'ingress_persistence_failed'
      shouldClearInput: false
      preserveInput: true
      errorKind: IngressPersistenceErrorKind
    }
  | {
      success: false
      disposition: 'terminal_failure_after_persistence'
      shouldClearInput: true
      preserveInput: false
      errorKind: TerminalErrorKind
    }

export type IngressAdmittedEvent = {
  type: 'ingress_admitted'
  requestId: string
  scopeId: string
  originUserMessageId: string
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

export type LifecycleRequest = {
  aliasId: string
  aliasGeneration: number
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
      archiveDisposition: 'not_required' | 'queued_cleanup'
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
      archiveDisposition: 'not_required' | 'queued_cleanup'
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

export const sendScopedRequestSchema: z.ZodType<SendScopedRequest> = z.object({
  scopeId: nonEmptyString,
  requestId: nonEmptyString,
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
}).strict()

export const ingressAdmittedEventSchema: z.ZodType<IngressAdmittedEvent> = z.object({
  type: z.literal('ingress_admitted'),
  requestId: nonEmptyString,
  scopeId: nonEmptyString,
  originUserMessageId: nonEmptyString,
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

export const sendScopedResponseSchema: z.ZodType<SendScopedResponse> = z.union([
  z.object({
    success: z.literal(true),
    disposition: z.literal('terminal_success'),
    ownerRunId: nonEmptyString,
    shouldClearInput: z.literal(true),
    preserveInput: z.literal(false),
    retryableByUser: z.literal(false),
    persistence: persistedIngressSchema,
    responseText: z.string(),
    canonicalMessage: canonicalAssistantMessageSchema,
    canonicalMessageDigest: digestString,
  }).strict(),
  z.object({
    success: z.literal(false),
    disposition: z.literal('rejected_before_persistence'),
    shouldClearInput: z.literal(false),
    preserveInput: z.literal(true),
    retryableByUser: z.boolean(),
    persistence: skippedIngressSchema,
    error: nonEmptyString,
    errorKind: z.enum(PRE_PERSISTENCE_ERROR_KINDS),
    admissionEvidenceDigest: digestString,
  }).strict(),
  z.object({
    success: z.literal(false),
    disposition: z.literal('ingress_persistence_failed'),
    shouldClearInput: z.literal(false),
    preserveInput: z.literal(true),
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
    shouldClearInput: z.literal(true),
    preserveInput: z.literal(false),
    retryableByUser: z.literal(false),
    persistence: persistedIngressSchema,
    error: nonEmptyString,
    errorKind: z.enum(TERMINAL_ERROR_KINDS),
    productOutcomeDigest: digestString,
  }).strict(),
])

export function parseSendScopedResponse(value: unknown): SendScopedResponse {
  return sendScopedResponseSchema.parse(value)
}

export function parseSendScopedRequest(value: unknown): SendScopedRequest {
  return sendScopedRequestSchema.parse(value)
}

export function parseIngressAdmittedEvent(value: unknown): IngressAdmittedEvent {
  return ingressAdmittedEventSchema.parse(value)
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

export const lifecycleRequestSchema: z.ZodType<LifecycleRequest> = z.object({
  aliasId: nonEmptyString,
  aliasGeneration: z.number().int().positive(),
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
    archiveDisposition: z.enum(['not_required', 'queued_cleanup']),
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
    archiveDisposition: z.enum(['not_required', 'queued_cleanup']),
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
  return createSessionResultSchema.parse(value)
}

export function parseLifecycleResult(value: unknown): LifecycleResult {
  return lifecycleResultSchema.parse(value)
}

export function parseLifecycleRequest(value: unknown): LifecycleRequest {
  return lifecycleRequestSchema.parse(value)
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
        shouldClearInput: true,
        preserveInput: false,
      }
    case 'rejected_before_persistence':
      return {
        success: false,
        disposition: response.disposition,
        shouldClearInput: false,
        preserveInput: true,
        errorKind: response.errorKind,
      }
    case 'ingress_persistence_failed':
      return {
        success: false,
        disposition: response.disposition,
        shouldClearInput: false,
        preserveInput: true,
        errorKind: response.errorKind,
      }
    case 'terminal_failure_after_persistence':
      return {
        success: false,
        disposition: response.disposition,
        shouldClearInput: true,
        preserveInput: false,
        errorKind: response.errorKind,
      }
    default:
      return assertNever(response)
  }
}
