import { randomUUID } from 'node:crypto'

import type { AIModelConfig } from '../../../../shared/ai-providers'
import {
  applyProviderRequestPatch,
  resolveProviderDefaultPatchers,
} from '../../../../shared/ai-providers/index'
import { REGISTERED_PATCH_PROFILES } from '../../../../shared/ai-providers/resolve-provider-patch-profile'
import type {
  CodexModelGatewayResponseEvidence,
  CodexToolArgumentValidator,
  CodexUpstreamProfileSnapshot,
} from './codex-model-gateway-contract'
import { digestCanonicalJson } from './codex-model-gateway-contract'
import {
  createCodexChatPreSemanticState,
  inspectCodexChatPrefix,
} from './codex-model-gateway-chat-prefix'

type JsonObject = Record<string, unknown>

export class CodexModelGatewayChatError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'CodexModelGatewayChatError'
  }
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function assertToolArgumentsObject(value: string, code: string): JsonObject {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new CodexModelGatewayChatError(code)
  }
  if (!isRecord(parsed)) throw new CodexModelGatewayChatError(code)
  return parsed
}

function chatInputAudio(audioUrl: string): JsonObject {
  const match = audioUrl.match(/^data:audio\/(mpeg|mp3|wav|x-wav);base64,([A-Za-z0-9+/]+={0,2})$/i)
  if (!match) throw new CodexModelGatewayChatError('gateway_chat_audio_url_unsupported')
  return {
    data: match[2],
    format: ['wav', 'x-wav'].includes(match[1].toLowerCase()) ? 'wav' : 'mp3',
  }
}

function contentPartToChat(part: unknown, role: string): unknown {
  if (!isRecord(part)) throw new CodexModelGatewayChatError('gateway_chat_content_invalid')
  if (part.type === 'input_text' || part.type === 'output_text') {
    if (typeof part.text !== 'string') {
      throw new CodexModelGatewayChatError('gateway_chat_content_text_invalid')
    }
    return { type: 'text', text: part.text }
  }
  if (part.type === 'input_image') {
    if (role !== 'user') throw new CodexModelGatewayChatError('gateway_chat_role_content_unsupported')
    const imageUrl = typeof part.image_url === 'string' ? part.image_url : part.url
    if (typeof imageUrl !== 'string' || !imageUrl) {
      throw new CodexModelGatewayChatError('gateway_chat_image_invalid')
    }
    return { type: 'image_url', image_url: { url: imageUrl, detail: part.detail || 'auto' } }
  }
  if (part.type === 'input_audio') {
    if (role !== 'user') throw new CodexModelGatewayChatError('gateway_chat_role_content_unsupported')
    const audioUrl = typeof part.audio_url === 'string' ? part.audio_url : part.url
    if (typeof audioUrl !== 'string' || !audioUrl) {
      throw new CodexModelGatewayChatError('gateway_chat_audio_invalid')
    }
    return { type: 'input_audio', input_audio: chatInputAudio(audioUrl) }
  }
  throw new CodexModelGatewayChatError('gateway_chat_content_type_unsupported')
}

function messageContentToChat(content: unknown, role: string): unknown {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) throw new CodexModelGatewayChatError('gateway_chat_message_content_invalid')
  const parts = content.map((part) => contentPartToChat(part, role))
  if (parts.every((part) => isRecord(part) && part.type === 'text')) {
    return parts.map((part) => (part as JsonObject).text as string).join('')
  }
  return parts
}

function functionOutputToChat(output: unknown): string | JsonObject[] {
  if (typeof output === 'string') return output
  if (!Array.isArray(output)) {
    throw new CodexModelGatewayChatError('gateway_chat_function_output_invalid')
  }
  return output.map((part) => {
    if (!isRecord(part) || part.type !== 'input_text' || typeof part.text !== 'string') {
      throw new CodexModelGatewayChatError('gateway_chat_function_output_multimodal_unsupported')
    }
    return { type: 'text', text: part.text }
  })
}

