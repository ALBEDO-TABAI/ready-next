import { randomUUID } from 'crypto'
import OpenAI from 'openai'
import { isProviderOutputIncomplete, ProviderOutputIncompleteError } from './provider-output-status'
import {
  OpenAIProvider,
  Usage,
  tool,
  type Model,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent
} from '@openai/agents'
import type { AgentSdkRuntimeDeps } from './agent-sdk-types'
import {
  getProviderDef,
  normalizeMaxOutputTokens,
  normalizeAIConfig,
  resolveMaxOutputTokens,
  resolveAIConfigCapabilities,
  type AIModelConfig,
  type AIProviderDef
} from '../../../../shared/ai-providers'
import {
  applyProviderRequestPatch,
  applyProviderResponsePatch,
  resolveProviderDefaultPatchers,
  resolveProviderPatchProfile,
  type PatchContext
} from '../../../../shared/ai-providers/index'
import { parseJsonOrEventStreamResponse, parseJsonOrEventStreamText } from '../../openai-responses'
import {
  AnthropicStreamAccumulator,
  ChatCompletionsStreamAccumulator,
  ResponsesStreamAccumulator,
  parseSseStream
} from './provider-sse'
import {
  buildChatCompletionsToolCalls,
  buildResponsesToolCalls
} from '../../claude-bridge/provider-tool-arguments'
import { buildProviderHttpError } from '../../claude-bridge/provider-terminal-error'
import { resolveOpenAIProviderRuntime } from '../provider-runtime-resolver'
import { assertManualThinkingModeProviderSafe } from '../thinking-compatibility'
import { logAgentMetric } from '../metrics'
import {
  extractAnthropicOutput,
  sanitizeMessagesForModelClient,
  modelInputToOpenAIChatMessages,
  modelInputToOpenAIResponsesInput,
  modelInputToAnthropicMessages,
  serializeSdkOpenAITools,
  serializeSdkOpenAIResponsesTools,
  openAIUsageFromJson,
  toOpenAIMessageOutput,
  toOpenAIFunctionCallOutput,
  buildProviderPatchContext,
  buildProviderHeaders,
  isEventStreamLikeResponse,
  buildProviderProtocolMismatchError,
  resolveOpenAIProtocolModel,
  textFromAgentOutputItem,
  extractResponsesText,
  stringifyModelVisibleFunctionResult,
  normalizeOpenAIChatContent,
  normalizeOpenAIResponsesContent,
  normalizeAnthropicContent,
  serializeAnthropicTools,
  sanitizeAnthropicThinkingBlock,
  readAnthropicThinkingBlocksFromRecord,
  contentPartToAnthropic,
  safeJsonParseObject,
  dataUrlToAnthropicImage,
  readReasoningContentFromRecord,
  reasoningProviderData,
  nonEmptyString,
  continuationChildRunId,
  continuationRunStatePath,
  asRecord,
  stringField
} from './agent-sdk-utils'

// Minimal debug log for provider module (avoids dependency on main file's agentSdkLogger).
export function log(message: string): void {
  console.log(`[agent-sdk-provider] ${message}`)
}

export { runWithOpenAIAgentsSdk, usageFromModelResponse } from './agent-sdk-provider-runner'

// ── P0-0 true SSE streaming shared helpers ──

/** P0-0 kill switch: `READY_SDK_TRUE_SSE=off` reverts every Ready model to
 *  the legacy pseudo-stream (blocking fetch → one big delta). Read per call
 *  so tests and live rollback need no restart-time wiring. */
export function resolveTrueSseMode(): 'on' | 'off' {
  return process.env.READY_SDK_TRUE_SSE === 'off' ? 'off' : 'on'
}

/** Terminal stream event — same literal shape the pseudo path has always
 *  emitted; the SDK Runner assembles conversation output items from it. */
function buildResponseDoneEvent(response: ModelResponse, fallbackId: string): StreamEvent {
  return {
    type: 'response_done',
    response: {
      id: response.responseId || fallbackId,
      requestId: response.requestId,
      providerData: response.providerData,
      usage: {
        requests: response.usage.requests,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        totalTokens: response.usage.totalTokens,
        inputTokensDetails: {},
        outputTokensDetails: {}
      },
      output: response.output
    }
  } as StreamEvent
}

