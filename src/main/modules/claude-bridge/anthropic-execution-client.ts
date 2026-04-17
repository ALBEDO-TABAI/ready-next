import type { AIModelConfig } from '../../../shared/ai-providers'
import { getProviderDef } from '../../../shared/ai-providers'
import { getPolicyAnthropicTools, collectToolNames, type ToolPolicy } from '../agent-control/execution-tool-config'
import { parseJsonResponse } from '../openai-responses'
import { annotateFallbackResult, type ExecutionFallbackInfo, resolveFallbackPlan } from './execution-fallback-policy'
import { resolveApiRequestTimeoutMs } from './request-timeout-policy'

export interface AnthropicSessionLike {
  messages: Array<{ role: 'user' | 'assistant' | 'system' | 'tool'; content: string | Array<Record<string, unknown>> }>
  systemPrompt: string
}

export interface AnthropicToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface AnthropicExecutionResponse {
  text: string
  toolCalls: AnthropicToolCall[]
  stopReason: string
  fallback?: ExecutionFallbackInfo
}

export class AnthropicExecutionClient {
  constructor(private readonly deps: {
    fetchWithTimeout: (
      url: string,
      init: RequestInit,
      signal: AbortSignal,
      label: string,
      timeoutMs?: number,
    ) => Promise<Response>
    serializeMessages: (
      messages: AnthropicSessionLike['messages'],
      format: 'anthropic' | 'openai',
    ) => Array<Record<string, unknown>>
    log: (message: string) => void
  }) {}

  async requestSimple(params: {
    session: AnthropicSessionLike
    config: AIModelConfig
    baseUrl: string
    signal: AbortSignal
    messagesOverride?: AnthropicSessionLike['messages']
    hasVideoInputs?: boolean
    buildVideoFrameFallbackMessages?: () => Promise<AnthropicSessionLike['messages']>
    onFallbackApplied?: (messages: AnthropicSessionLike['messages']) => void
    timeoutMs?: number
  }): Promise<{ text: string; fallback?: ExecutionFallbackInfo }> {
    try {
      return { text: await this.requestSimpleOnce(params) }
    } catch (error) {
      const fallbackPlan = resolveFallbackPlan({
        mode: 'video_frames',
        hasVideoInputs: Boolean(params.hasVideoInputs && params.buildVideoFrameFallbackMessages),
        error,
      })
      if (!fallbackPlan.shouldRetry || !params.buildVideoFrameFallbackMessages) {
        throw error
      }
      this.deps.log('Anthropic simple request with video blocks failed, retrying with extracted image frames fallback')
      const fallbackMessages = await params.buildVideoFrameFallbackMessages()
      params.onFallbackApplied?.(fallbackMessages)
      return annotateFallbackResult({
        text: await this.requestSimpleOnce({
          ...params,
          messagesOverride: fallbackMessages,
        }),
      }, {
        kind: 'video_frames',
        attempts: 1,
      })
    }
  }

