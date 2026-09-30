/**
 * P0-0 (2026-07-02 provider true SSE contract) — pure incremental SSE
 * machinery for the Ready provider models' streaming path.
 *
 * Everything here is IO-free apart from consuming the ReadableStream the
 * caller hands in: the parser turns bytes into SSE events, and the three
 * accumulators turn provider-specific stream events into (a) immediate text
 * deltas and (b) a final synthetic JSON payload that is SHAPE-IDENTICAL to
 * what the blocking (non-stream) HTTP path parses. The provider file then
 * runs the exact same response-shaping code over that payload, so streaming
 * and blocking may only differ in WHEN text becomes visible — never in what
 * the model loop ultimately sees.
 *
 * Block semantics mirror `parseEventStreamPayload` (openai-responses.ts):
 * `event:`/`data:` lines, multi-line data joined with \n, CRLF tolerated,
 * `:` comment lines ignored (but they still count as byte activity for the
 * idle guard), `[DONE]` surfaced verbatim for the caller to treat as EOF.
 */

/** Idle guard: abort a stream that produces NO bytes for this long. Any
 *  arriving bytes — including SSE comments / ping events — reset it. The
 *  fetch-level timeout only covers time-to-headers (direct-chat.ts
 *  fetchWithTimeout clears its timer once headers resolve), so without this
 *  guard a stalled stream would hang a run forever. */
export const STREAM_IDLE_TIMEOUT_MS = 120_000

export interface SseStreamEvent {
  event: string
  data: string
}

export interface ParseSseStreamOptions {
  signal?: AbortSignal
  idleTimeoutMs?: number
  /** Used in the idle-timeout error message, mirroring fetchWithTimeout. */
  label?: string
}

function buildAbortError(reason: unknown): Error {
  if (reason instanceof Error) return reason
  const error = new Error('stream aborted')
  error.name = 'AbortError'
  return error
}

/**
 * Incrementally parse a byte stream into SSE events. Yields one event per
 * SSE block that carries a non-empty `data`. `[DONE]` is yielded verbatim.
 * Throws on caller abort (propagating `signal.reason`) and on idle timeout.
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  options: ParseSseStreamOptions = {},
): AsyncGenerator<SseStreamEvent> {
  const idleTimeoutMs = options.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS
  const label = options.label || 'provider stream'
  const signal = options.signal
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  const onAbort = () => {
    void reader.cancel(signal?.reason).catch(() => { /* already closed */ })
  }
  if (signal) {
    if (signal.aborted) {
      onAbort()
      throw buildAbortError(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  }

  let buffer = ''

  const takeBlocks = (): string[] => {
    const blocks: string[] = []
    while (true) {
      const match = buffer.match(/\r?\n\r?\n/)
      if (!match || match.index === undefined) break
      blocks.push(buffer.slice(0, match.index))
      buffer = buffer.slice(match.index + match[0].length)
    }
    return blocks
  }

  const parseBlock = (block: string): SseStreamEvent | null => {
    if (!block.trim()) return null
    let eventName = ''
    const dataLines: string[] = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(':')) continue // SSE comment / keep-alive
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim()
        continue
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart())
      }
    }
    const data = dataLines.join('\n').trim()
    if (!data) return null
    return { event: eventName, data }
  }

  const readWithIdleGuard = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const idle = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Reject FIRST: reader.cancel() synchronously settles the pending
        // read() with {done:true}, and Promise.race would then resolve with
        // that instead of this rejection — the guard would never fire.
        reject(new Error(`${label} 流式响应空闲超时（>${Math.floor(idleTimeoutMs / 1000)}s）`))
        void reader.cancel().catch(() => { /* already closed */ })
      }, idleTimeoutMs)
    })
    try {
      return await Promise.race([reader.read(), idle])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  try {
    while (true) {
      const { done, value } = await readWithIdleGuard()
      if (signal?.aborted) throw buildAbortError(signal.reason)
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      for (const block of takeBlocks()) {
        const event = parseBlock(block)
        if (event) yield event
      }
    }
    // Flush a trailing block for servers that end without a blank line.
    buffer += decoder.decode()
    const tail = parseBlock(buffer)
    buffer = ''
    if (tail) yield tail
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort)
    void reader.cancel().catch(() => { /* already closed */ })
  }
}

