export type SendScopedErrorKind =
  | 'scope_missing'
  | 'message_persist_failed'
  | 'attachment_unavailable'
  | 'host_unavailable'
  | 'circuit_break'
  | 'superseded'
  | 'checkpoint_budget'
  | 'blocked_config'
  | 'blocked_external'
  | 'context_overflow'
  | 'blocked_tool_error'
  | 'adjudication_degraded'
  | 'browser_transaction_unconfirmed'
  | 'delivery_failed'
  | 'tool_unavailable'
  | 'no_artifact'
  | 'proof_gap'
  | 'failed_skill'
  | 'resume_launch_failed'
  | 'persistence_failed'
  | 'cancelled_user'
  | 'cancelled_runtime'
  | 'main_no_progress_timeout'
  | 'unknown'

export type SendScopedScopeStatus = 'pre-existing' | 'lazy-created' | 'failed'
export type SendScopedMessageStatus = 'persisted' | 'failed' | 'skipped'
export type SendScopedAttachmentStatus = 'metadata_persisted' | 'metadata_partial' | 'metadata_failed' | 'none'
export type SendScopedInputAttachmentStatus = 'included' | 'partial' | 'failed' | 'none'

export interface SendScopedAttachmentConfirmationInput {
  selectedCount: number
  metadataCount: number
  inputIncludedCount: number
  inputFailedCount: number
}

export interface SendScopedAttachmentConfirmation {
  attachments: SendScopedAttachmentStatus
  inputAttachments: SendScopedInputAttachmentStatus
}

export interface SendScopedPersistence {
  scope: SendScopedScopeStatus
  message: SendScopedMessageStatus
  attachments: SendScopedAttachmentStatus
  inputAttachments: SendScopedInputAttachmentStatus
}

export interface SendScopedUserMessage {
  id: string
  content: string
  timestamp?: string
  meta?: Record<string, unknown>
  attachmentConfirmation?: SendScopedAttachmentConfirmationInput
}

export interface SendScopedResponse {
  success: boolean
  error?: string
  errorKind?: SendScopedErrorKind
  responseText?: string
  persistence?: SendScopedPersistence
}

export async function runConfirmedSendScoped<ScopeRow>(params: {
  scopeId: string
  agent?: string
  userMessage?: SendScopedUserMessage
  getScope: (scopeId: string) => ScopeRow | null
  createLocalScope: (agent: string, scopeId: string) => ScopeRow
  persistUserMessage: (scope: ScopeRow, userMessage: SendScopedUserMessage) => void
  onLazyCreate?: (scopeId: string, agent: string) => void
  runConfirmed: (scope: ScopeRow, persistence: SendScopedPersistence) => Promise<SendScopedResponse>
}): Promise<SendScopedResponse> {
  let scopePersistence: SendScopedScopeStatus = 'pre-existing'
  let scope = params.getScope(params.scopeId)
  if (!scope && params.agent && params.scopeId.startsWith('conv-')) {
    scope = params.createLocalScope(params.agent, params.scopeId)
    scopePersistence = 'lazy-created'
    params.onLazyCreate?.(params.scopeId, params.agent)
  }
  if (!scope) {
    return {
      success: false,
      error: `Conversation scope not found: ${params.scopeId}`,
      errorKind: 'scope_missing',
      persistence: createSendScopedPersistence({
        scope: 'failed',
        message: 'skipped',
        attachmentConfirmation: params.userMessage?.attachmentConfirmation,
      }),
    }
  }

  let persistence = createSendScopedPersistence({
    scope: scopePersistence,
    message: 'skipped',
    attachmentConfirmation: params.userMessage?.attachmentConfirmation,
  })
  if (params.userMessage) {
    try {
      params.persistUserMessage(scope, params.userMessage)
      persistence = {
        ...persistence,
        message: 'persisted',
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        errorKind: classifySendScopedError(error, 'message'),
        persistence: markUserMessagePersistenceFailed(persistence),
      }
    }
  }

  return params.runConfirmed(scope, persistence)
}

export function resolveAttachmentConfirmation(
  input?: SendScopedAttachmentConfirmationInput | null,
): SendScopedAttachmentConfirmation {
  const selectedCount = Math.max(0, Number(input?.selectedCount || 0))
  const metadataCount = Math.max(0, Number(input?.metadataCount || 0))
  const inputIncludedCount = Math.max(0, Number(input?.inputIncludedCount || 0))
  const inputFailedCount = Math.max(0, Number(input?.inputFailedCount || 0))

  const attachments: SendScopedAttachmentStatus = selectedCount === 0
    ? 'none'
    : metadataCount <= 0
      ? 'metadata_failed'
      : metadataCount < selectedCount
        ? 'metadata_partial'
        : 'metadata_persisted'

  const inputAttachments: SendScopedInputAttachmentStatus = selectedCount === 0
    ? 'none'
    : inputFailedCount > 0 && inputIncludedCount > 0
      ? 'partial'
      : inputFailedCount > 0
        ? 'failed'
        : inputIncludedCount > 0
          ? 'included'
          : 'none'

  return { attachments, inputAttachments }
}

export function createSendScopedPersistence(params: {
  scope: SendScopedScopeStatus
  message?: SendScopedMessageStatus
  attachmentConfirmation?: SendScopedAttachmentConfirmationInput | null
}): SendScopedPersistence {
  const attachment = resolveAttachmentConfirmation(params.attachmentConfirmation)
  return {
    scope: params.scope,
    message: params.message || 'skipped',
    attachments: attachment.attachments,
    inputAttachments: attachment.inputAttachments,
  }
}

export function markUserMessagePersistenceFailed(
  persistence: SendScopedPersistence,
): SendScopedPersistence {
  return {
    ...persistence,
    message: 'failed',
    attachments: persistence.attachments === 'none' ? 'none' : 'metadata_failed',
  }
}

export function classifySendScopedError(
  error: unknown,
  context?: 'scope' | 'message' | 'attachment' | 'run',
): SendScopedErrorKind {
  if (context === 'message') return 'message_persist_failed'
  if (context === 'attachment') return 'attachment_unavailable'
  const message = error instanceof Error ? error.message : String(error || '')
  if (/Conversation scope not found:/i.test(message)) return 'scope_missing'
  if (/Attachment not found:|ENOENT|file not found|readFileForAI/i.test(message)) return 'attachment_unavailable'
  if (/circuit_break|circuit breaker/i.test(message)) return 'circuit_break'
  if (/host_unavailable|host unavailable|ToolHostUnavailableError/i.test(message)) return 'host_unavailable'
  return 'unknown'
}

const SEND_SCOPED_ERROR_KINDS = new Set<SendScopedErrorKind>([
  'scope_missing',
  'message_persist_failed',
  'attachment_unavailable',
  'host_unavailable',
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
])

export function normalizeSendScopedErrorKind(value: unknown): SendScopedErrorKind | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return SEND_SCOPED_ERROR_KINDS.has(trimmed as SendScopedErrorKind)
    ? trimmed as SendScopedErrorKind
    : null
}
