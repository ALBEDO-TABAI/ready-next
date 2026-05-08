import { randomUUID } from 'crypto'

import { resolveAIConfigCapabilities, type AIModelConfig, type AIProviderDef } from '../../../shared/ai-providers'
import {
  applyProviderRequestPatch,
  applyProviderResponsePatch,
  resolveProviderDefaultPatchers,
  resolveProviderPatchProfile,
  type PatchContext,
} from '../../../shared/ai-providers/index'
import { parseJsonOrEventStreamResponse, parseJsonResponse } from '../openai-responses'
import { buildToolDispatchDecision } from '../agent-control/execution-tool-policy'
import { getPolicyOpenAITools, buildTextToolBridgeSystemPrompt, collectToolNames, type ToolPolicy } from '../agent-control/execution-tool-config'
import { logAgentMetric } from '../agent-control/metrics'
import { TOOL_ERROR_METRICS } from '../agent-control/tool-error-metrics'
import { resolveOpenAIProviderRuntime } from '../agent-control/provider-runtime-resolver'
import type { ToolSnapshot, TurnToolCallParseError } from '../agent-control/run-contracts'
import type { ExecutionFallbackInfo } from './execution-fallback-policy'
import { annotateFallbackResult, resolveFallbackPlan } from './execution-fallback-policy'
import { withRetryBackoff } from './llm-resilience'
import { sanitizeOpenAICompatibleMessageHistory } from './openai-history-sanitization'
import { resolveRegisteredToolNamesLazily } from './tool-registry-bridge'
import { extractOpenAIMessageText } from './openai-message-text'
import { resolveApiRequestTimeoutMs } from './request-timeout-policy'
import { buildTextToolResultMessage, parseTextToolBridgeResponse } from './tool-bridge'
import {
  buildChatCompletionsToolCalls,
  buildResponsesToolCalls,
  type ProviderToolCallFailure,
} from './provider-tool-arguments'

export interface OpenAIChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | Array<Record<string, unknown>>
  tool_call_id?: string
  tool_calls?: Array<Record<string, unknown>>
  response_id?: string
  reasoning_content?: unknown
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
  toolCallParseErrors?: TurnToolCallParseError[]
  fallback?: ExecutionFallbackInfo
  toolSnapshots?: ToolSnapshot[]
}

export interface OpenAIToolSnapshotContext {
  iteration: number
  browserDecisionMode?: string | null
  browserHostAvailable?: boolean | null
  hasTools: boolean
  allowBrowserTools: boolean
  visibleCapabilityGroupIds: ToolSnapshot['visibleCapabilityGroupIds']
  suppressedCapabilityGroupIds: ToolSnapshot['suppressedCapabilityGroupIds']
  requestedTransport: ToolSnapshot['requestedTransport']
  supportsNativeTools: boolean
  preferTextToolBridge: boolean
  expectedAllowedToolNames?: string[] | null
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
      // Stage S (PR-S4 / W3.5) — apply provider-default + profile patcher
      // before serialization (priority enforced inside helper).
      const patchCtx = this.buildPatchContext({ config: params.config, baseUrl: params.baseUrl, model })
      applyProviderRequestPatch(reqBody, patchCtx)
      // TODO(stage-s-followup): wrap with withRetryBackoff
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

      const json = await parseJsonOrEventStreamResponse(resp, { requestUrl: url })
      applyProviderResponsePatch(json, patchCtx)
      return { text: this.extractResponsesText(json) }
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

