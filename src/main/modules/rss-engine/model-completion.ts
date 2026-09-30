import { randomUUID } from 'node:crypto'
import { ProviderOutputIncompleteError } from '../agent-control/runtime-core/provider-output-status'
import { MemorySession } from '@openai/agents'
import { getProviderDef, type AIModelConfig } from '../../../shared/ai-providers'
import { CONTEXT_SOFT_RATIO, estimateInputItemTokens, estimateTextTokens, resolveModelContextWindow } from '../../../shared/context-budget-types'
import { resolveAgentSdkProvider, runWithOpenAIAgentsSdk } from '../agent-control/runtime-core/agent-sdk-provider'

export interface RSSCompletionRequest {
  system: string
  user: string
  maxTokens: number
  timeoutMs?: number
  signal?: AbortSignal
  runId?: string
}

export function isRSSModelConfigured(config: AIModelConfig | null): config is AIModelConfig {
  return !!(config?.apiKey && config.baseUrl && config.model)
}

export function validateRSSModelRequest(config: AIModelConfig | null, request: RSSCompletionRequest): number {
  if (!isRSSModelConfigured(config)) throw new Error('请先在 Ready 中配置用于资讯分析的模型。')
  const modelDef = getProviderDef(config.provider, config.baseUrl)?.models.find((entry) => entry.id === config.model)
  const window = resolveModelContextWindow(config, modelDef)
  const inputTokens = estimateInputItemTokens([{ role: 'user', content: request.user }])
  if (inputTokens > window * CONTEXT_SOFT_RATIO || inputTokens + estimateTextTokens(request.system) + request.maxTokens > window) throw new Error('当前模型的上下文容量不足以完整读取本次资料和分类标准，请选择容量更大的模型。')
  return window
}

/** One requested judgment; transport failures propagate without another paid attempt. */
export async function completeRSSModel(config: AIModelConfig | null, request: RSSCompletionRequest): Promise<string> {
  request.signal?.throwIfAborted()
  if (!isRSSModelConfigured(config)) throw new Error('请先在 Ready 中配置用于资讯分析的模型。')
  const contextWindowTokens = validateRSSModelRequest(config, request)
  const { provider, model } = resolveAgentSdkProvider(config, {
    fetchWithTimeout: (url, init, signal) => fetch(url, { ...init, signal }),
    openAIClientMaxRetries: 0,
  })
  const id = request.runId || `rss-analysis-${randomUUID()}`
  const signal = AbortSignal.any([AbortSignal.timeout(request.timeoutMs || 120_000), ...(request.signal ? [request.signal] : [])])
  const result = await runWithOpenAIAgentsSdk({
    agentName: 'RSS analysis', runId: id, taskId: id, sessionId: id,
    instructions: request.system, input: request.user, provider, model,
    session: new MemorySession({ sessionId: id }), tools: [], maxTurns: 1,
    signal,
    contextWindowTokens,
    maxOutputTokens: request.maxTokens, onTextDelta: () => {},
  })
  signal.throwIfAborted()
  if (result.outputIncomplete) throw new ProviderOutputIncompleteError()
  return result.finalText.trim()
}
