import { EventEmitter } from 'events'
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
import type { BrowserController } from '../browser-engine/ipc-handler'
import type { SidecarManager } from './sidecar-manager'
import type { AgentControlRuntime } from './runtime'
import type { DomainAdapter } from './domain-adapter'
import type {
  ExecutionTurnResult,
  RunMessage,
  TaskType,
  TurnTranscriptEvent,
} from './run-contracts'
import type { ScopeRunEventPayload } from './types'
import type { TurnTerminalReason } from './turn-frame'
import type { MultimodalBlock } from '../claude-bridge/direct-chat'
import {
  buildTextToolBridgePrompt,
  buildTextToolResultMessage,
  parseTextToolBridgeResponse,
} from '../claude-bridge/tool-bridge'
import {
  readAIConfigDetailed,
  type AIConfigLoad,
} from '../claude-bridge/direct-chat-ai-config'
import { AppSettingsRepository } from '../repositories/app-settings-repository'
import {
  getProviderDef,
  normalizeAIConfig,
  resolveAIConfigCapabilities,
  type AIModelConfig,
  type AIProviderDef,
} from '../../../shared/ai-providers'
import {
  applyProviderRequestPatch,
  applyProviderResponsePatch,
  resolveProviderDefaultPatchers,
  resolveProviderPatchProfile,
  type PatchContext,
} from '../../../shared/ai-providers/index'
import {
  parseJsonOrEventStreamResponse,
} from '../openai-responses'
import {
  buildChatCompletionsToolCalls,
  buildResponsesToolCalls,
} from '../claude-bridge/provider-tool-arguments'
import { resolveOpenAIProviderRuntime } from './provider-runtime-resolver'
import type { BrowserTaskDecisionMode } from '../../../shared/browser-agent-task'
import { defaultToolRegistry } from './tool-registry'
import type { ToolDefinition } from './tool-definition'
import {
  buildExplicitNoSkillAuthorization,
  buildSelectedSkillToolAuthorization,
  type SkillToolAuthorization,
} from './skill-tool-authorization'
import { resolveCapabilityResolution } from './capability-resolver'
import { filterToolsByVisionCapability } from './tool-gateway'
import {
  buildToolRuntimeContext,
  toToolExecutorContext,
} from './tool-runtime-context-builder'
import { createEmptyActiveFrameContext } from './tool-runtime'
import { snapshotTurnFeatureFlags } from './turn-feature-flags'
import { executeToolCall as executeReadyToolCall } from '../tools'
import { PRIMITIVE_TOOL_DEFS, PRIMITIVE_TOOL_NAME_SET } from '../tools/skill-primitives/tool-defs'
import {
  createToolExecutionOutput,
  normalizeToolExecutionOutput,
  type ToolExecutionOutput,
} from './tool-result-types'
import { createRotatingLogger } from '../../utils/rotating-logger'

const agentSdkLogger = createRotatingLogger('ready-agent-sdk.log')
const settingsRepository = new AppSettingsRepository()

function log(message: string): void {
  try {
    agentSdkLogger.append(`[${new Date().toISOString()}] ${message}\n`)
  } catch {
    // silent-catch: logging must never break the agent path.
    // logging must never break the agent path
  }
}

interface AgentSdkSession {
  sdkSession: MemorySession
  abortController: AbortController | null
  systemPrompt: string
  generation: number
  activeRunId: string | null
}

interface ReadyAgentSdkRunParams {
  agentName: string
  runId: string
  taskId: string
  sessionId?: string
  input: string | AgentInputItem[]
  instructions: string
  model: string
  provider: ModelProvider
  session: MemorySession
  tools: AgentSdkTool[]
  signal: AbortSignal
  onTextDelta: (delta: string) => void
}

interface ReadyAgentSdkRunResult {
  finalText: string
}

interface ToolBridgeRuntimeContext {
  agentName: string
  runId: string
  taskId: string
  sessionId?: string
  signal: AbortSignal
  allowedToolNames: string[]
  authorization: SkillToolAuthorization
  emitOutput: (chunk: string, type: string, projectionPatch?: Record<string, unknown> | null) => void
  emitToolAction: (toolName: string, args: Record<string, unknown>) => void
  recordToolResult: (toolName: string, output: ToolExecutionOutput) => void
}

interface SkillContextOrchestratorLike {
  findExplicitlyRequestedSkills?: (userText: string) => Array<{
    id?: string
    skillId?: string
    name?: string
  }>
  buildPreferredSkillToolNames?: (userText: string, sessionId?: string) => string[] | null
  getCurrentReferenceSkillHint?: (sessionId?: string) => { id: string; name: string } | null
  rememberExplicitReferenceSkillHint?: (userText: string, sessionId?: string) => boolean
}

export interface AgentSdkRuntimeDeps {
  domainAdapters?: ReadonlyArray<DomainAdapter>
  loadAIConfig?: () => AIConfigLoad
  runAgent?: (params: ReadyAgentSdkRunParams) => Promise<ReadyAgentSdkRunResult>
  listToolDefinitions?: (params: {
    message: RunMessage
    sessionId?: string
    scopeId?: string
    config: AIModelConfig
    browserHostAvailable: boolean
    feishuConnected: boolean
    authorization: SkillToolAuthorization
  }) => ToolDefinition[]
  executeToolCall?: (
    toolName: string,
    args: Record<string, unknown>,
    context: ReturnType<typeof toToolExecutorContext>,
  ) => Promise<ToolExecutionOutput>
  fetchWithTimeout?: (
    url: string,
    init: RequestInit,
    signal: AbortSignal,
    label: string,
    timeoutMs?: number,
  ) => Promise<Response>
  skillContextOrchestrator?: SkillContextOrchestratorLike | null
}

function defaultSystemPrompt(): string {
  return '你是 Ready 应用中的 AI 助手，面向自媒体创作者。你擅长内容策划、文案写作、数据分析和创意建议。请使用简洁清晰的中文回答。'
}

function messageToText(message: RunMessage): string {
  if (typeof message === 'string') return message
  return message
    .map((block) => typeof block.text === 'string' ? block.text : '')
    .join('\n')
    .trim()
}

function shouldExposeResearchTools(message: RunMessage): boolean {
  const text = messageToText(message)
  return /(?:搜索|查找|查一下|检索|研究|资料|来源|引用|最新|今天|新闻|天气|股价|汇率|比分|赛程|官网|公告|价格|source|citation|research|search|latest|today|news)/i.test(text)
}

