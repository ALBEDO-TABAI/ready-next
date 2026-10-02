import { Usage, type AgentOutputItem, type ModelRequest } from '@openai/agents'
import { randomUUID } from 'crypto'
import {
  resolveAIConfigCapabilities,
  type AIModelConfig,
  type AIProviderDef
} from '../../../../shared/ai-providers'
import {
  resolveProviderDefaultPatchers,
  resolveProviderPatchProfile,
  type PatchContext
} from '../../../../shared/ai-providers/index'
import {
  sanitizeHistoricalMessagesByCapability,
  type CapabilityMessage,
  type MessageCapabilitySnapshot
} from '../domain-adapters/message-capability-filter'
import { logAgentMetric } from '../metrics'
import { redactModelVisibleToolText } from '../tools-runtime/model-visible-tool-output'
import type { ToolDefinition } from '../tools-runtime/tool-definition'
import type { ToolExecutionOutput } from '../tools-runtime/tool-result-types'
import { normalizeToolExecutionOutput } from '../tools-runtime/tool-result-types'
import { stringifyModelVisibleFunctionResult } from './agent-sdk-provider-utils'
import type { AgentSdkExecutionOptions } from './agent-sdk-types'
import { TOOL_TRACE_SECRET_KEY_PATTERN } from './tool-trace-detail'

// ── Group J: Model message builders (lines 3004-3247) ──

export function sanitizeMessagesForModelClient(
  rawMessages: ReadonlyArray<Record<string, unknown>>,
  config: AIModelConfig,
  route: 'openai-chat' | 'openai-responses' | 'anthropic'
): Array<Record<string, unknown>> {
  const resolved = resolveAIConfigCapabilities(config)
  const snapshot: MessageCapabilitySnapshot = {
    supportsVision: resolved?.supportsVision === true,
    supportsVideo: resolved?.supportsNativeVideo === true
  }
  if (snapshot.supportsVision && snapshot.supportsVideo) {
    return rawMessages.slice()
  }
  const decision = sanitizeHistoricalMessagesByCapability(
    rawMessages as unknown as CapabilityMessage[],
    snapshot
  )
  if (decision.removedImageBlocks > 0 || decision.removedVideoBlocks > 0) {
    logAgentMetric('provider_request_capability_filter', {
      route,
      removedImageBlocks: decision.removedImageBlocks,
      removedVideoBlocks: decision.removedVideoBlocks,
      replacedWithPlaceholders: decision.replacedWithPlaceholders,
      model: config.model,
      provider: config.provider
    })
  }
  return decision.filtered as unknown as Array<Record<string, unknown>>
}

export function modelInputToOpenAIChatMessages(
  input: ModelRequest['input']
): Array<Record<string, unknown>> {
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
        tool_calls: [
          {
            id: callId,
            type: 'function',
            function: {
              name: String(item.name || ''),
              arguments:
                typeof item.arguments === 'string'
                  ? item.arguments
                  : JSON.stringify(item.arguments || {})
            }
          }
        ],
        ...(reasoningContent !== undefined ? { reasoning_content: reasoningContent } : {})
      })
      continue
    }
    if (item.type === 'function_call_result') {
      const output = stringifyModelVisibleFunctionResult(item.output)
      messages.push({
        role: 'tool',
        tool_call_id: String(item.callId || item.call_id || item.id || ''),
        content: output
      })
      continue
    }
    const role =
      item.role === 'assistant' || item.role === 'user' || item.role === 'system' ? item.role : null
    if (!role) continue
    const reasoningContent = readReasoningContentFromRecord(item)
    messages.push({
      role,
      content: normalizeOpenAIChatContent(item.content),
      ...(reasoningContent !== undefined ? { reasoning_content: reasoningContent } : {})
    })
  }
  return messages.length > 0 ? messages : [{ role: 'user', content: '' }]
}

export function normalizeOpenAIChatContent(
  content: unknown
): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = content
    .map((item) => (item && typeof item === 'object' ? (item as Record<string, unknown>) : null))
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

export function normalizeOpenAIResponsesContent(
  content: unknown,
  role: 'user' | 'assistant'
): Array<Record<string, unknown>> {
  const textType = role === 'assistant' ? 'output_text' : 'input_text'
  if (typeof content === 'string') return [{ type: textType, text: content }]
  if (!Array.isArray(content)) return [{ type: textType, text: '' }]
  const parts = content
    .map((item) => (item && typeof item === 'object' ? (item as Record<string, unknown>) : null))
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

export function modelInputToOpenAIResponsesInput(
  input: ModelRequest['input']
): Array<Record<string, unknown>> {
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
        arguments:
          typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {})
      })
      continue
    }
    if (item.type === 'function_call_result') {
      const output = stringifyModelVisibleFunctionResult(item.output)
      items.push({
        type: 'function_call_output',
        call_id: String(item.callId || item.call_id || item.id || ''),
        output
      })
      continue
    }
    const role = item.role === 'assistant' ? 'assistant' : 'user'
    items.push({
      role,
      content: normalizeOpenAIResponsesContent(item.content, role)
    })
  }
  return items.length > 0 ? items : [{ role: 'user', content: [{ type: 'input_text', text: '' }] }]
}

