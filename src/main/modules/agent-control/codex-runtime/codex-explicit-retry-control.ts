import { parseActionAuthorizationMode } from '../../../../shared/action-authorization-mode'
import type { SendScopedRequest, SendScopedResponse } from '../../../../shared/ipc-contracts/agent-runtime'
import { matchesExactRetryIntent } from '../../../../shared/resume-lexicon'
import { createRejectedBeforePersistence } from '../send-scoped-confirmation'
import { digestCanonicalJson } from './codex-model-gateway-contract'

type ScopeIdentity = {
  id: string
  source_kind: string
  source_id: string
  thread_key: string
  meta_json: string | null
}

const META_KEYS = [
  'actionAuthorizationMode',
  'direction',
  'sourceId',
  'sourceKind',
  'threadKey',
  'workbenchMode',
] as const

export type ValidatedExplicitRetryControl = SendScopedRequest & {
  message: string
  resources?: never
  actionAdmissionRef?: never
  explicitRetry: NonNullable<SendScopedRequest['explicitRetry']>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort()
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
}

function scopeActionMode(scope: ScopeIdentity): 'ask' | 'auto' | 'full' {
  try {
    const meta = JSON.parse(scope.meta_json || '{}') as Record<string, unknown>
    return parseActionAuthorizationMode(meta.actionAuthorizationMode)
  } catch {
    // silent-catch: invalid policy metadata grants only the existing ask default; Retry still validates exact authority.
    return 'ask'
  }
}

export function validateExplicitRetryControl(input: {
  request: SendScopedRequest
  scope: ScopeIdentity | null
}): { ok: true; request: ValidatedExplicitRetryControl } | { ok: false; code: string } {
  const request = input.request
  if (!request.explicitRetry) return { ok: false, code: 'explicit_retry_missing' }
  if (!input.scope || input.scope.id !== request.scopeId) {
    return { ok: false, code: 'explicit_retry_scope_mismatch' }
  }
  if (typeof request.message !== 'string'
    || request.message !== request.userMessage.content
    || !matchesExactRetryIntent(request.message)) {
    return { ok: false, code: 'explicit_retry_control_text_invalid' }
  }
  if (request.resources !== undefined
    || request.actionAdmissionRef !== undefined) {
    return { ok: false, code: 'explicit_retry_resource_present' }
  }
  const counts = request.userMessage.attachmentConfirmation
  if (counts.selectedCount !== 0
    || counts.metadataCount !== 0
    || counts.inputIncludedCount !== 0
    || counts.inputFailedCount !== 0) {
    return { ok: false, code: 'explicit_retry_attachment_count_nonzero' }
  }
  const meta = request.userMessage.meta
  if (!exactKeys(meta, META_KEYS)) return { ok: false, code: 'explicit_retry_meta_invalid' }
  if (meta.sourceKind !== input.scope.source_kind
    || meta.sourceId !== input.scope.source_id
    || meta.threadKey !== input.scope.thread_key
    || meta.direction !== 'local-input'
    || meta.actionAuthorizationMode !== scopeActionMode(input.scope)
    || !['browser', 'document', 'rss', 'calendar'].includes(String(meta.workbenchMode))) {
    return { ok: false, code: 'explicit_retry_scope_meta_mismatch' }
  }
  return { ok: true, request: request as ValidatedExplicitRetryControl }
}

export function preflightExplicitRetryControl(input: {
  request: SendScopedRequest
  scope: ScopeIdentity | null
}): Extract<SendScopedResponse, { disposition: 'rejected_before_persistence' }> | null {
  if (!input.request.explicitRetry) return null
  const validation = validateExplicitRetryControl(input)
  if (validation.ok) return null
  return createRejectedBeforePersistence({
    scope: input.scope ? 'pre-existing' : 'failed',
    code: 'explicit_retry_control_invalid',
    retryableByUser: false,
    error: validation.code,
    admissionEvidenceDigest: digestCanonicalJson({
      contract: 'explicit_retry_control_rejection_v1',
      scopeId: input.request.scopeId,
      requestId: input.request.requestId,
      predecessorRunId: input.request.explicitRetry.predecessorRunId,
      code: validation.code,
    }),
  })
}
