/** Convert Chat Completions SSE to verified Responses output under the same tool admission contract. */
import { createCodexChatPreSemanticState, inspectCodexChatPrefix } from './codex-model-gateway-chat-prefix'
import {
  assertToolArgumentsObject,
  CodexModelGatewayChatError,
  isRecord,
  type JsonObject,
} from './codex-model-gateway-common'
import {
  type CodexModelGatewayResponseEvidence,
  type CodexToolArgumentValidator,
  type CodexUpstreamProfileSnapshot,
  digestCanonicalJson,
} from './codex-model-gateway-contract'
import { ProviderCredentialFilter } from './codex-provider-credential-filter'
import { randomUUID } from 'node:crypto'

type ToolState = {
  id: string
  name: string
  arguments: string
  matchedAuthorizedName: boolean
}

function event(type: string, payload: JsonObject): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`
}

function sanitizeProviderErrorField(value: unknown, credential: string, fallback: string): string {
  if (typeof value !== 'string' || !value) return fallback
  const withoutCredential = credential ? value.split(credential).join('[REDACTED]') : value
  return withoutCredential
    .replace(/Bearer\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+)/gi, 'Bearer [REDACTED]')
    .slice(0, 512)
}

function responseFailed(
  responseId: string,
  model: string,
  credential: string,
  code: string,
  details?: JsonObject,
): string {
  const safeCode = sanitizeProviderErrorField(details?.code, credential, code)
  const safeType = sanitizeProviderErrorField(details?.type, credential, 'gateway_error')
  const safeMessage = sanitizeProviderErrorField(details?.message, credential, safeCode)
  return event('response.failed', {
    response: {
      id: responseId,
      model,
      status: 'failed',
      output: [],
      error: { code: safeCode, message: safeMessage, type: safeType },
    },
  })
}

function usageInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new CodexModelGatewayChatError(code)
  }
  return Number(value)
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

function dataFromBlock(block: string): string | null {
  const data = block.split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
  return data.length > 0 ? data.join('\n') : null
}

export async function streamChatAsResponses(input: {
  body: ReadableStream<Uint8Array>
  write: (chunk: string) => void
  allowedToolNames: ReadonlySet<string>
  toolArgumentValidators: ReadonlyMap<string, CodexToolArgumentValidator>
  snapshot: CodexUpstreamProfileSnapshot
  credential: string
  abort: () => void
  maxBytes?: number
  maxEvents?: number
  maxItemBytes?: number
  eventIdleMs?: number
  admitToolResponse?: (calls: readonly Readonly<{
    codexCallId: string
    toolName: string
    argsDigest: string
  }>[]) => Promise<void>
  recordCompleted?: (evidence: CodexModelGatewayResponseEvidence) => Promise<void>
  recordFailed?: (observation: {
    code: string
    stage: 'stream-before-item' | 'stream-after-item' | 'terminal-validation'
    responseIdentitySeen: boolean
    partialAssistantItemSeen: boolean
    toolCallItemSeen: boolean
    elapsedMs: number
    eventCount: number
    wireByteCount: number
  }) => void
}): Promise<void> {
  const startedAtMs = Date.now()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const reader = input.body.getReader()
  let buffer = ''
  const responseId = `resp_ready_${randomUUID().replaceAll('-', '')}`
  const messageId = `msg_ready_${randomUUID().replaceAll('-', '')}`
  const reasoningId = `reasoning_ready_${randomUUID().replaceAll('-', '')}`
  let messageStarted = false
  let reasoningStarted = false
  let messageOutputIndex: number | null = null
  let reasoningOutputIndex: number | null = null
  let nextOutputIndex = 0
  let text = ''
  let reasoning = ''
  let usage: JsonObject = {}
  let usageSeen = false
  let finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | null = null
  let choiceFinished = false
  let sawDone = false
  let bytes = 0
  let structuralEvents = 0
  const maxBytes = input.maxBytes || 8 * 1024 * 1024
  const maxEvents = input.maxEvents || 4_096
  const maxItemBytes = input.maxItemBytes || 2 * 1024 * 1024
  const eventIdleMs = input.eventIdleMs || 120_000
  let lastProgressAt = Date.now()
  let sawExpectedModel = false
  const preSemanticState = createCodexChatPreSemanticState()
  const tools = new Map<number, ToolState>()
  const seenToolIds = new Set<string>()
  const messageFilter = new ProviderCredentialFilter(input.credential)
  const reasoningFilter = new ProviderCredentialFilter(input.credential)
  input.write(event('response.created', {
    response: { id: responseId, model: input.snapshot.model, status: 'in_progress', output: [] },
  }))

  let failureRecorded = false
  const fail = (code: string, details?: JsonObject): false => {
    if (!failureRecorded) {
      failureRecorded = true
      input.recordFailed?.({
        code,
        stage: sawDone
          ? 'terminal-validation'
          : messageStarted || tools.size > 0 ? 'stream-after-item' : 'stream-before-item',
        responseIdentitySeen: true,
        partialAssistantItemSeen: messageStarted,
        toolCallItemSeen: tools.size > 0,
        elapsedMs: Math.max(0, Date.now() - startedAtMs),
        eventCount: structuralEvents,
        wireByteCount: bytes,
      })
    }
    input.write(responseFailed(responseId, input.snapshot.model, input.credential, code, details))
    input.abort()
    return false
  }

  const readNext = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    const remaining = lastProgressAt + eventIdleMs - Date.now()
    if (remaining <= 0) {
      throw new CodexModelGatewayChatError('gateway_chat_event_idle_timeout')
    }
    let timeout: ReturnType<typeof setTimeout> | null = null
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new CodexModelGatewayChatError(
            'gateway_chat_event_idle_timeout',
          )), remaining)
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  const emitMessageDelta = (delta: string): void => {
    if (!delta) return
    if (!messageStarted) {
      messageStarted = true
      messageOutputIndex = nextOutputIndex
      nextOutputIndex += 1
      input.write(event('response.output_item.added', {
        output_index: messageOutputIndex,
        item: { type: 'message', id: messageId, role: 'assistant', phase: 'final_answer', content: [] },
      }))
    }
    text += delta
    if (Buffer.byteLength(text, 'utf8') > maxItemBytes) {
      throw new CodexModelGatewayChatError('gateway_chat_item_too_large')
    }
    input.write(event('response.output_text.delta', {
      output_index: messageOutputIndex, content_index: 0, item_id: messageId, delta,
    }))
  }

  const emitReasoningDelta = (delta: string): void => {
    if (!delta) return
    if (!reasoningStarted) {
      reasoningStarted = true
      reasoningOutputIndex = nextOutputIndex
      nextOutputIndex += 1
      input.write(event('response.output_item.added', {
        output_index: reasoningOutputIndex,
        item: { type: 'reasoning', id: reasoningId, summary: [] },
      }))
    }
    reasoning += delta
    if (Buffer.byteLength(reasoning, 'utf8') > maxItemBytes) {
      throw new CodexModelGatewayChatError('gateway_chat_item_too_large')
    }
    input.write(event('response.reasoning_summary_text.delta', {
      output_index: reasoningOutputIndex,
      item_id: reasoningId,
      delta,
    }))
  }

  try {
    while (true) {
      const next = await readNext()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > maxBytes) throw new CodexModelGatewayChatError('gateway_chat_stream_too_large')
      try {
        buffer += decoder.decode(next.value, { stream: true })
      } catch {
        throw new CodexModelGatewayChatError('gateway_chat_sse_utf8_invalid')
      }
      const parsed = parseSseBlocks(buffer)
      buffer = parsed.rest
      for (const block of parsed.blocks) {
        const raw = dataFromBlock(block)
        if (!raw) continue
        if (raw === '[DONE]') {
          if (sawDone) return void fail('gateway_chat_done_duplicate')
          structuralEvents += 1
          if (structuralEvents > maxEvents) {
            throw new CodexModelGatewayChatError('gateway_chat_event_limit_exceeded')
          }
          sawDone = true
          continue
        }
        if (sawDone) return void fail('gateway_chat_event_after_done')
        let parsedPayload: unknown
        try {
          parsedPayload = JSON.parse(raw)
        } catch {
          return void fail('gateway_chat_sse_json_invalid')
        }
        if (!isRecord(parsedPayload)) return void fail('gateway_chat_sse_payload_invalid')
        const inspection = inspectCodexChatPrefix({
          parsedPayload,
          snapshot: input.snapshot,
          credential: input.credential,
          state: preSemanticState,
        })
        if (inspection.kind === 'invalid') return void fail(inspection.code)
        if (inspection.kind === 'provider_error') {
          return void fail('gateway_chat_stream_error', inspection.error)
        }
        const payload = inspection.payload
        sawExpectedModel = true
        lastProgressAt = Date.now()
        if (payload.usage !== undefined && payload.usage !== null) {
          if (usageSeen) return void fail('gateway_chat_usage_duplicate')
          if (!isRecord(payload.usage)) return void fail('gateway_chat_usage_invalid')
          if (Object.keys(payload.usage).some((key) => ![
            'prompt_tokens', 'completion_tokens', 'total_tokens',
            'prompt_tokens_details', 'completion_tokens_details',
          ].includes(key))) return void fail('gateway_chat_usage_invalid')
          usage = payload.usage
          usageSeen = true
        }
        if (!Array.isArray(payload.choices)) return void fail('gateway_chat_choices_invalid')
        const hasStructuralContent = payload.usage !== undefined
          || payload.choices.some((choice) => isRecord(choice) && (
            choice.finish_reason !== undefined
            || (isRecord(choice.delta) && (
              choice.delta.role !== undefined
              || (Array.isArray(choice.delta.tool_calls) && choice.delta.tool_calls.some(
                (call) => isRecord(call) && (call.id !== undefined || call.type !== undefined),
              ))
            ))
          ))
        if (hasStructuralContent) {
          structuralEvents += 1
          if (structuralEvents > maxEvents) {
            throw new CodexModelGatewayChatError('gateway_chat_event_limit_exceeded')
          }
        }
        if (payload.choices.length > 1) return void fail('gateway_chat_choices_invalid')
        if (choiceFinished && payload.choices.length > 0) {
          return void fail('gateway_chat_choice_after_finish')
        }
        for (const choice of payload.choices) {
          if (!isRecord(choice)) return void fail('gateway_chat_choice_invalid')
          if (Object.keys(choice).some((key) => ![
            'index', 'delta', 'message', 'finish_reason', 'logprobs',
          ].includes(key))) return void fail('gateway_chat_choice_field_not_allowed')
          if (choice.logprobs !== undefined && choice.logprobs !== null) {
            return void fail('gateway_chat_logprobs_unsupported')
          }
          if (choice.index !== undefined && choice.index !== 0) {
            return void fail('gateway_chat_choice_index_invalid')
          }
          if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
            if (!['stop', 'tool_calls', 'length', 'content_filter'].includes(String(choice.finish_reason))) {
              return void fail('gateway_chat_finish_reason_invalid')
            }
            const nextFinishReason = String(choice.finish_reason) as (
              'stop' | 'tool_calls' | 'length' | 'content_filter'
            )
            if (finishReason && finishReason !== nextFinishReason) {
              return void fail('gateway_chat_finish_reason_changed')
            }
            finishReason = nextFinishReason
          }
          if (choice.delta !== undefined && choice.message !== undefined) {
            return void fail('gateway_chat_delta_invalid')
          }
          const delta = choice.delta !== undefined
            ? choice.delta
            : choice.message
          if (!isRecord(delta)) return void fail('gateway_chat_delta_invalid')
          if (Object.keys(delta).some((key) => ![
            'role', 'content', 'tool_calls', 'function_call', 'refusal', 'audio',
            'additional_kwargs', 'reasoning_details', 'reasoning_summary', 'reasoning_content',
          ].includes(key))) return void fail('gateway_chat_delta_field_not_allowed')
          if (delta.role !== undefined && delta.role !== 'assistant') {
            return void fail('gateway_chat_role_invalid')
          }
          if (delta.function_call !== undefined) {
            return void fail('gateway_chat_legacy_function_call_unsupported')
          }
          if (delta.refusal !== undefined && delta.refusal !== null) {
            return void fail('gateway_chat_refusal_unsupported')
          }
          if (delta.audio !== undefined && delta.audio !== null) {
            return void fail('gateway_chat_audio_output_unsupported')
          }
          if (delta.content !== undefined && delta.content !== null && typeof delta.content !== 'string') {
            return void fail('gateway_chat_content_delta_invalid')
          }
          if (typeof delta.content === 'string' && delta.content) {
            emitMessageDelta(messageFilter.push(delta.content))
          }
          if (delta.additional_kwargs !== undefined && !isRecord(delta.additional_kwargs)) {
            return void fail('gateway_chat_reasoning_invalid')
          }
          if (delta.reasoning_details !== undefined && !Array.isArray(delta.reasoning_details)) {
            return void fail('gateway_chat_reasoning_invalid')
          }
          for (const field of ['reasoning_summary', 'reasoning_content'] as const) {
            if (delta[field] !== undefined && delta[field] !== null && typeof delta[field] !== 'string') {
              return void fail('gateway_chat_reasoning_invalid')
            }
          }
          const additional = isRecord(delta.additional_kwargs) ? delta.additional_kwargs : {}
          if (Object.keys(additional).some((key) => key !== 'reasoning_content')) {
            return void fail('gateway_chat_reasoning_invalid')
          }
          if (
            additional.reasoning_content !== undefined
            && additional.reasoning_content !== null
            && typeof additional.reasoning_content !== 'string'
          ) return void fail('gateway_chat_reasoning_invalid')
          const reasoningDetails = Array.isArray(delta.reasoning_details) ? delta.reasoning_details : []
          if (
            (typeof delta.reasoning_content === 'string' && delta.reasoning_content)
            || (typeof additional.reasoning_content === 'string' && additional.reasoning_content)
            || reasoningDetails.length > 0
          ) return void fail('gateway_chat_raw_reasoning_unsupported')
          const reasoningDelta = typeof delta.reasoning_summary === 'string'
            ? delta.reasoning_summary
            : ''
          if (reasoningDelta) {
            emitReasoningDelta(reasoningFilter.push(reasoningDelta))
          }
          if (delta.tool_calls !== undefined && !Array.isArray(delta.tool_calls)) {
            return void fail('gateway_chat_tool_calls_invalid')
          }
          const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
          for (const call of toolCalls) {
            if (!isRecord(call)) return void fail('gateway_chat_tool_call_invalid')
            if (Object.keys(call).some((key) => !['index', 'id', 'type', 'function'].includes(key))) {
              return void fail('gateway_chat_tool_call_invalid')
            }
            if (!Number.isSafeInteger(call.index) || Number(call.index) < 0) {
              return void fail('gateway_chat_tool_call_index_invalid')
            }
            if (call.type !== undefined && call.type !== 'function') {
              return void fail('gateway_chat_tool_call_type_invalid')
            }
            if (call.function !== undefined && !isRecord(call.function)) {
              return void fail('gateway_chat_tool_function_invalid')
            }
            const index = Number(call.index)
            const fn = isRecord(call.function) ? call.function : {}
            if (Object.keys(fn).some((key) => !['name', 'arguments'].includes(key))) {
              return void fail('gateway_chat_tool_function_invalid')
            }
            if (!tools.has(index) && index !== tools.size) {
              return void fail('gateway_chat_tool_call_index_sequence_invalid')
            }
            if (call.id !== undefined && (typeof call.id !== 'string' || !call.id)) {
              return void fail('gateway_chat_tool_call_id_invalid')
            }
            if (fn.name !== undefined && typeof fn.name !== 'string') {
              return void fail('gateway_chat_tool_name_invalid')
            }
            if (fn.arguments !== undefined && typeof fn.arguments !== 'string') {
              return void fail('gateway_chat_tool_arguments_invalid')
            }
            const current = tools.get(index) || {
              id: '', name: '', arguments: '',
              matchedAuthorizedName: false,
            }
            if (typeof call.id === 'string' && call.id) {
              if (
                (input.credential && call.id.includes(input.credential))
                || /Bearer\s+/i.test(call.id)
              ) {
                return void fail('gateway_provider_credential_in_identity')
              }
              if (current.id && current.id !== call.id) return void fail('gateway_tool_call_identity_changed')
              if (!current.id && seenToolIds.has(call.id)) {
                return void fail('gateway_tool_call_identity_duplicate')
              }
              if (!current.id) seenToolIds.add(call.id)
              current.id = call.id
            }
            if (typeof fn.name === 'string') {
              current.name += fn.name
              if (input.allowedToolNames.has(current.name)) current.matchedAuthorizedName = true
            }
            if (typeof fn.arguments === 'string') {
              current.arguments += fn.arguments
              if (Buffer.byteLength(current.arguments, 'utf8') > maxItemBytes) {
                throw new CodexModelGatewayChatError('gateway_chat_item_too_large')
              }
            }
            tools.set(index, current)
          }
          if (choice.finish_reason !== undefined && choice.finish_reason !== null) choiceFinished = true
        }
      }
      if (sawDone) {
        await reader.cancel().catch(() => undefined)
        break
      }
    }
  } catch (error) {
    const code = error instanceof CodexModelGatewayChatError
      ? error.code
      : 'gateway_chat_stream_failed'
    await reader.cancel().catch(() => undefined)
    fail(code)
    return
  } finally {
    reader.releaseLock()
  }

  try {
    buffer += decoder.decode()
  } catch {
    return void fail('gateway_chat_sse_utf8_invalid')
  }
  if (buffer.trim()) return void fail('gateway_chat_sse_truncated')
  if (!sawDone) return void fail('gateway_chat_done_missing')
  if (!finishReason) return void fail('gateway_chat_finish_reason_missing')
  if (!sawExpectedModel) return void fail('gateway_upstream_model_missing')
  if (finishReason === 'tool_calls' && tools.size === 0) {
    return void fail('gateway_chat_tool_calls_missing')
  }
  if (finishReason !== 'tool_calls' && tools.size > 0) {
    return void fail('gateway_chat_finish_reason_mismatch')
  }

  emitMessageDelta(messageFilter.flush())
  emitReasoningDelta(reasoningFilter.flush())

  for (const state of tools.values()) {
    if (!state.name) return void fail('gateway_response_tool_name_missing')
    if (!state.id) return void fail('gateway_response_tool_call_id_missing')
    if (!input.allowedToolNames.has(state.name)) {
      return void fail(
        state.matchedAuthorizedName
          ? 'gateway_tool_call_name_changed'
          : 'gateway_response_tool_not_authorized',
      )
    }
    try {
      if (
        (input.credential && state.arguments.includes(input.credential))
        || /Bearer\s+/i.test(state.arguments)
      ) return void fail('gateway_tool_arguments_secret_detected')
      const parsedArguments = assertToolArgumentsObject(
        state.arguments,
        'gateway_chat_tool_arguments_json_invalid',
      )
      if (!input.toolArgumentValidators.get(state.name)?.safeParse(parsedArguments).success) {
        return void fail('gateway_tool_arguments_schema_invalid')
      }
    } catch (error) {
      return void fail(
        error instanceof CodexModelGatewayChatError
          ? error.code
          : 'gateway_chat_tool_arguments_json_invalid',
      )
    }
  }
  let inputTokens: number
  let outputTokens: number
  let totalTokens: number
  let cachedTokens = 0
  let reasoningTokens = 0
  let promptAudioTokens = 0
  let completionAudioTokens = 0
  let acceptedPredictionTokens = 0
  let rejectedPredictionTokens = 0
  try {
    if (Object.keys(usage).length === 0) {
      return void fail('gateway_chat_usage_missing')
    } else {
      inputTokens = usageInteger(usage.prompt_tokens, 'gateway_chat_usage_invalid')
      outputTokens = usageInteger(usage.completion_tokens, 'gateway_chat_usage_invalid')
      totalTokens = usageInteger(usage.total_tokens, 'gateway_chat_usage_invalid')
      if (totalTokens !== inputTokens + outputTokens) {
        return void fail('gateway_chat_usage_invalid')
      }
      if (usage.prompt_tokens_details !== undefined) {
        if (!isRecord(usage.prompt_tokens_details)) return void fail('gateway_chat_usage_invalid')
        if (Object.keys(usage.prompt_tokens_details).some((key) => ![
          'cached_tokens', 'audio_tokens',
        ].includes(key))) {
          return void fail('gateway_chat_usage_invalid')
        }
        if (usage.prompt_tokens_details.cached_tokens !== undefined) {
          cachedTokens = usageInteger(
            usage.prompt_tokens_details.cached_tokens,
            'gateway_chat_usage_invalid',
          )
        }
        if (usage.prompt_tokens_details.audio_tokens !== undefined) {
          promptAudioTokens = usageInteger(
            usage.prompt_tokens_details.audio_tokens,
            'gateway_chat_usage_invalid',
          )
        }
      }
      if (usage.completion_tokens_details !== undefined) {
        if (!isRecord(usage.completion_tokens_details)) return void fail('gateway_chat_usage_invalid')
        if (Object.keys(usage.completion_tokens_details).some((key) => ![
          'reasoning_tokens', 'audio_tokens',
          'accepted_prediction_tokens', 'rejected_prediction_tokens',
        ].includes(key))) {
          return void fail('gateway_chat_usage_invalid')
        }
        if (usage.completion_tokens_details.reasoning_tokens !== undefined) {
          reasoningTokens = usageInteger(
            usage.completion_tokens_details.reasoning_tokens,
            'gateway_chat_usage_invalid',
          )
        }
        if (usage.completion_tokens_details.audio_tokens !== undefined) {
          completionAudioTokens = usageInteger(
            usage.completion_tokens_details.audio_tokens,
            'gateway_chat_usage_invalid',
          )
        }
        if (usage.completion_tokens_details.accepted_prediction_tokens !== undefined) {
          acceptedPredictionTokens = usageInteger(
            usage.completion_tokens_details.accepted_prediction_tokens,
            'gateway_chat_usage_invalid',
          )
        }
        if (usage.completion_tokens_details.rejected_prediction_tokens !== undefined) {
          rejectedPredictionTokens = usageInteger(
            usage.completion_tokens_details.rejected_prediction_tokens,
            'gateway_chat_usage_invalid',
          )
        }
      }
      if (
        cachedTokens > inputTokens
        || promptAudioTokens > inputTokens
        || reasoningTokens > outputTokens
        || completionAudioTokens > outputTokens
        || acceptedPredictionTokens > outputTokens
        || rejectedPredictionTokens > outputTokens
      ) {
        return void fail('gateway_chat_usage_invalid')
      }
    }
  } catch (error) {
    return void fail(error instanceof CodexModelGatewayChatError ? error.code : 'gateway_chat_usage_invalid')
  }
  if (finishReason === 'length' || finishReason === 'content_filter') {
    return void fail(
      finishReason === 'length'
        ? 'gateway_upstream_output_truncated'
        : 'gateway_upstream_output_filtered',
    )
  }
  if (tools.size > 0) {
    try {
      if (!input.admitToolResponse) {
        throw new Error('gateway_tool_response_admission_unavailable')
      }
      await input.admitToolResponse([...tools.values()].map((state) => ({
        codexCallId: state.id,
        toolName: state.name,
        argsDigest: digestCanonicalJson(JSON.parse(state.arguments)),
      })))
    } catch (error) {
      const code = error instanceof Error && /^gateway_[a-z0-9_]+$/.test(error.message)
        ? error.message
        : 'gateway_tool_response_admission_failed'
      return void fail(code)
    }
  }
  const bufferedItems = [
    ...(messageStarted && messageOutputIndex !== null
      ? [{ kind: 'message' as const, outputIndex: messageOutputIndex }]
      : []),
    ...(reasoningStarted && reasoningOutputIndex !== null
      ? [{ kind: 'reasoning' as const, outputIndex: reasoningOutputIndex }]
      : []),
  ].sort((left, right) => left.outputIndex - right.outputIndex)
  for (const item of bufferedItems) {
    if (item.kind === 'message') {
      input.write(event('response.output_item.done', {
        output_index: item.outputIndex,
        item: {
          type: 'message', id: messageId, role: 'assistant', phase: 'final_answer',
          content: [{ type: 'output_text', text }],
        },
      }))
    } else {
      input.write(event('response.output_item.done', {
        output_index: item.outputIndex,
        item: {
          type: 'reasoning', id: reasoningId,
          summary: [{ type: 'summary_text', text: reasoning }],
        },
      }))
    }
  }
  for (const state of tools.values()) {
    const outputIndex = nextOutputIndex
    nextOutputIndex += 1
    input.write(event('response.output_item.added', {
      output_index: outputIndex,
      item: { type: 'function_call', id: state.id, call_id: state.id, name: state.name, arguments: '' },
    }))
    if (state.arguments) {
      input.write(event('response.function_call_arguments.delta', {
        output_index: outputIndex, item_id: state.id, delta: state.arguments,
      }))
    }
    input.write(event('response.output_item.done', {
      output_index: outputIndex,
      item: {
        type: 'function_call', id: state.id, call_id: state.id,
        name: state.name, arguments: state.arguments,
      },
    }))
  }
  const completedPayload = {
    type: 'response.completed',
    response: {
      id: responseId,
      status: 'completed',
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: totalTokens,
        input_tokens_details: isRecord(usage.prompt_tokens_details)
          ? { cached_tokens: cachedTokens }
          : null,
        output_tokens_details: isRecord(usage.completion_tokens_details)
          ? { reasoning_tokens: reasoningTokens }
          : null,
      },
    },
  }
  if (input.recordCompleted) {
    try {
      await input.recordCompleted({
        responseId,
        terminalDigest: digestCanonicalJson(completedPayload),
        outputDigest: digestCanonicalJson({
          text,
          reasoning,
          tools: [...tools.values()].map((state) => ({
            id: state.id,
            name: state.name,
            argumentsDigest: digestCanonicalJson(state.arguments),
          })),
        }),
        usageDigest: digestCanonicalJson(completedPayload.response.usage),
      })
    } catch (error) {
      return void fail(
        error instanceof Error && /^gateway_[a-z0-9_]+$/.test(error.message)
          ? error.message
          : 'gateway_response_evidence_failed',
      )
    }
  }
  input.write(event('response.completed', { response: completedPayload.response }))
}
