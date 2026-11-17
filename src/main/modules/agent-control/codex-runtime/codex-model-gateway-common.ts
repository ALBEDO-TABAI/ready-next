export type JsonObject = Record<string, unknown>

export class CodexModelGatewayError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
    readonly responseHeaders: Readonly<Record<string, string>> = {},
    readonly responseError: Readonly<{ code: string; message: string; type: string }> = {
      code,
      message: code,
      type: 'gateway_error',
    },
  ) {
    super(code)
    this.name = 'CodexModelGatewayError'
  }
}

/**
 * Codex drops a model stream after its SSE idle timeout (300s by default) even while the gateway is still
 * reading upstream, e.g. while a long tool call is held until the whole response validates. Codex ignores an
 * unknown event type but counts it as activity, so a downstream that stayed quiet while upstream kept
 * arriving gets one; a stalled upstream gets none and is left to the gateway's own idle policy.
 */
export const CODEX_DOWNSTREAM_KEEPALIVE_MS = 15_000
const CODEX_DOWNSTREAM_KEEPALIVE = 'event: ready.keepalive\ndata: {"type":"ready.keepalive"}\n\n'

export function createCodexDownstream(
  write: (chunk: string) => void,
  keepaliveMs = CODEX_DOWNSTREAM_KEEPALIVE_MS,
): { write(chunk: string): void; upstreamProgressed(): void } {
  let lastWriteAt = Date.now()
  return {
    write(chunk) {
      write(chunk)
      lastWriteAt = Date.now()
    },
    upstreamProgressed() {
      if (Date.now() - lastWriteAt < keepaliveMs) return
      write(CODEX_DOWNSTREAM_KEEPALIVE)
      lastWriteAt = Date.now()
    },
  }
}

export function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function nonEmptyString(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new CodexModelGatewayError(code)
  return value
}

/** Key names an exact-shape check did not expect, kept on the error for the diagnostic log only. */
const unexpectedKeysByError = new WeakMap<Error, readonly string[]>()

export function unexpectedKeysOf(error: unknown): readonly string[] {
  return error instanceof Error ? unexpectedKeysByError.get(error) ?? [] : []
}

export function assertExactKeys(value: JsonObject, allowed: readonly string[], code: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) {
    const error = new CodexModelGatewayError(code, 502)
    unexpectedKeysByError.set(error, unexpected)
    throw error
  }
}

export class CodexModelGatewayChatError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'CodexModelGatewayChatError'
  }
}

export function assertToolArgumentsObject(value: string, code: string): JsonObject {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new CodexModelGatewayChatError(code)
  }
  if (!isRecord(parsed)) throw new CodexModelGatewayChatError(code)
  return parsed
}

export class CodexModelGatewayAuthorityError extends CodexModelGatewayError {
  constructor(code: string, status = 409) {
    super(code, status)
    this.name = 'CodexModelGatewayAuthorityError'
  }
}

/**
 * Whether text carries something shaped like a bearer credential: the word followed by a quoted value or by an
 * unbroken run that is not a plain word (it has a digit or token punctuation). The bare word must pass — a model
 * searching for "ring bearer gifts" or asking what a Bearer token is writes ordinary tool arguments.
 */
export function carriesBearerCredential(value: string): boolean {
  return /Bearer\s+(?:\\?["']|(?=[\w.~+/=-]*[0-9._~+/=-])[\w.~+/=-]{8,})/i.test(value)
}

/** The same shape, as the span to blank out of text shown to the person or returned to the model. */
export const BEARER_CREDENTIAL_SPAN = /Bearer\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|(?=[\w.~+/=-]*[0-9._~+/=-])[\w.~+/=-]{8,})/gi

/**
 * Whether a provider answered with the model that was asked for. An alias is answered under its dated snapshot
 * name ("gpt-4o" -> "gpt-4o-2024-08-06", "claude-sonnet-4-5" -> "claude-sonnet-4-5-20250929"); that is the same
 * model. Anything else is a reroute and stays refused.
 */
export function isRequestedUpstreamModel(answered: unknown, requested: string): boolean {
  if (typeof answered !== 'string' || !requested) return false
  if (answered === requested) return true
  return answered.startsWith(`${requested}-`) && /^(\d{4}-\d{2}-\d{2}|\d{8})$/.test(answered.slice(requested.length + 1))
}

/**
 * A model sometimes calls a tool that is not offered this turn, or with arguments its schema rejects. Failing the
 * whole turn for that throws away everything done so far, when the model can correct itself if told. The runtime
 * answers a call to a name it does not know with "unsupported call: <name>" and keeps the turn going, without
 * the call ever reaching Ready's execution chain. So a refused call is passed on under a name that says why and
 * that no tool has; it is never admitted or executed.
 *
 * Returns the name to pass on, or null when the call is in order.
 */
export function refusedToolCallName(input: {
  name: string
  argumentsObject: unknown
  allowedTools: ReadonlySet<string>
  validators: ReadonlyMap<string, { safeParse(value: unknown): { success: boolean } }>
}): string | null {
  // A turn that offers no tools at all asked for an answer (`tool_choice: none`); a call there is the provider
  // ignoring the request, not a mistake the model can correct, and it fails as before.
  if (input.allowedTools.size === 0) throw new CodexModelGatewayError('gateway_response_tool_not_authorized', 502)
  const reason = !input.allowedTools.has(input.name)
    ? 'unavailable_tool'
    : input.validators.get(input.name)?.safeParse(input.argumentsObject).success ? null : 'invalid_arguments'
  if (!reason) return null
  const renamed = `${reason}__${input.name.replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 64)
  if (input.allowedTools.has(renamed)) throw new CodexModelGatewayError('gateway_response_tool_not_authorized', 502)
  return renamed
}