export interface StreamFeedResult {
  /** Text that became visible with this event — yield it downstream now. */
  textDelta?: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

// ── OpenAI chat completions ─────────────────────────────────────────────────

interface ChatToolCallSlot {
  id?: string
  type?: string
  name: string
  arguments: string
}

/**
 * Accumulates `chat.completion.chunk` payloads. `final()` synthesizes the
 * non-streaming completion JSON the blocking path parses:
 * `{ id, choices:[{ message:{ content, tool_calls?, reasoning_content?,
 * reasoning_details? }, finish_reason? }], usage? }`.
 */
export class ChatCompletionsStreamAccumulator {
  private id: string | null = null
  private content = ''
  private reasoningContent = ''
  private reasoningDetails: unknown[] = []
  private readonly toolCalls = new Map<number, ChatToolCallSlot>()
  private usage: Record<string, unknown> | null = null
  private finishReason: string | null = null

  get isComplete(): boolean { return this.finishReason !== null }

  feed(chunk: Record<string, unknown>): StreamFeedResult {
    if (!this.id && typeof chunk.id === 'string' && chunk.id) this.id = chunk.id
    const usage = asRecord(chunk.usage)
    if (usage) this.usage = usage
    const choices = Array.isArray(chunk.choices) ? chunk.choices : []
    const choice = asRecord(choices[0])
    if (!choice) return {}
    if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
      this.finishReason = choice.finish_reason
    }
    // Standard streams carry `delta`; some gateways echo a full `message`
    // object per chunk instead — treat it as a delta-shaped record.
    const delta = asRecord(choice.delta) || asRecord(choice.message)
    if (!delta) return {}
    let textDelta: string | undefined
    if (typeof delta.content === 'string' && delta.content) {
      this.content += delta.content
      textDelta = delta.content
    }
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      this.reasoningContent += delta.reasoning_content
    }
    if (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length > 0) {
      this.reasoningDetails.push(...delta.reasoning_details)
    }
    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
    for (const raw of toolCalls) {
      const record = asRecord(raw)
      if (!record) continue
      const index = typeof record.index === 'number' ? record.index : this.toolCalls.size
      const slot = this.toolCalls.get(index) || { name: '', arguments: '' }
      if (typeof record.id === 'string' && record.id) slot.id = record.id
      if (typeof record.type === 'string' && record.type) slot.type = record.type
      const fn = asRecord(record.function)
      if (fn) {
        if (typeof fn.name === 'string' && fn.name) slot.name += fn.name
        if (typeof fn.arguments === 'string') slot.arguments += fn.arguments
      }
      this.toolCalls.set(index, slot)
    }
    return { textDelta }
  }

  final(): Record<string, unknown> {
    const message: Record<string, unknown> = { role: 'assistant', content: this.content }
    if (this.reasoningContent) message.reasoning_content = this.reasoningContent
    if (this.reasoningDetails.length > 0) message.reasoning_details = this.reasoningDetails
    if (this.toolCalls.size > 0) {
      message.tool_calls = [...this.toolCalls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, call]) => ({
          ...(call.id ? { id: call.id } : {}),
          type: call.type || 'function',
          function: { name: call.name, arguments: call.arguments },
        }))
    }
    const json: Record<string, unknown> = {
      choices: [{
        message,
        ...(this.finishReason ? { finish_reason: this.finishReason } : {}),
      }],
    }
    if (this.id) json.id = this.id
    if (this.usage) json.usage = this.usage
    return json
  }
}

// ── OpenAI responses API ────────────────────────────────────────────────────

/**
 * Accumulates responses-API stream events. Text deltas surface from
 * `response.output_text.delta`; the terminal payload comes from
 * `response.completed` (event name or record.type). A last partial payload
 * must never stand in for the missing terminal response.
 */
export class ResponsesStreamAccumulator {
  private completed: Record<string, unknown> | null = null

  feed(eventName: string, data: Record<string, unknown>): StreamFeedResult {
    const type = typeof data.type === 'string' && data.type ? data.type : eventName
    if (type === 'response.output_text.delta') {
      const delta = typeof data.delta === 'string' ? data.delta : ''
      return delta ? { textDelta: delta } : {}
    }
    const candidate = asRecord(data.response) || data
    if (type === 'response.completed') {
      this.completed = candidate
      return {}
    }
    return {}
  }

