/** Convert a frozen Responses request to Chat Completions; no model loop or network access. */
import type { AIModelConfig } from '../../../../shared/ai-providers'
import { applyProviderRequestPatch, resolveProviderDefaultPatchers } from '../../../../shared/ai-providers/index'
import { REGISTERED_PATCH_PROFILES } from '../../../../shared/ai-providers/resolve-provider-patch-profile'
import {
  assertToolArgumentsObject,
  CodexModelGatewayChatError,
  isRecord,
  type JsonObject,
} from './codex-model-gateway-common'
import type { CodexUpstreamProfileSnapshot } from './codex-model-gateway-contract'

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

export { CodexModelGatewayChatError } from './codex-model-gateway-common'
