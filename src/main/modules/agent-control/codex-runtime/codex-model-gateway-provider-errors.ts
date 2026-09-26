import { CodexModelGatewayError, isRecord, type JsonObject } from './codex-model-gateway-common'
import type { CodexModelGatewayFailureEvidence } from './codex-model-gateway-contract'

export function sanitizedProviderError(text: string, credential: string): {
  code: string
  message: string
  type: string
} | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const source = isRecord(parsed.error) ? parsed.error : parsed
  const sanitize = (value: unknown): string | null => {
    if (typeof value !== 'string' || !value) return null
    const withoutCredential = credential ? value.split(credential).join('[REDACTED]') : value
    return withoutCredential
      .replace(/Bearer\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+)/gi, 'Bearer [REDACTED]')
      .slice(0, 512)
  }
  const code = sanitize(source.code)
  const type = sanitize(source.type)
  const message = sanitize(source.message)
  if (!code && !type && !message) return null
  return {
    code: code || 'gateway_upstream_error',
    type: type || 'upstream_error',
    message: message || code || type || 'gateway_upstream_error',
  }
}

export function sanitizeProviderText(value: string, credential: string): string {
  const withoutCredential = credential ? value.split(credential).join('[REDACTED]') : value
  return withoutCredential.replace(
    /Bearer\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+)/gi,
    'Bearer [REDACTED]',
  )
}

export function assertNativeProviderIdentitySafe(payload: JsonObject, credential: string): void {
  const assertSafe = (value: unknown): void => {
    if (typeof value !== 'string') return
    if ((credential && value.includes(credential)) || /Bearer\s+/i.test(value)) {
      throw new CodexModelGatewayError('gateway_provider_credential_in_identity', 502)
    }
  }
  assertSafe(payload.type)
  assertSafe(payload.item_id)
  const inspectItem = (item: unknown): void => {
    if (!isRecord(item)) return
    for (const key of ['type', 'id', 'name', 'call_id', 'role', 'phase', 'status']) assertSafe(item[key])
  }
  inspectItem(payload.item)
  if (isRecord(payload.response)) {
    for (const key of ['id', 'model', 'status']) assertSafe(payload.response[key])
    if (Array.isArray(payload.response.output)) payload.response.output.forEach(inspectItem)
  }
}

function assertNativeProviderCredentialAbsent(value: unknown, credential: string): void {
  if (typeof value === 'string') {
    if ((credential && value.includes(credential)) || /Bearer\s+(?!\[REDACTED\])/i.test(value)) {
      throw new CodexModelGatewayError('gateway_provider_credential_unredacted', 502)
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => assertNativeProviderCredentialAbsent(entry, credential))
    return
  }
  if (isRecord(value)) {
    Object.entries(value).forEach(([key, entry]) => {
      assertNativeProviderCredentialAbsent(key, credential)
      assertNativeProviderCredentialAbsent(entry, credential)
    })
  }
}

function redactNativeItem(item: JsonObject, credential: string): JsonObject {
  return {
    ...item,
    ...(typeof item.arguments === 'string'
      ? { arguments: sanitizeProviderText(item.arguments, credential) } : {}),
    ...(Array.isArray(item.content) ? {
      content: item.content.map((part) => {
        if (!isRecord(part)) return part
        if (part.type === 'refusal' && typeof part.refusal === 'string') {
          return { ...part, refusal: sanitizeProviderText(part.refusal, credential) }
        }
        return typeof part.text === 'string'
          ? { ...part, text: sanitizeProviderText(part.text, credential) }
          : part
      }),
    } : {}),
    ...(Array.isArray(item.summary) ? {
      summary: item.summary.map((part) => isRecord(part) && typeof part.text === 'string'
        ? { ...part, text: sanitizeProviderText(part.text, credential) }
        : part),
    } : {}),
  }
}