function resolveBrowserDecisionMode(
  message: RunMessage,
  browserHostAvailable: boolean,
): BrowserTaskDecisionMode {
  if (!browserHostAvailable) return 'free_tool_loop'
  const text = messageToText(message)
  if (/(?:上传|附件|文件选择|upload|attach)/i.test(text)) return 'browser_upload_workflow'
  if (
    shouldExposeResearchTools(message)
    || /(?:网页|浏览器|网站|打开|点击|输入|页面|链接|下载|url|https?:\/\/|browser|website|click|download)/i.test(text)
  ) {
    return 'browser_workflow'
  }
  return 'free_tool_loop'
}

function toSdkInput(message: RunMessage): string | AgentInputItem[] {
  if (typeof message === 'string') return message

  const content = message.map((block) => {
    if (block.type === 'image' && block.base64) {
      return {
        type: 'input_image',
        image: `data:${block.mimeType || 'image/png'};base64,${block.base64}`,
        detail: 'auto',
      }
    }
    const fallbackText = block.type === 'video'
      ? '[视频附件已接收；当前 SDK 实验路径会先把视频作为附件说明处理。]'
      : block.text || ''
    return {
      type: 'input_text',
      text: fallbackText,
    }
  })

  return [
    {
      role: 'user',
      content,
    } as AgentInputItem,
  ]
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (
    error.name === 'AbortError'
    || /abort|cancel/i.test(error.message)
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function defaultFetchWithTimeout(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  return fetch(url, {
    ...init,
    signal,
  })
}

function classifySdkRuntimeError(error: unknown): {
  terminalReason: TurnTerminalReason
  userMessagePrefix: string
} {
  const message = errorMessage(error)
  if (/(?:api key|authentication|unauthorized|invalid.*key|forbidden|401|403|只支持 OpenAI 协议)/i.test(message)) {
    return {
      terminalReason: 'blocked_config',
      userMessagePrefix: 'SDK 配置失败',
    }
  }
  if (/(?:quota|rate limit|429|fetch failed|network|timeout|timed out|ENOTFOUND|ECONN|ETIMEDOUT)/i.test(message)) {
    return {
      terminalReason: 'blocked_external',
      userMessagePrefix: 'SDK 外部服务暂时不可用',
    }
  }
  return {
    terminalReason: 'blocked_external',
    userMessagePrefix: 'SDK 请求失败',
  }
}

function resolveAgentSdkProvider(
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

export function canUseReadyAgentSdkForConfig(config: AIModelConfig | null | undefined): boolean {
  const normalized = normalizeAIConfig(config)
  if (!normalized?.provider || !normalized.model) return false
  const protocol = resolveAIConfigCapabilities(normalized)?.agentProtocol
  return protocol === 'openai' || protocol === 'anthropic'
}

function extractToolCallFromStreamEvent(event: RunStreamEvent): {
  name: string
  args: Record<string, unknown>
} | null {
  if (event.type !== 'run_item_stream_event' || event.name !== 'tool_called') return null
  const rawItem = (event.item as { rawItem?: unknown }).rawItem
  if (!rawItem || typeof rawItem !== 'object') return null
  const record = rawItem as { type?: unknown; name?: unknown; arguments?: unknown }
  if (record.type !== 'function_call' || typeof record.name !== 'string') return null
  if (typeof record.arguments !== 'string') {
    return { name: record.name, args: {} }
  }
  try {
    const parsed = JSON.parse(record.arguments) as unknown
    return {
      name: record.name,
      args: parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {},
    }
  } catch {
    // silent-catch: invalid streamed tool arguments fall back to an empty object.
    return { name: record.name, args: {} }
  }
}

async function runWithOpenAIAgentsSdk(
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
    maxTurns: 8,
    toolExecution: {
      maxFunctionToolConcurrency: 1,
    },
  })
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
  if (stream.error) throw stream.error
  return {
    finalText: typeof stream.finalOutput === 'string' ? stream.finalOutput : '',
  }
}

function stringifyToolResult(output: ToolExecutionOutput): string {
  const normalized = normalizeToolExecutionOutput(output)
  return JSON.stringify({
    text: normalized.text,
    shape: normalized.shape,
    data: normalized.data,
    projectionPatch: normalized.projectionPatch,
    framePatch: normalized.framePatch,
    interactionHint: normalized.interactionHint,
  })
}

function toOpenAIToolSchemas(definitions: ToolDefinition[]): Array<Record<string, unknown>> {
  return definitions.map((definition) => ({
    type: 'function',
    function: {
      name: definition.name,
      description: definition.description || definition.name,
      parameters: definition.schema && definition.schema.type === 'object'
        ? definition.schema
        : { type: 'object', properties: {}, additionalProperties: false },
    },
  }))
}

function buildProviderPatchContext(params: {
  config: AIModelConfig
  baseUrl: string
  model: string
}): PatchContext {
  const defaults = resolveProviderDefaultPatchers(params.config.provider)
  return {
    config: params.config,
    baseUrl: params.baseUrl,
    model: params.model,
    profile: resolveProviderPatchProfile(params.config, params.baseUrl, params.model),
    providerDefaultRequestPatcher: defaults.defaultRequestPatcher,
    providerDefaultResponsePatcher: defaults.defaultResponsePatcher,
  }
}

function buildProviderHeaders(config: AIModelConfig, provider: AIProviderDef | undefined): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const authHeader = provider?.authHeader || 'Authorization'
  const authPrefix = provider?.authPrefix ?? 'Bearer '
  headers[authHeader] = `${authPrefix}${config.apiKey}`
  if (provider?.extraHeaders) Object.assign(headers, provider.extraHeaders)
  return headers
}

function resolveOpenAIProtocolModel(config: AIModelConfig): string {
  if (config.provider === 'volcengine' && config.endpointId) return config.endpointId
  return config.model
}

function normalizeOpenAIChatContent(content: unknown): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = content
    .map((item) => item && typeof item === 'object' ? item as Record<string, unknown> : null)
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((part) => {
      if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
        return { type: 'text', text: String(part.text || '') }
      }
      if (part.type === 'input_image' && typeof part.image === 'string') {
        return { type: 'image_url', image_url: { url: part.image } }
      }
      return { type: 'text', text: '' }
    })
  return parts.length > 0 ? parts : ''
}

