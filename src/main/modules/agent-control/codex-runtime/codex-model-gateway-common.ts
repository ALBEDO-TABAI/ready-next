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

export function assertExactKeys(value: JsonObject, allowed: readonly string[], code: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new CodexModelGatewayError(code, 502)
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
