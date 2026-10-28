import { isRetryableProviderHttpStatus } from '../../claude-bridge/provider-terminal-error'
import {
  createCodexChatPreSemanticState,
  inspectCodexChatPrefix,
} from './codex-model-gateway-chat-prefix'
import type { CodexUpstreamProfileSnapshot } from './codex-model-gateway-contract'

type JsonObject = Record<string, unknown>

export const READY_GATEWAY_MAX_CONTROLLED_RETRIES = 6

const FULL_JITTER_BASE_DELAY_MS = 500
const FULL_JITTER_MAX_DELAY_MS = 30_000
const MAX_RETRY_AFTER_MS = 120_000
const DEFAULT_PROBE_MAX_BYTES = 256 * 1024
const DEFAULT_PROBE_MAX_EVENTS = 128

export class CodexModelGatewayRetryError extends Error {
  constructor(
    readonly code: string,
    readonly status = 502,
    readonly retryableBeforeOutput = false,
  ) {
    super(code)
    this.name = 'CodexModelGatewayRetryError'
  }
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function retryAfterMs(response: Response | null): number | null {
  const raw = response?.headers.get('retry-after')
  if (!raw) return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS)
  }
  const time = Date.parse(raw)
  return Number.isFinite(time)
    ? Math.max(0, Math.min(time - Date.now(), MAX_RETRY_AFTER_MS))
    : null
}

function fullJitterDelayMs(retryOrdinal: number): number {
  const ceiling = Math.min(
    FULL_JITTER_MAX_DELAY_MS,
    FULL_JITTER_BASE_DELAY_MS * 2 ** (retryOrdinal - 1),
  )
  return Math.floor(Math.random() * (ceiling + 1))
}

export async function waitForControlledGatewayRetry(input: {
  retryOrdinal: number
  response?: Response | null
  signal: AbortSignal
}): Promise<void> {
  if (input.signal.aborted) {
    throw new CodexModelGatewayRetryError('gateway_request_aborted', 499)
  }
  const ms = retryAfterMs(input.response || null) ?? fullJitterDelayMs(input.retryOrdinal)
  if (ms <= 0) return
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout)
      reject(new CodexModelGatewayRetryError('gateway_request_aborted', 499))
    }
    const timeout = setTimeout(() => {
      input.signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    input.signal.addEventListener('abort', onAbort, { once: true })
  })
}

export async function fetchCodexUpstreamWithRetry(input: {
  url: string
  headers: Record<string, string>
  body: JsonObject
  maxRetries: number
  attemptOffset?: number
  signal: AbortSignal
  headersDeadlineMs: number
  onAttempt?: (attempt: number) => void
}): Promise<{ response: Response; retriesUsed: number }> {
  let attempt = 0
  while (true) {
    const attemptController = new AbortController()
    const abortAttempt = () => attemptController.abort()
    input.signal.addEventListener('abort', abortAttempt, { once: true })
    if (input.signal.aborted) abortAttempt()
    let timedOut = false
    let keepAbortLink = false
    try {
      if (input.signal.aborted) {
        throw new CodexModelGatewayRetryError('gateway_request_aborted', 499)
      }
      input.onAttempt?.((input.attemptOffset || 0) + attempt)
      let timeout: ReturnType<typeof setTimeout> | null = null
      const response = await Promise.race([
        fetch(input.url, {
          method: 'POST',
          redirect: 'manual',
          headers: input.headers,
          body: JSON.stringify(input.body),
          signal: attemptController.signal,
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            timedOut = true
            abortAttempt()
            reject(new CodexModelGatewayRetryError('gateway_upstream_headers_deadline', 504))
          }, input.headersDeadlineMs)
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout)
      })
      const retryable = isRetryableProviderHttpStatus(response.status)
      if (!retryable || attempt >= input.maxRetries) {
        keepAbortLink = true
        return { response, retriesUsed: attempt }
      }
      await response.body?.cancel()
      await waitForControlledGatewayRetry({
        retryOrdinal: (input.attemptOffset || 0) + attempt + 1,
        response,
        signal: input.signal,
      })
    } catch (error) {
      if (input.signal.aborted) {
        throw new CodexModelGatewayRetryError('gateway_request_aborted', 499)
      }
      const normalizedError = timedOut
        ? new CodexModelGatewayRetryError('gateway_upstream_headers_deadline', 504)
        : error
      if (attempt >= input.maxRetries) {
        if (normalizedError instanceof CodexModelGatewayRetryError) throw normalizedError
        throw new CodexModelGatewayRetryError('gateway_upstream_transport_failed', 502)
      }
      await waitForControlledGatewayRetry({
        retryOrdinal: (input.attemptOffset || 0) + attempt + 1,
        signal: input.signal,
      })
    } finally {
      if (!keepAbortLink) input.signal.removeEventListener('abort', abortAttempt)
    }
    attempt += 1
  }
}

