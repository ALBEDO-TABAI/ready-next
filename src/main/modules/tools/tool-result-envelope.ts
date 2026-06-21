/**
 * Tool result envelope (EP1-T4-1). Pure mapping layer — NOT wired into
 * dispatch here (T4-2 does that additively). Translates the existing
 * open-ended `errorKind` (tool-errors.ts) into an action-oriented `kind`
 * designed around "what should happen next" (07 §3.1), so the model reacts
 * correctly: re-read schema (arg_error), re-auth (auth_expired), stop retrying
 * (rate_limited / denied_*), etc.
 */

import {
  ACTION_CONFIRMATION_ERROR_KINDS,
  MCP_TOOL_ERROR_KINDS,
  TOOL_ADMISSION_ERROR_KINDS,
  WEB_RESEARCH_ERROR_KINDS,
} from '../agent-control/contracts/error-kinds'

export type ToolEnvelopeKind =
  | 'ok'
  | 'arg_error'
  | 'auth_expired'
  | 'rate_limited'
  | 'not_found'
  | 'upstream_error'
  | 'network_error'
  | 'denied_by_policy'
  | typeof TOOL_ADMISSION_ERROR_KINDS.deniedByUserNegation.code
  | 'internal_error'

export interface ToolResultEnvelope {
  ok: boolean
  kind: ToolEnvelopeKind
  data?: unknown
  error?: {
    message: string
    hint?: string
    retryAfterSec?: number
  }
  meta?: {
    elapsedMs?: number
    cacheState?: string
  }
}

/**
 * Explicit map of every `errorKind` literal present in HEAD (harvested from
 * tool-errors.ts + tools/ + agent-control/). New kinds fall through to the
 * pattern matcher, then to `internal_error` with `mapped: false` so the
 * caller can warn instead of silently mis-bucketing.
 */