function responsesInputToChatMessages(input: unknown, instructions: unknown): JsonObject[] {
  if (!Array.isArray(input)) throw new CodexModelGatewayChatError('gateway_chat_input_invalid')
  const messages: JsonObject[] = []
  const functionCalls = new Set<string>()
  const functionOutputs = new Set<string>()
  const pendingFunctionOutputs = new Set<string>()
  let toolOutputBlockStarted = false
  if (typeof instructions === 'string' && instructions) {
    messages.push({ role: 'developer', content: instructions })
  }
  let pendingReasoningSummary = ''
  const takeReasoningSummary = (): JsonObject => {
    if (!pendingReasoningSummary) return {}
    const reasoningSummary = pendingReasoningSummary
    pendingReasoningSummary = ''
    return { reasoning_summary: reasoningSummary }
  }
  const flushReasoningSummary = (): void => {
    if (!pendingReasoningSummary) return
    messages.push({ role: 'assistant', content: '', ...takeReasoningSummary() })
  }
  for (const item of input) {
    if (!isRecord(item)) throw new CodexModelGatewayChatError('gateway_chat_input_item_invalid')
    if (
      item.type !== 'function_call'
      && item.type !== 'function_call_output'
      && pendingFunctionOutputs.size > 0
    ) throw new CodexModelGatewayChatError('gateway_chat_function_output_order_invalid')
    if (item.type === 'message') {
      if (item.role !== 'assistant') flushReasoningSummary()
      toolOutputBlockStarted = false
      if (typeof item.role !== 'string' || !['system', 'developer', 'user', 'assistant'].includes(item.role)) {
        throw new CodexModelGatewayChatError('gateway_chat_role_invalid')
      }
      messages.push({
        role: item.role,
        content: messageContentToChat(item.content, item.role),
        ...(item.role === 'assistant' ? takeReasoningSummary() : {}),
      })
      continue
    }
    if (item.type === 'function_call') {
      if (
        typeof item.call_id !== 'string'
        || !item.call_id
        || typeof item.name !== 'string'
        || !item.name
        || typeof item.arguments !== 'string'
      ) throw new CodexModelGatewayChatError('gateway_chat_function_call_invalid')
      if (toolOutputBlockStarted && pendingFunctionOutputs.size > 0) {
        throw new CodexModelGatewayChatError('gateway_chat_function_output_order_invalid')
      }
      if (pendingFunctionOutputs.size === 0) toolOutputBlockStarted = false
      assertToolArgumentsObject(item.arguments, 'gateway_chat_function_arguments_invalid')
      const callId = item.call_id
      const name = item.name
      if (functionCalls.has(callId)) {
        throw new CodexModelGatewayChatError('gateway_chat_function_call_duplicate')
      }
      functionCalls.add(callId)
      pendingFunctionOutputs.add(callId)
      const toolCall = {
        id: callId,
        type: 'function',
        function: { name, arguments: item.arguments },
      }
      const previous = messages.at(-1)
      if (previous?.role === 'assistant') {
        if (pendingReasoningSummary && previous.reasoning_summary === undefined) {
          Object.assign(previous, takeReasoningSummary())
        }
        const toolCalls = Array.isArray(previous.tool_calls) ? previous.tool_calls : []
        if (!Array.isArray(previous.tool_calls)) previous.tool_calls = toolCalls
        toolCalls.push(toolCall)
      } else {
        messages.push({
          role: 'assistant', content: null, tool_calls: [toolCall], ...takeReasoningSummary(),
        })
      }
      continue
    }
    if (item.type === 'function_call_output') {
      flushReasoningSummary()
      if (
        typeof item.call_id !== 'string'
        || !item.call_id
        || !functionCalls.has(item.call_id)
        || !pendingFunctionOutputs.has(item.call_id)
        || functionOutputs.has(item.call_id)
      ) throw new CodexModelGatewayChatError('gateway_chat_function_output_invalid')
      functionOutputs.add(item.call_id)
      pendingFunctionOutputs.delete(item.call_id)
      toolOutputBlockStarted = true
      messages.push({
        role: 'tool', tool_call_id: item.call_id, content: functionOutputToChat(item.output),
      })
      continue
    }
    if (item.type === 'reasoning') {
      if (
        (item.encrypted_content !== undefined && item.encrypted_content !== null)
        || !Array.isArray(item.summary)
        || item.summary.some((part) => (
          !isRecord(part) || part.type !== 'summary_text' || typeof part.text !== 'string'
        ))
      ) throw new CodexModelGatewayChatError('gateway_chat_reasoning_history_unsupported')
      pendingReasoningSummary += item.summary
        .map((part) => String((part as JsonObject).text))
        .join('')
      continue
    }
    throw new CodexModelGatewayChatError('gateway_chat_input_type_unsupported')
  }
  flushReasoningSummary()
  if (functionCalls.size !== functionOutputs.size || pendingFunctionOutputs.size > 0) {
    throw new CodexModelGatewayChatError('gateway_chat_function_output_missing')
  }
  return messages
}