  /** Only a confirmed terminal response can be shaped as completion. */
  final(): Record<string, unknown> | null {
    return this.completed
  }
}

// ── Anthropic messages API ──────────────────────────────────────────────────

interface AnthropicBlockSlot {
  type: string
  text: string
  partialJson: string
  block: Record<string, unknown>
}

/**
 * Rebuilds the non-streaming `/v1/messages` payload from stream events:
 * `{ id, content: [...blocks], usage, stop_reason? }`. Only text blocks
 * surface live deltas; tool_use input JSON and thinking blocks accumulate
 * silently and land in the final payload for the blocking-path extractor.
 */
export class AnthropicStreamAccumulator {
  private id: string | null = null
  private readonly blocks = new Map<number, AnthropicBlockSlot>()
  private readonly usage: Record<string, unknown> = {}
  private stopReason: string | null = null
  private stopped = false

  get isComplete(): boolean { return this.stopped }

  feed(eventName: string, data: Record<string, unknown>): StreamFeedResult {
    const type = typeof data.type === 'string' && data.type ? data.type : eventName
    if (type === 'message_stop') { this.stopped = true; return {} }
    if (type === 'message_start') {
      const message = asRecord(data.message)
      if (message) {
        if (typeof message.id === 'string' && message.id) this.id = message.id
        const usage = asRecord(message.usage)
        if (usage) Object.assign(this.usage, usage)
      }
      return {}
    }
    if (type === 'content_block_start') {
      const index = typeof data.index === 'number' ? data.index : this.blocks.size
      const block = asRecord(data.content_block) || {}
      this.blocks.set(index, {
        type: typeof block.type === 'string' ? block.type : '',
        text: typeof block.text === 'string' ? block.text : '',
        partialJson: '',
        block: { ...block },
      })
      return {}
    }
    if (type === 'content_block_delta') {
      const index = typeof data.index === 'number' ? data.index : -1
      const slot = this.blocks.get(index)
      const delta = asRecord(data.delta)
      if (!slot || !delta) return {}
      const deltaType = typeof delta.type === 'string' ? delta.type : ''
      if (deltaType === 'text_delta' && typeof delta.text === 'string' && delta.text) {
        slot.text += delta.text
        return slot.type === 'text' ? { textDelta: delta.text } : {}
      }
      if (deltaType === 'input_json_delta' && typeof delta.partial_json === 'string') {
        slot.partialJson += delta.partial_json
        return {}
      }
      if (deltaType === 'thinking_delta' && typeof delta.thinking === 'string') {
        slot.block.thinking = `${typeof slot.block.thinking === 'string' ? slot.block.thinking : ''}${delta.thinking}`
        return {}
      }
      if (deltaType === 'signature_delta' && typeof delta.signature === 'string') {
        slot.block.signature = `${typeof slot.block.signature === 'string' ? slot.block.signature : ''}${delta.signature}`
        return {}
      }
      return {}
    }
    if (type === 'message_delta') {
      const usage = asRecord(data.usage)
      if (usage) Object.assign(this.usage, usage)
      const delta = asRecord(data.delta)
      if (delta && typeof delta.stop_reason === 'string' && delta.stop_reason) {
        this.stopReason = delta.stop_reason
      }
      return {}
    }
    // ping / content_block_stop / message_stop / error(由调用方前置处理)
    return {}
  }

  final(fallbackId: string): Record<string, unknown> {
    const content = [...this.blocks.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, slot]) => {
        if (slot.type === 'text') {
          return { type: 'text', text: slot.text }
        }
        if (slot.type === 'tool_use') {
          let input: unknown = slot.block.input ?? {}
          if (slot.partialJson) {
            try {
              input = JSON.parse(slot.partialJson)
            } catch {
              // silent-catch: truncated partial tool JSON finalizes as empty input
              input = {}
            }
          }
          return { ...slot.block, type: 'tool_use', input }
        }
        return { ...slot.block, ...(slot.text ? { text: slot.text } : {}) }
      })
    return {
      id: this.id || fallbackId,
      content,
      usage: { ...this.usage },
      ...(this.stopReason ? { stop_reason: this.stopReason } : {}),
    }
  }
}