function normalizeOpenAIResponsesContent(content: unknown, role: 'user' | 'assistant'): Array<Record<string, unknown>> {
  const textType = role === 'assistant' ? 'output_text' : 'input_text'
  if (typeof content === 'string') return [{ type: textType, text: content }]
  if (!Array.isArray(content)) return [{ type: textType, text: '' }]
  const parts = content
    .map((item) => item && typeof item === 'object' ? item as Record<string, unknown> : null)
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((part) => {
      if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
        return { type: textType, text: String(part.text || '') }
      }
      if (part.type === 'input_image' && typeof part.image === 'string') {
        return { type: 'input_image', image_url: part.image }
      }
      return { type: textType, text: '' }
    })
  return parts.length > 0 ? parts : [{ type: textType, text: '' }]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readReasoningContentFromRecord(record: Record<string, unknown>): unknown {
  if (Object.prototype.hasOwnProperty.call(record, 'reasoning_content')) {
    return record.reasoning_content
  }
  if (Object.prototype.hasOwnProperty.call(record, 'reasoningContent')) {
    return record.reasoningContent
  }
  const additional = asRecord(record.additional_kwargs) || asRecord(record.additionalKwargs)
  if (additional && Object.prototype.hasOwnProperty.call(additional, 'reasoning_content')) {
    return additional.reasoning_content
  }
  const providerData = asRecord(record.providerData)
  if (providerData) {
    const fromProviderData = readReasoningContentFromRecord(providerData)
    if (fromProviderData !== undefined) return fromProviderData
  }
  return undefined
}

function reasoningProviderData(reasoningContent: unknown): Record<string, unknown> | undefined {
  return reasoningContent !== undefined ? { reasoning_content: reasoningContent } : undefined
}

function modelInputToOpenAIChatMessages(input: ModelRequest['input']): Array<Record<string, unknown>> {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }]
  }
  const messages: Array<Record<string, unknown>> = []
  for (const rawItem of input || []) {
    if (!rawItem || typeof rawItem !== 'object') continue
    const item = rawItem as Record<string, unknown>
    if (item.type === 'function_call') {
      const callId = String(item.callId || item.call_id || item.id || `call-${randomUUID()}`)
      const reasoningContent = readReasoningContentFromRecord(item)
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: callId,
          type: 'function',
          function: {
            name: String(item.name || ''),
            arguments: typeof item.arguments === 'string'
              ? item.arguments
              : JSON.stringify(item.arguments || {}),
          },
        }],
        ...(reasoningContent !== undefined ? { reasoning_content: reasoningContent } : {}),
      })
      continue
    }
    if (item.type === 'function_call_result') {
      const output = typeof item.output === 'string'
        ? item.output
        : JSON.stringify(item.output || '')
      messages.push({
        role: 'tool',
        tool_call_id: String(item.callId || item.call_id || item.id || ''),
        content: output,
      })
      continue
    }
    const role = item.role === 'assistant' || item.role === 'user' || item.role === 'system'
      ? item.role
      : null
    if (!role) continue
    const reasoningContent = readReasoningContentFromRecord(item)
    messages.push({
      role,
      content: normalizeOpenAIChatContent(item.content),
      ...(reasoningContent !== undefined ? { reasoning_content: reasoningContent } : {}),
    })
  }
  return messages.length > 0 ? messages : [{ role: 'user', content: '' }]
}

function modelInputToOpenAIResponsesInput(input: ModelRequest['input']): Array<Record<string, unknown>> {
  if (typeof input === 'string') {
    return [{ role: 'user', content: [{ type: 'input_text', text: input }] }]
  }
  const items: Array<Record<string, unknown>> = []
  for (const rawItem of input || []) {
    if (!rawItem || typeof rawItem !== 'object') continue
    const item = rawItem as Record<string, unknown>
    if (item.type === 'function_call') {
      items.push({
        type: 'function_call',
        call_id: String(item.callId || item.call_id || item.id || `call-${randomUUID()}`),
        name: String(item.name || ''),
        arguments: typeof item.arguments === 'string'
          ? item.arguments
          : JSON.stringify(item.arguments || {}),
      })
      continue
    }
    if (item.type === 'function_call_result') {
      const output = typeof item.output === 'string'
        ? item.output
        : JSON.stringify(item.output || '')
      items.push({
        type: 'function_call_output',
        call_id: String(item.callId || item.call_id || item.id || ''),
        output,
      })
      continue
    }
    const role = item.role === 'assistant' ? 'assistant' : 'user'
    items.push({
      role,
      content: normalizeOpenAIResponsesContent(item.content, role),
    })
  }
  return items.length > 0 ? items : [{ role: 'user', content: [{ type: 'input_text', text: '' }] }]
}

function serializeSdkOpenAITools(request: ModelRequest): Array<Record<string, unknown>> {
  return (request.tools || [])
    .filter((item) => item.type === 'function')
    .map((item) => ({
      type: 'function',
      function: {
        name: item.name,
        description: item.description || item.name,
        parameters: item.parameters && typeof item.parameters === 'object'
          ? item.parameters
          : { type: 'object', properties: {}, additionalProperties: false },
      },
    }))
}

function serializeSdkOpenAIResponsesTools(request: ModelRequest): Array<Record<string, unknown>> {
  return serializeSdkOpenAITools(request).map((item) => {
    const fn = item.function as Record<string, unknown>
    return {
      type: 'function',
      name: fn.name,
      description: fn.description,
      parameters: fn.parameters,
    }
  })
}

function textFromAgentOutputItem(item: AgentOutputItem): string {
  if (item.type !== 'message') return ''
  if (typeof item.content === 'string') return item.content
  if (!Array.isArray(item.content)) return ''
  return item.content
    .map((part) => part && typeof part === 'object' && part.type === 'output_text' ? String(part.text || '') : '')
    .join('')
}

function extractResponsesText(payload: Record<string, unknown>): string {
  const output = Array.isArray(payload.output) ? payload.output as Array<Record<string, unknown>> : []
  const texts: string[] = []
  for (const item of output) {
    const content = Array.isArray(item.content) ? item.content as Array<Record<string, unknown>> : []
    for (const part of content) {
      if (part.type === 'output_text' && typeof part.text === 'string') texts.push(part.text)
    }
  }
  if (texts.length > 0) return texts.join('')
  return typeof payload.output_text === 'string' ? payload.output_text : ''
}

