import { randomUUID } from 'node:crypto'
import { MemorySession } from '@openai/agents'
import { getProviderDef, type AIModelConfig } from '../../../shared/ai-providers'
import { resolveModelContextWindow } from '../../../shared/context-budget-types'
import { resolveAgentSdkProvider, runWithOpenAIAgentsSdk } from '../agent-control/runtime-core/agent-sdk-provider'

export interface RSSCompletionRequest {
  system: string
  user: string
  maxTokens: number
  timeoutMs?: number
}

/** One requested judgment; transport failures propagate without another paid attempt. */
export async function completeRSSModel(config: AIModelConfig | null, request: RSSCompletionRequest): Promise<string> {
  if (!config?.apiKey || !config.baseUrl || !config.model) throw new Error('请先在 Ready 中配置用于资讯分析的模型。')
  const { provider, model } = resolveAgentSdkProvider(config, {
    fetchWithTimeout: (url, init, signal) => fetch(url, { ...init, signal }),
    openAIClientMaxRetries: 0,
  })
  const id = `rss-analysis-${randomUUID()}`
  const modelDef = getProviderDef(config.provider, config.baseUrl)?.models.find((entry) => entry.id === model)
  const result = await runWithOpenAIAgentsSdk({
    agentName: 'RSS analysis', runId: id, taskId: id, sessionId: id,
    instructions: request.system, input: request.user, provider, model,
    session: new MemorySession({ sessionId: id }), tools: [], maxTurns: 1,
    signal: AbortSignal.timeout(request.timeoutMs || 120_000),
    contextWindowTokens: resolveModelContextWindow(config, modelDef),
    maxOutputTokens: request.maxTokens, onTextDelta: () => {},
  })
  if (result.outputIncomplete) throw new Error('模型返回的分析未完整结束，本次未发布报告。')
  return result.finalText.trim()
}
