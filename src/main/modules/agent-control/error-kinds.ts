/**
 * Stage U (PR 1) — central registry of `errorKind` string literals used by
 * domain tool handlers in the `agent_interaction` group (ask_user_questions)
 * and provider request paths.
 *
 * Distinct from `tool-error-metrics.ts`:
 *   - `TOOL_ERROR_METRICS` is the registry of **metric names**
 *     (snake_case strings passed to `logAgentMetric`).
 *   - This file is the registry of **errorKind values**
 *     (snake_case strings passed as `ToolDomainError`'s first arg /
 *     `ToolExecutionOutput.errorKind`). They feed the dispatch contract
 *     (§6.11) and the renderer's `agent:error` IPC envelope.
 *
 * Why they are separate:
 *   - A single errorKind may emit zero, one, or several metrics depending
 *     on the path it surfaces through.
 *   - A metric may be emitted from non-error sites too (e.g. a success-side
 *     counter), so it cannot be modeled as "the errorKind that triggered me".
 *
 * Each entry carries:
 *   - `code` (the string literal — KEEP STABLE across renames)
 *   - `metricName?` — when present, the matching `TOOL_ERROR_METRICS.<key>`
 *     value (the snake_case metric string) so the CI gate
 *     `check-ask-user-error-kinds-registered.cjs` can verify mapping.
 *   - `noMetric?: true` — when set, declares the errorKind intentionally
 *     does not emit a metric (e.g. terminal abort already counted elsewhere).
 *     The gate accepts either `metricName` or `noMetric: true` — but never
 *     both, and never neither.
 *
 * Anything thrown from `ask_user_questions` / cancel handler / provider
 * adapter that lands as an `errorKind` MUST be listed here. The gate scans
 * the source files in `scripts/check-ask-user-error-kinds-registered.cjs`
 * and fails CI if a literal slips through.
 */

export interface ErrorKindMeta {
  readonly code: string
  readonly metricName?: string
  readonly noMetric?: true
  readonly description: string
}

// ---------- ask_user_questions ----------

export const ASK_USER_ERROR_KINDS = {
  /** Server-side re-validation of submitted answers failed (missing required,
   *  single_choice answer outside options, etc.). Thrown from submit IPC. */
  inputValidation: {
    code: 'input_validation',
    noMetric: true,
    description: 'submit IPC reject — answers did not pass server-side schema/business validation',
  },
  /** Generic persistence failure: DB throw (e.g. SQLITE_BUSY) during update
   *  or insert. recoverable=true on the IPC envelope; caller may retry. */
  persistenceFailed: {
    code: 'persistence_failed',
    metricName: 'ask_user_questions_submit_db_failed',
    description: 'DB write threw (transient). In-memory pending preserved; user may retry.',
  },
  /** `updateChatMessageMeta` returned false → the card row no longer exists
   *  (already swept / never persisted). The in-memory Promise MUST be
   *  rejected so the tool handler stops awaiting; renderer marks the card
   *  locally as cancelled(card_row_missing). */
  waitingTaskGone: {
    code: 'waiting_task_gone',
    metricName: 'ask_user_questions_submit_db_failed',
    description: 'DB row missing or session already gone — in-memory Promise terminated, card locally cancelled.',
  },
  /** DB write of `submitted` succeeded but `store.resolve(cardId, ...)` returned
   *  false (race: handler already timed out / aborted before resolve landed).
   *  Submit IPC rolls back the DB row to cancelled(card_resolver_missed). */
  cardResolverMissed: {
    code: 'card_resolver_missed',
    metricName: 'ask_user_questions_submit_resolver_missed',
    description: 'DB write succeeded but waiting Promise was already gone; DB row rolled back.',
  },
  /** A new pending card is requested while the same session already has one
   *  in flight. The model must wait for the user to finish before issuing
   *  another reflection. */
  overlappingCard: {
    code: 'overlapping_card',
    noMetric: true,
    description: 'Session already has a pending ask_user_questions card.',
  },
  /** Cancel reason was `user_typed_instead` — the user sent a new message
   *  rather than answering the card; surfaced as "user replied with prose". */
  userSkipped: {
    code: 'user_skipped',
    noMetric: true,
    description: 'User typed a new message instead of selecting card options.',
  },
  /** Explicit user cancel via the card's skip button. */
  userCancelled: {
    code: 'user_cancelled',
    noMetric: true,
    description: 'User clicked the card cancel/skip button.',
  },
  /** AbortSignal fired — usually a session reset or scope switch. */
  aborted: {
    code: 'aborted',
    noMetric: true,
    description: 'Handler abort signal triggered (session reset / scope teardown).',
  },
  /** No answer within the 24h handler timeout. */
  timeout: {
    code: 'timeout',
    noMetric: true,
    description: 'No user response within the configured timeoutMs (default 24h).',
  },
  /** Cancel IPC: in-memory store.reject succeeded but DB write failed.
   *  Returned as IPC envelope `errorKind` (not via ToolDomainError, since the
   *  Promise is already rejected with userCancelled/userSkipped). Renderer
   *  must locally fold the card to `cancelled(cancel_persist_failed)` so the
   *  UI doesn't keep showing pending. Boot sweep cleans up the DB residue. */
  cancelPersistFailed: {
    code: 'cancel_persist_failed',
    metricName: 'ask_user_questions_cancel_persist_failed',
    description: 'Cancel store-reject succeeded but DB write failed; renderer folds card locally.',
  },
} as const satisfies Record<string, ErrorKindMeta>

export type AskUserErrorKindKey = keyof typeof ASK_USER_ERROR_KINDS
export type AskUserErrorKind = (typeof ASK_USER_ERROR_KINDS)[AskUserErrorKindKey]['code']

// ---------- provider request adapter ----------

export const PROVIDER_ERROR_KINDS = {
  /** Provider request could not be safely constructed or sent. PR 3 uses this
   *  for current-turn media mismatch and manual thinking-mode mismatch. */
  providerRequestFailed: {
    code: 'provider_request_failed',
    metricName: 'provider_thinking_echo_unsupported',
    description: 'Provider request blocked before network I/O due to unsupported or unverified request capability.',
  },
  /** Provider returned a 400 that explicitly asks for multi-turn thinking
   *  content to be preserved / echoed. */
  providerThinkingEchoRequired: {
    code: 'provider_thinking_echo_required',
    metricName: 'provider_thinking_echo_required_400',
    description: 'Provider 400 indicates missing reasoning_content / extended thinking echo.',
  },
} as const satisfies Record<string, ErrorKindMeta>

export type ProviderErrorKindKey = keyof typeof PROVIDER_ERROR_KINDS
export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[ProviderErrorKindKey]['code']

// ---------- helpers ----------

const ALL_REGISTERED_CODES: ReadonlySet<string> = new Set<string>([
  ...Object.values(ASK_USER_ERROR_KINDS).map((m) => m.code),
  ...Object.values(PROVIDER_ERROR_KINDS).map((m) => m.code),
])

/** True iff `kind` is a registered errorKind in either group. */
export function isRegisteredErrorKind(kind: string): boolean {
  return ALL_REGISTERED_CODES.has(kind)
}

/** Lookup the meta record for an errorKind code; null when unregistered. */
export function lookupErrorKindMeta(code: string): ErrorKindMeta | null {
  for (const meta of Object.values(ASK_USER_ERROR_KINDS)) {
    if (meta.code === code) return meta
  }
  for (const meta of Object.values(PROVIDER_ERROR_KINDS)) {
    if (meta.code === code) return meta
  }
  return null
}
