/**
 * Stage X2.2 — ProviderTerminalError classifier.
 *
 * Per plan §7.2 (docs/superpowers/plans/2026-05-22-X-trust-foundation-and-w5-recovery-implementation.md)
 * every provider error gets a typed `ProviderTerminalError`. This is a
 * NEW concern alongside the legacy `ExecutionErrorKind` in
 * `error-classifier.ts`:
 *
 *   - `ExecutionErrorKind` is a retry/fallback policy classifier used by
 *     the SDK runtime's resilience layer (rate_limit / context_overflow /
 *     timeout_model / timeout_tool / auth / transient / host_unavailable /
 *     unknown). It collapses 402 onto generic "unknown" because the
 *     resilience layer does not differentiate "no funds" from "API
 *     accepts request but fails for unknown reason".
 *
 *   - `ProviderTerminalCode` is the USER-RECOVERY classifier described in
 *     plan §7.2: 11 codes that map 1-to-1 onto distinct user-facing toast
 *     copy + composer-unlock policy (e.g. quota_exceeded deep-links to
 *     Settings; rate_limited shows a countdown; provider_thinking_echo
 *     auto-retries; context_overflow suggests /compact). The renderer's
 *     runtime driver consumes this when surfacing the terminal failure
 *     to the user.
 *
 * The classifier is a PURE function of
 * (httpStatus?, errorBody?, signal?, retryAfterSeconds?). Same input ⇒
 * same output. No side effects.
 */

export type ProviderTerminalCode =
  | 'quota_exceeded'                   // 402, 429-with-quota signal
  | 'auth_required'                    // 401, 403
  | 'rate_limited'                     // 429 without quota signal, retry-after present
  | 'invalid_request'                  // 400, 422
  | 'context_overflow'                 // 400 with context-length body marker, or 413
  | 'timeout_model'                    // client-side stream timeout
  | 'timeout_tool'                     // tool execution exceeded budget
  | 'transient'                        // 408, 425, 500, 502, 503, 504, ECONNRESET, EAI_AGAIN
  | 'provider_thinking_echo_required'  // provider rejects request lacking prior thinking blocks
  | 'network'                          // DNS / TLS / connection refused
  | 'unknown'                          // unrecognized

export interface ProviderTerminalError {
  code: ProviderTerminalCode
  httpStatus?: number
  providerMessage: string
  /**
   * Only set when `code === 'rate_limited'`. Renderer countdown toast
   * derives the wait window from this value (default 30s when the
   * provider omits the header).
   */
  retryAfterSeconds?: number
}

export interface ClassifyProviderErrorInput {
  httpStatus?: number
  errorBody?: string
  signal?: string
  retryAfterSeconds?: number
}

// ---------------------------------------------------------------------------
// Body-level marker patterns
// ---------------------------------------------------------------------------

const QUOTA_BODY_MARKERS = /(quota_exceeded|insufficient[\s_-]*(balance|funds|credits|quota)|monthly[\s_-]*quota|exceeded[\s_-]*(your[\s_-]*)?quota|billing|payment[\s_-]*required|hard[\s_-]*limit)/i

const CONTEXT_OVERFLOW_BODY_MARKERS = /(context[\s_-]*(length|window)|maximum[\s_-]*context|prompt[\s_-]*is[\s_-]*too[\s_-]*long|too[\s_-]*many[\s_-]*tokens|context_length_exceeded)/i

const AUTH_BODY_MARKERS = /(invalid[\s_-]*api[\s_-]*key|invalid_api_key|api[\s_-]*key[\s_-]*(revoked|missing|expired)|unauthorized|forbidden|permission_denied)/i

const THINKING_ECHO_BODY_MARKERS = /(thinking[\s_-]*block|extended[\s_-]*thinking|reasoning[\s_-]*replay|prior[\s_-]*thinking)/i

const NETWORK_BODY_MARKERS = /(enotfound|econnrefused|getaddrinfo[\s\S]*(enotfound|eai_again)?|unable[\s_-]*to[\s_-]*verify[\s_-]*(the[\s_-]*)?(first[\s_-]*)?certificate|tls|self[\s_-]*signed[\s_-]*certificate|ssl_error|hostname[\s_-]*mismatch|connection[\s_-]*refused|dns)/i

const TRANSIENT_BODY_MARKERS = /(econnreset|socket[\s_-]*hang[\s_-]*up|eai_again|epipe|etimedout)/i

