import { randomUUID } from 'crypto'
import {
  Agent,
  MemorySession,
  OpenAIProvider,
  Runner,
  Usage,
  tool,
  type AgentInputItem,
  type AgentOutputItem,
  type Model,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type RunStreamEvent,
  type StreamEvent,
  type Tool as AgentSdkTool,
} from '@openai/agents'
import type {
  ReadyAgentSdkRunParams,
  ReadyAgentSdkRunResult,
  AgentSdkRuntimeDeps,
} from './agent-sdk-types'
import {
  getProviderDef,
  normalizeAIConfig,
  resolveAIConfigCapabilities,
  type AIModelConfig,
  type AIProviderDef,
} from '../../../../shared/ai-providers'
import {
  applyProviderRequestPatch,
  applyProviderResponsePatch,
  resolveProviderDefaultPatchers,
  resolveProviderPatchProfile,
  type PatchContext,
} from '../../../../shared/ai-providers/index'
import {
  parseJsonOrEventStreamResponse,
} from '../../openai-responses'
import {
  buildChatCompletionsToolCalls,
  buildResponsesToolCalls,
} from '../../claude-bridge/provider-tool-arguments'
import { buildProviderHttpError } from '../../claude-bridge/provider-terminal-error'
import { resolveOpenAIProviderRuntime } from '../provider-runtime-resolver'
import { assertManualThinkingModeProviderSafe } from '../thinking-compatibility'
import { logAgentMetric } from '../metrics'
import {
  compactAgentInputItems,
} from '../compaction/compact-agent-input'
import {
  extractToolCallFromStreamEvent,
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
  stringField,
} from './agent-sdk-utils'

// Minimal debug log for provider module (avoids dependency on main file's agentSdkLogger).
export function log(message: string): void {
  console.log(`[agent-sdk-provider] ${message}`)
}

// ── Group H: runWithOpenAIAgentsSdk (line 2203) ──

export async function runWithOpenAIAgentsSdk(
  params: ReadyAgentSdkRunParams,
): Promise<ReadyAgentSdkRunResult> {
  const agent = new Agent({
    name: params.agentName,
    instructions: params.instructions,
    model: params.model,
    tools: params.tools,
  })
  const runner = new Runner({
    modelProvider: params.provider,
    tracingDisabled: true,
    traceIncludeSensitiveData: false,
    workflowName: 'Ready Agent SDK Runtime',
    groupId: params.sessionId,
  })
  const stream = await runner.run(agent, params.input, {
    stream: true,
    signal: params.signal,
    session: params.session,
    maxTurns: params.maxTurns,
    callModelInputFilter: async ({ modelData }) => {
      const result = await compactAgentInputItems(modelData.input, {
        windowTokens: params.contextWindowTokens,
      })
      if (!result.compacted) return modelData
      logAgentMetric('agent_sdk_auto_context_compacted', {
        agentName: params.agentName,
        sessionId: params.sessionId || null,
        runId: params.runId,
        taskId: params.taskId,
        contextWindowTokens: params.contextWindowTokens,
        beforeTokens: result.report.beforeTokens,
        afterTokens: result.report.afterTokens,
        droppedItems: result.report.droppedItems,
        truncatedToolResults: result.report.truncatedToolResults,
        summarized: result.report.summarized,
        itemsBefore: modelData.input.length,
        itemsAfter: result.items.length,
      })
      log(`auto context compacted agent=${params.agentName} run=${params.runId} before=${result.report.beforeTokens} after=${result.report.afterTokens} dropped=${result.report.droppedItems} truncated=${result.report.truncatedToolResults}`)
      return { ...modelData, input: result.items }
    },
    toolExecution: {
      maxFunctionToolConcurrency: 1,
    },
  })
  try {
    for await (const event of stream) {
      if (
        event.type === 'raw_model_stream_event'
        && event.data.type === 'output_text_delta'
        && typeof event.data.delta === 'string'
      ) {
        params.onTextDelta(event.data.delta)
        continue
      }
      const toolCall = extractToolCallFromStreamEvent(event)
      if (toolCall) {
        log(`sdk tool_called name=${toolCall.name}`)
      }
    }
    await stream.completed
  } finally {
    const streamLoopPromise = (stream as { _getStreamLoopPromise?: () => Promise<unknown> })
      ._getStreamLoopPromise?.()
    if (streamLoopPromise) await streamLoopPromise
  }
  if (stream.error) throw stream.error
  const rawResponses = stream.rawResponses
  const lastResponse = rawResponses[rawResponses.length - 1]
  return {
    finalText: typeof stream.finalOutput === 'string' ? stream.finalOutput : '',
    usage: usageFromModelResponse(lastResponse),
    lastResponseId: stream.lastResponseId,
  }
}

