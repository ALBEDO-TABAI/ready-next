import { randomUUID } from 'crypto'

import type { AIModelConfig, AIProviderDef } from '../../../shared/ai-providers'
import { parseJsonOrEventStreamResponse } from '../openai-responses'
import { getPolicyOpenAITools, buildTextToolBridgeSystemPrompt, collectToolNames, type ToolPolicy } from '../agent-control/execution-tool-config'
import { resolveOpenAIProviderRuntime } from '../agent-control/provider-runtime-resolver'
import type { ExecutionFallbackInfo } from './execution-fallback-policy'
import { annotateFallbackResult, resolveFallbackPlan } from './execution-fallback-policy'
import { extractOpenAIMessageText } from './openai-message-text'
import { resolveApiRequestTimeoutMs } from './request-timeout-policy'
import { buildTextToolResultMessage, parseTextToolBridgeResponse } from './tool-bridge'

export interface OpenAIChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | Array<Record<string, unknown>>
}

export interface OpenAISessionLike {
  messages: OpenAIChatMessage[]
  systemPrompt: string
  preferTextToolBridge: boolean
}

export interface OpenAIToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface OpenAIExecutionResponse {
  text: string
  toolCalls: OpenAIToolCall[]
  stopReason: string
  reasoningContent?: unknown
  providerResponseId?: string
  rawText?: string
  toolTransport?: 'native' | 'text'
  fallback?: ExecutionFallbackInfo
}

export class OpenAIExecutionClient {
  constructor(private readonly deps: {
    fetchWithTimeout: (
      url: string,
      init: RequestInit,
      signal: AbortSignal,
      label: string,
      timeoutMs?: number,
    ) => Promise<Response>
    log: (message: string) => void
  }) {}