function responsesToolsToChat(tools: unknown): JsonObject[] {
  if (!Array.isArray(tools)) throw new CodexModelGatewayChatError('gateway_chat_tools_invalid')
  return tools.map((tool) => {
    if (
      !isRecord(tool)
      || tool.type !== 'function'
      || typeof tool.name !== 'string'
      || !tool.name.trim()
      || !isRecord(tool.parameters)
      || Object.keys(tool).some((key) => (
        !['type', 'name', 'description', 'parameters', 'strict'].includes(key)
      ))
      || (tool.description !== undefined && typeof tool.description !== 'string')
      || (tool.strict !== undefined && typeof tool.strict !== 'boolean')
    ) {
      throw new CodexModelGatewayChatError('gateway_chat_tool_invalid')
    }
    return {
      type: 'function',
      function: {
        name: tool.name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        parameters: tool.parameters,
        ...(typeof tool.strict === 'boolean' ? { strict: tool.strict } : {}),
      },
    }
  })
}

function responsesToolChoiceToChat(toolChoice: unknown, toolNames: ReadonlySet<string>): unknown {
  if (typeof toolChoice === 'string') {
    if (['auto', 'none', 'required'].includes(toolChoice)) return toolChoice
    throw new CodexModelGatewayChatError('gateway_chat_tool_choice_invalid')
  }
  if (
    isRecord(toolChoice)
    && toolChoice.type === 'function'
    && typeof toolChoice.name === 'string'
    && toolChoice.name
    && toolNames.has(toolChoice.name)
    && Object.keys(toolChoice).every((key) => key === 'type' || key === 'name')
  ) {
    return { type: 'function', function: { name: toolChoice.name } }
  }
  throw new CodexModelGatewayChatError('gateway_chat_tool_choice_invalid')
}

export function responsesRequestToChat(input: {
  request: JsonObject
  snapshot: CodexUpstreamProfileSnapshot
}): JsonObject {
  if (typeof input.request.parallel_tool_calls !== 'boolean') {
    throw new CodexModelGatewayChatError('gateway_chat_parallel_tool_calls_invalid')
  }
  const tools = responsesToolsToChat(input.request.tools)
  const toolNames = new Set(tools.map((tool) => String((tool.function as JsonObject).name)))
  const config: AIModelConfig = {
    provider: input.snapshot.providerId as AIModelConfig['provider'],
    baseUrl: input.snapshot.baseUrl,
    apiKey: '',
    model: input.snapshot.model,
    agentProtocol: 'openai',
    wireApi: 'chat/completions',
    reasoningEffort: input.snapshot.reasoningEffort || undefined,
  }
  const patchProfile = input.snapshot.patchProfileId
    ? REGISTERED_PATCH_PROFILES.find((profile) => profile.profileId === input.snapshot.patchProfileId) || null
    : null
  const defaultPatchers = resolveProviderDefaultPatchers(input.snapshot.providerId)
  const body: JsonObject = {
    model: input.snapshot.model,
    messages: responsesInputToChatMessages(input.request.input, input.request.instructions),
    tools,
    tool_choice: responsesToolChoiceToChat(input.request.tool_choice, toolNames),
    parallel_tool_calls: input.request.parallel_tool_calls,
    stream: true,
    stream_options: { include_usage: true },
    ...(input.snapshot.maxOutputTokens ? { max_tokens: input.snapshot.maxOutputTokens } : {}),
    ...(input.snapshot.reasoningEffort ? { reasoning_effort: input.snapshot.reasoningEffort } : {}),
  }
  if ((body.tools as unknown[]).length === 0) {
    delete body.tools
    delete body.tool_choice
    delete body.parallel_tool_calls
  }
  return applyProviderRequestPatch(body, {
    config,
    baseUrl: input.snapshot.baseUrl,
    model: input.snapshot.model,
    profile: patchProfile,
    providerDefaultRequestPatcher: defaultPatchers.defaultRequestPatcher,
    providerDefaultResponsePatcher: defaultPatchers.defaultResponsePatcher,
  }) as JsonObject
}

type ToolState = {
  id: string
  name: string
  arguments: string
  matchedAuthorizedName: boolean
}

export class ProviderCredentialFilter {
  private credentialPending = ''
  private bearerPending = ''

  constructor(private readonly credential: string) {}

  push(value: string): string {
    return this.redactBearer(this.redactCredential(value, false), false)
  }

  flush(): string {
    return this.redactBearer(this.redactCredential('', true), true)
  }

  private redactCredential(value: string, flush: boolean): string {
    if (!this.credential) return value
    let remaining = this.credentialPending + value
    let output = ''
    let match = remaining.indexOf(this.credential)
    while (match >= 0) {
      output += `${remaining.slice(0, match)}[REDACTED]`
      remaining = remaining.slice(match + this.credential.length)
      match = remaining.indexOf(this.credential)
    }
    if (!flush) {
      let heldPrefixLength = 0
      const maximum = Math.min(this.credential.length - 1, remaining.length)
      for (let length = maximum; length > 0; length -= 1) {
        if (this.credential.startsWith(remaining.slice(-length))) {
          heldPrefixLength = length
          break
        }
      }
      output += remaining.slice(0, remaining.length - heldPrefixLength)
      this.credentialPending = heldPrefixLength > 0 ? remaining.slice(-heldPrefixLength) : ''
      return output
    }
    this.credentialPending = ''
    return output + remaining
  }