// ── usageFromModelResponse (line 2281) ──

export function usageFromModelResponse(response: ModelResponse | undefined): ReadyAgentSdkRunResult['usage'] {
  if (!response?.usage) return undefined
  return {
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    totalTokens: response.usage.totalTokens,
  }
}

// ── Resolve provider (line 2124) ──

export function resolveAgentSdkProvider(
  config: AIModelConfig,
  deps: { fetchWithTimeout: NonNullable<AgentSdkRuntimeDeps['fetchWithTimeout']> },
): {
  provider: ModelProvider
  model: string
} {
  const normalized = normalizeAIConfig(config)
  const capabilities = resolveAIConfigCapabilities(normalized)
  if (!normalized || !capabilities) {
    throw new Error('当前 SDK 路径无法解析 AI 配置。')
  }

  const baseURL = String(capabilities.baseUrl || normalized.baseUrl || '').trim().replace(/\/+$/, '')
  if (capabilities.agentProtocol === 'anthropic') {
    return {
      model: normalized.model,
      provider: new ReadyAnthropicModelProvider({
        config: normalized,
        baseUrl: baseURL,
        fetchWithTimeout: deps.fetchWithTimeout,
      }),
    }
  }
  if (capabilities.agentProtocol !== 'openai') {
    throw new Error('当前 SDK 路径暂不支持该模型协议配置。')
  }
  if (normalized.provider !== 'openai') {
    return {
      model: normalized.model,
      provider: new ReadyOpenAICompatibleModelProvider({
        config: normalized,
        baseUrl: baseURL,
        fetchWithTimeout: deps.fetchWithTimeout,
      }),
    }
  }
  return {
    model: normalized.model,
    provider: new OpenAIProvider({
      apiKey: normalized.apiKey,
      baseURL: baseURL || undefined,
      useResponses: capabilities.wireApi === 'responses',
      strictFeatureValidation: false,
    }),
  }
}

// ── ReadyOpenAICompatibleModelProvider (line 3254, NOT exported) ──

class ReadyOpenAICompatibleModelProvider implements ModelProvider {
  constructor(private readonly deps: {
    config: AIModelConfig
    baseUrl: string
    fetchWithTimeout: NonNullable<AgentSdkRuntimeDeps['fetchWithTimeout']>
  }) {}

  getModel(): Model {
    return new ReadyOpenAICompatibleModel(this.deps)
  }
}

// ── ReadyOpenAICompatibleModel (line 3266, exported) ──