  async requestSimple(params: {
    session: OpenAISessionLike
    config: AIModelConfig
    baseUrl: string
    provider: AIProviderDef | undefined
    signal: AbortSignal
    isKimi?: boolean
    enableKimiWebSearch?: boolean
    timeoutMs?: number
  }): Promise<{ text: string; fallback?: ExecutionFallbackInfo }> {
    const headers = this.buildHeaders(params.config, params.provider)
    let model = params.config.model
    if (params.config.provider === 'volcengine' && params.config.endpointId) {
      model = params.config.endpointId
    }

    const runtime = resolveOpenAIProviderRuntime({
      config: params.config,
      provider: params.provider,
      baseUrl: params.baseUrl,
    })
    const repairedMessages = this.repairOpenAIToolMessageHistory(params.session.messages) as unknown as OpenAIChatMessage[]
    if (runtime.wireApi === 'responses') {
      const url = `${params.baseUrl}/responses`
      this.deps.log(`POST ${url}, model=${model}, wireApi=responses, stream=false`)
      const reqBody: Record<string, unknown> = {
        model,
        instructions: params.session.systemPrompt,
        input: this.serializeMessagesForResponses(repairedMessages),
        stream: false,
      }
      if (runtime.reasoningEffort) {
        reqBody.reasoning = { effort: runtime.reasoningEffort }
      }
      const resp = await this.deps.fetchWithTimeout(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(reqBody),
        signal: params.signal,
      }, params.signal, 'openai simple responses', params.timeoutMs)

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '')
        throw new Error(`HTTP ${resp.status}: ${errBody.slice(0, 300)}`)
      }

      return { text: this.extractResponsesText(await parseJsonOrEventStreamResponse(resp)) }
    }

    const messages = [
      { role: 'system' as const, content: params.session.systemPrompt },
      ...this.serializeMessages(repairedMessages),
    ]

    const url = `${params.baseUrl}/chat/completions`
    this.deps.log(`POST ${url}, model=${model}, stream=false, kimi=${params.isKimi} (simple)`)
    const reqBody: Record<string, unknown> = { model, messages }
    if (params.isKimi && params.enableKimiWebSearch) {
      reqBody.tools = [{
        type: 'builtin_function',
        function: { name: '$web_search' },
      }]
    }

    const resp = await this.deps.fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(reqBody),
      signal: params.signal,
    }, params.signal, 'openai simple', params.timeoutMs)

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '')
      throw new Error(`HTTP ${resp.status}: ${errBody.slice(0, 300)}`)
    }

    const json = await resp.json() as {
      choices?: Array<{ message?: { content?: string } }>
    }
    return { text: json.choices?.[0]?.message?.content || '' }
  }

  async requestTextToolBridge(params: {
    session: OpenAISessionLike
    config: AIModelConfig
    baseUrl: string
    provider: AIProviderDef | undefined
    signal: AbortSignal
    policy?: ToolPolicy
  }): Promise<OpenAIExecutionResponse> {
    const headers = this.buildHeaders(params.config, params.provider)
    let model = params.config.model
    if (params.config.provider === 'volcengine' && params.config.endpointId) {
      model = params.config.endpointId
    }

    const runtime = resolveOpenAIProviderRuntime({
      config: params.config,
      provider: params.provider,
      baseUrl: params.baseUrl,
    })
    const systemPrompt = `${params.session.systemPrompt}\n\n${buildTextToolBridgeSystemPrompt(params.policy)}`
    const repairedMessages = this.repairOpenAIToolMessageHistory(params.session.messages) as unknown as OpenAIChatMessage[]

    if (runtime.wireApi === 'responses') {
      const url = `${params.baseUrl}/responses`
      this.deps.log(`POST ${url}, model=${model}, tool bridge=text, wireApi=responses`)
      const reqBody: Record<string, unknown> = {
        model,
        instructions: systemPrompt,
        input: this.serializeMessagesForResponses(repairedMessages),
        stream: false,
      }
      if (runtime.reasoningEffort) {
        reqBody.reasoning = { effort: runtime.reasoningEffort }
      }
      const resp = await this.deps.fetchWithTimeout(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(reqBody),
        signal: params.signal,
      }, params.signal, 'openai text tool bridge responses')

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '')
        throw new Error(`HTTP ${resp.status}: ${errBody.slice(0, 300)}`)
      }

      const json = await parseJsonOrEventStreamResponse(resp) as Record<string, unknown>
      return this.toTextToolBridgeResponse(
        this.extractResponsesText(json),
        (json as { reasoning?: unknown }).reasoning,
        typeof json.id === 'string' ? json.id : undefined,
      )
    }

    const messages = [
      { role: 'system' as const, content: systemPrompt },
      ...this.serializeMessages(repairedMessages),
    ]
    const url = `${params.baseUrl}/chat/completions`
    this.deps.log(`POST ${url}, model=${model}, tool bridge=text`)

    const resp = await this.deps.fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages }),
      signal: params.signal,
    }, params.signal, 'openai text tool bridge')

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '')
      throw new Error(`HTTP ${resp.status}: ${errBody.slice(0, 300)}`)
    }

    const json = await resp.json() as {
      choices?: Array<{
        message?: {
          content?: string
          reasoning_content?: unknown
        }
      }>
    }
    const choice = json.choices?.[0]
    return this.toTextToolBridgeResponse(
      extractOpenAIMessageText(choice?.message?.content),
      choice?.message?.reasoning_content,
    )
  }

  async requestWithTools(params: {
    session: OpenAISessionLike
    config: AIModelConfig
    baseUrl: string
    provider: AIProviderDef | undefined
    signal: AbortSignal
    policy?: ToolPolicy
    timeoutMs?: number
  }): Promise<OpenAIExecutionResponse> {
    const headers = this.buildHeaders(params.config, params.provider)
    const isKimiCodingBase = params.baseUrl.replace(/\/+$/, '').includes('api.kimi.com/coding')
    if (isKimiCodingBase) {
      headers.Authorization = `Bearer ${params.config.apiKey}`
      headers['x-api-key'] = params.config.apiKey
      headers['User-Agent'] = 'KimiCLI/1.14.0'
    }

    let model = params.config.model
    if (params.config.provider === 'volcengine' && params.config.endpointId) {
      model = params.config.endpointId
    }

    const openAIBase = isKimiCodingBase ? this.resolveKimiCodingV1Base(params.baseUrl) : params.baseUrl
    const runtime = resolveOpenAIProviderRuntime({
      config: params.config,
      provider: params.provider,
      baseUrl: openAIBase,
    })
    const timeoutMs = Math.max(params.timeoutMs || 0, resolveApiRequestTimeoutMs(params.policy, {
      baseUrl: params.baseUrl,
    }))
    const tools = getPolicyOpenAITools(params.policy)
    const repairedMessages = this.repairOpenAIToolMessageHistory(params.session.messages) as unknown as OpenAIChatMessage[]
    if (params.policy?.forceDocumentTool) {
      this.deps.log(`forceDocumentTool openai tools=${collectToolNames(tools, 'openai').join(',')}`)
    }
    if (params.policy?.forceDesignTool) {
      this.deps.log(`forceDesignTool openai tools=${collectToolNames(tools, 'openai').join(',')}`)
    }

    const preRequestFallbackPlan = resolveFallbackPlan({
      mode: 'openai_prefer_text_bridge',
      config: params.config,
      preferTextToolBridge: params.session.preferTextToolBridge,
    })
    if (preRequestFallbackPlan.shouldRetry) {
      params.session.preferTextToolBridge = true
      this.deps.log(`OpenAI tool transport fallback engaged before request, provider=${params.config.provider}, baseUrl=${openAIBase}`)
      return annotateFallbackResult(await this.requestTextToolBridge({
        session: params.session,
        config: params.config,
        baseUrl: openAIBase,
        provider: params.provider,
        signal: params.signal,
        policy: params.policy,
      }), { kind: 'text_bridge', attempts: 1 })
    }

    if (runtime.wireApi === 'responses') {
      try {
        const nativeResponse = await this.requestWithResponsesTools({
          session: params.session,
          runtime,
          model,
          openAIBase,
          headers,
          signal: params.signal,
          timeoutMs,
          tools,
          repairedMessages,
          policy: params.policy,
        })
        const fallbackPlan = resolveFallbackPlan({
          mode: 'openai_missing_native_tools',
          config: params.config,
          preferTextToolBridge: params.session.preferTextToolBridge,
          text: nativeResponse.text,
        })
        if (nativeResponse.toolCalls.length === 0 && fallbackPlan.shouldRetry) {
          params.session.preferTextToolBridge = true
          this.deps.log(`OpenAI native tools unavailable after responses reply; retrying with text bridge, provider=${params.config.provider}, baseUrl=${openAIBase}`)
          return annotateFallbackResult(await this.requestTextToolBridge({
            session: params.session,
            config: params.config,
            baseUrl: openAIBase,
            provider: params.provider,
            signal: params.signal,
            policy: params.policy,
          }), { kind: 'text_bridge', attempts: 1 })
        }
        return nativeResponse
      } catch (error) {
        const fallbackPlan = resolveFallbackPlan({
          mode: 'openai_wire_api',
          error,
        })
        if (!fallbackPlan.shouldRetry) {
          throw error
        }
        this.deps.log(`OpenAI responses wire API failed; retrying with chat/completions, provider=${params.config.provider}, baseUrl=${openAIBase}`)
        return annotateFallbackResult(await this.requestWithChatCompletionsTools({
          session: params.session,
          model,
          openAIBase,
          headers,
          signal: params.signal,
          timeoutMs,
          tools,
          repairedMessages,
          policy: params.policy,
        }), { kind: 'wire_api_retry', attempts: 1 })
      }
    }

    const nativeResponse = await this.requestWithChatCompletionsTools({
      session: params.session,
      model,
      openAIBase,
      headers,
      signal: params.signal,
      timeoutMs,
      tools,
      repairedMessages,
      policy: params.policy,
    })
    const fallbackPlan = resolveFallbackPlan({
      mode: 'openai_missing_native_tools',
      config: params.config,
      preferTextToolBridge: params.session.preferTextToolBridge,
      text: nativeResponse.text,
    })
    if (nativeResponse.toolCalls.length === 0 && fallbackPlan.shouldRetry) {
      params.session.preferTextToolBridge = true
      this.deps.log(`OpenAI native tools unavailable after chat completion reply; retrying with text bridge, provider=${params.config.provider}, baseUrl=${openAIBase}`)
      return annotateFallbackResult(await this.requestTextToolBridge({
        session: params.session,
        config: params.config,
        baseUrl: openAIBase,
        provider: params.provider,
        signal: params.signal,
        policy: params.policy,
      }), { kind: 'text_bridge', attempts: 1 })
    }
    return nativeResponse
  }

  private buildHeaders(
    config: AIModelConfig,
    provider: AIProviderDef | undefined,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    const authHeader = provider?.authHeader || 'Authorization'
    const authPrefix = provider?.authPrefix ?? 'Bearer '
    headers[authHeader] = `${authPrefix}${config.apiKey}`
    if (provider?.extraHeaders) {
      Object.assign(headers, provider.extraHeaders)
    }
    return headers
  }

  private resolveKimiCodingV1Base(baseUrl: string): string {
    const normalized = baseUrl.replace(/\/+$/, '')
    return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`
  }

  private async requestWithResponsesTools(params: {
    session: OpenAISessionLike
    runtime: ReturnType<typeof resolveOpenAIProviderRuntime>
    model: string
    openAIBase: string
    headers: Record<string, string>
    signal: AbortSignal
    timeoutMs: number
    tools: Array<Record<string, unknown>>
    repairedMessages: OpenAIChatMessage[]
    policy?: ToolPolicy
  }): Promise<OpenAIExecutionResponse> {
    const continuation = this.getResponsesContinuationState(params.session)
    const url = `${params.openAIBase}/responses`
    this.deps.log(`POST ${url}, model=${params.model}, with tools, wireApi=responses${params.policy?.forceDocumentTool ? ' (force document)' : params.policy?.forceDesignTool ? ' (force design)' : ''}, timeout=${params.timeoutMs}`)
    const reqBody: Record<string, unknown> = {
      model: params.model,
      tools: this.convertOpenAIToolsToResponses(params.tools),
      stream: false,
    }
    if (params.runtime.reasoningEffort) {
      reqBody.reasoning = { effort: params.runtime.reasoningEffort }
    }
    if (continuation) {
      reqBody.previous_response_id = continuation.previousResponseId
      reqBody.input = continuation.input
    } else {
      reqBody.instructions = params.session.systemPrompt
      reqBody.input = this.serializeMessagesForResponses(params.repairedMessages)
    }

    const resp = await this.deps.fetchWithTimeout(url, {
      method: 'POST',
      headers: params.headers,
      body: JSON.stringify(reqBody),
      signal: params.signal,
    }, params.signal, 'openai responses tools', params.timeoutMs)

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '')
      throw new Error(`HTTP ${resp.status}: ${errBody.slice(0, 300)}`)
    }

    const json = await parseJsonOrEventStreamResponse(resp) as Record<string, unknown>
    return {
      text: this.extractResponsesText(json),
      toolCalls: this.extractResponsesToolCalls(json),
      stopReason: String(json.status || 'completed'),
      reasoningContent: (json as { reasoning?: unknown }).reasoning,
      providerResponseId: typeof json.id === 'string' ? json.id : undefined,
      toolTransport: 'native',
    }
  }

  private async requestWithChatCompletionsTools(params: {
    session: OpenAISessionLike
    model: string
    openAIBase: string
    headers: Record<string, string>
    signal: AbortSignal
    timeoutMs: number
    tools: Array<Record<string, unknown>>
    repairedMessages: OpenAIChatMessage[]
    policy?: ToolPolicy
  }): Promise<OpenAIExecutionResponse> {
    const messages = [
      { role: 'system' as const, content: params.session.systemPrompt },
      ...this.serializeMessages(params.repairedMessages),
    ]
    const url = `${params.openAIBase}/chat/completions`
    this.deps.log(`POST ${url}, model=${params.model}, with tools${params.policy?.forceDocumentTool ? ' (force document)' : params.policy?.forceDesignTool ? ' (force design)' : ''}, timeout=${params.timeoutMs}`)
    const resp = await this.deps.fetchWithTimeout(url, {
      method: 'POST',
      headers: params.headers,
      body: JSON.stringify({ model: params.model, messages, tools: params.tools }),
      signal: params.signal,
    }, params.signal, 'openai tools', params.timeoutMs)

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '')
      throw new Error(`HTTP ${resp.status}: ${errBody.slice(0, 300)}`)
    }

    const json = await resp.json() as {
      choices?: Array<{
        message?: {
          content?: string
          reasoning_content?: unknown
          tool_calls?: Array<{
            id: string
            function?: { name?: string; arguments?: string }
          }>
        }
        finish_reason?: string
      }>
    }
    const choice = json.choices?.[0]
    const nativeResponse: OpenAIExecutionResponse = {
      text: extractOpenAIMessageText(choice?.message?.content),
      toolCalls: (choice?.message?.tool_calls || []).map((tc) => ({
        id: tc.id,
        name: tc.function?.name || '',
        input: (() => {
          try { return JSON.parse(tc.function?.arguments || '{}') } catch { return {} }
        })(),
      })),
      stopReason: choice?.finish_reason || 'stop',
      reasoningContent: choice?.message?.reasoning_content,
      toolTransport: 'native',
    }
    this.deps.log(`OpenAI response: text=${nativeResponse.text.length}chars, toolCalls=${nativeResponse.toolCalls.length}, reasoning=${nativeResponse.reasoningContent !== undefined}, finish=${choice?.finish_reason}`)
    return nativeResponse
  }

  private toTextToolBridgeResponse(
    rawText: string,
    reasoningContent?: unknown,
    providerResponseId?: string,
  ): OpenAIExecutionResponse {
    const parsed = parseTextToolBridgeResponse(rawText)
    return {
      text: parsed.visibleText,
      rawText,
      toolCalls: parsed.toolCalls.map((call) => ({
        id: `texttc_${randomUUID().replace(/-/g, '')}`,
        name: call.name,
        input: call.args,
      })),
      stopReason: 'text_tool_bridge',
      reasoningContent,
      providerResponseId,
      toolTransport: 'text',
    }
  }

  private serializeMessagesForResponses(messages: OpenAIChatMessage[]): Array<Record<string, unknown>> {
    return messages
      .map((message) => message as unknown as Record<string, unknown>)
      .filter((message) => message.role !== 'tool')
      .map((message) => {
        const role = message.role === 'assistant' ? 'assistant' : 'user'
        const textType = role === 'assistant' ? 'output_text' : 'input_text'
        if (!Array.isArray(message.content)) {
          return {
            role,
            content: [{ type: textType, text: typeof message.content === 'string' ? message.content : '' }],
          }
        }

        const content = (message.content as Array<Record<string, unknown>>).map((part) => {
          if (part.type === 'text') {
            return { type: textType, text: typeof part.text === 'string' ? part.text : '' }
          }
          if (part.type === 'image' && part.source && typeof part.source === 'object') {
            const source = part.source as Record<string, unknown>
            const data = typeof source.data === 'string' ? source.data : ''
            const mediaType = typeof source.media_type === 'string' ? source.media_type : 'image/png'
            return {
              type: 'input_image',
              image_url: `data:${mediaType};base64,${data}`,
            }
          }
          if (part.type === 'video' && part.source && typeof part.source === 'object') {
            const source = part.source as Record<string, unknown>
            const data = typeof source.data === 'string' ? source.data : ''
            const mediaType = typeof source.media_type === 'string' ? source.media_type : 'video/mp4'
            return {
              type: 'input_file',
              file_data: `data:${mediaType};base64,${data}`,
              filename: 'upload.mp4',
            }
          }
          return { type: textType, text: '' }
        })

        return { role, content }
      })
  }

  private convertOpenAIToolsToResponses(tools: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return tools.map((tool) => {
      const fn = (tool.function as Record<string, unknown> | undefined) || {}
      return {
        type: 'function',
        name: fn.name,
        description: fn.description,
        parameters: fn.parameters,
      }
    })
  }

  private extractResponsesText(payload: unknown): string {
    if (!payload || typeof payload !== 'object') return ''
    const output = Array.isArray((payload as { output?: unknown[] }).output)
      ? (payload as { output?: unknown[] }).output as Array<Record<string, unknown>>
      : []
    const texts: string[] = []
    for (const item of output) {
      const content = Array.isArray(item.content) ? item.content as Array<Record<string, unknown>> : []
      for (const part of content) {
        if (part.type === 'output_text' && typeof part.text === 'string') {
          texts.push(part.text)
        }
      }
    }
    return texts.join('')
  }

  private extractResponsesToolCalls(payload: unknown): OpenAIToolCall[] {
    if (!payload || typeof payload !== 'object') return []
    const output = Array.isArray((payload as { output?: unknown[] }).output)
      ? (payload as { output?: unknown[] }).output as Array<Record<string, unknown>>
      : []
    const calls: OpenAIToolCall[] = []
    for (const item of output) {
      if (item.type !== 'function_call') continue
      const argumentsText = typeof item.arguments === 'string' ? item.arguments : '{}'
      calls.push({
        id: typeof item.call_id === 'string' ? item.call_id : `respfc_${randomUUID().replace(/-/g, '')}`,
        name: typeof item.name === 'string' ? item.name : '',
        input: (() => {
          try { return JSON.parse(argumentsText) } catch { return {} }
        })(),
      })
    }
    return calls
  }

  private getResponsesContinuationState(session: OpenAISessionLike): {
    previousResponseId: string
    input: Array<Record<string, unknown>>
  } | null {
    const rawMessages = this.repairOpenAIToolMessageHistory(session.messages)
    let previousResponseId: string | null = null
    let startIndex = 0

    for (let i = rawMessages.length - 1; i >= 0; i -= 1) {
      const message = rawMessages[i]
      const responseId = typeof message.response_id === 'string' ? message.response_id : null
      if (responseId) {
        previousResponseId = responseId
        startIndex = i + 1
        break
      }
    }

    if (!previousResponseId) return null
    return {
      previousResponseId,
      input: this.serializeMessagesForResponses(rawMessages.slice(startIndex) as unknown as OpenAIChatMessage[]),
    }
  }

  private repairOpenAIToolMessageHistory(messages: OpenAIChatMessage[]): Array<Record<string, unknown>> {
    const rawMessages = messages.map((message) => ({ ...(message as unknown as Record<string, unknown>) }))
    const openToolCallIds = new Set<string>()

    for (const message of rawMessages) {
      if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
        for (const toolCall of message.tool_calls as Array<Record<string, unknown>>) {
          if (typeof toolCall.id === 'string') {
            openToolCallIds.add(toolCall.id)
          }
        }
        continue
      }
      if (message.role === 'tool') {
        const toolCallId = typeof message.tool_call_id === 'string' ? message.tool_call_id : null
        if (toolCallId) {
          openToolCallIds.delete(toolCallId)
        }
      }
    }

    if (openToolCallIds.size === 0) return rawMessages
    return rawMessages.filter((message) => {
      if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) return true
      return (message.tool_calls as Array<Record<string, unknown>>).every((toolCall) => {
        const id = typeof toolCall.id === 'string' ? toolCall.id : null
        return !id || !openToolCallIds.has(id)
      })
    })
  }

  private serializeMessages(messages: OpenAIChatMessage[]): Array<Record<string, unknown>> {
    return messages.map((message) => {
      if (Array.isArray(message.content)) {
        const parts = message.content.map((block) => {
          if (block.type === 'image' && block.source) {
            const src = block.source as { media_type: string; data: string }
            return {
              type: 'image_url',
              image_url: { url: `data:${src.media_type};base64,${src.data}` },
            }
          }
          if (block.type === 'video' && block.source) {
            const src = block.source as { media_type: string; data: string }
            return {
              type: 'video_url',
              video_url: { url: `data:${src.media_type};base64,${src.data}` },
            }
          }
          if (block.type === 'text') return { type: 'text', text: block.text }
          return block
        })
        return { role: message.role, content: parts }
      }
      return { ...message } as Record<string, unknown>
    })
  }
}