/** Request/rate-limit statuses that are retryable outside the generic 5xx range. */
export const PROVIDER_EXPLICIT_RETRY_STATUS_CODES = [408, 425, 429] as const

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeBody(input: ClassifyProviderErrorInput): string {
  return input.errorBody ? String(input.errorBody) : ''
}

export function isTransientProviderHttpStatus(status: number | null | undefined): boolean {
  if (status === 408 || status === 425) return true
  if (status === null || status === undefined || status < 500 || status > 599) return false
  // 501/505 describe a protocol or capability mismatch. Replaying the same
  // request cannot repair either condition; every other gateway/server 5xx is
  // treated as transient, including Cloudflare's 520–524 range.
  return status !== 501 && status !== 505
}

export function isRetryableProviderHttpStatus(status: number | null | undefined): boolean {
  return status === 429 || isTransientProviderHttpStatus(status)
}

// ---------------------------------------------------------------------------
// Public classifier
// ---------------------------------------------------------------------------

export function classifyProviderError(input: ClassifyProviderErrorInput): ProviderTerminalError {
  const body = safeBody(input)
  const httpStatus = typeof input.httpStatus === 'number' ? input.httpStatus : undefined
  const signal = input.signal ? String(input.signal) : ''
  const providerMessage = body || (httpStatus ? `HTTP ${httpStatus}` : signal || 'provider error')

  // 1) Signal-driven (timeouts) — these are client-side; they don't carry
  //    a provider HTTP status, so we check them first.
  if (signal === 'stream-timeout' || /stream[\s_-]*timeout/i.test(signal)) {
    return { code: 'timeout_model', httpStatus, providerMessage }
  }
  if (signal === 'tool-timeout' || /tool[\s_-]*timeout/i.test(signal)) {
    return { code: 'timeout_tool', httpStatus, providerMessage }
  }

  // 2) Network-level errors (DNS / TLS / connection refused). Body match
  //    only — these typically have no HTTP status.
  if (httpStatus === undefined && NETWORK_BODY_MARKERS.test(body)) {
    // ECONNRESET / EAI_AGAIN are transient (the server was reachable),
    // not network (DNS/TLS/refused). Disambiguate by giving network
    // matchers precedence ONLY when no transient marker is present.
    if (!TRANSIENT_BODY_MARKERS.test(body)) {
      return { code: 'network', httpStatus, providerMessage }
    }
  }

  // 3) HTTP-status-driven path. Each branch may further inspect the body
  //    to refine the code (e.g. 400 + context-length body → context_overflow).
  if (httpStatus === 402) {
    return { code: 'quota_exceeded', httpStatus, providerMessage }
  }

  if (httpStatus === 401 || httpStatus === 403) {
    return { code: 'auth_required', httpStatus, providerMessage }
  }

  if (httpStatus === 429) {
    if (QUOTA_BODY_MARKERS.test(body)) {
      return { code: 'quota_exceeded', httpStatus, providerMessage }
    }
    const retryAfterSeconds = typeof input.retryAfterSeconds === 'number' && input.retryAfterSeconds > 0
      ? input.retryAfterSeconds
      : undefined
    return retryAfterSeconds !== undefined
      ? { code: 'rate_limited', httpStatus, providerMessage, retryAfterSeconds }
      : { code: 'rate_limited', httpStatus, providerMessage }
  }

  if (httpStatus === 413) {
    return { code: 'context_overflow', httpStatus, providerMessage }
  }

  if (httpStatus === 400) {
    if (CONTEXT_OVERFLOW_BODY_MARKERS.test(body)) {
      return { code: 'context_overflow', httpStatus, providerMessage }
    }
    if (THINKING_ECHO_BODY_MARKERS.test(body)) {
      return { code: 'provider_thinking_echo_required', httpStatus, providerMessage }
    }
    if (AUTH_BODY_MARKERS.test(body)) {
      return { code: 'auth_required', httpStatus, providerMessage }
    }
    return { code: 'invalid_request', httpStatus, providerMessage }
  }

  if (httpStatus === 422) {
    return { code: 'invalid_request', httpStatus, providerMessage }
  }

  if (isTransientProviderHttpStatus(httpStatus)) {
    return { code: 'transient', httpStatus, providerMessage }
  }

  // 4) Body-level fallbacks for sub-HTTP-status signals (mostly node errno).
  if (TRANSIENT_BODY_MARKERS.test(body)) {
    return { code: 'transient', httpStatus, providerMessage }
  }
  if (NETWORK_BODY_MARKERS.test(body)) {
    return { code: 'network', httpStatus, providerMessage }
  }
  if (CONTEXT_OVERFLOW_BODY_MARKERS.test(body)) {
    return { code: 'context_overflow', httpStatus, providerMessage }
  }
  if (THINKING_ECHO_BODY_MARKERS.test(body)) {
    return { code: 'provider_thinking_echo_required', httpStatus, providerMessage }
  }

  // 5) Default — keep the HTTP status (e.g. 418) so the renderer can
  //    surface a meaningful "unknown HTTP 418" toast.
  return { code: 'unknown', httpStatus, providerMessage }
}

