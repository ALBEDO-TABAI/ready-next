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