export function serializeSdkOpenAITools(request: ModelRequest): Array<Record<string, unknown>> {
  return (request.tools || [])
    .filter((item) => item.type === 'function')
    .map((item) => ({
      type: 'function',
      function: {
        name: item.name,
        description: item.description || item.name,
        parameters:
          item.parameters && typeof item.parameters === 'object'
            ? item.parameters
            : { type: 'object', properties: {}, additionalProperties: false }
      }
    }))
}

export function serializeSdkOpenAIResponsesTools(
  request: ModelRequest
): Array<Record<string, unknown>> {
  return serializeSdkOpenAITools(request).map((item) => {
    const fn = item.function as Record<string, unknown>
    return {
      type: 'function',
      name: fn.name,
      description: fn.description,
      parameters: fn.parameters
    }
  })
}

export function textFromAgentOutputItem(item: AgentOutputItem): string {
  if (item.type !== 'message') return ''
  if (typeof item.content === 'string') return item.content
  if (!Array.isArray(item.content)) return ''
  return item.content
    .map((part) =>
      part && typeof part === 'object' && part.type === 'output_text' ? String(part.text || '') : ''
    )
    .join('')
}

export function extractResponsesText(payload: Record<string, unknown>): string {
  const output = Array.isArray(payload.output)
    ? (payload.output as Array<Record<string, unknown>>)
    : []
  const texts: string[] = []
  for (const item of output) {
    if (item.phase === 'commentary') continue
    const content = Array.isArray(item.content)
      ? (item.content as Array<Record<string, unknown>>)
      : []
    for (const part of content) {
      if (part.type === 'output_text' && typeof part.text === 'string') texts.push(part.text)
    }
  }
  if (texts.length > 0) return texts.join('')
  if (output.some((item) => item.type === 'message')) return ''
  return typeof payload.output_text === 'string' ? payload.output_text : ''
}

export function openAIUsageFromJson(json: Record<string, unknown>): Usage {
  const usage =
    json.usage && typeof json.usage === 'object' ? (json.usage as Record<string, unknown>) : {}
  const inputTokens = Number(usage.input_tokens || usage.prompt_tokens || usage.inputTokens || 0)
  const outputTokens = Number(
    usage.output_tokens || usage.completion_tokens || usage.outputTokens || 0
  )
  const totalTokens = Number(
    usage.total_tokens || usage.totalTokens || inputTokens + outputTokens || 0
  )
  return new Usage({
    inputTokens,
    outputTokens,
    totalTokens
  })
}

export function toOpenAIMessageOutput(
  text: string,
  id: string,
  providerData?: Record<string, unknown>
): AgentOutputItem[] {
  if (!text) return []
  return [
    {
      id,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text }],
      ...(providerData ? { providerData } : {})
    } as AgentOutputItem
  ]
}

export function toOpenAIFunctionCallOutput(
  calls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  id: string,
  providerData?: Record<string, unknown>
): AgentOutputItem[] {
  return calls.map(
    (call) =>
      ({
        id,
        type: 'function_call',
        callId: call.id || `call-${randomUUID()}`,
        name: call.name,
        status: 'completed',
        arguments: JSON.stringify(call.input || {}),
        ...(providerData ? { providerData } : {})
      }) as AgentOutputItem
  )
}

export function buildProviderPatchContext(params: {
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
    providerDefaultResponsePatcher: defaults.defaultResponsePatcher
  }
}

export function buildProviderHeaders(
  config: AIModelConfig,
  provider: AIProviderDef | undefined
): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const authHeader = provider?.authHeader || 'Authorization'
  const authPrefix = provider?.authPrefix ?? 'Bearer '
  headers[authHeader] = `${authPrefix}${config.apiKey}`
  if (provider?.extraHeaders) Object.assign(headers, provider.extraHeaders)
  return headers
}

export function isEventStreamLikeResponse(response: Response, rawText: string): boolean {
  const contentType = response.headers.get('content-type')?.toLowerCase() || ''
  if (contentType.includes('text/event-stream')) return true
  const trimmed = rawText.trimStart()
  return trimmed.startsWith('event:') || trimmed.startsWith('data:') || trimmed.startsWith(':')
}