/** Legacy/degrade emission: whole-response text as one delta per output
 *  item, then response_done — byte-parity with the pre-P0-0 pseudo stream. */
function* pseudoStreamEventsFromModelResponse(
  response: ModelResponse,
  fallbackId: string
): Generator<StreamEvent> {
  for (const item of response.output) {
    const text = textFromAgentOutputItem(item)
    if (text) {
      yield { type: 'output_text_delta', delta: text } as StreamEvent
    }
  }
  yield buildResponseDoneEvent(response, fallbackId)
}

function safeParseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** In-band stream error payloads (`{error:{…}}` chunks / anthropic `error`
 *  events) must fail loud with the provider message, not be swallowed. */
function providerStreamPayloadError(record: Record<string, unknown>): Error | null {
  const errorField =
    record.error && typeof record.error === 'object'
      ? (record.error as Record<string, unknown>)
      : null
  if (!errorField && record.type !== 'error') return null
  const source = errorField || record
  const message =
    typeof source.message === 'string' && source.message
      ? source.message
      : JSON.stringify(source).slice(0, 200)
  return new Error(`模型流式响应返回错误：${message}`)
}

function isEventStreamContentType(response: Response): boolean {
  return String(response.headers.get('content-type') || '')
    .toLowerCase()
    .includes('text/event-stream')
}

/** Rung-2 scope guard: only a 4xx that plausibly rejects the STREAM REQUEST
 *  SHAPE (unknown `stream`/`stream_options` field) may retry once via the
 *  blocking path. Semantic 4xx must bubble unchanged — 413 overflow feeds the
 *  orchestrator's compaction retry, 401/403 stay zero-retry, 429 stays with
 *  upstream backoff classification. */
function isLikelyStreamShapeRejection(status: number, errorBody: string): boolean {
  if (status !== 400 && status !== 404 && status !== 405 && status !== 415 && status !== 422)
    return false
  return /stream/i.test(errorBody)
}

// ── Resolve provider (line 2124) ──

export function resolveAgentSdkProvider(
  config: AIModelConfig,
  deps: { fetchWithTimeout: NonNullable<AgentSdkRuntimeDeps['fetchWithTimeout']>; openAIClientMaxRetries?: number }
): {
  provider: ModelProvider
  model: string
} {
  const normalized = normalizeAIConfig(config)
  const capabilities = resolveAIConfigCapabilities(normalized)
  if (!normalized || !capabilities) {
    throw new Error('当前 SDK 路径无法解析 AI 配置。')
  }

  const baseURL = String(capabilities.baseUrl || normalized.baseUrl || '')
    .trim()
    .replace(/\/+$/, '')
  if (capabilities.agentProtocol === 'anthropic') {
    return {
      model: normalized.model,
      provider: new ReadyAnthropicModelProvider({
        config: normalized,
        baseUrl: baseURL,
        fetchWithTimeout: deps.fetchWithTimeout
      })
    }
  }
  if (capabilities.agentProtocol !== 'openai') {
    throw new Error('当前 SDK 路径暂不支持该模型协议配置。')
  }
  // Our chat adapter retains finish_reason; the SDK chat adapter drops it.
  if (normalized.provider !== 'openai' || capabilities.wireApi === 'chat/completions') {
    return {
      model: normalized.model,
      provider: new ReadyOpenAICompatibleModelProvider({
        config: normalized,
        baseUrl: baseURL,
        fetchWithTimeout: deps.fetchWithTimeout
      })
    }
  }
  return {
    model: normalized.model,
    provider: new OpenAIProvider({
      ...(deps.openAIClientMaxRetries === undefined ? {
        apiKey: normalized.apiKey, baseURL: baseURL || undefined,
      } : { openAIClient: new OpenAI({
        apiKey: normalized.apiKey, baseURL: baseURL || undefined, maxRetries: deps.openAIClientMaxRetries,
      }) }),
      useResponses: capabilities.wireApi === 'responses',
      strictFeatureValidation: false
    })
  }
}