function openAIUsageFromJson(json: Record<string, unknown>): Usage {
  const usage = json.usage && typeof json.usage === 'object'
    ? json.usage as Record<string, unknown>
    : {}
  const inputTokens = Number(usage.input_tokens || usage.prompt_tokens || usage.inputTokens || 0)
  const outputTokens = Number(usage.output_tokens || usage.completion_tokens || usage.outputTokens || 0)
  const totalTokens = Number(usage.total_tokens || usage.totalTokens || inputTokens + outputTokens || 0)
  return new Usage({
    inputTokens,
    outputTokens,
    totalTokens,
  })
}

function toOpenAIMessageOutput(
  text: string,
  id: string,
  providerData?: Record<string, unknown>,
): AgentOutputItem[] {
  if (!text) return []
  return [{
    id,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text }],
    ...(providerData ? { providerData } : {}),
  } as AgentOutputItem]
}

function toOpenAIFunctionCallOutput(
  calls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  id: string,
  providerData?: Record<string, unknown>,
): AgentOutputItem[] {
  return calls.map((call) => ({
    id,
    type: 'function_call',
    callId: call.id || `call-${randomUUID()}`,
    name: call.name,
    status: 'completed',
    arguments: JSON.stringify(call.input || {}),
    ...(providerData ? { providerData } : {}),
  } as AgentOutputItem))
}

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

