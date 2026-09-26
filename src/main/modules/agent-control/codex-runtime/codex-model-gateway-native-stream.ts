/** Deliver validated Responses events incrementally; admit tool results only after a valid terminal. */
import { CodexModelGatewayError, isRecord, type JsonObject } from './codex-model-gateway-common'
import {
  type CodexModelGatewayFailureEvidence,
  type CodexModelGatewayResponseEvidence,
  type CodexToolArgumentValidator,
  digestCanonicalJson,
} from './codex-model-gateway-contract'
import { CodexMessagesError } from './codex-model-gateway-messages'
import { type NativeResponseState, validateNativeEvent } from './codex-model-gateway-native-validation'
import { normalizeChatGptOAuthResponseEvent } from './codex-model-gateway-oauth'
import {
  assertNativeProviderIdentitySafe,
  gatewayFailureEvidence,
  redactNativeProviderEvent,
  sanitizeProviderText,
} from './codex-model-gateway-provider-errors'
import type { CodexModelGatewayToolResponseCall } from './codex-model-gateway-types'
import { ProviderCredentialFilter } from './codex-provider-credential-filter'
import { createProviderMessagePhaseNormalizer } from './codex-provider-message-phase'
import { CodexProviderStreamPolicy, CodexProviderStreamPolicyError } from './codex-provider-stream-policy'
import { normalizeZaiResponseEvent } from './codex-zai-responses'
import { randomBytes } from 'node:crypto'
import type { ServerResponse } from 'node:http'

function parseSse(buffer: string): { blocks: string[]; rest: string } {
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

function nativeEventFromBlock(block: string): { raw: string; payload: JsonObject } | null {
  const lines = block.split('\n')
  const eventName = lines.find((line) => line.startsWith('event:'))?.slice(6).trim()
  const data = lines.filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart()).join('\n')
  if (!data || data === '[DONE]') return null
  let payload: unknown
  try {
    payload = JSON.parse(data)
  } catch {
    throw new CodexModelGatewayError('gateway_native_sse_json_invalid', 502)
  }
  if (!isRecord(payload) || typeof payload.type !== 'string' || (eventName && eventName !== payload.type)) {
    throw new CodexModelGatewayError('gateway_native_sse_event_invalid', 502)
  }
  return { raw: `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`, payload }
}