// ── ReadyOpenAICompatibleModelProvider (line 3254, NOT exported) ──

class ReadyOpenAICompatibleModelProvider implements ModelProvider {
  constructor(
    private readonly deps: {
      config: AIModelConfig
      baseUrl: string
      fetchWithTimeout: NonNullable<AgentSdkRuntimeDeps['fetchWithTimeout']>
    }
  ) {}

  getModel(): Model {
    return new ReadyOpenAICompatibleModel(this.deps)
  }
}

// ── ReadyOpenAICompatibleModel (line 3266, exported) ──

/** Blocking-path response shaping, shared verbatim by the streaming path
 *  (P0-0 contract assumption 4): streaming synthesizes a shape-identical
 *  JSON payload and runs the SAME shaping, so the two paths may only differ
 *  in when text becomes visible — never in what the run loop finally sees. */
interface ProviderResponseDiagnostics {
  path: 'chat' | 'responses' | 'anthropic'
  provider: string | null
  model: string
  cap: number | null
}

function logProviderOutputTruncated(
  json: Record<string, unknown>,
  diagnostics: ProviderResponseDiagnostics
): void {
  if (!isProviderOutputIncomplete(json)) return
  logAgentMetric('provider_output_truncated', { ...diagnostics })
}

function shapeChatCompletionsModelResponse(
  json: Record<string, unknown>,
  patchContext: PatchContext,
  fallbackResponseId: string,
  diagnostics: ProviderResponseDiagnostics
): ModelResponse {
  applyProviderResponsePatch(json, patchContext)
  logProviderOutputTruncated(json, diagnostics)
  const choices = Array.isArray(json.choices)
    ? (json.choices as Array<Record<string, unknown>>)
    : []
  const choice = choices[0] || {}
  const message =
    choice.message && typeof choice.message === 'object'
      ? (choice.message as Record<string, unknown>)
      : {}
  const built = buildChatCompletionsToolCalls(message.tool_calls as never)
  const text = typeof message.content === 'string' ? message.content : ''
  const providerData = reasoningProviderData(readReasoningContentFromRecord(message))
  return {
    usage: openAIUsageFromJson(json),
    output: [
      ...toOpenAIMessageOutput(text, fallbackResponseId, providerData),
      ...toOpenAIFunctionCallOutput(built.toolCalls, fallbackResponseId, providerData)
    ],
    responseId: String(json.id || fallbackResponseId),
    providerData: json
  }
}

function shapeResponsesModelResponse(
  json: Record<string, unknown>,
  patchContext: PatchContext,
  fallbackResponseId: string,
  diagnostics: ProviderResponseDiagnostics
): ModelResponse {
  applyProviderResponsePatch(json, patchContext)
  logProviderOutputTruncated(json, diagnostics)
  const output = Array.isArray(json.output) ? (json.output as Array<Record<string, unknown>>) : []
  const built = buildResponsesToolCalls(output, () => `respfc_${randomUUID().replace(/-/g, '')}`)
  const text = extractResponsesText(json)
  return {
    usage: openAIUsageFromJson(json),
    output: [
      ...toOpenAIMessageOutput(text, String(json.id || fallbackResponseId)),
      ...toOpenAIFunctionCallOutput(built.toolCalls, String(json.id || fallbackResponseId))
    ],
    responseId: String(json.id || fallbackResponseId),
    providerData: json
  }
}

export class ReadyOpenAICompatibleModel implements Model {
  constructor(
    private readonly deps: {
      config: AIModelConfig
      baseUrl: string
      fetchWithTimeout: NonNullable<AgentSdkRuntimeDeps['fetchWithTimeout']>
    }
  ) {}

  private responseDiagnostics(
    path: 'chat' | 'responses',
    request: ModelRequest
  ): ProviderResponseDiagnostics {
    const cap = this.resolveRequestMaxOutputTokens(request)
    return {
      path,
      provider: this.deps.config.provider || null,
      model: this.deps.config.model,
      cap
    }
  }