class ReadyOpenAICompatibleModel implements Model {
  constructor(private readonly deps: {
    config: AIModelConfig
    baseUrl: string
    fetchWithTimeout: NonNullable<AgentSdkRuntimeDeps['fetchWithTimeout']>
  }) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
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
      ...modelInputToOpenAIChatMessages(request.input),
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
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${rawText.slice(0, 300)}`)
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
      input: modelInputToOpenAIResponsesInput(request.input),
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
      throw new Error(`HTTP ${response.status}: ${rawError.slice(0, 300)}`)
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

function safeJsonParseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    // silent-catch: malformed provider JSON is treated as an empty object.
    return {}
  }
}

function dataUrlToAnthropicImage(value: string): Record<string, unknown> | null {
  const match = value.match(/^data:([^;,]+);base64,(.+)$/)
  if (!match) return null
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: match[1],
      data: match[2],
    },
  }
}

function contentPartToAnthropic(part: Record<string, unknown>): Record<string, unknown> | null {
  if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
    return { type: 'text', text: String(part.text || '') }
  }
  if (part.type === 'input_image' && typeof part.image === 'string') {
    return dataUrlToAnthropicImage(part.image) || { type: 'text', text: '[图片附件]' }
  }
  return null
}

function normalizeAnthropicContent(content: unknown): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = content
    .map((item) => item && typeof item === 'object' ? contentPartToAnthropic(item as Record<string, unknown>) : null)
    .filter((item): item is Record<string, unknown> => Boolean(item))
  return parts.length > 0 ? parts : ''
}

function modelInputToAnthropicMessages(input: ModelRequest['input']): Array<Record<string, unknown>> {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }]
  }
  const messages: Array<Record<string, unknown>> = []
  for (const rawItem of input || []) {
    if (!rawItem || typeof rawItem !== 'object') continue
    const item = rawItem as Record<string, unknown>
    if (item.type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: String(item.callId || item.id || ''),
          name: String(item.name || ''),
          input: typeof item.arguments === 'string' ? safeJsonParseObject(item.arguments) : {},
        }],
      })
      continue
    }
    if (item.type === 'function_call_result') {
      const output = typeof item.output === 'string'
        ? item.output
        : JSON.stringify(item.output || '')
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: String(item.callId || item.id || ''),
          content: output,
        }],
      })
      continue
    }
    const role = item.role === 'assistant' || item.role === 'user'
      ? item.role
      : item.role === 'system'
        ? 'user'
        : null
    if (!role) continue
    messages.push({
      role,
      content: normalizeAnthropicContent(item.content),
    })
  }
  return messages.length > 0 ? messages : [{ role: 'user', content: '' }]
}

function serializeAnthropicTools(request: ModelRequest): Array<Record<string, unknown>> {
  return (request.tools || [])
    .filter((item) => item.type === 'function')
    .map((item) => ({
      name: item.name,
      description: item.description || item.name,
      input_schema: item.parameters && typeof item.parameters === 'object'
        ? item.parameters
        : { type: 'object', properties: {}, additionalProperties: false },
    }))
}

function extractAnthropicOutput(json: Record<string, unknown>, fallbackId: string): AgentOutputItem[] {
  const output: AgentOutputItem[] = []
  const content = Array.isArray(json.content) ? json.content as Array<Record<string, unknown>> : []
  const text = content
    .filter((block) => block.type === 'text')
    .map((block) => String(block.text || ''))
    .join('')
  if (text) {
    output.push({
      id: String(json.id || fallbackId),
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text }],
    } as AgentOutputItem)
  }
  for (const block of content) {
    if (block.type !== 'tool_use') continue
    output.push({
      id: String(json.id || fallbackId),
      type: 'function_call',
      callId: String(block.id || `call-${randomUUID()}`),
      name: String(block.name || ''),
      status: 'completed',
      arguments: JSON.stringify(
        block.input && typeof block.input === 'object' && !Array.isArray(block.input)
          ? block.input
          : {},
      ),
    } as AgentOutputItem)
  }
  return output
}

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

class ReadyAnthropicModel implements Model {
  constructor(private readonly deps: {
    config: AIModelConfig
    baseUrl: string
    fetchWithTimeout: NonNullable<AgentSdkRuntimeDeps['fetchWithTimeout']>
  }) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const responseId = `anthropic-${randomUUID()}`
    const body: Record<string, unknown> = {
      model: this.deps.config.model,
      max_tokens: request.modelSettings.maxTokens || 4096,
      system: request.systemInstructions || '',
      messages: modelInputToAnthropicMessages(request.input),
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
      throw new Error(`HTTP ${resp.status}: ${rawText.slice(0, 300)}`)
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

function publicAgentName(agentName: string): string {
  const marker = agentName.indexOf('::')
  return marker === -1 ? agentName : agentName.slice(0, marker)
}

function scopeRunModuleForTool(definition: ToolDefinition): ScopeRunEventPayload['module'] {
  if (definition.domain === 'general_research') return 'research'
  if (
    definition.domain === 'file'
    || definition.domain === 'memory'
    || definition.domain === 'session'
    || definition.domain === 'mcp'
    || definition.domain === 'pet'
  ) {
    return 'system'
  }
  return definition.domain
}

function formatToolCallTrace(toolName: string, args: Record<string, unknown>): string {
  const keys = Object.keys(args)
    .filter((key) => !/(?:key|token|secret|password|authorization)/i.test(key))
    .slice(0, 6)
  return `${toolName}(${keys.join(', ')})`
}

function formatToolResultTrace(toolName: string, output: ToolExecutionOutput): string {
  const normalized = normalizeToolExecutionOutput(output)
  const text = String(normalized.text || '').trim()
  return text ? `${toolName}: ${text.slice(0, 240)}` : `${toolName}: 已完成`
}

export class AgentSdkRuntime extends EventEmitter {
  private readonly sessions = new Map<string, AgentSdkSession>()
  private readonly domainAdapters: ReadonlyArray<DomainAdapter>
  private readonly loadAIConfig: () => AIConfigLoad
  private readonly runAgent: (params: ReadyAgentSdkRunParams) => Promise<ReadyAgentSdkRunResult>
  private readonly listToolDefinitionsForTurn: NonNullable<AgentSdkRuntimeDeps['listToolDefinitions']>
  private readonly executeToolCall: NonNullable<AgentSdkRuntimeDeps['executeToolCall']>
  private readonly fetchWithTimeout: NonNullable<AgentSdkRuntimeDeps['fetchWithTimeout']>
  private readonly skillContextOrchestrator: SkillContextOrchestratorLike | null
  private browserController: BrowserController | null = null
  private sidecarManager: SidecarManager | null = null
  private runtime: AgentControlRuntime | null = null
  private runCleanupRegistry: {
    registerRunCleanup: (runId: string, cleanup: () => void | Promise<void>) => void
  } | null = null
  private rendererToolActionRequester: ((payload: {
    agent?: string
    sessionId?: string
    runId?: string
    tool: string
    args: Record<string, unknown>
  }) => Promise<Record<string, unknown>>) | null = null
  private cancelPendingToolActions: ((agent: string, sessionId?: string) => void) | null = null

  constructor(deps: AgentSdkRuntimeDeps = {}) {
    super()
    this.domainAdapters = deps.domainAdapters || []
    this.loadAIConfig = deps.loadAIConfig || (() =>
      readAIConfigDetailed(() => settingsRepository.getSetting('ai_model_config')))
    this.runAgent = deps.runAgent || runWithOpenAIAgentsSdk
    this.executeToolCall = deps.executeToolCall || executeReadyToolCall
    this.fetchWithTimeout = deps.fetchWithTimeout || defaultFetchWithTimeout
    this.skillContextOrchestrator = deps.skillContextOrchestrator || null
    this.listToolDefinitionsForTurn = deps.listToolDefinitions || ((params) =>
      this.listDefaultToolDefinitionsForTurn(params))
  }

  setRunCleanupRegistry(registry: {
    registerRunCleanup: (runId: string, cleanup: () => void | Promise<void>) => void
  } | null): void {
    this.runCleanupRegistry = registry
  }

  setBrowserController(controller: BrowserController): void {
    this.browserController = controller
  }

  hasBrowserController(): boolean {
    return Boolean(this.browserController)
  }

  getDomainAdapters(): ReadonlyArray<DomainAdapter> {
    return this.domainAdapters
  }

  setSidecarManager(manager: SidecarManager): void {
    this.sidecarManager = manager
  }

  setRuntime(runtime: AgentControlRuntime): void {
    this.runtime = runtime
  }

  setRendererToolActionRequester(
    requester: ((payload: {
      agent?: string
      sessionId?: string
      runId?: string
      tool: string
      args: Record<string, unknown>
    }) => Promise<Record<string, unknown>>) | null,
  ): void {
    this.rendererToolActionRequester = requester
  }

  setCancelPendingToolActions(
    canceller: ((agent: string, sessionId?: string) => void) | null,
  ): void {
    this.cancelPendingToolActions = canceller
  }

  private listDefaultToolDefinitionsForTurn(params: {
    message: RunMessage
    sessionId?: string
    scopeId?: string
    config: AIModelConfig
    browserHostAvailable: boolean
    feishuConnected: boolean
    authorization: SkillToolAuthorization
  }): ToolDefinition[] {
    const capabilityResolution = resolveCapabilityResolution({
      config: params.config,
      profile: 'local_chat',
      browserDecisionMode: resolveBrowserDecisionMode(params.message, params.browserHostAvailable),
      runtimeAvailability: {
        browserHostAvailable: params.browserHostAvailable,
        feishuConnected: params.feishuConnected,
      },
    })
    const definitions = capabilityResolution.visibleCapabilityGroupIds.flatMap((groupId) =>
      defaultToolRegistry.getToolDefinitionsForGroup(
        groupId,
        params.sessionId,
        params.authorization,
        params.scopeId,
      ))
    return filterToolsByVisionCapability(
      definitions as unknown as Array<Record<string, unknown>>,
      { supportsVision: capabilityResolution.supportsVision === true },
    ) as unknown as ToolDefinition[]
  }

  newSession(name: string, systemPrompt?: string): void {
    this.stopGeneration(name)
    this.sessions.set(name, {
      sdkSession: new MemorySession({ sessionId: name }),
      abortController: null,
      systemPrompt: systemPrompt || defaultSystemPrompt(),
      generation: 0,
      activeRunId: null,
    })
  }

  setSystemPrompt(name: string, systemPrompt?: string): void {
    if (!this.sessions.has(name)) {
      this.newSession(name, systemPrompt)
      return
    }
    const session = this.sessions.get(name)!
    session.systemPrompt = systemPrompt || defaultSystemPrompt()
  }

  stopGeneration(name: string): void {
    const session = this.sessions.get(name)
    if (!session) return
    const runId = session.activeRunId
    session.generation += 1
    if (session.abortController) {
      try {
        this.cancelPendingToolActions?.(name)
      } catch (error) {
        log(`cancelPendingToolActions failed: ${errorMessage(error)}`)
      }
      session.abortController.abort(new Error('cancelled_user'))
      session.abortController = null
    }
    if (runId) {
      this.emit('status', {
        agent: name,
        runId,
        status: 'cancelled',
        terminalReason: 'cancelled_user',
        isMock: false,
      })
      session.activeRunId = null
    }
  }

  async sendMessage(
    name: string,
    content: string | MultimodalBlock[],
    requestId?: string,
    executionOptions?: {
      taskId?: string
      publicSessionId?: string
      requestEnvelope?: unknown
    },
  ): Promise<ExecutionTurnResult> {
    const runId = requestId || randomUUID()
    if (!this.sessions.has(name)) {
      this.newSession(name)
    }
    const session = this.sessions.get(name)!
    const taskId = executionOptions?.taskId || `task-${runId}`
    const sessionId = executionOptions?.publicSessionId || this.extractSessionIdFromInternalName(name)
    const transcriptEvents: TurnTranscriptEvent[] = []
    const usedTools: string[] = []
    const projectionPatches: Record<string, unknown>[] = []

    if (session.abortController) {
      const previousAbortController = session.abortController
      try {
        this.cancelPendingToolActions?.(name, sessionId)
      } catch (error) {
        log(`preempt cancelPendingToolActions failed: ${errorMessage(error)}`)
      }
      session.generation += 1
      previousAbortController.abort(new Error('process_restarted'))
      session.abortController = null
      log(`preempted previous SDK run agent=${name}`)
    }

    session.generation += 1
    const runGeneration = session.generation
    session.activeRunId = runId
    const abortController = new AbortController()
    session.abortController = abortController

    const isCurrentRun = (): boolean => {
      const latest = this.sessions.get(name)
      return Boolean(latest && latest.generation === runGeneration && latest.activeRunId === runId)
    }
    const emitOutput = (chunk: string, type: string, projectionPatch?: Record<string, unknown> | null): void => {
      if (!isCurrentRun()) return
      transcriptEvents.push({ kind: 'output', type, chunk, projectionPatch: projectionPatch || null })
      this.emit('output', {
        agent: name,
        sessionId,
        runId,
        taskId,
        chunk,
        type,
        projectionPatch: projectionPatch || null,
      })
    }
    const emitStatus = (status: string, terminalReason?: TurnTerminalReason | null): void => {
      if (!isCurrentRun()) return
      transcriptEvents.push({ kind: 'status', status, terminalReason: terminalReason || null })
      this.emit('status', {
        agent: name,
        sessionId,
        runId,
        status,
        ...(typeof terminalReason === 'undefined' ? {} : { terminalReason }),
        isMock: false,
      })
    }
    const emitRuntimeError = (error: unknown, terminalReason: TurnTerminalReason): void => {
      if (!isCurrentRun()) return
      const message = errorMessage(error)
      transcriptEvents.push({ kind: 'error', error: message })
      this.emit('error', {
        agent: name,
        sessionId,
        runId,
        error: message,
        type: 'runtime',
        errorKind: terminalReason,
        recoverable: false,
      })
    }

    emitStatus('working')

    try {
      const configDetail = this.loadAIConfig()
      if (!configDetail.ok) {
        const userMessage =
          configDetail.reason === 'json_corrupt'
            ? 'AI 配置已损坏（JSON 解析失败），请前往设置页重置'
            : 'AI 配置读取失败（数据库错误），请稍后重试或检查日志'
        emitOutput(userMessage, 'error')
        emitOutput('', 'done')
        emitStatus('error', configDetail.reason === 'json_corrupt' ? 'blocked_config' : 'persistence_failed')
        return this.buildResult({
          success: false,
          error: userMessage,
          finalText: '',
          cancelled: false,
          taskId,
          usedTools,
          transcriptEvents,
          projectionPatches,
          terminalReason: configDetail.reason === 'json_corrupt' ? 'blocked_config' : 'persistence_failed',
        })
      }
      if (!configDetail.config?.apiKey) {
        const userMessage = '未配置 API Key，请前往设置页配置'
        emitOutput(userMessage, 'error')
        emitOutput('', 'done')
        emitStatus('error', 'blocked_config')
        return this.buildResult({
          success: false,
          error: userMessage,
          finalText: '',
          cancelled: false,
          taskId,
          usedTools,
          transcriptEvents,
          projectionPatches,
          terminalReason: 'blocked_config',
        })
      }

      const { provider, model } = resolveAgentSdkProvider(configDetail.config, {
        fetchWithTimeout: this.fetchWithTimeout,
      })
      const capabilities = resolveAIConfigCapabilities(normalizeAIConfig(configDetail.config))
      const useTextToolBridge = capabilities?.toolCallTransport === 'text'
      const authorization = this.resolveSkillAuthorizationForTurn(content as RunMessage, sessionId)
      const toolDefinitions = this.listToolDefinitionsForTurn({
        message: content as RunMessage,
        sessionId,
        scopeId: sessionId,
        config: configDetail.config,
        browserHostAvailable: this.hasBrowserController(),
        feishuConnected: this.runtime?.isChannelTypeAvailable?.('feishu-app') ?? false,
        authorization,
      })
      const allowedToolNames = toolDefinitions.map((definition) => definition.name)
      const toolBridgeRuntimeContext: ToolBridgeRuntimeContext = {
        agentName: name,
        runId,
        taskId,
        sessionId,
        signal: abortController.signal,
        allowedToolNames,
        authorization,
        emitOutput,
        emitToolAction: (toolName, args) => {
          if (!isCurrentRun()) return
          transcriptEvents.push({ kind: 'tool_action', tool: toolName, args })
          this.emit('toolAction', { agent: name, sessionId, runId, tool: toolName, args })
        },
        recordToolResult: (toolName, output) => {
          usedTools.push(toolName)
          const normalized = normalizeToolExecutionOutput(output)
          if (normalized.projectionPatch) {
            projectionPatches.push(normalized.projectionPatch)
          }
        },
      }
      const definitionByName = new Map(toolDefinitions.map((definition) => [definition.name, definition]))
      const sdkTools = useTextToolBridge
        ? []
        : toolDefinitions.map((definition) => this.buildSdkTool(definition, toolBridgeRuntimeContext))

      const instructions = [
        session.systemPrompt,
        '你现在运行在 Ready 的 OpenAI Agents SDK 实验路径中。',
        '能用工具完成的事情要直接完成；最后用简单中文说明结果。',
        sdkTools.length > 0
          ? '本轮可用工具已经按 Ready 的策略过滤。不要声称使用不存在的工具。'
          : '本轮没有开放工具；直接回答或说明缺口。',
        useTextToolBridge && toolDefinitions.length > 0
          ? buildTextToolBridgePrompt(toOpenAIToolSchemas(toolDefinitions))
          : '',
        `当前日期：${new Date().toISOString().slice(0, 10)}`,
      ].join('\n')

      let finalText = ''
      let nextInput = toSdkInput(content as RunMessage)
      for (let bridgeTurn = 0; bridgeTurn < (useTextToolBridge ? 4 : 1); bridgeTurn += 1) {
        let streamedText = ''
        const runResult = await this.runAgent({
          agentName: name,
          runId,
          taskId,
          sessionId,
          input: nextInput,
          instructions,
          model,
          provider,
          session: session.sdkSession,
          tools: sdkTools,
          signal: abortController.signal,
          onTextDelta: (delta) => {
            streamedText += delta
            if (!useTextToolBridge) {
              emitOutput(delta, 'text')
            }
          },
        })
        const modelText = runResult.finalText || streamedText
        if (!useTextToolBridge) {
          finalText = modelText
          if (!streamedText && finalText) {
            emitOutput(finalText, 'text')
          }
          break
        }

        const parsed = parseTextToolBridgeResponse(modelText)
        if (parsed.visibleText) {
          emitOutput(parsed.visibleText, 'text')
        }
        if (parsed.toolCalls.length === 0) {
          finalText = parsed.visibleText || modelText
          break
        }

        const bridgeResults: Array<{ id: string; name: string; result: ToolExecutionOutput }> = []
        for (const call of parsed.toolCalls) {
          const definition = definitionByName.get(call.name)
          if (!definition) {
            bridgeResults.push({
              id: `text-bridge-${bridgeTurn}-${bridgeResults.length}`,
              name: call.name,
              result: createToolExecutionOutput(`工具 ${call.name} 未在本轮授权列表中。`, {
                shape: 'json',
                data: {
                  errorKind: 'tool_restricted_this_turn',
                  toolName: call.name,
                },
              }),
            })
            continue
          }
          const output = await this.executeReadyToolDefinition(
            definition,
            call.args,
            toolBridgeRuntimeContext,
          )
          bridgeResults.push({
            id: `text-bridge-${bridgeTurn}-${bridgeResults.length}`,
            name: call.name,
            result: output,
          })
        }
        nextInput = buildTextToolResultMessage(bridgeResults)
        finalText = parsed.visibleText
      }
      if (useTextToolBridge && !finalText && usedTools.length > 0) {
        finalText = '工具已执行，但模型尚未给出最终回复。'
        emitOutput(finalText, 'text')
      }
      const finalProjectionPatch = this.mergeProjectionPatches(projectionPatches)
      emitOutput('', 'done', finalProjectionPatch)
      emitStatus('done', 'done')
      return this.buildResult({
        success: true,
        finalText,
        cancelled: false,
        taskId,
        usedTools,
        transcriptEvents,
        projectionPatches,
        terminalReason: 'done',
      })
    } catch (error) {
      if (isAbortError(error)) {
        emitOutput('', 'done')
        emitStatus('cancelled', 'cancelled_runtime')
        return this.buildResult({
          success: true,
          finalText: '',
          cancelled: true,
          taskId,
          usedTools,
          transcriptEvents,
          projectionPatches,
          terminalReason: 'cancelled_runtime',
        })
      }
      const failure = classifySdkRuntimeError(error)
      const message = errorMessage(error)
      emitOutput(`${failure.userMessagePrefix}: ${message}`, 'error')
      emitOutput('', 'done')
      emitRuntimeError(error, failure.terminalReason)
      emitStatus('error', failure.terminalReason)
      return this.buildResult({
        success: false,
        error: message,
        finalText: '',
        cancelled: false,
        taskId,
        usedTools,
        transcriptEvents,
        projectionPatches,
        terminalReason: failure.terminalReason,
      })
    } finally {
      if (session.abortController === abortController) {
        session.abortController = null
      }
      if (session.activeRunId === runId) {
        session.activeRunId = null
      }
    }
  }

  private buildSdkTool(
    definition: ToolDefinition,
    runtimeContext: ToolBridgeRuntimeContext,
  ): AgentSdkTool {
    const schema = definition.schema && definition.schema.type === 'object'
      ? definition.schema
      : { type: 'object', properties: {}, additionalProperties: false }
    return tool({
      name: definition.name,
      description: definition.description,
      parameters: schema as never,
      strict: false,
      timeoutMs: definition.executionTimeoutMs,
      execute: async (input) => {
        const args = input && typeof input === 'object' && !Array.isArray(input)
          ? input as Record<string, unknown>
          : {}
        const output = await this.executeReadyToolDefinition(definition, args, runtimeContext)
        return stringifyToolResult(output)
      },
      errorFunction: (_context, error) => stringifyToolResult(createToolExecutionOutput(
        `工具 ${definition.name} 失败：${errorMessage(error)}`,
        {
          shape: 'json',
          data: {
            errorKind: 'tool_failed',
            toolName: definition.name,
            message: errorMessage(error),
          },
        },
      )),
    }) as AgentSdkTool
  }

  private async executeReadyToolDefinition(
    definition: ToolDefinition,
    args: Record<string, unknown>,
    runtimeContext: ToolBridgeRuntimeContext,
  ): Promise<ToolExecutionOutput> {
    const callTrace = formatToolCallTrace(definition.name, args)
    runtimeContext.emitOutput(callTrace, 'tool_use')
    this.publishSdkToolEvent({
      runtimeContext,
      definition,
      kind: 'call',
      text: callTrace,
    })
    runtimeContext.emitToolAction(definition.name, args)
    const output = await this.executeToolCall(
      definition.name,
      args,
      toToolExecutorContext(buildToolRuntimeContext({
        browserController: this.browserController,
        sidecarManager: this.sidecarManager,
        runtime: this.runtime,
        scope: runtimeContext.sessionId
          ? this.runtime?.getConversationScope(runtimeContext.sessionId) || undefined
          : undefined,
        allowedToolNames: runtimeContext.allowedToolNames,
        emitToolAction: runtimeContext.emitToolAction,
        requestModuleToolAction: this.rendererToolActionRequester
          ? (toolName, toolArgs) => this.rendererToolActionRequester!({
            agent: runtimeContext.agentName,
            sessionId: runtimeContext.sessionId,
            runId: runtimeContext.runId,
            tool: toolName,
            args: toolArgs,
          })
          : undefined,
        abortSignal: runtimeContext.signal,
        sessionId: runtimeContext.sessionId,
        scopeId: runtimeContext.sessionId,
        runId: runtimeContext.runId,
        taskId: runtimeContext.taskId,
        parentTaskId: runtimeContext.taskId,
        parentStepId: runtimeContext.taskId,
        taskProjectionId: runtimeContext.taskId,
        frameSkillId: null,
        registerRunCleanup: (cleanup) => {
          this.runCleanupRegistry?.registerRunCleanup(runtimeContext.runId, cleanup)
        },
        agentContext: null,
        turnFeatureFlags: snapshotTurnFeatureFlags(),
            activeFrame: createEmptyActiveFrameContext(),
            authorization: runtimeContext.authorization,
          })),
    )
    runtimeContext.recordToolResult(definition.name, output)
    const normalized = normalizeToolExecutionOutput(output)
    const resultTrace = formatToolResultTrace(definition.name, normalized)
    runtimeContext.emitOutput(resultTrace, 'tool_result', normalized.projectionPatch || null)
    this.publishSdkToolEvent({
      runtimeContext,
      definition,
      kind: 'result',
      text: resultTrace,
      projectionPatch: normalized.projectionPatch,
    })
    return output
  }

  private resolveSkillAuthorizationForTurn(
    message: RunMessage,
    sessionId?: string,
  ): SkillToolAuthorization {
    const orchestrator = this.skillContextOrchestrator
    if (!orchestrator) return buildExplicitNoSkillAuthorization('no_skill_signal')
    const userText = messageToText(message)
    if (!userText) return buildExplicitNoSkillAuthorization('no_skill_signal')
    const explicitSkills = orchestrator.findExplicitlyRequestedSkills?.(userText) || []
    const explicitSkill = explicitSkills[0] || null
    const explicitSkillId = explicitSkill?.id || explicitSkill?.skillId || null
    if (explicitSkillId) {
      try {
        orchestrator.rememberExplicitReferenceSkillHint?.(userText, sessionId)
      } catch (error) {
        log(`rememberExplicitReferenceSkillHint failed: ${errorMessage(error)}`)
      }
    }

    const preferredSkillToolNames = orchestrator.buildPreferredSkillToolNames?.(userText, sessionId) || []
    const typedActions = preferredSkillToolNames.filter((name) =>
      name.startsWith('skill_') && !PRIMITIVE_TOOL_NAME_SET.has(name),
    )
    const referenceHint = orchestrator.getCurrentReferenceSkillHint?.(sessionId) || null
    const skillId = explicitSkillId || (typedActions.length > 0 ? referenceHint?.id || null : null)
    if (!skillId) return buildExplicitNoSkillAuthorization('no_skill_signal')

    return buildSelectedSkillToolAuthorization({
      skillId,
      allowedTypedActions: typedActions,
      allowedPrimitives: PRIMITIVE_TOOL_DEFS.map((definition) => definition.name),
      source: explicitSkillId ? 'explicit' : 'active_task',
      reason: explicitSkillId ? 'explicit_user_mention' : 'reference_hint',
    })
  }

  private publishSdkToolEvent(params: {
    runtimeContext: ToolBridgeRuntimeContext
    definition: ToolDefinition
    kind: 'call' | 'result'
    text: string
    projectionPatch?: Record<string, unknown> | null
  }): void {
    if (!params.runtimeContext.sessionId) return
    const timestamp = new Date().toISOString()
    const projectionPatch = params.projectionPatch || null
    this.runtime?.publishScopeRunEvent({
      type: 'updated',
      scopeId: params.runtimeContext.sessionId,
      agent: publicAgentName(params.runtimeContext.agentName),
      runId: params.runtimeContext.runId,
      taskId: params.runtimeContext.taskId,
      phase: params.kind === 'call' ? 'tool_running' : 'responding',
      module: scopeRunModuleForTool(params.definition),
      taskType: params.definition.domain === 'general_research' ? 'research' : undefined,
      taskProjectionId: params.runtimeContext.taskId,
      latestText: params.kind === 'result' ? params.text : undefined,
      taskTitle: typeof projectionPatch?.taskTitle === 'string' ? projectionPatch.taskTitle : undefined,
      taskSummary: typeof projectionPatch?.taskSummary === 'string' ? projectionPatch.taskSummary : undefined,
      toolEvent: {
        id: `sdk-tool-${params.kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: params.kind,
        text: params.text,
        timestamp,
      },
      timestamp,
    }, projectionPatch ? { projectionPatch, transcriptEvents: [] } : null)
  }

  private mergeProjectionPatches(patches: Record<string, unknown>[]): Record<string, unknown> | null {
    if (patches.length === 0) return null
    return patches.reduce<Record<string, unknown>>((acc, patch) => ({ ...acc, ...patch }), {})
  }

  private buildResult(params: {
    success: boolean
    finalText: string
    cancelled: boolean
    taskId: string
    usedTools: string[]
    transcriptEvents: TurnTranscriptEvent[]
    projectionPatches: Record<string, unknown>[]
    terminalReason: TurnTerminalReason
    error?: string
  }): ExecutionTurnResult {
    const taskType = this.resolveTaskTypeFromTools(params.usedTools)
    return {
      success: params.success,
      status: params.cancelled ? 'cancelled' : params.success ? 'done' : 'error',
      finalText: params.finalText,
      cancelled: params.cancelled,
      usedTools: [...params.usedTools],
      error: params.error,
      taskId: params.taskId,
      taskType,
      interactionState: 'running',
      taskProjectionId: params.taskId,
      executionDiagnostics: {
        taskId: params.taskId,
        toolSnapshots: null,
      },
      projectionTruth: {
        projectionPatch: this.mergeProjectionPatches(params.projectionPatches),
        transcriptEvents: params.transcriptEvents,
      },
      terminalReason: params.terminalReason,
    }
  }

  private extractSessionIdFromInternalName(name: string): string | undefined {
    const marker = name.indexOf('::')
    return marker === -1 ? undefined : name.slice(marker + 2)
  }

  private resolveTaskTypeFromTools(usedTools: string[]): TaskType {
    if (usedTools.length === 0) return 'direct_answer'
    if (usedTools.some((name) =>
      name.startsWith('web_')
      || name === 'present_file'
      || name === 'browser_research_topic'
      || name === 'browser_search',
    )) {
      return 'research'
    }
    return 'multi_step_task'
  }
}
