import { randomUUID } from 'crypto'
import type { AIModelConfig } from '../../../shared/ai-providers'
import { getProviderDef } from '../../../shared/ai-providers'
import {
  applyProviderRequestPatch,
  applyProviderResponsePatch,
  resolveProviderDefaultPatchers,
  resolveProviderPatchProfile,
  type PatchContext,
} from '../../../shared/ai-providers/index'
import { getPolicyAnthropicTools, collectToolNames, type ToolPolicy } from '../agent-control/execution-tool-config'
import { logAgentMetric } from '../agent-control/metrics'
import { TOOL_ERROR_METRICS } from '../agent-control/tool-error-metrics'
import { parseJsonResponse } from '../openai-responses'
import { annotateFallbackResult, type ExecutionFallbackInfo, resolveFallbackPlan } from './execution-fallback-policy'
import { withRetryBackoff } from './llm-resilience'
import { resolveApiRequestTimeoutMs } from './request-timeout-policy'
import { parseTextToolBridgeResponse } from './tool-bridge'

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
  rawText?: string
  toolTransport?: 'native' | 'text'
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

    // Stage S (PR-S4 / W3.5) — extract inline body so the patcher can
    // mutate it before serialization.
    const reqBody: Record<string, unknown> = {
      model,
      max_tokens: 4096,
      system: params.session.systemPrompt,
      messages: this.deps.serializeMessages(params.messagesOverride ?? params.session.messages, 'anthropic'),
    }
    const patchCtx = this.buildPatchContext({
      config: params.config,
      baseUrl: params.baseUrl,
      model,
    })
    applyProviderRequestPatch(reqBody, patchCtx)
    // Stage S W8.2 — wrap fetch in withRetryBackoff so transient 408/409/425/429/5xx
    // and "server busy" responses are retried with exponential backoff before bubbling.
    const resp = await withRetryBackoff(async () => {
      const r = await this.deps.fetchWithTimeout(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(reqBody),
        signal: params.signal,
      }, params.signal, 'anthropic simple', params.timeoutMs)
      if (!r.ok) {
        const errBody = await r.text().catch(() => '')
        const err = new Error(`HTTP ${r.status}: ${errBody.slice(0, 300)}`) as Error & { status?: number }
        err.status = r.status
        throw err
      }
      return r
    })

    const json = await parseJsonResponse(resp, { requestUrl: url }) as {
      content?: Array<{ type: string; text?: string }>
    }
    applyProviderResponsePatch(json, patchCtx)
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
    // Stage S (PR-S4 / W3.5) — extract inline body so the patcher can
    // mutate it before serialization.
    const reqBody: Record<string, unknown> = {
      model,
      max_tokens: 4096,
      system: params.session.systemPrompt,
      messages: this.deps.serializeMessages(params.session.messages, 'anthropic'),
      tools,
    }
    const patchCtx = this.buildPatchContext({
      config: params.config,
      baseUrl: params.baseUrl,
      model,
    })
    applyProviderRequestPatch(reqBody, patchCtx)
    // TODO(stage-s-followup): wrap with withRetryBackoff
    const resp = await this.deps.fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(reqBody),
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
    applyProviderResponsePatch(json, patchCtx)
    const nativeResponse: AnthropicExecutionResponse = {
      text: json.content?.filter((block) => block.type === 'text').map((block) => block.text).join('') || '',
      toolCalls: (json.content || [])
        .filter((block) => block.type === 'tool_use')
        .map((block) => ({
          id: block.id || '',
          name: block.name || '',
          input: block.input || {},
        })),
      stopReason: json.stop_reason || 'end_turn',
      toolTransport: 'native',
    }
    return this.recoverXmlToolCallsFromNative(nativeResponse)
  }

  private recoverXmlToolCallsFromNative(response: AnthropicExecutionResponse): AnthropicExecutionResponse {
    if (response.toolCalls.length > 0) return response
    if (!response.text || !/<tool_call>|<function=|<parameter=|:::tool_call/i.test(response.text)) return response
    const parsed = parseTextToolBridgeResponse(response.text)
    if (parsed.toolCalls.length === 0) return response
    logAgentMetric(TOOL_ERROR_METRICS.xmlToolCallsRecoveredFromNative, {
      route: 'anthropic_messages',
      originalCallsCount: 0,
      recoveredCallsCount: parsed.toolCalls.length,
      recoveredToolNames: parsed.toolCalls.map((call) => call.name).slice(0, 5),
      originalTextLen: response.text.length,
      cleanedTextLen: parsed.visibleText.length,
    })
    this.deps.log(
      `[xml_recovery] anthropic_messages: model emitted ${parsed.toolCalls.length} XML tool_call(s); recovering as text-bridge so dispatch can proceed.`,
    )
    return {
      ...response,
      text: parsed.visibleText,
      rawText: response.text,
      toolCalls: parsed.toolCalls.map((call) => ({
        id: `xmlrec_${randomUUID().replace(/-/g, '')}`,
        name: call.name,
        input: call.args,
      })),
      toolTransport: 'text',
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

  /**
   * Stage S (PR-S4 / W3.5) — Anthropic patch-context builder. Mirrors
   * the OpenAI-execution-client helper so request/response patchers
   * see the same shape regardless of wire protocol.
   */
  private buildPatchContext(params: {
    config: AIModelConfig
    baseUrl: string
    model: string
  }): PatchContext {
    const defaults = resolveProviderDefaultPatchers(params.config.provider)
    const profile = resolveProviderPatchProfile(params.config, params.baseUrl, params.model)
    return {
      config: params.config,
      baseUrl: params.baseUrl,
      model: params.model,
      profile,
      providerDefaultRequestPatcher: defaults.defaultRequestPatcher,
      providerDefaultResponsePatcher: defaults.defaultResponsePatcher,
    }
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