function parseSseBlocks(buffer: string): { blocks: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, '\n')
  const blocks: string[] = []
  let start = 0
  while (true) {
    const boundary = normalized.indexOf('\n\n', start)
    if (boundary < 0) break
    blocks.push(normalized.slice(start, boundary))
    start = boundary + 2
  }
  return { blocks, rest: normalized.slice(start) }
}

function fieldsFromSseBlock(block: string): { data: string | null; eventName: string | null } {
  const lines = block.split('\n')
  const values = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
  const eventName = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() || null
  return {
    data: values.length > 0 ? values.join('\n') : null,
    eventName,
  }
}

function transientProviderError(value: unknown): boolean {
  if (!isRecord(value)) return false
  const source = isRecord(value.error) ? value.error : value
  const text = [source.code, source.type, source.message, source.status]
    .filter((field): field is string | number => (
      typeof field === 'string' || typeof field === 'number'
    ))
    .join(' ')
    .toLowerCase()
  if (!text) return false
  if (
    /auth|unauthori[sz]ed|forbidden|permission|invalid[_ -]?(request|argument|parameter|api[_ -]?key)|context|token[_ -]?limit|content[_ -]?filter|unsupported|not[_ -]?found/.test(text)
  ) return false
  const explicitStatus = [
    source.status,
    source.status_code,
    source.statusCode,
    source.http_status,
    source.code,
  ].map((candidate) => {
    if (typeof candidate === 'number' && Number.isInteger(candidate)) return candidate
    if (typeof candidate === 'string' && /^\d{3}$/.test(candidate)) return Number(candidate)
    return null
  }).find((candidate): candidate is number => candidate !== null)
  if (explicitStatus !== undefined) return isRetryableProviderHttpStatus(explicitStatus)
  const httpStatus = text.match(/\bhttp\s+(\d{3})\b/i)
  if (httpStatus) return isRetryableProviderHttpStatus(Number(httpStatus[1]))
  return /rate[_ -]?limit|overload|temporar|unavailable|upstream[_ -]?(unavailable|timeout|reset|connection|server[_ -]?error)|server[_ -]?error|timeout|timed[_ -]?out|connection|reset|econn|socket|terminated|暂时|不可用|繁忙|超时|限流/.test(text)
}

function isStandaloneTransientNativeError(
  payload: JsonObject,
  eventName: string | null,
): boolean {
  if (eventName !== 'error' || payload.type !== 'error') return false
  if (Object.keys(payload).some((key) => ![
    'type', 'code', 'message', 'param', 'sequence_number',
  ].includes(key))) return false
  if (
    (payload.code !== null && typeof payload.code !== 'string')
    || typeof payload.message !== 'string'
    || payload.message.length === 0
    || (payload.param !== null && typeof payload.param !== 'string')
    || !Number.isSafeInteger(payload.sequence_number)
    || Number(payload.sequence_number) < 0
  ) return false
  return transientProviderError(payload)
}

function replayBufferedBody(
  chunks: readonly Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  let index = 0
  let released = false
  const release = () => {
    if (released) return
    released = true
    reader.releaseLock()
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index])
        index += 1
        return
      }
      try {
        const next = await reader.read()
        if (next.done) {
          release()
          controller.close()
          return
        }
        controller.enqueue(next.value)
      } catch (error) {
        release()
        controller.error(error)
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason)
      } finally {
        release()
      }
    },
  })
}