export function redactNativeProviderEvent(
  payload: JsonObject,
  credential: string,
  deferDelta = false,
): JsonObject {
  if (payload.type === 'error') {
    const safeError: JsonObject = {
      type: 'error',
      code: payload.code === null
        ? null
        : sanitizeProviderText(String(payload.code), credential).slice(0, 512),
      message: sanitizeProviderText(String(payload.message), credential).slice(0, 512),
      param: payload.param === null
        ? null
        : sanitizeProviderText(String(payload.param), credential).slice(0, 512),
      sequence_number: payload.sequence_number,
    }
    assertNativeProviderCredentialAbsent(safeError, credential)
    return safeError
  }
  const safePayload: JsonObject = {
    ...payload,
    ...(typeof payload.delta === 'string'
      ? { delta: deferDelta ? '' : sanitizeProviderText(payload.delta, credential) } : {}),
    ...(typeof payload.text === 'string'
      ? { text: sanitizeProviderText(payload.text, credential) } : {}),
    ...(typeof payload.refusal === 'string'
      ? { refusal: sanitizeProviderText(payload.refusal, credential) } : {}),
    ...(typeof payload.arguments === 'string'
      ? { arguments: sanitizeProviderText(payload.arguments, credential) } : {}),
    ...(isRecord(payload.part) && typeof payload.part.text === 'string'
      ? { part: { ...payload.part, text: sanitizeProviderText(payload.part.text, credential) } }
      : isRecord(payload.part) && typeof payload.part.refusal === 'string'
        ? { part: { ...payload.part, refusal: sanitizeProviderText(payload.part.refusal, credential) } }
        : {}),
    ...(isRecord(payload.item) ? { item: redactNativeItem(payload.item, credential) } : {}),
    ...(isRecord(payload.response) ? {
      response: {
        ...payload.response,
        ...(Array.isArray(payload.response.output)
          ? { output: payload.response.output.map((item) => isRecord(item) ? redactNativeItem(item, credential) : item) }
          : {}),
      },
    } : {}),
  }
  if (payload.type === 'response.failed' && isRecord(payload.response) && isRecord(payload.response.error)) {
    const error = sanitizedProviderError(JSON.stringify({ error: payload.response.error }), credential)
    const safeResponse = safePayload.response as JsonObject
    const safeFailure = {
      ...safePayload,
      response: {
        ...safeResponse,
        error: error || {
          code: 'gateway_upstream_error',
          type: 'upstream_error',
          message: 'gateway_upstream_error',
        },
      },
    }
    assertNativeProviderCredentialAbsent(safeFailure, credential)
    return safeFailure
  }
  assertNativeProviderCredentialAbsent(safePayload, credential)
  return safePayload
}

export function safeProviderHeader(
  value: string | null,
  credential: string,
  kind: 'request_id' | 'retry_after',
): string | null {
  if (!value || /[\r\n\0]/.test(value) || value.length > 256) return null
  if ((credential && value.includes(credential)) || /Bearer\s+/i.test(value)) return null
  if (kind === 'request_id') return /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value) ? value : null
  if (/^\d{1,10}$/.test(value)) return value
  return Number.isFinite(Date.parse(value)) ? value : null
}

export function gatewayFailureClass(code: string): CodexModelGatewayFailureEvidence['failureClass'] {
  if (/context|token|too_large|limit_exceeded/.test(code)) return 'context'
  if (/provider|upstream_http|upstream_output|stream_error/.test(code)) return 'provider'
  if (/invalid|mismatch|duplicate|changed|forbidden|missing|after_terminal/.test(code)) return 'protocol'
  return 'transport'
}

export function gatewayFailureEvidence(input: {
  code: string
  stage: CodexModelGatewayFailureEvidence['failureStage']
  responseIdentitySeen: boolean
  partialAssistantItemSeen: boolean
  toolCallItemSeen: boolean
  startedAtMs: number
  eventCount: number
  wireByteCount: number
}): CodexModelGatewayFailureEvidence {
  return {
    failureClass: gatewayFailureClass(input.code),
    failureStage: input.stage,
    responseIdentitySeen: input.responseIdentitySeen,
    partialAssistantItemSeen: input.partialAssistantItemSeen,
    toolCallItemSeen: input.toolCallItemSeen,
    elapsedMs: Math.max(0, Date.now() - input.startedAtMs),
    eventCount: input.eventCount,
    wireByteCount: input.wireByteCount,
    causeCode: /^[a-z][a-z0-9_]{2,95}$/.test(input.code)
      ? input.code
      : 'gateway_stream_failed',
  }
}