export function buildProviderProtocolMismatchError(requestUrl: string): Error {
  const error = new Error(
    `供应商协议不匹配：当前按 OpenAI chat/completions 请求，但 ${requestUrl} 返回了事件流。请把供应商协议切到 Anthropic，或把 API 地址改成 OpenAI chat/completions 兼容地址。`
  )
  const typed = error as Error & { code?: string; terminalReason?: string }
  typed.code = 'provider_protocol_mismatch'
  typed.terminalReason = 'provider_protocol_mismatch'
  return error
}

export function resolveOpenAIProtocolModel(config: AIModelConfig): string {
  if (config.provider === 'volcengine' && config.endpointId) return config.endpointId
  return config.model
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function readReasoningContentFromRecord(record: Record<string, unknown>): unknown {
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

export function reasoningProviderData(
  reasoningContent: unknown
): Record<string, unknown> | undefined {
  return reasoningContent !== undefined ? { reasoning_content: reasoningContent } : undefined
}

export function stringField(
  record: Record<string, unknown> | null | undefined,
  key: string
): string | null {
  const value = record?.[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function continuationChildRunId(options?: AgentSdkExecutionOptions): string | null {
  return (
    nonEmptyString(options?.continuationIntent?.childRunId) ||
    nonEmptyString(options?.continuationState?.continuationRef?.childRunId)
  )
}

export function continuationRunStatePath(options?: AgentSdkExecutionOptions): string | null {
  return (
    nonEmptyString(options?.continuationIntent?.runStatePath) ||
    nonEmptyString(options?.continuationState?.continuationRef?.runStatePath)
  )
}

export function toOpenAIToolSchemas(definitions: ToolDefinition[]): Array<Record<string, unknown>> {
  return definitions.map((definition) => ({
    type: 'function',
    function: {
      name: definition.name,
      description: definition.description || definition.name,
      parameters:
        definition.schema && definition.schema.type === 'object'
          ? definition.schema
          : { type: 'object', properties: {}, additionalProperties: false }
    }
  }))
}

// ── Group K: Post-class helpers (lines 3702-3740) ──

export function publicAgentName(agentName: string): string {
  const marker = agentName.indexOf('::')
  return marker === -1 ? agentName : agentName.slice(0, marker)
}

export function scopeRunModuleForTool(
  definition: ToolDefinition
): import('../contracts/types').ScopeRunEventPayload['module'] {
  if (definition.domain === 'general_research') return 'research'
  if (
    definition.domain === 'file' ||
    definition.domain === 'image_generation' ||
    definition.domain === 'memory' ||
    definition.domain === 'session' ||
    definition.domain === 'mcp' ||
    definition.domain === 'pet' ||
    definition.domain === 'agent_interaction' ||
    definition.domain === 'skill_install' ||
    definition.domain === 'skill_activation' ||
    definition.domain === 'channel' ||
    definition.domain === 'mcp_install' ||
    definition.domain === 'command_exec'
  ) {
    return 'system'
  }
  return definition.domain
}

export function formatToolCallTrace(toolName: string, args: Record<string, unknown>): string {
  const keys = Object.keys(args)
    .filter((key) => !TOOL_TRACE_SECRET_KEY_PATTERN.test(key))
    .slice(0, 6)
  return `${toolName}(${keys.join(', ')})`
}

export function formatToolResultTrace(toolName: string, output: ToolExecutionOutput): string {
  const normalized = normalizeToolExecutionOutput(output)
  const text = redactModelVisibleToolText(String(normalized.text || '')).trim()
  return text ? `${toolName}: ${text.slice(0, 240)}` : `${toolName}: 已完成`
}

// ── Anthropic helper functions needed by model builders ──

export function safeJsonParseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    // silent-catch: malformed JSON degrades to an empty object (safe-parse contract).
    return {}
  }
}

export function dataUrlToAnthropicImage(value: string): Record<string, unknown> | null {
  const match = value.match(/^data:([^;,]+);base64,(.+)$/)
  if (!match) return null
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: match[1],
      data: match[2]
    }
  }
}

export function contentPartToAnthropic(
  part: Record<string, unknown>
): Record<string, unknown> | null {
  if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
    return { type: 'text', text: String(part.text || '') }
  }
  if (part.type === 'input_image' && typeof part.image === 'string') {
    return dataUrlToAnthropicImage(part.image) || { type: 'text', text: '[图片附件]' }
  }
  return null
}

export function sanitizeAnthropicThinkingBlock(
  block: Record<string, unknown>
): Record<string, unknown> | null {
  if (block.type !== 'thinking' || typeof block.thinking !== 'string') return null
  return {
    type: 'thinking',
    thinking: block.thinking,
    ...(typeof block.signature === 'string' ? { signature: block.signature } : {})
  }
}