export class ReadyOpenAICompatibleModel implements Model {
  constructor(private readonly deps: {
    config: AIModelConfig
    baseUrl: string
    fetchWithTimeout: NonNullable<AgentSdkRuntimeDeps['fetchWithTimeout']>
  }) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    assertManualThinkingModeProviderSafe(this.deps.config, 'sdk-openai-compatible')
    const provider = getProviderDef(this.deps.config.provider, this.deps.baseUrl)
    const runtime = resolveOpenAIProviderRuntime({
      config: this.deps.config,
      provider,
      baseUrl: this.deps.baseUrl,
    })
    return runtime.wireApi === 'responses'
      ? this.getResponsesResponse(request, provider, runtime)
      : this.getChatCompletionsResponse(request, provider)
  }

  private async getChatCompletionsResponse(
    request: ModelRequest,
    provider: AIProviderDef | undefined,
  ): Promise<ModelResponse> {
    const responseId = `openai-compatible-${randomUUID()}`
    const model = resolveOpenAIProtocolModel(this.deps.config)
    const messages = [
      { role: 'system', content: request.systemInstructions || '' },
      ...sanitizeMessagesForModelClient(
        modelInputToOpenAIChatMessages(request.input),
        this.deps.config,
        'openai-chat',
      ),
    ]
    const body: Record<string, unknown> = { model, messages }
    const tools = serializeSdkOpenAITools(request)
    if (tools.length > 0) body.tools = tools
    const patchContext = buildProviderPatchContext({
      config: this.deps.config,
      baseUrl: this.deps.baseUrl,
      model,
    })
    applyProviderRequestPatch(body, patchContext)

    const url = `${this.deps.baseUrl}/chat/completions`
    const response = await this.deps.fetchWithTimeout(url, {
      method: 'POST',
      headers: buildProviderHeaders(this.deps.config, provider),
      body: JSON.stringify(body),
      signal: request.signal,
    }, request.signal || new AbortController().signal, 'agents-sdk openai-compatible chat')
    const rawText = await response.text()
    if (!response.ok) throw buildProviderHttpError({ httpStatus: response.status, errorBody: rawText })
    if (isEventStreamLikeResponse(response, rawText)) throw buildProviderProtocolMismatchError(url)
    const json = JSON.parse(rawText || '{}') as Record<string, unknown>
    applyProviderResponsePatch(json, patchContext)
    const choices = Array.isArray(json.choices) ? json.choices as Array<Record<string, unknown>> : []
    const choice = choices[0] || {}
    const message = choice.message && typeof choice.message === 'object'
      ? choice.message as Record<string, unknown>
      : {}
    const built = buildChatCompletionsToolCalls(message.tool_calls as never)
    const text = typeof message.content === 'string' ? message.content : ''
    const providerData = reasoningProviderData(readReasoningContentFromRecord(message))
    return {
      usage: openAIUsageFromJson(json),
      output: [
        ...toOpenAIMessageOutput(text, responseId, providerData),
        ...toOpenAIFunctionCallOutput(built.toolCalls, responseId, providerData),
      ],
      responseId: String(json.id || responseId),
      providerData: json,
    }
  }

  private async getResponsesResponse(
    request: ModelRequest,
    provider: AIProviderDef | undefined,
    runtime: ReturnType<typeof resolveOpenAIProviderRuntime>,
  ): Promise<ModelResponse> {
    const responseId = `openai-compatible-${randomUUID()}`
    const model = resolveOpenAIProtocolModel(this.deps.config)
    const body: Record<string, unknown> = {
      model,
      instructions: request.systemInstructions || '',
      input: sanitizeMessagesForModelClient(
        modelInputToOpenAIResponsesInput(request.input),
        this.deps.config,
        'openai-responses',
      ),
      stream: false,
    }
    if (runtime.reasoningEffort) body.reasoning = { effort: runtime.reasoningEffort }
    const tools = serializeSdkOpenAIResponsesTools(request)
    if (tools.length > 0) body.tools = tools
    const patchContext = buildProviderPatchContext({
      config: this.deps.config,
      baseUrl: this.deps.baseUrl,
      model,
    })
    applyProviderRequestPatch(body, patchContext)

    const url = `${this.deps.baseUrl}/responses`
    const response = await this.deps.fetchWithTimeout(url, {
      method: 'POST',
      headers: buildProviderHeaders(this.deps.config, provider),
      body: JSON.stringify(body),
      signal: request.signal,
    }, request.signal || new AbortController().signal, 'agents-sdk openai-compatible responses')
    if (!response.ok) {
      const rawError = await response.text().catch(() => '')
      throw buildProviderHttpError({ httpStatus: response.status, errorBody: rawError })
    }
    const json = await parseJsonOrEventStreamResponse(response, { requestUrl: url }) as Record<string, unknown>
    applyProviderResponsePatch(json, patchContext)
    const output = Array.isArray(json.output) ? json.output as Array<Record<string, unknown>> : []
    const built = buildResponsesToolCalls(output, () => `respfc_${randomUUID().replace(/-/g, '')}`)
    const text = extractResponsesText(json)
    return {
      usage: openAIUsageFromJson(json),
      output: [
        ...toOpenAIMessageOutput(text, String(json.id || responseId)),
        ...toOpenAIFunctionCallOutput(built.toolCalls, String(json.id || responseId)),
      ],
      responseId: String(json.id || responseId),
      providerData: json,
    }
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    const response = await this.getResponse(request)
    for (const item of response.output) {
      const text = textFromAgentOutputItem(item)
      if (text) {
        yield { type: 'output_text_delta', delta: text } as StreamEvent
      }
    }
    yield {
      type: 'response_done',
      response: {
        id: response.responseId || `openai-compatible-${randomUUID()}`,
        requestId: response.requestId,
        usage: {
          requests: response.usage.requests,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          totalTokens: response.usage.totalTokens,
          inputTokensDetails: {},
          outputTokensDetails: {},
        },
        output: response.output,
      },
    } as StreamEvent
  }
}