const EXPLICIT_KIND_MAP: Record<string, ToolEnvelopeKind> = {
  // arg_error — caller should fix arguments / re-read schema
  input_validation: 'arg_error',
  command_empty: 'arg_error',
  command_parse_failed: 'arg_error',
  config_patch_invalid_pointer: 'arg_error',
  no_payload: 'arg_error',
  detached_task_hint_required: 'arg_error',
  target_document_required: 'arg_error',
  target_document_preserved_content_missing: 'arg_error',
  scope_missing: 'arg_error',
  // auth_expired — caller should re-authenticate / guide user to settings
  clip_login_required: 'auth_expired',
  decrypt_unavailable: 'auth_expired',
  // rate_limited — backpressure; stop hammering, retry later
  queued_global_concurrency: 'rate_limited',
  // not_found — target does not exist
  not_found: 'not_found',
  no_record: 'not_found',
  widget_not_found: 'not_found',
  detached_task_not_found: 'not_found',
  [MCP_TOOL_ERROR_KINDS.toolUnregistered.code]: 'not_found',
  [TOOL_ADMISSION_ERROR_KINDS.toolNotRegistered.code]: 'not_found',
  no_driver_registered: 'not_found',
  detached_task_skill_not_loaded: 'not_found',
  detached_task_skill_action_unknown: 'not_found',
  // upstream_error — a dependency/service is down or failed
  host_unavailable: 'upstream_error',
  [MCP_TOOL_ERROR_KINDS.clientMissing.code]: 'upstream_error',
  [MCP_TOOL_ERROR_KINDS.toolFailed.code]: 'upstream_error',
  clip_fetch_failed: 'upstream_error',
  [WEB_RESEARCH_ERROR_KINDS.webSearchFailed.code]: 'upstream_error',
  [WEB_RESEARCH_ERROR_KINDS.webFetchFailed.code]: 'upstream_error',
  present_file_failed: 'upstream_error',
  target_document_open_unavailable: 'upstream_error',
  target_document_save_unavailable: 'upstream_error',
  target_document_open_failed: 'upstream_error',
  target_document_save_failed: 'upstream_error',
  detached_task_runtime_unavailable: 'upstream_error',
  driver_init_failed: 'upstream_error',
  driver_observe_failed: 'upstream_error',
  driver_plan_failed: 'upstream_error',
  launch_stuck: 'upstream_error',
  // network_error — transport-level failure
  timeout: 'network_error',
  // denied_by_policy — authorization / safety gate refused
  [TOOL_ADMISSION_ERROR_KINDS.authorizationDenied.code]: 'denied_by_policy',
  [TOOL_ADMISSION_ERROR_KINDS.toolRestrictedThisTurn.code]: 'denied_by_policy',
  [TOOL_ADMISSION_ERROR_KINDS.internalToolNotAllowed.code]: 'denied_by_policy',
  [TOOL_ADMISSION_ERROR_KINDS.deniedByUserNegation.code]: 'denied_by_policy',
  [MCP_TOOL_ERROR_KINDS.authorizationDenied.code]: 'denied_by_policy',
  detached_task_forbidden: 'denied_by_policy',
  blocked_config: 'denied_by_policy',
  blocked_external: 'denied_by_policy',
  command_high_risk_blocked: 'denied_by_policy',
  [ACTION_CONFIRMATION_ERROR_KINDS.deniedManualOnly.code]: 'denied_by_policy',
  freeform_script_denied: 'denied_by_policy',
  [ACTION_CONFIRMATION_ERROR_KINDS.deniedPendingConfirmation.code]: 'denied_by_policy',
  [ACTION_CONFIRMATION_ERROR_KINDS.confirmationDeniedByUser.code]: 'denied_by_policy',
  [ACTION_CONFIRMATION_ERROR_KINDS.confirmationExpired.code]: 'denied_by_policy',
  nested_child_run: 'denied_by_policy',
  detached_task_visibility_internal: 'denied_by_policy',
  path_outside_outputs: 'denied_by_policy',
  child_run_circuit_breaker_open: 'denied_by_policy',
  // internal_error — our bug / lifecycle; not the model's to fix
  aborted: 'internal_error',
  tool_handler_failure: 'internal_error',
  tool_failed: 'internal_error',
  runner_uncaught: 'internal_error',
  persistence_failed: 'internal_error',
  repository_create_failed: 'internal_error',
  repository_update_failed: 'internal_error',
  handoff_completion_failed: 'internal_error',
  handoff_agent_context_missing: 'internal_error',
  detached_task_start_failed: 'internal_error',
  process_restarted: 'internal_error',
  checkpoint_background: 'internal_error',
  checkpoint_budget: 'internal_error',
  cancelled_user: 'internal_error',
  failed_skill: 'internal_error',
  not_resumable: 'internal_error',
  primitive_no_skill_context: 'internal_error',
  card_resolver_missed: 'internal_error',
}

/** Pattern fallback for kinds not in the explicit table (future tools). */
const PATTERN_MAP: ReadonlyArray<readonly [RegExp, ToolEnvelopeKind]> = [
  [/validation|invalid|required|parse|schema|arg|empty/, 'arg_error'],
  [/login|auth|credential|token|decrypt|unauthorized|forbidden_auth|401|403/, 'auth_expired'],
  [/rate|throttle|too_many|429|concurrency/, 'rate_limited'],
  [/not_found|unregistered|no_record|not_loaded|unknown|missing|404/, 'not_found'],
  [/timeout|network|econn|socket|dns/, 'network_error'],
  [/unavailable|host|upstream|driver|fetch_failed|stuck|502|503|504/, 'upstream_error'],
  [/denied|forbidden|restricted|blocked|policy|high_risk|outside_outputs/, 'denied_by_policy'],
]

export interface MappedEnvelopeKind {
  kind: ToolEnvelopeKind
  /** false → fell through to internal_error; caller should warn (telemetry). */
  mapped: boolean
}