export function readAnthropicThinkingBlocksFromRecord(
  record: Record<string, unknown>
): Record<string, unknown>[] {
  const direct = Array.isArray(record.anthropicThinkingBlocks)
    ? record.anthropicThinkingBlocks
    : null
  if (direct) {
    return direct
      .map((item) =>
        item && typeof item === 'object'
          ? sanitizeAnthropicThinkingBlock(item as Record<string, unknown>)
          : null
      )
      .filter((item): item is Record<string, unknown> => Boolean(item))
  }
  const providerData = asRecord(record.providerData)
  if (!providerData) return []
  return readAnthropicThinkingBlocksFromRecord(providerData)
}

export function normalizeAnthropicContent(
  content: unknown
): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = content
    .map((item) =>
      item && typeof item === 'object'
        ? contentPartToAnthropic(item as Record<string, unknown>)
        : null
    )
    .filter((item): item is Record<string, unknown> => Boolean(item))
  return parts.length > 0 ? parts : ''
}

export function modelInputToAnthropicMessages(
  input: ModelRequest['input']
): Array<Record<string, unknown>> {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }]
  }
  const messages: Array<Record<string, unknown>> = []
  let lastAssistantResponseId: string | null = null
  const appendAssistantContent = (
    item: Record<string, unknown>,
    contentBlocks: Array<Record<string, unknown>>,
  ): void => {
    const responseId = typeof item.id === 'string' && item.id ? item.id : null
    const thinkingBlocks = readAnthropicThinkingBlocksFromRecord(item)
    const previous = messages.at(-1)
    if (
      responseId
      && responseId === lastAssistantResponseId
      && previous?.role === 'assistant'
      && Array.isArray(previous.content)
    ) {
      const previousContent = previous.content as Array<Record<string, unknown>>
      if (!previousContent.some((block) => block.type === 'thinking')) {
        previousContent.unshift(...thinkingBlocks)
      }
      previousContent.push(...contentBlocks)
      return
    }
    messages.push({
      role: 'assistant',
      content: [...thinkingBlocks, ...contentBlocks],
    })
    lastAssistantResponseId = responseId
  }
  for (const rawItem of input || []) {
    if (!rawItem || typeof rawItem !== 'object') continue
    const item = rawItem as Record<string, unknown>
    if (item.type === 'function_call') {
      appendAssistantContent(item, [{
        type: 'tool_use',
        id: String(item.callId || item.id || ''),
        name: String(item.name || ''),
        input: typeof item.arguments === 'string' ? safeJsonParseObject(item.arguments) : {}
      }])
      continue
    }
    if (item.type === 'function_call_result') {
      lastAssistantResponseId = null
      const output = stringifyModelVisibleFunctionResult(item.output)
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: String(item.callId || item.id || ''),
            content: output
          }
        ]
      })
      continue
    }
    const role =
      item.role === 'assistant' || item.role === 'user'
        ? item.role
        : item.role === 'system'
          ? 'user'
          : null
    if (!role) continue
    if (role === 'assistant') {
      const normalizedContent = normalizeAnthropicContent(item.content)
      appendAssistantContent(
        item,
        typeof normalizedContent === 'string'
          ? (normalizedContent ? [{ type: 'text', text: normalizedContent }] : [])
          : normalizedContent,
      )
      continue
    }
    lastAssistantResponseId = null
    messages.push({
      role,
      content: normalizeAnthropicContent(item.content)
    })
  }
  return messages.length > 0 ? messages : [{ role: 'user', content: '' }]
}

export function serializeAnthropicTools(request: ModelRequest): Array<Record<string, unknown>> {
  return (request.tools || [])
    .filter((item) => item.type === 'function')
    .map((item) => ({
      name: item.name,
      description: item.description || item.name,
      input_schema:
        item.parameters && typeof item.parameters === 'object'
          ? item.parameters
          : { type: 'object', properties: {}, additionalProperties: false }
    }))
}

export function extractAnthropicOutput(
  json: Record<string, unknown>,
  fallbackId: string,
  responseProviderData?: Record<string, unknown>,
): AgentOutputItem[] {
  const output: AgentOutputItem[] = []
  const content = Array.isArray(json.content)
    ? (json.content as Array<Record<string, unknown>>)
    : []
  const thinkingBlocks = content
    .map(sanitizeAnthropicThinkingBlock)
    .filter((block): block is Record<string, unknown> => Boolean(block))
  const providerData = thinkingBlocks.length > 0 || responseProviderData
    ? {
        ...(responseProviderData || {}),
        ...(thinkingBlocks.length > 0 ? { anthropicThinkingBlocks: thinkingBlocks } : {}),
      }
    : undefined
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
      ...(providerData ? { providerData } : {})
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
          : {}
      ),
      ...(providerData ? { providerData } : {})
    } as AgentOutputItem)
  }
  return output
}
