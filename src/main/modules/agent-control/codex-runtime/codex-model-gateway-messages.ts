import type { CodexUpstreamProfileSnapshot } from './codex-model-gateway-contract'
import { applyKimiK3AnthropicHeaders, applyKimiK3AnthropicRequestContract } from '../../../../shared/ai-providers/kimi-k3'
import type { AIModelConfig } from '../../../../shared/ai-providers'

type ObjectValue = Record<string, any>
const HISTORY_PREFIX = 'ready-anthropic:v1:'

export class CodexMessagesError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'CodexMessagesError' }
}
function reject(reason: string): never { throw new CodexMessagesError(`gateway_messages_${reason}`) }
function record(value: unknown): value is ObjectValue { return !!value && typeof value === 'object' && !Array.isArray(value) }
function text(value: unknown): string { if (typeof value !== 'string') reject('text_invalid'); return value }
function integer(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 0) reject('integer_invalid'); return Number(value) }
function config(snapshot: CodexUpstreamProfileSnapshot): AIModelConfig {
  return { provider: snapshot.providerId as AIModelConfig['provider'], baseUrl: snapshot.baseUrl, model: snapshot.model, apiKey: '', agentProtocol: 'anthropic', reasoningEffort: snapshot.reasoningEffort || undefined }
}
export function messagesHeaders(snapshot: CodexUpstreamProfileSnapshot): Record<string, string> {
  const headers = { ...snapshot.extraHeaders }
  applyKimiK3AnthropicHeaders(headers, config(snapshot))
  return headers
}
function thinkingBlock(value: unknown): ObjectValue {
  if (!record(value)) reject('thinking_invalid')
  if (value.type === 'redacted_thinking' && typeof value.data === 'string') return { type: value.type, data: value.data }
  if (value.type !== 'thinking' || typeof value.thinking !== 'string' || typeof value.signature !== 'string' || !value.signature) reject('thinking_signature_missing')
  return { type: 'thinking', thinking: value.thinking, signature: value.signature }
}
function content(value: unknown): ObjectValue[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  if (!Array.isArray(value)) reject('content_invalid')
  return value.map((part) => {
    if (!record(part)) reject('content_invalid')
    if (['input_text', 'output_text'].includes(part.type)) return { type: 'text', text: text(part.text) }
    if (part.type === 'input_image') {
      const url = text(part.image_url)
      const data = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(url)
      if (data) return { type: 'image', source: { type: 'base64', media_type: data[1], data: data[2] } }
      if (/^https?:\/\//.test(url)) return { type: 'image', source: { type: 'url', url } }
    }
    reject('content_unsupported')
  })
}

export function responsesRequestToMessages(request: ObjectValue, snapshot: CodexUpstreamProfileSnapshot): ObjectValue {
  if (!Array.isArray(request.input) || !Array.isArray(request.tools)) reject('request_invalid')
  const system: ObjectValue[] = request.instructions ? [{ type: 'text', text: text(request.instructions) }] : []
  const messages: ObjectValue[] = []
  const calls = new Set<string>()
  const pending = new Set<string>()
  const append = (role: string, blocks: ObjectValue[]) => {
    if (messages.at(-1)?.role === role) messages.at(-1)!.content.push(...blocks)
    else messages.push({ role, content: blocks })
  }
  for (const item of request.input) {
    if (!record(item)) reject('input_invalid')
    if (item.type === 'function_call_output') {
      if (!pending.delete(item.call_id)) reject('tool_result_unbound')
      append('user', [{ type: 'tool_result', tool_use_id: item.call_id, content: typeof item.output === 'string' ? item.output : content(item.output) }])
    } else if (item.type === 'function_call') {
      if (messages.at(-1)?.role === 'user' && pending.size) reject('tool_result_order_invalid')
      if (!item.call_id || calls.has(item.call_id) || !item.name) reject('tool_identity_invalid')
      let args: unknown
      try { args = JSON.parse(text(item.arguments)) } catch {
        // silent-catch: reject() rethrows the unparseable arguments as gateway_messages_tool_arguments_invalid
        reject('tool_arguments_invalid')
      }
      if (!record(args)) reject('tool_arguments_invalid')
      calls.add(item.call_id); pending.add(item.call_id)
      append('assistant', [{ type: 'tool_use', id: item.call_id, name: item.name, input: args }])
    } else {
      if (pending.size) reject('tool_result_missing')
      if (item.type === 'reasoning') {
        if (typeof item.encrypted_content !== 'string' || !item.encrypted_content.startsWith(HISTORY_PREFIX)) reject('reasoning_history_invalid')
        let saved: ObjectValue
        try { saved = JSON.parse(Buffer.from(item.encrypted_content.slice(HISTORY_PREFIX.length), 'base64').toString('utf8')) } catch {
          // silent-catch: reject() rethrows the undecodable reasoning history as gateway_messages_reasoning_history_invalid
          reject('reasoning_history_invalid')
        }
        if (saved.model !== snapshot.model || !Array.isArray(saved.blocks)) reject('reasoning_history_invalid')
        append('assistant', saved.blocks.map(thinkingBlock))
      } else if (item.type === 'message') {
        const blocks = content(item.content)
        if (item.role === 'developer' || item.role === 'system') {
          if (blocks.some((block) => block.type !== 'text')) reject('system_content_invalid')
          system.push(...blocks)
        } else if (item.role === 'user' || item.role === 'assistant') append(item.role, blocks)
        else reject('role_invalid')
      } else reject('input_unsupported')
    }
  }
  if (pending.size) reject('tool_result_missing')
  const tools = request.tools.map((tool: ObjectValue) => {
    if (tool.type !== 'function' || !tool.name || !record(tool.parameters)) reject('tool_invalid')
    return { name: tool.name, description: tool.description || '', input_schema: tool.parameters }
  })
  const maxTokens = snapshot.maxOutputTokens || 4096
  const body: ObjectValue = { model: snapshot.model, system, messages, stream: true, max_tokens: maxTokens }
  if (tools.length && request.tool_choice !== 'none') {
    body.tools = tools
    const choice = request.tool_choice
    body.tool_choice = { ...(record(choice) && choice.type === 'function' ? { type: 'tool', name: choice.name } : { type: choice === 'required' ? 'any' : 'auto' }), disable_parallel_tool_use: request.parallel_tool_calls !== true }
  }
  if (snapshot.supportsThinking && snapshot.reasoningEffort) {
    if (snapshot.reasoningEffort === 'none') body.thinking = { type: 'disabled' }
    else if (snapshot.model === 'claude-opus-5-5') {
      body.thinking = { type: 'adaptive' }
      body.output_config = { effort: snapshot.reasoningEffort === 'minimal' ? 'low' : snapshot.reasoningEffort }
    } else {
      if (maxTokens <= 1024) reject('thinking_budget_invalid')
      const budget = { minimal: 1024, low: 1024, medium: 2048, high: 4096, xhigh: 8192, max: 16384 }[snapshot.reasoningEffort]
      body.thinking = { type: 'enabled', budget_tokens: Math.min(maxTokens - 1, budget) }
    }
  }
  applyKimiK3AnthropicRequestContract(body, config(snapshot))
  return body
}

/** One upstream message becomes one Responses stream. Never executes or loops tools. */
export function messagesAsResponses(body: ReadableStream<Uint8Array>, expectedModel: string, limits: { maxBytes: number; maxEvents: number; maxItemBytes: number }): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const encoder = new TextEncoder()
  let buffer = '', responseId = '', model = '', stopReason = ''
  let bytes = 0, structural = 0, sequence = 0, stopped = false
  let usage: ObjectValue = {}
  const blocks: Array<{ source: ObjectValue; item: ObjectValue; text: string; signature: string; done: boolean }> = []
  const event = (type: string, fields: ObjectValue) => ({ type, sequence_number: sequence++, ...fields })
  const response = (status: string) => ({ id: responseId, model, status, output: status === 'in_progress' ? [] : blocks.map((block) => block.item) })
  const feed = (input: ObjectValue): ObjectValue[] => {
    if (!record(input) || typeof input.type !== 'string' || stopped) reject('event_invalid')
    if (!input.type.endsWith('_delta') && ++structural > limits.maxEvents) reject('event_limit_exceeded')
    if (input.type === 'ping') return []
    if (input.type === 'error') reject('provider_stream_error')
    if (input.type === 'message_start') {
      if (responseId || !record(input.message) || !input.message.id || input.message.model !== expectedModel || input.message.content?.length) reject('message_start_invalid')
      responseId = text(input.message.id); model = input.message.model; usage = input.message.usage || {}
      return [event('response.created', { response: response('in_progress') })]
    }
    if (!responseId || stopReason && input.type !== 'message_stop') reject('event_order_invalid')
    if (input.type === 'content_block_start') {
      const index = integer(input.index), source = input.content_block
      if (index !== blocks.length || !record(source) || blocks.some((block) => !block.done)) reject('block_order_invalid')
      const id = `item_${responseId}_${index}`
      let item: ObjectValue
      if (source.type === 'text') item = { type: 'message', id, role: 'assistant', status: 'in_progress', content: [] }
      else if (source.type === 'tool_use') {
        if (!source.id || !source.name || !record(source.input) || Object.keys(source.input).length) reject('tool_start_invalid')
        item = { type: 'function_call', id, call_id: source.id, name: source.name, arguments: '', status: 'in_progress' }
      } else if (source.type === 'thinking' || source.type === 'redacted_thinking') item = { type: 'reasoning', id, summary: [], ...(source.type === 'thinking' ? { content: [] } : {}), status: 'in_progress' }
      else reject('block_unsupported')
      blocks.push({ source, item, text: source.type === 'text' ? text(source.text) : source.thinking || '', signature: source.signature || '', done: false })
      const out = [event('response.output_item.added', { output_index: index, item: { ...item } })]
      if (source.type === 'text' && source.text) out.push(event('response.output_text.delta', { output_index: index, item_id: id, content_index: 0, delta: source.text }))
      return out
    }
    if (input.type === 'content_block_delta' || input.type === 'content_block_stop') {
      const index = integer(input.index), block = blocks[index]
      if (!block || block.done || index !== blocks.length - 1) reject('block_identity_invalid')
      const ref = { output_index: index, item_id: block.item.id }
      if (input.type === 'content_block_delta') {
        const delta = input.delta
        if (!record(delta)) reject('delta_invalid')
        if (delta.type === 'signature_delta' && block.source.type === 'thinking') block.signature += text(delta.signature)
        else if (delta.type === 'thinking_delta' && block.source.type === 'thinking') block.text += text(delta.thinking)
        else if (delta.type === 'text_delta' && block.source.type === 'text') block.text += text(delta.text)
        else if (delta.type === 'input_json_delta' && block.source.type === 'tool_use') block.text += text(delta.partial_json)
        else reject('delta_invalid')
        if (Buffer.byteLength(block.text + block.signature) > limits.maxItemBytes) reject('item_too_large')
        if (block.source.type === 'text') return [event('response.output_text.delta', { ...ref, content_index: 0, delta: delta.text })]
        if (block.source.type === 'tool_use') return [event('response.function_call_arguments.delta', { ...ref, delta: delta.partial_json })]
        // Raw thinking is native history, never visible summary text.
        return delta.type === 'thinking_delta' ? [event('response.reasoning_text.delta', { ...ref, content_index: 0, delta: delta.thinking })] : []
      }
      block.done = true
      block.item = { ...block.item, status: 'completed' }
      const out: ObjectValue[] = []
      if (block.source.type === 'text') {
        block.item.content = [{ type: 'output_text', text: block.text }]
        out.push(event('response.output_text.done', { ...ref, content_index: 0, text: block.text }))
      } else if (block.source.type === 'tool_use') {
        if (!block.text) { block.text = '{}'; out.push(event('response.function_call_arguments.delta', { ...ref, delta: '{}' })) }
        block.item.arguments = block.text
        out.push(event('response.function_call_arguments.done', { ...ref, arguments: block.text }))
      } else {
        if (block.source.type === 'thinking') {
          block.item.content = [{ type: 'reasoning_text', text: block.text }]
          out.push(event('response.reasoning_text.done', { ...ref, content_index: 0, text: block.text }))
        }
        const saved = thinkingBlock(block.source.type === 'thinking' ? { type: 'thinking', thinking: block.text, signature: block.signature } : block.source)
        block.item.encrypted_content = HISTORY_PREFIX + Buffer.from(JSON.stringify({ model, blocks: [saved] })).toString('base64')
      }
      out.push(event('response.output_item.done', { output_index: index, item: block.item }))
      return out
    }
    if (input.type === 'message_delta') {
      if (blocks.some((block) => !block.done) || !record(input.delta) || typeof input.delta.stop_reason !== 'string') reject('stop_invalid')
      stopReason = input.delta.stop_reason
      usage = { ...usage, ...input.usage }
      return []
    }
    if (input.type === 'message_stop') {
      if (!['end_turn', 'tool_use', 'stop_sequence', 'max_tokens'].includes(stopReason)) reject('stop_reason_unsupported')
      const hasTools = blocks.some((block) => block.source.type === 'tool_use')
      if ((stopReason === 'tool_use') !== hasTools && stopReason !== 'max_tokens') reject('stop_reason_mismatch')
      const inputTokens = integer(usage.input_tokens) + integer(usage.cache_read_input_tokens || 0) + integer(usage.cache_creation_input_tokens || 0)
      const outputTokens = integer(usage.output_tokens)
      const status = stopReason === 'max_tokens' ? 'incomplete' : 'completed'
      stopped = true
      return [event(`response.${status}`, { response: { ...response(status), ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}), usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens, input_tokens_details: { cached_tokens: usage.cache_read_input_tokens || 0 }, output_tokens_details: { reasoning_tokens: 0 } } } })]
    }
    reject('event_unsupported')
  }
  return new ReadableStream({
    async pull(controller) {
      try {
        while (!stopped) {
          const boundary = buffer.indexOf('\n\n')
          if (boundary >= 0) {
            const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
            const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
            if (!data) continue
            const payload = JSON.parse(data)
            const name = block.split('\n').find((line) => line.startsWith('event:'))?.slice(6).trim()
            if (name && name !== payload.type) reject('event_name_mismatch')
            const events = feed(payload)
            if (events.length) {
              controller.enqueue(encoder.encode(events.map((value) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join('')))
              if (stopped) { await reader.cancel(); reader.releaseLock(); controller.close() }
              return
            }
          } else {
            const next = await reader.read()
            if (next.done) reject('terminal_missing')
            bytes += next.value.byteLength
            if (bytes > limits.maxBytes) reject('stream_too_large')
            buffer += decoder.decode(next.value, { stream: true })
            buffer = buffer.replace(/\r\n/g, '\n')
          }
        }
      } catch (error) { await reader.cancel().catch(() => undefined); reader.releaseLock(); controller.error(error) }
    },
    async cancel(reason) { if (!stopped) { await reader.cancel(reason); reader.releaseLock() } },
  })
}