  private async requestSimpleOnce(params: {
    session: AnthropicSessionLike
    config: AIModelConfig
    baseUrl: string
    signal: AbortSignal
    messagesOverride?: AnthropicSessionLike['messages']
    timeoutMs?: number
  }): Promise<string> {
    const headers = this.buildHeaders(params.config, params.baseUrl)
    const model = this.resolveModel(params.config, params.baseUrl)
    const url = `${params.baseUrl}/v1/messages`
    this.deps.log(`POST ${url}, model=${model}, stream=false (simple)`)

    const resp = await this.deps.fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system: params.session.systemPrompt,
        messages: this.deps.serializeMessages(params.messagesOverride ?? params.session.messages, 'anthropic'),
      }),
      signal: params.signal,
    }, params.signal, 'anthropic simple', params.timeoutMs)

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '')
      throw new Error(`HTTP ${resp.status}: ${errBody.slice(0, 300)}`)
    }

    const json = await parseJsonResponse(resp, { requestUrl: url }) as {
      content?: Array<{ type: string; text?: string }>
    }
    return json.content?.filter((block) => block.type === 'text').map((block) => block.text).join('') || ''
  }

  async requestWithTools(params: {
    session: AnthropicSessionLike
    config: AIModelConfig
    baseUrl: string
    signal: AbortSignal
    policy?: ToolPolicy
    timeoutMs?: number
  }): Promise<AnthropicExecutionResponse> {
    try {
      return await this.requestWithToolsOnce(params)
    } catch (error) {
      const fallbackPlan = resolveFallbackPlan({
        mode: 'kimi_coding',
        error,
      })
      if (!this.shouldUseKimiCodingDefaults(params.baseUrl) || !fallbackPlan.shouldRetry) {
        throw error
      }
      this.deps.log('Anthropic tool request on kimi coding timed out or failed transiently, retrying once with shared fallback policy')
      return annotateFallbackResult(await this.requestWithToolsOnce(params), {
        kind: 'kimi_coding_retry',
        attempts: 1,
      })
    }
  }

  private async requestWithToolsOnce(params: {
    session: AnthropicSessionLike
    config: AIModelConfig
    baseUrl: string
    signal: AbortSignal
    policy?: ToolPolicy
    timeoutMs?: number
  }): Promise<AnthropicExecutionResponse> {
    const headers = this.buildHeaders(params.config, params.baseUrl)
    const model = this.resolveModel(params.config, params.baseUrl)
    const timeoutMs = Math.max(params.timeoutMs || 0, resolveApiRequestTimeoutMs(params.policy, {
      baseUrl: params.baseUrl,
    }))
    const tools = getPolicyAnthropicTools(params.policy)
    if (params.policy?.forceDocumentTool) {
      this.deps.log(`forceDocumentTool anthropic tools=${collectToolNames(tools, 'anthropic').join(',')}`)
    }
    if (params.policy?.forceDesignTool) {
      this.deps.log(`forceDesignTool anthropic tools=${collectToolNames(tools, 'anthropic').join(',')}`)
    }

    const url = `${params.baseUrl}/v1/messages`
    this.deps.log(`POST ${url}, model=${model}, with tools, timeout=${timeoutMs}`)
    const resp = await this.deps.fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system: params.session.systemPrompt,
        messages: this.deps.serializeMessages(params.session.messages, 'anthropic'),
        tools,
      }),
      signal: params.signal,
    }, params.signal, 'anthropic tools', timeoutMs)

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '')
      throw new Error(`HTTP ${resp.status}: ${errBody.slice(0, 300)}`)
    }

    const json = await parseJsonResponse(resp, { requestUrl: url }) as {
      content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>
      stop_reason?: string
    }
    return {
      text: json.content?.filter((block) => block.type === 'text').map((block) => block.text).join('') || '',
      toolCalls: (json.content || [])
        .filter((block) => block.type === 'tool_use')
        .map((block) => ({
          id: block.id || '',
          name: block.name || '',
          input: block.input || {},
        })),
      stopReason: json.stop_reason || 'end_turn',
    }
  }

  resolveModel(config: AIModelConfig, baseUrl: string): string {
    const rawModel = (config.model || '').trim()
    if (rawModel && rawModel !== '__custom__' && rawModel !== 'custom') {
      return rawModel
    }
    if (this.shouldUseKimiCodingDefaults(baseUrl)) {
      return 'kimi-for-coding'
    }
    return 'claude-haiku-3-5-20241022'
  }

  buildHeaders(config: AIModelConfig, baseUrl: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    }
    if ((config.provider === 'anthropic' && !config.agentProtocol) || this.shouldUseKimiCodingDefaults(baseUrl)) {
      headers['x-api-key'] = config.apiKey
      return headers
    }
    const provider = getProviderDef(config.provider, baseUrl)
    const authHeader = provider?.authHeader || 'Authorization'
    const authPrefix = provider?.authPrefix ?? 'Bearer '
    headers[authHeader] = `${authPrefix}${config.apiKey}`
    if (provider?.extraHeaders) {
      Object.assign(headers, provider.extraHeaders)
    }
    return headers
  }

  private shouldUseKimiCodingDefaults(baseUrl: string): boolean {
    return baseUrl.replace(/\/+$/, '').includes('api.kimi.com/coding')
  }
}