// ---------------------------------------------------------------------------
// Stage X2.2 wiring helpers
// ---------------------------------------------------------------------------

const PROVIDER_TERMINAL_PROPERTY = '__providerTerminal' as const

/**
 * Stamp a classified `ProviderTerminalError` onto an Error instance so
 * downstream consumers (turn-engine catch, emit-runtime-error, renderer
 * driver) can read the structured classification without re-parsing the
 * message string. Property name is intentionally non-enumerable to keep
 * Error serialization compact.
 */
export function attachProviderTerminalError(error: Error, terminal: ProviderTerminalError): Error {
  Object.defineProperty(error, PROVIDER_TERMINAL_PROPERTY, {
    value: terminal,
    enumerable: false,
    configurable: true,
    writable: true,
  })
  return error
}

/**
 * Read a previously-attached `ProviderTerminalError` from an Error
 * instance (or any value). Returns `null` if absent or malformed.
 */
export function readProviderTerminalError(value: unknown): ProviderTerminalError | null {
  if (!value || typeof value !== 'object') return null
  const candidate = (value as { [PROVIDER_TERMINAL_PROPERTY]?: unknown })[PROVIDER_TERMINAL_PROPERTY]
  if (!candidate || typeof candidate !== 'object') return null
  const obj = candidate as Record<string, unknown>
  if (typeof obj.code !== 'string') return null
  if (typeof obj.providerMessage !== 'string') return null
  return obj as unknown as ProviderTerminalError
}

/**
 * Build an Error pre-stamped with the classification derived from an
 * HTTP response. Used at provider fetch boundaries (OpenAI-compatible,
 * Anthropic, etc.) where we already have the raw HTTP status and body.
 *
 * Stage X6.1 — the returned Error also exposes `.status = httpStatus`
 * as a non-enumerable own property so the legacy `withRetryBackoff`
 * retry classifier (`llm-resilience.ts:isRetryableError` reading
 * `error.status`) keeps working when this helper is wired into the
 * legacy clients. Consumers that want the structured classification
 * should call `readProviderTerminalError(error)` instead of reading
 * `.status` directly.
 */
export function buildProviderHttpError(input: {
  httpStatus: number
  errorBody: string
  signal?: string
  retryAfterSeconds?: number
  messagePrefix?: string
}): Error {
  const terminal = classifyProviderError(input)
  const prefix = input.messagePrefix ? `${input.messagePrefix} ` : ''
  const message = `${prefix}HTTP ${input.httpStatus}: ${input.errorBody.slice(0, 300)}`.trim()
  const error = new Error(message)
  Object.defineProperty(error, 'status', {
    value: input.httpStatus,
    enumerable: false,
    configurable: true,
    writable: true,
  })
  return attachProviderTerminalError(error, terminal)
}

/**
 * Parse a `Retry-After` HTTP header value (RFC 7231 §7.1.3) into a
 * seconds count. Returns `undefined` when:
 *   - the header is absent
 *   - the value is neither a positive integer nor a parseable HTTP-date
 *   - the parsed delay is non-positive (already elapsed)
 *
 * Used at provider fetch boundaries to feed `buildProviderHttpError`'s
 * `retryAfterSeconds` so 429 responses with a real wait window get
 * classified as `rate_limited` (with countdown) instead of the unwound
 * `unknown` fallback. Pure function — no side effects.
 */
export function parseRetryAfterHeader(rawValue: string | null | undefined): number | undefined {
  if (!rawValue) return undefined
  const trimmed = String(rawValue).trim()
  if (!trimmed) return undefined
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed)
    return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined
  }
  const httpDateMs = Date.parse(trimmed)
  if (!Number.isFinite(httpDateMs)) return undefined
  const deltaSeconds = Math.ceil((httpDateMs - Date.now()) / 1000)
  return deltaSeconds > 0 ? deltaSeconds : undefined
}