// ── ReadyAnthropicModelProvider (line 3600, NOT exported) ──

class ReadyAnthropicModelProvider implements ModelProvider {
  constructor(private readonly deps: {
    config: AIModelConfig
    baseUrl: string
    fetchWithTimeout: NonNullable<AgentSdkRuntimeDeps['fetchWithTimeout']>
  }) {}

  getModel(): Model {
    return new ReadyAnthropicModel(this.deps)
  }
}

// ── ReadyAnthropicModel (line 3612, exported) ──

export class ReadyAnthropicModel implements Model {
  constructor(private readonly deps: {
    config: AIModelConfig
    baseUrl: string
    fetchWithTimeout: NonNullable<AgentSdkRuntimeDeps['fetchWithTimeout']>
  }) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    assertManualThinkingModeProviderSafe(this.deps.config, 'sdk-anthropic')
    const responseId = `anthropic-${randomUUID()}`
    const body: Record<string, unknown> = {
      model: this.deps.config.model,
      max_tokens: request.modelSettings.maxTokens || 4096,
      system: request.systemInstructions || '',
      messages: sanitizeMessagesForModelClient(
        modelInputToAnthropicMessages(request.input),
        this.deps.config,
        'anthropic',
      ),
    }
    const tools = serializeAnthropicTools(request)
    if (tools.length > 0) body.tools = tools
    const provider = getProviderDef(this.deps.config.provider, this.deps.baseUrl)
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    }
    const authHeader = provider?.authHeader || 'Authorization'
    const authPrefix = provider?.authPrefix ?? 'Bearer '
    headers[authHeader] = `${authPrefix}${this.deps.config.apiKey}`
    if (provider?.extraHeaders) Object.assign(headers, provider.extraHeaders)

    const url = `${this.deps.baseUrl}/v1/messages`
    const resp = await this.deps.fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: request.signal,
    }, request.signal || new AbortController().signal, 'agents-sdk anthropic model')
    const rawText = await resp.text()
    if (!resp.ok) {
      throw buildProviderHttpError({ httpStatus: resp.status, errorBody: rawText })
    }
    const json = JSON.parse(rawText || '{}') as Record<string, unknown>
    const usage = json.usage && typeof json.usage === 'object'
      ? json.usage as Record<string, unknown>
      : {}
    return {
      usage: new Usage({
        inputTokens: Number(usage.input_tokens || usage.inputTokens || 0),
        outputTokens: Number(usage.output_tokens || usage.outputTokens || 0),
        totalTokens: Number(usage.total_tokens || usage.totalTokens || 0),
      }),
      output: extractAnthropicOutput(json, responseId),
      responseId: String(json.id || responseId),
      providerData: json,
    }
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    const response = await this.getResponse(request)
    for (const item of response.output) {
      if (item.type !== 'message') continue
      for (const part of item.content || []) {
        if (part && typeof part === 'object' && part.type === 'output_text' && part.text) {
          yield { type: 'output_text_delta', delta: part.text } as StreamEvent
        }
      }
    }
    yield {
      type: 'response_done',
      response: {
        id: response.responseId || `anthropic-${randomUUID()}`,
        requestId: response.requestId,
        usage: {
          requests: response.usage.requests,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          totalTokens: response.usage.totalTokens,
          inputTokensDetails: {},
          outputTokensDetails: {},
        },
        output: response.output,
      },
    } as StreamEvent
  }
}