export async function streamNativeResponses(input: {
  body: ReadableStream<Uint8Array>
  response: ServerResponse
  allowedTools: ReadonlySet<string>
  toolArgumentValidators: ReadonlyMap<string, CodexToolArgumentValidator>
  expectedModel: string
  normalizeChatGptOAuth: boolean
  normalizeZai: boolean
  inferMessagePhase: boolean
  credential: string
  abort: () => void
  maxBytes: number
  maxEvents: number
  maxItemBytes: number
  eventIdleMs: number
  admitToolResponse: (calls: readonly CodexModelGatewayToolResponseCall[]) => Promise<void>
  recordCompleted: (evidence: CodexModelGatewayResponseEvidence) => Promise<void>
  recordFailed: (evidence: CodexModelGatewayFailureEvidence) => void
}): Promise<void> {
  const normalizePhase = input.inferMessagePhase ? createProviderMessagePhaseNormalizer() : (event: JsonObject) => [event]
  const startedAtMs = Date.now()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const reader = input.body.getReader()
  const deltaFilters = new Map<string, {
    filter: ProviderCredentialFilter
    eventType: string
    itemId: string
    base: JsonObject
  }>()
  let buffer = ''
  const policy = new CodexProviderStreamPolicy({
    maxWireBytes: input.maxBytes,
    maxStructuralEvents: input.maxEvents,
    maxItemHeldBytes: input.maxItemBytes,
    eventIdleMs: input.eventIdleMs,
  })
  const state: NativeResponseState = {
    responseId: null,
    inProgressSeen: false,
    terminal: false,
    items: new Map(),
    itemIds: new Set(),
    callIds: new Set(),
  }
  let terminalEvent: string | null = null
  let terminalPayload: JsonObject | null = null
  let terminalSucceeded = false
  let holdFromFunctionCall = false
  const heldFunctionTail: JsonObject[] = []
  const encodeSafePayload = (payload: JsonObject): string => (
    `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`
  )
  const appendHeldFunctionPayload = (payload: JsonObject): void => {
    const previous = heldFunctionTail.at(-1)
    if (
      payload.type === 'response.function_call_arguments.delta'
      && previous?.type === payload.type
      && previous.item_id === payload.item_id
      && previous.output_index === payload.output_index
      && typeof previous.delta === 'string'
      && typeof payload.delta === 'string'
    ) {
      previous.delta += payload.delta
      return
    }
    heldFunctionTail.push({ ...payload })
  }
  const writeSafePayload = (payload: JsonObject): void => {
    if (holdFromFunctionCall) appendHeldFunctionPayload(payload)
    else input.response.write(encodeSafePayload(payload))
  }
  const deltaFamily = (eventType: string): string | null => {
    if (eventType === 'response.function_call_arguments.delta') return 'arguments'
    if (eventType === 'response.reasoning_summary_text.delta') return 'reasoning'
    if (eventType === 'response.reasoning_text.delta') return 'reasoning_text'
    if (eventType === 'response.output_text.delta') return 'output_text'
    if (eventType === 'response.refusal.delta') return 'refusal'
    return null
  }
  const flushDeltaFilters = (predicate: (entry: {
    eventType: string; itemId: string
  }) => boolean): void => {
    for (const [key, entry] of deltaFilters) {
      if (!predicate(entry)) continue
      const delta = entry.filter.flush()
      if (delta) writeSafePayload({
        ...entry.base,
        type: entry.eventType,
        delta: sanitizeProviderText(delta, input.credential),
      })
      deltaFilters.delete(key)
    }
  }
  const readNext = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    const remaining = policy.remainingWaitMs()
    if (remaining <= 0) {
      throw new CodexModelGatewayError(policy.timeoutCode(), 502)
    }
    let timeout: ReturnType<typeof setTimeout> | null = null
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new CodexModelGatewayError(
            policy.timeoutCode(),
            502,
          )), remaining)
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }
  try {
    while (true) {
      const next = await readNext()
      if (next.done) break
      try {
        policy.recordWireBytes(next.value.byteLength)
      } catch (error) {
        if (error instanceof CodexProviderStreamPolicyError) {
          throw new CodexModelGatewayError(error.code, 502)
        }
        throw error
      }
      try {
        buffer += decoder.decode(next.value, { stream: true })
      } catch {
        throw new CodexModelGatewayError('gateway_native_sse_utf8_invalid', 502)
      }
      const parsed = parseSse(buffer)
      buffer = parsed.rest
      for (const block of parsed.blocks) {
        const parsedEvent = nativeEventFromBlock(block)
        if (!parsedEvent) continue
        const normalizedPayload = input.normalizeChatGptOAuth
          ? normalizeChatGptOAuthResponseEvent(
              parsedEvent.payload,
              [...state.items.values()].flatMap((item) => item.doneItem ? [item.doneItem] : []),
            )
          : input.normalizeZai ? normalizeZaiResponseEvent(parsedEvent.payload) : parsedEvent.payload
        for (const providerPayload of normalizePhase(normalizedPayload)) {
          const eventType = String(providerPayload.type)
          assertNativeProviderIdentitySafe(providerPayload, input.credential)
          validateNativeEvent(
            providerPayload,
            input.allowedTools,
            input.toolArgumentValidators,
            state,
            input.expectedModel,
            input.credential,
          )
          try {
            policy.acceptValidatedEvent(providerPayload)
          } catch (error) {
            if (error instanceof CodexProviderStreamPolicyError) {
              throw new CodexModelGatewayError(error.code, 502)
            }
            throw error
          }
          if (
            eventType === 'response.output_item.added'
            && isRecord(providerPayload.item)
            && providerPayload.item.type === 'function_call'
          ) holdFromFunctionCall = true
          const itemId = typeof providerPayload.item_id === 'string'
            ? providerPayload.item_id
            : isRecord(providerPayload.item) && typeof providerPayload.item.id === 'string'
              ? providerPayload.item.id
              : ''
          if (eventType === 'response.output_item.done') {
            flushDeltaFilters((entry) => entry.itemId === itemId)
          } else if (eventType.endsWith('.done')) {
            const family = eventType.replace(/\.done$/, '').replace(/^response\./, '')
            flushDeltaFilters((entry) => (
              entry.itemId === itemId && entry.eventType.includes(family.replace(/_done$/, ''))
            ))
          }
          const family = deltaFamily(eventType)
          let gatewayPayload = providerPayload
          if (eventType === 'response.incomplete' && isRecord(providerPayload.response)) {
            const incompleteDetails = providerPayload.response.incomplete_details
            const reason = isRecord(incompleteDetails) ? incompleteDetails.reason : null
            const response = { ...providerPayload.response }
            delete response.incomplete_details
            const code = reason === 'max_output_tokens'
              ? 'gateway_upstream_output_truncated'
              : 'gateway_upstream_output_filtered'
            gatewayPayload = {
              ...providerPayload,
              type: 'response.failed',
              response: {
                ...response,
                status: 'failed',
                error: { code, message: code, type: 'gateway_error' },
              },
            }
          }
          let safePayload = redactNativeProviderEvent(
            gatewayPayload,
            input.credential,
            family !== null,
          )
          if (family && typeof providerPayload.delta === 'string') {
            const key = `${family}:${itemId}:${String(providerPayload.content_index ?? providerPayload.summary_index ?? 0)}`
            let entry = deltaFilters.get(key)
            if (!entry) {
              const base = { ...safePayload }
              delete base.delta
              entry = {
                filter: new ProviderCredentialFilter(input.credential),
                eventType,
                itemId,
                base,
              }
              deltaFilters.set(key, entry)
            }
            safePayload = {
              ...safePayload,
              delta: sanitizeProviderText(entry.filter.push(providerPayload.delta), input.credential),
            }
          }
          if (state.terminal) {
            terminalSucceeded = safePayload.type === 'response.completed'
            const completedPayload = terminalSucceeded || !isRecord(safePayload.response)
              ? safePayload
              : {
                  ...safePayload,
                  response: { ...safePayload.response, output: [] },
                }
            terminalEvent = `event: ${completedPayload.type}\ndata: ${JSON.stringify(completedPayload)}\n\n`
            terminalPayload = completedPayload
            if (safePayload.type !== 'response.completed' && holdFromFunctionCall) {
              heldFunctionTail.length = 0
              holdFromFunctionCall = false
            }
          } else writeSafePayload(safePayload)
        }
      }
      if (state.terminal) {
        await reader.cancel().catch(() => undefined)
        break
      }
    }
    if (!state.terminal) {
      try {
        buffer += decoder.decode()
      } catch {
        throw new CodexModelGatewayError('gateway_native_sse_utf8_invalid', 502)
      }
      if (buffer.trim()) throw new CodexModelGatewayError('gateway_native_sse_truncated', 502)
    }
    if (!state.terminal) throw new CodexModelGatewayError('gateway_native_terminal_missing', 502)
    if (!terminalEvent) throw new CodexModelGatewayError('gateway_native_terminal_missing', 502)
    if (!terminalSucceeded) {
      deltaFilters.clear()
      heldFunctionTail.length = 0
      holdFromFunctionCall = false
      const responseError = isRecord(terminalPayload?.response)
        && isRecord(terminalPayload.response.error)
        && typeof terminalPayload.response.error.code === 'string'
        ? terminalPayload.response.error.code
        : 'gateway_provider_terminal_failed'
      const snapshot = policy.snapshot()
      input.recordFailed(gatewayFailureEvidence({
        code: responseError,
        stage: 'post-terminal',
        responseIdentitySeen: state.responseId !== null,
        partialAssistantItemSeen: [...state.items.values()].some((item) => item.type === 'message'),
        toolCallItemSeen: [...state.items.values()].some((item) => item.type === 'function_call'),
        startedAtMs,
        eventCount: snapshot.structuralEvents,
        wireByteCount: snapshot.wireBytes,
      }))
      input.response.write(terminalEvent)
      return
    }
    flushDeltaFilters(() => true)
    const toolCalls = [...state.items.values()]
      .filter((item) => item.type === 'function_call')
      .map((item) => {
        let parsedArguments: unknown
        try {
          parsedArguments = JSON.parse(item.arguments)
        } catch {
          throw new CodexModelGatewayError('gateway_native_tool_arguments_json_invalid', 502)
        }
        if (!item.callId || !item.name) {
          throw new CodexModelGatewayError('gateway_native_tool_identity_invalid', 502)
        }
        return {
          codexCallId: item.callId,
          toolName: item.name,
          argsDigest: digestCanonicalJson(parsedArguments),
        }
      })
    if (toolCalls.length > 0) await input.admitToolResponse(toolCalls)
    if (!terminalPayload || !isRecord(terminalPayload.response)) {
      throw new CodexModelGatewayError('gateway_native_terminal_missing', 502)
    }
    await input.recordCompleted({
      responseId: String(terminalPayload.response.id),
      terminalDigest: digestCanonicalJson(terminalPayload),
      outputDigest: digestCanonicalJson([...state.items.entries()].map(([index, item]) => ({
        index,
        digest: item.doneItemDigest,
      }))),
      usageDigest: digestCanonicalJson(terminalPayload.response.usage),
    })
    for (const safePayload of heldFunctionTail) input.response.write(encodeSafePayload(safePayload))
    heldFunctionTail.length = 0
    holdFromFunctionCall = false
    input.response.write(terminalEvent)
  } catch (error) {
    input.abort()
    await reader.cancel().catch(() => undefined)
    heldFunctionTail.length = 0
    holdFromFunctionCall = false
    // silent-catch: abort upstream, persist response_failed, and emit the failed terminal; recordFailed errors still propagate.
    const code = error instanceof CodexModelGatewayError || error instanceof CodexMessagesError ? error.code : 'gateway_native_stream_failed'
    const snapshot = policy.snapshot()
    input.recordFailed(gatewayFailureEvidence({
      code,
      stage: state.terminal
        ? 'terminal-validation'
        : state.items.size > 0 ? 'stream-after-item' : 'stream-before-item',
      responseIdentitySeen: state.responseId !== null,
      partialAssistantItemSeen: [...state.items.values()].some((item) => item.type === 'message'),
      toolCallItemSeen: [...state.items.values()].some((item) => item.type === 'function_call'),
      startedAtMs,
      eventCount: snapshot.structuralEvents,
      wireByteCount: snapshot.wireBytes,
    }))
    const responseId = state.responseId || `resp_ready_${randomBytes(16).toString('hex')}`
    input.response.write(`event: response.failed\ndata: ${JSON.stringify({
      type: 'response.failed',
      sequence_number: 0,
      response: {
        id: responseId,
        model: input.expectedModel,
        status: 'failed',
        output: [],
        error: { code, message: code, type: 'gateway_error', param: null },
      },
    })}\n\n`)
  } finally {
    reader.releaseLock()
  }
}
