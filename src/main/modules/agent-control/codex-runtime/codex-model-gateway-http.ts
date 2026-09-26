import { CodexModelGatewayError, isRecord, type JsonObject } from './codex-model-gateway-common'
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

function safeTokenEqual(received: string, expected: string): boolean {
  const receivedBuffer = Buffer.from(received)
  const expectedBuffer = Buffer.from(expected)
  return receivedBuffer.length === expectedBuffer.length
    && timingSafeEqual(receivedBuffer, expectedBuffer)
}

export function parseAuthorization(request: IncomingMessage, expected: string): void {
  const authorization = request.headers.authorization || ''
  const prefix = 'Bearer '
  if (!authorization.startsWith(prefix) || !safeTokenEqual(authorization.slice(prefix.length), expected)) {
    throw new CodexModelGatewayError('gateway_bearer_invalid', 401)
  }
}

export async function readJsonBody(
  request: IncomingMessage,
  maxBodyBytes: number,
  signal: AbortSignal,
  deadlineMs: number,
): Promise<JsonObject> {
  const chunks: Buffer[] = []
  let size = 0
  let timedOut = false
  const onAbort = () => {
    if (!request.complete) request.destroy(new Error('gateway_request_aborted'))
  }
  const timeout = setTimeout(() => {
    timedOut = true
    if (!request.complete) request.destroy(new Error('gateway_body_deadline'))
  }, deadlineMs)
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    for await (const chunk of request) {
      if (signal.aborted) throw new CodexModelGatewayError('gateway_spawn_capability_revoked', 401)
      const buffer = Buffer.from(chunk)
      size += buffer.length
      if (size > maxBodyBytes) throw new CodexModelGatewayError('gateway_body_too_large', 413)
      chunks.push(buffer)
    }
  } catch (error) {
    if (error instanceof CodexModelGatewayError) throw error
    if (signal.aborted) throw new CodexModelGatewayError('gateway_spawn_capability_revoked', 401)
    if (timedOut) throw new CodexModelGatewayError('gateway_body_deadline', 408)
    throw error
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', onAbort)
  }
  let parsed: unknown
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    parsed = JSON.parse(decoded)
  } catch (error) {
    if (error instanceof TypeError) throw new CodexModelGatewayError('gateway_body_utf8_invalid')
    throw new CodexModelGatewayError('gateway_body_json_invalid')
  }
  if (!isRecord(parsed)) throw new CodexModelGatewayError('gateway_body_invalid')
  return parsed
}

export async function readBoundedResponseText(input: {
  response: Response
  signal: AbortSignal
  deadlineMs: number
  maxBytes?: number
}): Promise<string> {
  const { response, signal, deadlineMs, maxBytes = 16_384 } = input
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let timeout: ReturnType<typeof setTimeout> | null = null
  let onAbort: (() => void) | null = null
  let aborted = false
  let deadlineExpired = false
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      aborted = true
      reject(new CodexModelGatewayError('gateway_request_aborted', 499))
      void reader.cancel().catch(() => undefined)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    timeout = setTimeout(() => {
      deadlineExpired = true
      reject(new CodexModelGatewayError('gateway_upstream_error_body_deadline', 502))
      void reader.cancel().catch(() => undefined)
    }, deadlineMs)
  })
  try {
    if (signal.aborted) throw new CodexModelGatewayError('gateway_request_aborted', 499)
    while (true) {
      const next = await Promise.race([reader.read(), interrupted])
      if (deadlineExpired) {
        throw new CodexModelGatewayError('gateway_upstream_error_body_deadline', 502)
      }
      if (aborted) throw new CodexModelGatewayError('gateway_request_aborted', 499)
      if (next.done) break
      size += next.value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        return ''
      }
      chunks.push(next.value)
    }
  } finally {
    if (timeout) clearTimeout(timeout)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
  const combined = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(combined)
}

export function sendError(response: ServerResponse, error: unknown): void {
  const gatewayError = error instanceof CodexModelGatewayError
    ? error
    : new CodexModelGatewayError('gateway_request_unbound', 409)
  if (response.headersSent) {
    response.end()
    return
  }
  response.writeHead(gatewayError.status, {
    'content-type': 'application/json',
    ...gatewayError.responseHeaders,
  })
  response.end(JSON.stringify({
    error: gatewayError.responseError,
  }))
}