  private resolveRequestMaxOutputTokens(request: ModelRequest): number {
    return (
      normalizeMaxOutputTokens(request.modelSettings?.maxTokens) ??
      resolveMaxOutputTokens(this.deps.config)
    )
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    assertManualThinkingModeProviderSafe(this.deps.config, 'sdk-openai-compatible')
    const provider = getProviderDef(this.deps.config.provider, this.deps.baseUrl)
    const runtime = resolveOpenAIProviderRuntime({
      config: this.deps.config,
      provider,
      baseUrl: this.deps.baseUrl
    })
    return runtime.wireApi === 'responses'
      ? this.getResponsesResponse(request, provider, runtime)
      : this.getChatCompletionsResponse(request, provider)
  }

  private chatCompletionsParts(
    request: ModelRequest,
    provider: AIProviderDef | undefined
  ): {
    responseId: string
    url: string
    headers: Record<string, string>
    body: Record<string, unknown>
    patchContext: PatchContext
  } {
    const responseId = `openai-compatible-${randomUUID()}`
    const model = resolveOpenAIProtocolModel(this.deps.config)
    const messages = [
      { role: 'system', content: request.systemInstructions || '' },
      ...sanitizeMessagesForModelClient(
        modelInputToOpenAIChatMessages(request.input),
        this.deps.config,
        'openai-chat'
      )
    ]
    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: this.resolveRequestMaxOutputTokens(request)
    }
    const tools = serializeSdkOpenAITools(request)
    if (tools.length > 0) body.tools = tools
    const patchContext = buildProviderPatchContext({
      config: this.deps.config,
      baseUrl: this.deps.baseUrl,
      model
    })
    return {
      responseId,
      url: `${this.deps.baseUrl}/chat/completions`,
      headers: buildProviderHeaders(this.deps.config, provider),
      body,
      patchContext
    }
  }

  private async getChatCompletionsResponse(
    request: ModelRequest,
    provider: AIProviderDef | undefined
  ): Promise<ModelResponse> {
    const parts = this.chatCompletionsParts(request, provider)
    applyProviderRequestPatch(parts.body, parts.patchContext)

    const response = await this.deps.fetchWithTimeout(
      parts.url,
      {
        method: 'POST',
        headers: parts.headers,
        body: JSON.stringify(parts.body),
        signal: request.signal
      },
      request.signal || new AbortController().signal,
      'agents-sdk openai-compatible chat'
    )
    const rawText = await response.text()
    if (!response.ok)
      throw buildProviderHttpError({ httpStatus: response.status, errorBody: rawText })
    if (isEventStreamLikeResponse(response, rawText))
      throw buildProviderProtocolMismatchError(parts.url)
    const json = JSON.parse(rawText || '{}') as Record<string, unknown>
    return shapeChatCompletionsModelResponse(
      json,
      parts.patchContext,
      parts.responseId,
      this.responseDiagnostics('chat', request)
    )
  }

  private responsesParts(
    request: ModelRequest,
    provider: AIProviderDef | undefined,
    runtime: ReturnType<typeof resolveOpenAIProviderRuntime>
  ): {
    responseId: string
    url: string
    headers: Record<string, string>
    body: Record<string, unknown>
    patchContext: PatchContext
  } {
    const responseId = `openai-compatible-${randomUUID()}`
    const model = resolveOpenAIProtocolModel(this.deps.config)
    const body: Record<string, unknown> = {
      model,
      max_output_tokens: this.resolveRequestMaxOutputTokens(request),
      instructions: request.systemInstructions || '',
      input: sanitizeMessagesForModelClient(
        modelInputToOpenAIResponsesInput(request.input),
        this.deps.config,
        'openai-responses'
      )
    }
    if (runtime.reasoningEffort) body.reasoning = { effort: runtime.reasoningEffort }
    const tools = serializeSdkOpenAIResponsesTools(request)
    if (tools.length > 0) body.tools = tools
    const patchContext = buildProviderPatchContext({
      config: this.deps.config,
      baseUrl: this.deps.baseUrl,
      model
    })
    return {
      responseId,
      url: `${this.deps.baseUrl}/responses`,
      headers: buildProviderHeaders(this.deps.config, provider),
      body,
      patchContext
    }
  }

  private async getResponsesResponse(
    request: ModelRequest,
    provider: AIProviderDef | undefined,
    runtime: ReturnType<typeof resolveOpenAIProviderRuntime>
  ): Promise<ModelResponse> {
    const parts = this.responsesParts(request, provider, runtime)
    parts.body.stream = false
    applyProviderRequestPatch(parts.body, parts.patchContext)

    const response = await this.deps.fetchWithTimeout(
      parts.url,
      {
        method: 'POST',
        headers: parts.headers,
        body: JSON.stringify(parts.body),
        signal: request.signal
      },
      request.signal || new AbortController().signal,
      'agents-sdk openai-compatible responses'
    )
    if (!response.ok) {
      const rawError = await response.text().catch(() => '')
      throw buildProviderHttpError({ httpStatus: response.status, errorBody: rawError })
    }
    const json = (await parseJsonOrEventStreamResponse(response, {
      requestUrl: parts.url
    })) as Record<string, unknown>
    return shapeResponsesModelResponse(
      json,
      parts.patchContext,
      parts.responseId,
      this.responseDiagnostics('responses', request)
    )
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    if (resolveTrueSseMode() === 'off') {
      const response = await this.getResponse(request)
      yield* pseudoStreamEventsFromModelResponse(response, `openai-compatible-${randomUUID()}`)
      return
    }
    assertManualThinkingModeProviderSafe(this.deps.config, 'sdk-openai-compatible')
    const provider = getProviderDef(this.deps.config.provider, this.deps.baseUrl)
    const runtime = resolveOpenAIProviderRuntime({
      config: this.deps.config,
      provider,
      baseUrl: this.deps.baseUrl
    })
    if (runtime.wireApi === 'responses') {
      yield* this.streamResponsesResponse(request, provider, runtime)
    } else {
      yield* this.streamChatCompletionsResponse(request, provider)
    }
  }

  private async *streamChatCompletionsResponse(
    request: ModelRequest,
    provider: AIProviderDef | undefined
  ): AsyncIterable<StreamEvent> {
    const parts = this.chatCompletionsParts(request, provider)
    parts.body.stream = true
    // include_usage undefined-guarded：provider patch/用户配置可覆盖（vllm 档
    // 位在 stream===true 时也会补同一字段，两侧幂等）。
    if (parts.body.stream_options === undefined) {
      parts.body.stream_options = { include_usage: true }
    }
    applyProviderRequestPatch(parts.body, parts.patchContext)

    const label = 'agents-sdk openai-compatible chat stream'
    const response = await this.deps.fetchWithTimeout(
      parts.url,
      {
        method: 'POST',
        headers: parts.headers,
        body: JSON.stringify(parts.body),
        signal: request.signal
      },
      request.signal || new AbortController().signal,
      label
    )
    if (!response.ok) {
      const rawError = await response.text().catch(() => '')
      // 降级二：首 delta 前"流式形状被拒"→ 单次阻塞重试（无 token 损耗）。
      // 语义性 4xx（413 overflow / 401 / 429…）原样冒泡，见 isLikelyStreamShapeRejection。
      if (isLikelyStreamShapeRejection(response.status, rawError)) {
        logAgentMetric('provider_stream_fallback', {
          path: 'chat',
          provider: this.deps.config.provider || null,
          reason: 'stream_request_rejected',
          httpStatus: response.status
        })
        const blocking = await this.getChatCompletionsResponse(request, provider)
        yield* pseudoStreamEventsFromModelResponse(blocking, parts.responseId)
        return
      }
      throw buildProviderHttpError({ httpStatus: response.status, errorBody: rawError })
    }
    // 降级一：服务端无视 stream:true 返回 JSON（或缺 body）→ 阻塞形状交付。
    if (!isEventStreamContentType(response) || !response.body) {
      const rawText = await response.text()
      logAgentMetric('provider_stream_fallback', {
        path: 'chat',
        provider: this.deps.config.provider || null,
        reason: 'non_sse_response'
      })
      const parsed = parseJsonOrEventStreamText(rawText, { requestUrl: parts.url })
      const json = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
      yield* pseudoStreamEventsFromModelResponse(
        shapeChatCompletionsModelResponse(
          json,
          parts.patchContext,
          parts.responseId,
          this.responseDiagnostics('chat', request)
        ),
        parts.responseId
      )
      return
    }

    const accumulator = new ChatCompletionsStreamAccumulator()
    const startedAt = Date.now()
    let firstDeltaSeen = false
    let doneSeen = false
    for await (const event of parseSseStream(response.body, { signal: request.signal, label })) {
      if (event.data === '[DONE]') { doneSeen = true; break }
      const chunk = safeParseJsonRecord(event.data)
      if (!chunk) continue
      const streamError = providerStreamPayloadError(chunk)
      if (streamError) throw streamError
      const { textDelta } = accumulator.feed(chunk)
      if (textDelta) {
        if (!firstDeltaSeen) {
          firstDeltaSeen = true
          logAgentMetric('provider_stream_first_delta', {
            path: 'chat',
            provider: this.deps.config.provider || null,
            ms: Date.now() - startedAt
          })
        }
        yield { type: 'output_text_delta', delta: textDelta } as StreamEvent
      }
    }
    if (!doneSeen && !accumulator.isComplete) throw new Error(`${label} 未收到结束标记（stream_incomplete）`)
    const shaped = shapeChatCompletionsModelResponse(
      accumulator.final(),
      parts.patchContext,
      parts.responseId,
      this.responseDiagnostics('chat', request)
    )
    yield buildResponseDoneEvent(shaped, parts.responseId)
  }

  private async *streamResponsesResponse(
    request: ModelRequest,
    provider: AIProviderDef | undefined,
    runtime: ReturnType<typeof resolveOpenAIProviderRuntime>
  ): AsyncIterable<StreamEvent> {
    const parts = this.responsesParts(request, provider, runtime)
    parts.body.stream = true
    applyProviderRequestPatch(parts.body, parts.patchContext)

    const label = 'agents-sdk openai-compatible responses stream'
    const response = await this.deps.fetchWithTimeout(
      parts.url,
      {
        method: 'POST',
        headers: parts.headers,
        body: JSON.stringify(parts.body),
        signal: request.signal
      },
      request.signal || new AbortController().signal,
      label
    )
    if (!response.ok) {
      const rawError = await response.text().catch(() => '')
      if (isLikelyStreamShapeRejection(response.status, rawError)) {
        logAgentMetric('provider_stream_fallback', {
          path: 'responses',
          provider: this.deps.config.provider || null,
          reason: 'stream_request_rejected',
          httpStatus: response.status
        })
        const blocking = await this.getResponsesResponse(request, provider, runtime)
        yield* pseudoStreamEventsFromModelResponse(blocking, parts.responseId)
        return
      }
      throw buildProviderHttpError({ httpStatus: response.status, errorBody: rawError })
    }
    if (!isEventStreamContentType(response) || !response.body) {
      const rawText = await response.text()
      logAgentMetric('provider_stream_fallback', {
        path: 'responses',
        provider: this.deps.config.provider || null,
        reason: 'non_sse_response'
      })
      const parsed = parseJsonOrEventStreamText(rawText, { requestUrl: parts.url })
      const json = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
      yield* pseudoStreamEventsFromModelResponse(
        shapeResponsesModelResponse(
          json,
          parts.patchContext,
          parts.responseId,
          this.responseDiagnostics('responses', request)
        ),
        parts.responseId
      )
      return
    }

    const accumulator = new ResponsesStreamAccumulator()
    const startedAt = Date.now()
    let firstDeltaSeen = false
    for await (const event of parseSseStream(response.body, { signal: request.signal, label })) {
      if (event.data === '[DONE]') break
      const payload = safeParseJsonRecord(event.data)
      if (!payload) continue
      const streamError = providerStreamPayloadError(payload)
      if (streamError) throw streamError
      if (isProviderOutputIncomplete(payload.response)) throw new ProviderOutputIncompleteError()
      const { textDelta } = accumulator.feed(event.event, payload)
      if (textDelta) {
        if (!firstDeltaSeen) {
          firstDeltaSeen = true
          logAgentMetric('provider_stream_first_delta', {
            path: 'responses',
            provider: this.deps.config.provider || null,
            ms: Date.now() - startedAt
          })
        }
        yield { type: 'output_text_delta', delta: textDelta } as StreamEvent
      }
    }
    const finalPayload = accumulator.final()
    if (!finalPayload) {
      throw new Error(`${label} 未收到终局响应载荷（stream_incomplete）`)
    }
    const shaped = shapeResponsesModelResponse(
      finalPayload,
      parts.patchContext,
      parts.responseId,
      this.responseDiagnostics('responses', request)
    )
    yield buildResponseDoneEvent(shaped, parts.responseId)
  }
}