  private redactBearer(value: string, flush: boolean): string {
    const source = this.bearerPending + value
    const lower = source.toLowerCase()
    const marker = 'bearer'
    let output = ''
    let cursor = 0
    this.bearerPending = ''
    while (cursor < source.length) {
      const found = lower.indexOf(marker, cursor)
      if (found < 0) {
        let heldPrefixLength = 0
        if (!flush) {
          const maximum = Math.min(marker.length - 1, source.length - cursor)
          for (let length = maximum; length > 0; length -= 1) {
            if (marker.startsWith(lower.slice(-length))) {
              heldPrefixLength = length
              break
            }
          }
        }
        output += source.slice(cursor, source.length - heldPrefixLength)
        if (heldPrefixLength > 0) this.bearerPending = source.slice(-heldPrefixLength)
        break
      }
      output += source.slice(cursor, found)
      let next = found + marker.length
      if (next === source.length) {
        if (flush) output += source.slice(found)
        else this.bearerPending = source.slice(found)
        break
      }
      if (!/\s/.test(source[next])) {
        output += source[found]
        cursor = found + 1
        continue
      }
      while (next < source.length && /\s/.test(source[next])) next += 1
      if (next === source.length) {
        if (flush) output += source.slice(found)
        else this.bearerPending = source.slice(found)
        break
      }
      const quote = source[next] === '"' || source[next] === "'" ? source[next] : ''
      let tokenEnd = quote ? next + 1 : next
      while (
        tokenEnd < source.length
        && (
          quote
            ? source[tokenEnd] !== quote
            : !/\s/.test(source[tokenEnd]) && source[tokenEnd] !== '"' && source[tokenEnd] !== "'"
        )
      ) tokenEnd += 1
      if (tokenEnd === source.length && !flush) {
        this.bearerPending = source.slice(found)
        break
      }
      output += 'Bearer [REDACTED]'
      cursor = quote && tokenEnd < source.length ? tokenEnd + 1 : tokenEnd
    }
    return output
  }
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
  streamDeadlineMs?: number
  postTerminalDrainMs?: number
  admitToolResponse?: (calls: readonly Readonly<{
    codexCallId: string
    toolName: string
    argsDigest: string
  }>[]) => Promise<void>
  recordCompleted?: (evidence: CodexModelGatewayResponseEvidence) => Promise<void>
}): Promise<void> {
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
  let events = 0
  const maxBytes = input.maxBytes || 8 * 1024 * 1024
  const maxEvents = input.maxEvents || 4_096
  const streamDeadlineMs = input.streamDeadlineMs || 120_000
  const postTerminalDrainMs = input.postTerminalDrainMs || 1_000
  const startedAt = Date.now()
  let terminalAt: number | null = null
  let sawExpectedModel = false
  const preSemanticState = createCodexChatPreSemanticState()
  const tools = new Map<number, ToolState>()
  const seenToolIds = new Set<string>()
  const messageFilter = new ProviderCredentialFilter(input.credential)
  const reasoningFilter = new ProviderCredentialFilter(input.credential)
  input.write(event('response.created', {
    response: { id: responseId, model: input.snapshot.model, status: 'in_progress', output: [] },
  }))

  const fail = (code: string, details?: JsonObject): false => {
    input.write(responseFailed(responseId, input.snapshot.model, input.credential, code, details))
    input.abort()
    return false
  }

  const readNext = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    const deadline = terminalAt === null
      ? startedAt + streamDeadlineMs
      : Math.min(startedAt + streamDeadlineMs, terminalAt + postTerminalDrainMs)
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new CodexModelGatewayChatError(
        terminalAt === null ? 'gateway_chat_stream_deadline' : 'gateway_chat_post_terminal_timeout',
      )
    }
    let timeout: ReturnType<typeof setTimeout> | null = null
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new CodexModelGatewayChatError(
            terminalAt === null ? 'gateway_chat_stream_deadline' : 'gateway_chat_post_terminal_timeout',
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
        events += 1
        if (events > maxEvents) throw new CodexModelGatewayChatError('gateway_chat_event_limit_exceeded')
        if (raw === '[DONE]') {
          if (sawDone) return void fail('gateway_chat_done_duplicate')
          sawDone = true
          terminalAt = Date.now()
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
            if (typeof fn.arguments === 'string') current.arguments += fn.arguments
            tools.set(index, current)
          }
          if (choice.finish_reason !== undefined && choice.finish_reason !== null) choiceFinished = true
        }
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