export function mapErrorKindToEnvelopeKind(errorKind: string): MappedEnvelopeKind {
  const explicit = EXPLICIT_KIND_MAP[errorKind]
  if (explicit) return { kind: explicit, mapped: true }
  for (const [pattern, kind] of PATTERN_MAP) {
    if (pattern.test(errorKind)) return { kind, mapped: true }
  }
  return { kind: 'internal_error', mapped: false }
}

/** Assemble a success envelope. */
export function buildOkEnvelope(
  data?: unknown,
  meta?: ToolResultEnvelope['meta'],
): ToolResultEnvelope {
  return { ok: true, kind: 'ok', ...(data !== undefined ? { data } : {}), ...(meta ? { meta } : {}) }
}

/** Assemble an error envelope from an errorKind + message (+ optional hint/meta). */
export function buildErrorEnvelope(params: {
  errorKind: string
  message: string
  hint?: string
  retryAfterSec?: number
  meta?: ToolResultEnvelope['meta']
}): ToolResultEnvelope {
  const { kind } = mapErrorKindToEnvelopeKind(params.errorKind)
  const error: NonNullable<ToolResultEnvelope['error']> = { message: params.message }
  if (params.hint) error.hint = params.hint
  if (typeof params.retryAfterSec === 'number') error.retryAfterSec = params.retryAfterSec
  return { ok: false, kind, error, ...(params.meta ? { meta: params.meta } : {}) }
}

const ENVELOPE_MESSAGE_MAX_CHARS = 400

/**
 * EP1-T4-2 — derive the envelope for one finished tool output at the dispatch
 * exit (`executeToolCall`). Pure and structural (no ToolExecutionOutput import
 * — keeps this module dependency-free).
 *
 * Discipline:
 *   - `data.errorKind` (the established error convention) decides ok vs error.
 *   - Error messages enter the envelope as a SINGLE clipped line — prefer the
 *     structured `data.message`, fall back to the first line of the legacy
 *     text. Multi-section diagnostics (subprocess STDOUT/STDERR dumps, log
 *     artifact pointers) stay in the legacy fields only.
 *   - Ok envelopes carry NO payload duplicate in phase 1: the envelope is the
 *     protocol header; the payload remains in the legacy text/data fields.
 */
export function deriveEnvelopeForToolOutput(output: {
  text: string
  data: Record<string, unknown> | null
}): ToolResultEnvelope {
  const explicitErrorKind = output.data && typeof output.data.errorKind === 'string' && output.data.errorKind
    ? output.data.errorKind
    : null
  // Skill child gateway (and other structured results) signal failure with
  // `data.ok === false` and no errorKind — without this fallback those would
  // mislabel as ok envelopes.
  const errorKind = explicitErrorKind
    ?? (output.data && output.data.ok === false ? 'tool_failed' : null)
  if (!errorKind) {
    return buildOkEnvelope()
  }
  const structuredMessage = output.data && typeof output.data.message === 'string' && output.data.message.trim()
    ? output.data.message
    : null
  const source = structuredMessage ?? output.text ?? ''
  const firstLine = source.split('\n', 1)[0].trim()
  const message = (firstLine || 'tool failed').slice(0, ENVELOPE_MESSAGE_MAX_CHARS)
  // Legacy admission denials overload `host_unavailable` with a `reason`
  // (e.g. tool_restricted_this_turn) — that is a policy refusal, not an
  // upstream outage. Prefer the reason when it maps cleanly, so the model
  // stops retrying instead of treating it as a transient dependency failure.
  let kindSource = errorKind
  if (errorKind === 'host_unavailable' && output.data && typeof output.data.reason === 'string') {
    const viaReason = mapErrorKindToEnvelopeKind(output.data.reason)
    if (viaReason.mapped) kindSource = output.data.reason
  }
  return buildErrorEnvelope({ errorKind: kindSource, message })
}