// ── ReadyAnthropicModelProvider (line 3600, NOT exported) ──

class ReadyAnthropicModelProvider implements ModelProvider {
  constructor(
    private readonly deps: {
      config: AIModelConfig
      baseUrl: string
      fetchWithTimeout: NonNullable<AgentSdkRuntimeDeps['fetchWithTimeout']>
    }
  ) {}

  getModel(): Model {
    return new ReadyAnthropicModel(this.deps)
  }
}

// ── ReadyAnthropicModel (line 3612, exported) ──

/** Anthropic blocking-path shaping — 与流式终局合成载荷共用（P0-0）。
 *  totalTokens 维持既有语义（anthropic 不回传 total 时为 0），不做求和改良。 */
function shapeAnthropicModelResponse(
  json: Record<string, unknown>,
  fallbackResponseId: string,
  diagnostics: ProviderResponseDiagnostics
): ModelResponse {
  logProviderOutputTruncated(json, diagnostics)
  const usage =
    json.usage && typeof json.usage === 'object' ? (json.usage as Record<string, unknown>) : {}
  return {
    usage: new Usage({
      inputTokens: Number(usage.input_tokens || usage.inputTokens || 0),
      outputTokens: Number(usage.output_tokens || usage.outputTokens || 0),
      totalTokens: Number(usage.total_tokens || usage.totalTokens || 0)
    }),
    output: extractAnthropicOutput(json, fallbackResponseId),
    responseId: String(json.id || fallbackResponseId),
    providerData: json
  }
}