    // Stage S (PR-S4 / W3.5) — provider-default + profile patcher.
    const patchCtx = this.buildPatchContext({ config: params.config, baseUrl: params.baseUrl, model })
    applyProviderRequestPatch(reqBody, patchCtx)
    // Stage S W8.2 — wrap fetch in withRetryBackoff so transient 408/409/425/429/5xx
    // and "server busy" responses are retried with exponential backoff before bubbling.
    const resp = await withRetryBackoff(async () => {
      const r = await this.deps.fetchWithTimeout(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(reqBody),
        signal: params.signal,
      }, params.signal, 'openai simple', params.timeoutMs)
      if (!r.ok) {
        const errBody = await r.text().catch(() => '')
        const err = new Error(`HTTP ${r.status}: ${errBody.slice(0, 300)}`) as Error & { status?: number }
        err.status = r.status
        throw err
      }
      return r
    })

    const json = await parseJsonResponse(resp, { requestUrl: url }) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    applyProviderResponsePatch(json, patchCtx)
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
      // Stage S (PR-S4 / W3.5) — provider-default + profile patcher.
      const patchCtx = this.buildPatchContext({ config: params.config, baseUrl: params.baseUrl, model })
      applyProviderRequestPatch(reqBody, patchCtx)
      // TODO(stage-s-followup): wrap with withRetryBackoff
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

      const json = await parseJsonOrEventStreamResponse(resp, { requestUrl: url }) as Record<string, unknown>
      applyProviderResponsePatch(json, patchCtx)
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

    // Stage S (PR-S4 / W3.5) — extract inline body to a variable so the
    // patcher can mutate it before serialization.
    const reqBody: Record<string, unknown> = { model, messages }
    const patchCtx = this.buildPatchContext({ config: params.config, baseUrl: params.baseUrl, model })
    applyProviderRequestPatch(reqBody, patchCtx)
    // TODO(stage-s-followup): wrap with withRetryBackoff
    const resp = await this.deps.fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(reqBody),
      signal: params.signal,
    }, params.signal, 'openai text tool bridge')

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '')
      throw new Error(`HTTP ${resp.status}: ${errBody.slice(0, 300)}`)
    }

    const json = await parseJsonResponse(resp, { requestUrl: url }) as {
      choices?: Array<{
        message?: {
          content?: string
          reasoning_content?: unknown
        }
      }>
    }
    applyProviderResponsePatch(json, patchCtx)
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
    preferTextToolBridgeOnce?: boolean
    toolSnapshotContext?: OpenAIToolSnapshotContext
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
    const allowedToolNames = collectToolNames(tools, 'openai')
    const preferTextToolBridge = Boolean(params.preferTextToolBridgeOnce)
    const toolSnapshots: ToolSnapshot[] = []
    const snapshotDefaults = this.buildProviderSnapshotDefaults({
      config: params.config,
      baseUrl: openAIBase,
      model,
      runtime,
      allowedToolNames,
      preferTextToolBridge,
      snapshotContext: params.toolSnapshotContext,
    })
    const mismatch = this.hasToolListMismatch(
      params.toolSnapshotContext?.expectedAllowedToolNames || null,
      allowedToolNames,
    )
    if (mismatch) {
      this.deps.log(`[tool_snapshot_mismatch] ${JSON.stringify({
        provider: snapshotDefaults.provider,
        baseUrl: snapshotDefaults.baseUrl,
        model: snapshotDefaults.model,
        iteration: snapshotDefaults.iteration,
        expectedAllowedToolNames: params.toolSnapshotContext?.expectedAllowedToolNames || [],
        actualAllowedToolNames: allowedToolNames,
      })}`)
      try {
        logAgentMetric(TOOL_ERROR_METRICS.toolSnapshotMismatch, {
          provider: snapshotDefaults.provider,
          expectedCount: params.toolSnapshotContext?.expectedAllowedToolNames?.length || 0,
          actualCount: allowedToolNames.length,
          expectedSample: (params.toolSnapshotContext?.expectedAllowedToolNames || []).slice(0, 3),
          actualSample: allowedToolNames.slice(0, 3),
        })
      } catch {
        // metrics must never break the request path
      }
    }
    const appendToolSnapshot = (snapshot: ToolSnapshot) => {
      toolSnapshots.push(snapshot)
      this.deps.log(`[tool_snapshot] ${JSON.stringify(snapshot)}`)
    }
    const recordProviderRequest = (effectiveTransport: ToolSnapshot['effectiveTransport'], fallbackReason?: string | null) => {
      appendToolSnapshot(this.buildToolSnapshot({
        defaults: snapshotDefaults,
        stage: 'provider_request',
        effectiveTransport,
        toolCallsCount: 0,
        fallbackReason,
        mismatch,
      }))
    }
    const recordProviderResponse = (effectiveTransport: ToolSnapshot['effectiveTransport'], response: OpenAIExecutionResponse, fallbackReason?: string | null) => {
      appendToolSnapshot(this.buildToolSnapshot({
        defaults: snapshotDefaults,
        stage: 'provider_response',
        effectiveTransport,
        toolCallsCount: response.toolCalls.length,
        fallbackReason,
        mismatch,
      }))
    }
    const attachToolSnapshots = <T extends OpenAIExecutionResponse>(response: T): T => ({
      ...response,
      toolSnapshots: toolSnapshots.length > 0 ? toolSnapshots : [],
    })
    const repairedMessages = this.repairOpenAIToolMessageHistory(params.session.messages) as unknown as OpenAIChatMessage[]
    if (params.policy?.forceDocumentTool) {
      this.deps.log(`forceDocumentTool openai tools=${allowedToolNames.join(',')}`)
    }
    if (params.policy?.forceDesignTool) {
      this.deps.log(`forceDesignTool openai tools=${allowedToolNames.join(',')}`)
    }

    const preRequestFallbackPlan = resolveFallbackPlan({
      mode: 'openai_prefer_text_bridge',
      config: params.config,
      preferTextToolBridge,
    })
    if (preRequestFallbackPlan.shouldRetry) {
      this.deps.log(`OpenAI tool transport fallback engaged before request, provider=${params.config.provider}, baseUrl=${openAIBase}`)
      recordProviderRequest('text', 'prefer_text_tool_bridge')
      const textBridgeResponse = await this.requestTextToolBridge({
        session: params.session,
        config: params.config,
        baseUrl: openAIBase,
        provider: params.provider,
        signal: params.signal,
        policy: params.policy,
      })
      recordProviderResponse('text', textBridgeResponse, 'prefer_text_tool_bridge')
      return annotateFallbackResult(attachToolSnapshots(textBridgeResponse), { kind: 'text_bridge', attempts: 1 })
    }

    if (runtime.wireApi === 'responses') {
      try {
        recordProviderRequest('native')
        const nativeResponse = await this.requestWithResponsesTools({
          session: params.session,
          config: params.config,
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
          preferTextToolBridge,
          text: nativeResponse.text,
        })
        const fallbackReason = nativeResponse.toolCalls.length === 0 && fallbackPlan.shouldRetry
          ? 'missing_native_tools'
          : null
        recordProviderResponse('native', nativeResponse, fallbackReason)
        if (nativeResponse.toolCalls.length === 0 && fallbackPlan.shouldRetry) {
          this.deps.log(`OpenAI native tools unavailable after responses reply; retrying with text bridge, provider=${params.config.provider}, baseUrl=${openAIBase}`)
          recordProviderRequest('text', 'missing_native_tools')
          const textBridgeResponse = await this.requestTextToolBridge({
            session: params.session,
            config: params.config,
            baseUrl: openAIBase,
            provider: params.provider,
            signal: params.signal,
            policy: params.policy,
          })
          recordProviderResponse('text', textBridgeResponse, 'missing_native_tools')
          return annotateFallbackResult(attachToolSnapshots(textBridgeResponse), { kind: 'text_bridge', attempts: 1 })
        }
        return attachToolSnapshots(nativeResponse)
      } catch (error) {
        const fallbackPlan = resolveFallbackPlan({
          mode: 'openai_wire_api',
          error,
        })
        if (!fallbackPlan.shouldRetry) {
          throw error
        }
        this.deps.log(`OpenAI responses wire API failed; retrying with chat/completions, provider=${params.config.provider}, baseUrl=${openAIBase}`)
        recordProviderRequest('native', 'wire_api_retry')
        const retryResponse = await this.requestWithChatCompletionsTools({
          session: params.session,
          config: params.config,
          model,
          openAIBase,
          headers,
          signal: params.signal,
          timeoutMs,
          tools,
          repairedMessages,
          policy: params.policy,
        })
        recordProviderResponse('native', retryResponse, 'wire_api_retry')
        return annotateFallbackResult(attachToolSnapshots(retryResponse), { kind: 'wire_api_retry', attempts: 1 })
      }
    }

    recordProviderRequest('native')
    const nativeResponse = await this.requestWithChatCompletionsTools({
      session: params.session,
      config: params.config,
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
      preferTextToolBridge,
      text: nativeResponse.text,
    })
    const fallbackReason = nativeResponse.toolCalls.length === 0 && fallbackPlan.shouldRetry
      ? 'missing_native_tools'
      : null
    recordProviderResponse('native', nativeResponse, fallbackReason)
    if (nativeResponse.toolCalls.length === 0 && fallbackPlan.shouldRetry) {
      this.deps.log(`OpenAI native tools unavailable after chat completion reply; retrying with text bridge, provider=${params.config.provider}, baseUrl=${openAIBase}`)
      recordProviderRequest('text', 'missing_native_tools')
      const textBridgeResponse = await this.requestTextToolBridge({
        session: params.session,
        config: params.config,
        baseUrl: openAIBase,
        provider: params.provider,
        signal: params.signal,
        policy: params.policy,
      })
      recordProviderResponse('text', textBridgeResponse, 'missing_native_tools')
      return annotateFallbackResult(attachToolSnapshots(textBridgeResponse), { kind: 'text_bridge', attempts: 1 })
    }
    return attachToolSnapshots(nativeResponse)
  }

  /**
   * Stage S (PR-S4 / W3.5) — build a PatchContext for the current call.
   *
   * Resolves the provider-default patchers (e.g. openai-compatible's
   * `stream_usage` filler) from the sub-module registry, then resolves
   * the matching profile (gemini-oai / deepseek / minimax / vllm). The
   * priority contract — user config > provider default > profile — is
   * enforced inside `apply-provider-patch.ts`; callers must merge user
   * values into `body` before invoking `applyProviderRequestPatch`.
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

  private buildProviderSnapshotDefaults(params: {
    config: AIModelConfig
    baseUrl: string
    model: string
    runtime: ReturnType<typeof resolveOpenAIProviderRuntime>
    allowedToolNames: string[]
    preferTextToolBridge: boolean
    snapshotContext?: OpenAIToolSnapshotContext
  }): Omit<ToolSnapshot, 'stage' | 'source' | 'effectiveTransport' | 'fallbackReason' | 'toolCallsCount' | 'mismatch'> {
    const capabilities = resolveAIConfigCapabilities(params.config)
    const dispatchDecision = buildToolDispatchDecision({
      supportsToolCalls: capabilities?.supportsToolCalls ?? true,
      supportsNativeToolCalls: capabilities?.supportsNativeToolCalls ?? capabilities?.supportsToolCalls ?? true,
      toolCallTransport: capabilities?.toolCallTransport || null,
      preferTextToolBridge: params.preferTextToolBridge,
    })
    return {
      iteration: Math.max(0, Number(params.snapshotContext?.iteration || 0)),
      provider: params.config.provider,
      baseUrl: params.baseUrl,
      model: params.model,
      wireApi: params.runtime.wireApi,
      browserDecisionMode: params.snapshotContext?.browserDecisionMode || null,
      browserHostAvailable: typeof params.snapshotContext?.browserHostAvailable === 'boolean'
        ? params.snapshotContext.browserHostAvailable
        : null,
      hasTools: params.snapshotContext?.hasTools ?? params.allowedToolNames.length > 0,
      allowBrowserTools: params.snapshotContext?.allowBrowserTools ?? params.allowedToolNames.some((name) => name.startsWith('browser_')),
      visibleCapabilityGroupIds: [...(params.snapshotContext?.visibleCapabilityGroupIds || [])],
      suppressedCapabilityGroupIds: [...(params.snapshotContext?.suppressedCapabilityGroupIds || [])],
      allowedToolNames: [...params.allowedToolNames],
      requestedTransport: params.snapshotContext?.requestedTransport || dispatchDecision.transport,
      supportsNativeTools: params.snapshotContext?.supportsNativeTools ?? dispatchDecision.supportsNativeTools,
      preferTextToolBridge: params.snapshotContext?.preferTextToolBridge ?? dispatchDecision.preferTextToolBridge,
    }
  }

  private buildToolSnapshot(params: {
    defaults: Omit<ToolSnapshot, 'stage' | 'source' | 'effectiveTransport' | 'fallbackReason' | 'toolCallsCount' | 'mismatch'>
    stage: ToolSnapshot['stage']
    effectiveTransport: ToolSnapshot['effectiveTransport']
    fallbackReason?: string | null
    toolCallsCount?: number | null
    mismatch?: boolean
  }): ToolSnapshot {
    return {
      stage: params.stage,
      source: 'provider',
      ...params.defaults,
      effectiveTransport: params.effectiveTransport,
      fallbackReason: params.fallbackReason || null,
      toolCallsCount: typeof params.toolCallsCount === 'number' ? params.toolCallsCount : null,
      mismatch: Boolean(params.mismatch),
    }
  }

  private hasToolListMismatch(expected: string[] | null, actual: string[]): boolean {
    if (!expected || expected.length === 0) return false
    if (expected.length !== actual.length) return true
    const expectedSorted = [...expected].sort()
    const actualSorted = [...actual].sort()
    return expectedSorted.some((name, index) => name !== actualSorted[index])
  }

  private async requestWithResponsesTools(params: {
    session: OpenAISessionLike
    config: AIModelConfig
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

    // Stage S (PR-S4 / W3.5) — provider-default + profile patcher.
    const patchCtx = this.buildPatchContext({
      config: params.config,
      baseUrl: params.openAIBase,
      model: params.model,
    })
    applyProviderRequestPatch(reqBody, patchCtx)
    // TODO(stage-s-followup): wrap with withRetryBackoff
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

    const json = await parseJsonOrEventStreamResponse(resp, { requestUrl: url }) as Record<string, unknown>
    applyProviderResponsePatch(json, patchCtx)
    const responsesToolCallResult = this.extractResponsesToolCalls(json)
    const responsesNative: OpenAIExecutionResponse = {
      text: this.extractResponsesText(json),
      toolCalls: responsesToolCallResult.toolCalls,
      stopReason: String(json.status || 'completed'),
      reasoningContent: (json as { reasoning?: unknown }).reasoning,
      providerResponseId: typeof json.id === 'string' ? json.id : undefined,
      toolTransport: 'native',
      toolCallParseErrors: responsesToolCallResult.toolCallParseErrors.length > 0
        ? responsesToolCallResult.toolCallParseErrors
        : undefined,
    }
    // Screenshot-bug ROOT FIX — recover XML tool_calls leaked into text.
    return this.recoverXmlToolCallsFromNative(responsesNative, 'responses')
  }

  private async requestWithChatCompletionsTools(params: {
    session: OpenAISessionLike
    config: AIModelConfig
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
    // Stage S (PR-S4 / W3.5) — extract inline body to a variable so the
    // patcher can mutate it before serialization.
    const reqBody: Record<string, unknown> = { model: params.model, messages, tools: params.tools }
    const patchCtx = this.buildPatchContext({
      config: params.config,
      baseUrl: params.openAIBase,
      model: params.model,
    })
    applyProviderRequestPatch(reqBody, patchCtx)
    // TODO(stage-s-followup): wrap with withRetryBackoff
    const resp = await this.deps.fetchWithTimeout(url, {
      method: 'POST',
      headers: params.headers,
      body: JSON.stringify(reqBody),
      signal: params.signal,
    }, params.signal, 'openai tools', params.timeoutMs)

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '')
      throw new Error(`HTTP ${resp.status}: ${errBody.slice(0, 300)}`)
    }

    const json = await parseJsonResponse(resp, { requestUrl: url }) as {
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
    applyProviderResponsePatch(json, patchCtx)
    const choice = json.choices?.[0]
    // Stage 2.1a — corrupt `arguments` JSON used to silently become `{}`,
    // letting an empty-args call into dispatch and ultimately invoking the
    // wrong tool. The helper drops corrupt calls and reports them so we
    // can emit `provider_arguments_corrupt`. Empty / "{}" args still parse
    // to `{}` because some tools legitimately take zero arguments.
    const built = buildChatCompletionsToolCalls(choice?.message?.tool_calls)
    for (const failure of built.failures) {
      logAgentMetric(TOOL_ERROR_METRICS.providerArgumentsCorrupt, {
        route: 'chat_completions',
        toolName: failure.toolName,
        callId: failure.callId,
        rawSample: failure.rawSample,
      })
    }
    const nativeResponse: OpenAIExecutionResponse = {
      text: extractOpenAIMessageText(choice?.message?.content),
      toolCalls: built.toolCalls,
      stopReason: choice?.finish_reason || 'stop',
      reasoningContent: choice?.message?.reasoning_content,
      toolTransport: 'native',
      toolCallParseErrors: built.failures.length > 0
        ? this.buildToolCallParseErrors('chat_completions', built.failures)
        : undefined,
    }
    this.deps.log(`OpenAI response: text=${nativeResponse.text.length}chars, toolCalls=${nativeResponse.toolCalls.length}, reasoning=${nativeResponse.reasoningContent !== undefined}, finish=${choice?.finish_reason}`)
    // Screenshot-bug ROOT FIX — recover XML tool_calls leaked into text.
    return this.recoverXmlToolCallsFromNative(nativeResponse, 'chat_completions')
  }

  /**
   * Screenshot-bug ROOT FIX — recover XML-style `<tool_call><function=NAME>
   * <parameter=KEY>VAL</parameter></function></tool_call>` calls that the
   * model emitted in plain text under NATIVE function-calling transport.
   *
   * Background: some OpenAI-compatible providers (mimo / qwen / others)
   * advertise native function calling, but the underlying model was trained
   * on the XML format. The provider passes the model's text through verbatim
   * and returns `tool_calls: []`. Without this recovery, turn-engine sees
   * "no tool calls" and ends the turn, leaving the user with a chat bubble
   * full of leaked XML and zero actual work done. Original Phase 3.2 fix
   * stripped the XML for cosmetic cleanliness but didn't restore the
   * model's intent — the user reported "直接就停止了这次".
   *
   * Returns the response unchanged when:
   *   - native already had real tool_calls (prefer the structured path)
   *   - text doesn't have the XML markers (fast path, no allocation)
   *   - parser extracts 0 calls (malformed XML — TurnTranscript's strip
   *     becomes the last-resort cleanup so the user at least sees clean
   *     text instead of raw markup)
   *
   * When recovery succeeds the response is rewritten as if it were
   * text-bridge: toolCalls populated with synthetic IDs, text replaced by
   * the cleaned visibleText, toolTransport tagged 'text' so downstream
   * consumers handle it consistently.
   */
  private recoverXmlToolCallsFromNative(
    response: OpenAIExecutionResponse,
    route: 'chat_completions' | 'responses',
  ): OpenAIExecutionResponse {
    if (response.toolCalls.length > 0) return response
    if (!response.text) return response
    // Reuse the same marker pattern as the renderer-side guard so a single
    // regex change keeps both layers in sync.
    if (!/<tool_call>|<function=|<parameter=|:::tool_call/i.test(response.text)) return response
    const parsed = parseTextToolBridgeResponse(response.text)
    if (parsed.toolCalls.length === 0) return response
    logAgentMetric(TOOL_ERROR_METRICS.xmlToolCallsRecoveredFromNative, {
      route,
      originalCallsCount: 0,
      recoveredCallsCount: parsed.toolCalls.length,
      recoveredToolNames: parsed.toolCalls.map((call) => call.name).slice(0, 5),
      originalTextLen: response.text.length,
      cleanedTextLen: parsed.visibleText.length,
    })
    this.deps.log(
      `[xml_recovery] ${route}: model emitted ${parsed.toolCalls.length} XML tool_call(s) under native transport; recovering as text-bridge so dispatch can proceed.`,
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
      // Tag as text-bridge so downstream (history compression, retry logic,
      // metrics) treats the recovered calls the same as canonical text-bridge.
      toolTransport: 'text',
    }
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

  private extractResponsesToolCalls(payload: unknown): {
    toolCalls: OpenAIToolCall[]
    toolCallParseErrors: TurnToolCallParseError[]
  } {
    if (!payload || typeof payload !== 'object') {
      return { toolCalls: [], toolCallParseErrors: [] }
    }
    const output = Array.isArray((payload as { output?: unknown[] }).output)
      ? (payload as { output?: unknown[] }).output as Array<Record<string, unknown>>
      : []
    // Stage 2.1a — same corruption handling as the chat_completions branch.
    // Missing `item.arguments` defaults to `'{}'`, which the parser treats
    // as a legitimate empty-args call (no metric). Synthetic call_id is
    // generated only when the provider omits one.
    const built = buildResponsesToolCalls(
      output,
      () => `respfc_${randomUUID().replace(/-/g, '')}`,
    )
    for (const failure of built.failures) {
      logAgentMetric(TOOL_ERROR_METRICS.providerArgumentsCorrupt, {
        route: 'responses',
        toolName: failure.toolName,
        callId: failure.callId,
        rawSample: failure.rawSample,
      })
    }
    return {
      toolCalls: built.toolCalls,
      toolCallParseErrors: this.buildToolCallParseErrors('responses', built.failures),
    }
  }

  private buildToolCallParseErrors(
    route: TurnToolCallParseError['route'],
    failures: ReadonlyArray<ProviderToolCallFailure>,
  ): TurnToolCallParseError[] {
    return failures.map((failure) => ({
      route,
      ...(failure.toolName ? { toolName: failure.toolName } : {}),
      ...(failure.callId ? { callId: failure.callId } : {}),
      reason: 'corrupt' as const,
    }))
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
    return sanitizeOpenAICompatibleMessageHistory(messages, {
      validToolNames: resolveRegisteredToolNamesLazily(),
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