export async function prepareCodexUpstreamStreamForControlledRetry(input: {
  body: ReadableStream<Uint8Array>
  wireApi: 'responses' | 'chat/completions' | 'messages'
  snapshot: CodexUpstreamProfileSnapshot
  credential: string
  signal: AbortSignal
  deadlineMs: number
  maxProbeBytes?: number
  maxProbeEvents?: number
}): Promise<ReadableStream<Uint8Array>> {
  const reader = input.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const chunks: Uint8Array[] = []
  let buffer = ''
  let bytes = 0
  let events = 0
  const startedAt = Date.now()
  const maxProbeBytes = input.maxProbeBytes || DEFAULT_PROBE_MAX_BYTES
  const maxProbeEvents = input.maxProbeEvents || DEFAULT_PROBE_MAX_EVENTS
  const chatState = createCodexChatPreSemanticState()

  const cancelAndThrow = async (error: CodexModelGatewayRetryError): Promise<never> => {
    try {
      await reader.cancel()
    } catch {
      // silent-catch: cancel is transport cleanup only; the retry error is thrown right after
      // The retry decision is already final; transport cleanup cannot replace it.
    } finally {
      reader.releaseLock()
    }
    throw error
  }

  while (true) {
    if (input.signal.aborted) {
      return cancelAndThrow(new CodexModelGatewayRetryError('gateway_request_aborted', 499))
    }
    const remaining = input.deadlineMs - (Date.now() - startedAt)
    if (remaining <= 0) {
      return cancelAndThrow(new CodexModelGatewayRetryError(
        'gateway_upstream_stream_pre_output_deadline',
        502,
        true,
      ))
    }
    let timeout: ReturnType<typeof setTimeout> | null = null
    let next: ReadableStreamReadResult<Uint8Array>
    try {
      next = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new CodexModelGatewayRetryError(
            'gateway_upstream_stream_pre_output_deadline',
            502,
            true,
          )), remaining)
        }),
      ])
    } catch (error) {
      // silent-catch: read failures and the probe deadline become a retry error that cancelAndThrow throws
      const retryError = error instanceof CodexModelGatewayRetryError
        ? error
        : new CodexModelGatewayRetryError(
            'gateway_upstream_stream_closed_before_output',
            502,
            true,
          )
      return cancelAndThrow(retryError)
    } finally {
      if (timeout) clearTimeout(timeout)
    }
    if (next.done) {
      try {
        decoder.decode()
      } catch {
        // silent-catch: an invalid UTF-8 tail ends probing; the buffered bytes are replayed downstream unchanged
        return replayBufferedBody(chunks, reader)
      }
      return cancelAndThrow(new CodexModelGatewayRetryError(
        'gateway_upstream_stream_closed_before_output',
        502,
        true,
      ))
    }
    chunks.push(next.value)
    bytes += next.value.byteLength
    if (bytes >= maxProbeBytes) return replayBufferedBody(chunks, reader)
    try {
      buffer += decoder.decode(next.value, { stream: true })
    } catch {
      // silent-catch: bytes that are not valid UTF-8 cannot be probed, so the buffered bytes are replayed unchanged
      return replayBufferedBody(chunks, reader)
    }
    const parsed = parseSseBlocks(buffer)
    buffer = parsed.rest
    for (const block of parsed.blocks) {
      const fields = fieldsFromSseBlock(block)
      const raw = fields.data
      if (!raw) continue
      events += 1
      if (events >= maxProbeEvents) return replayBufferedBody(chunks, reader)
      if (raw === '[DONE]') return replayBufferedBody(chunks, reader)
      let payload: unknown
      try {
        payload = JSON.parse(raw)
      } catch {
        // silent-catch: a non-JSON SSE data payload ends probing; the buffered bytes are replayed unchanged
        return replayBufferedBody(chunks, reader)
      }
      if (!isRecord(payload)) return replayBufferedBody(chunks, reader)
      if (input.wireApi === 'chat/completions') {
        const inspection = inspectCodexChatPrefix({
          parsedPayload: payload,
          snapshot: input.snapshot,
          credential: input.credential,
          state: chatState,
        })
        if (inspection.kind === 'neutral') continue
        if (
          inspection.kind !== 'provider_error'
          || !transientProviderError(inspection.error)
        ) return replayBufferedBody(chunks, reader)
        return cancelAndThrow(new CodexModelGatewayRetryError(
          'gateway_upstream_transient_before_output',
          502,
          true,
        ))
      }
      if (isStandaloneTransientNativeError(payload, fields.eventName)) {
        return cancelAndThrow(new CodexModelGatewayRetryError(
          'gateway_upstream_transient_before_output',
          502,
          true,
        ))
      }
      return replayBufferedBody(chunks, reader)
    }
  }
}