export class ReadyAnthropicModel implements Model {
  constructor(
    private readonly deps: {
      config: AIModelConfig
      baseUrl: string
      fetchWithTimeout: NonNullable<AgentSdkRuntimeDeps['fetchWithTimeout']>
    }
  ) {}

  private anthropicParts(request: ModelRequest): {
    responseId: string
    url: string
    headers: Record<string, string>
    body: Record<string, unknown>
    maxOutputTokens: number
  } {
    const responseId = `anthropic-${randomUUID()}`
    const maxOutputTokens =
      normalizeMaxOutputTokens(request.modelSettings?.maxTokens) ??
      resolveMaxOutputTokens(this.deps.config)
    const body: Record<string, unknown> = {
      model: this.deps.config.model,
      max_tokens: maxOutputTokens,
      system: request.systemInstructions || '',
      messages: sanitizeMessagesForModelClient(
        modelInputToAnthropicMessages(request.input),
        this.deps.config,
        'anthropic'
      )
    }
    const tools = serializeAnthropicTools(request)
    if (tools.length > 0) body.tools = tools
    const provider = getProviderDef(this.deps.config.provider, this.deps.baseUrl)
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01'
    }
    const authHeader = provider?.authHeader || 'Authorization'
    const authPrefix = provider?.authPrefix ?? 'Bearer '
    headers[authHeader] = `${authPrefix}${this.deps.config.apiKey}`
    if (provider?.extraHeaders) Object.assign(headers, provider.extraHeaders)
    return { responseId, url: `${this.deps.baseUrl}/v1/messages`, headers, body, maxOutputTokens }
  }

  private responseDiagnostics(maxOutputTokens: number): ProviderResponseDiagnostics {
    return {
      path: 'anthropic',
      provider: this.deps.config.provider || null,
      model: this.deps.config.model,
      cap: maxOutputTokens
    }
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    assertManualThinkingModeProviderSafe(this.deps.config, 'sdk-anthropic')
    const parts = this.anthropicParts(request)
    const resp = await this.deps.fetchWithTimeout(
      parts.url,
      {
        method: 'POST',
        headers: parts.headers,
        body: JSON.stringify(parts.body),
        signal: request.signal
      },
      request.signal || new AbortController().signal,
      'agents-sdk anthropic model'
    )
    const rawText = await resp.text()
    if (!resp.ok) {
      throw buildProviderHttpError({ httpStatus: resp.status, errorBody: rawText })
    }
    const json = JSON.parse(rawText || '{}') as Record<string, unknown>
    return shapeAnthropicModelResponse(
      json,
      parts.responseId,
      this.responseDiagnostics(parts.maxOutputTokens)
    )
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    if (resolveTrueSseMode() === 'off') {
      const response = await this.getResponse(request)
      yield* pseudoStreamEventsFromModelResponse(response, `anthropic-${randomUUID()}`)
      return
    }
    assertManualThinkingModeProviderSafe(this.deps.config, 'sdk-anthropic')
    const parts = this.anthropicParts(request)
    parts.body.stream = true

    const label = 'agents-sdk anthropic model stream'
    const response = await this.deps.fetchWithTimeout(
      parts.url,
      {
        method: 'POST',
        headers: parts.headers,
        body: JSON.stringify(parts.body),
        signal: request.signal
      },
      request.signal || new AbortController().signal,
      label
    )
    if (!response.ok) {
      const rawError = await response.text().catch(() => '')
      if (isLikelyStreamShapeRejection(response.status, rawError)) {
        logAgentMetric('provider_stream_fallback', {
          path: 'anthropic',
          provider: this.deps.config.provider || null,
          reason: 'stream_request_rejected',
          httpStatus: response.status
        })
        const blocking = await this.getResponse(request)
        yield* pseudoStreamEventsFromModelResponse(blocking, parts.responseId)
        return
      }
      throw buildProviderHttpError({ httpStatus: response.status, errorBody: rawError })
    }
    if (!isEventStreamContentType(response) || !response.body) {
      // R-GEN — this degrade fires after the true-SSE request was dispatched;
      // pseudo-stream the accepted response with the same resolved cap.
      const rawText = await response.text()
      logAgentMetric('provider_stream_fallback', {
        path: 'anthropic',
        provider: this.deps.config.provider || null,
        reason: 'non_sse_response'
      })
      const parsed = parseJsonOrEventStreamText(rawText, { requestUrl: parts.url })
      const json = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
      yield* pseudoStreamEventsFromModelResponse(
        shapeAnthropicModelResponse(
          json,
          parts.responseId,
          this.responseDiagnostics(parts.maxOutputTokens)
        ),
        parts.responseId
      )
      return
    }

    const accumulator = new AnthropicStreamAccumulator()
    const startedAt = Date.now()
    let firstDeltaSeen = false
    for await (const event of parseSseStream(response.body, { signal: request.signal, label })) {
      if (event.data === '[DONE]') break
      const payload = safeParseJsonRecord(event.data)
      if (!payload) continue
      const streamError = providerStreamPayloadError(payload)
      if (streamError) throw streamError
      const { textDelta } = accumulator.feed(event.event, payload)
      if (textDelta) {
        if (!firstDeltaSeen) {
          firstDeltaSeen = true
          logAgentMetric('provider_stream_first_delta', {
            path: 'anthropic',
            provider: this.deps.config.provider || null,
            ms: Date.now() - startedAt
          })
        }
        yield { type: 'output_text_delta', delta: textDelta } as StreamEvent
      }
    }
    if (!accumulator.isComplete) throw new Error(`${label} 未收到结束标记（stream_incomplete）`)
    const shaped = shapeAnthropicModelResponse(
      accumulator.final(parts.responseId),
      parts.responseId,
      this.responseDiagnostics(parts.maxOutputTokens)
    )
    yield buildResponseDoneEvent(shaped, parts.responseId)
  }
}
