import type { AIModelConfig, AIProviderDef, AIReasoningEffort, AIWireAPI } from '../../../shared/ai-providers'
import { resolveAIConfigCapabilities } from '../../../shared/ai-providers'
import { looksLikeMissingNativeToolsReply } from '../claude-bridge/tool-bridge'
import { buildToolDispatchDecision } from './tool-policy/execution-tool-policy'

export interface OpenAIProviderRuntime {
  wireApi: AIWireAPI
  reasoningEffort?: AIReasoningEffort
}

export function resolveOpenAIProviderRuntime(params: {
  config: AIModelConfig
  provider?: AIProviderDef
  baseUrl: string
}): OpenAIProviderRuntime {
  const capabilities = resolveAIConfigCapabilities(params.config)
  const wireApi = capabilities?.wireApi === 'responses' || capabilities?.wireApi === 'chat/completions'
    ? capabilities.wireApi
    : (() => {
      const explicit = params.config.wireApi || params.provider?.wireApi
      if (explicit === 'responses' || explicit === 'chat/completions') return explicit
      return params.baseUrl.includes('/codex/v1') ? 'responses' : 'chat/completions'
    })()

  const reasoningEffort = (() => {
    const effort = params.config.reasoningEffort || params.provider?.defaultReasoningEffort
    return effort === 'minimal' || effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'max'
      ? effort
      : undefined
  })()

  return {
    wireApi,
    reasoningEffort,
  }
}

export function shouldUseTextToolBridgeForRun(params: {
  config: AIModelConfig
  preferTextToolBridge: boolean
}): boolean {
  const capabilities = resolveAIConfigCapabilities(params.config)
  return buildToolDispatchDecision({
    supportsToolCalls: capabilities?.supportsToolCalls ?? true,
    supportsNativeToolCalls: capabilities?.supportsNativeToolCalls ?? capabilities?.supportsToolCalls ?? true,
    toolCallTransport: capabilities?.toolCallTransport || null,
    preferTextToolBridge: params.preferTextToolBridge,
  }).preferTextToolBridge
}

export function shouldRetryWithTextToolBridge(params: {
  text: string
  config: AIModelConfig
  preferTextToolBridge: boolean
}): boolean {
  const capabilities = resolveAIConfigCapabilities(params.config)
  const dispatchDecision = buildToolDispatchDecision({
    supportsToolCalls: capabilities?.supportsToolCalls ?? true,
    supportsNativeToolCalls: capabilities?.supportsNativeToolCalls ?? capabilities?.supportsToolCalls ?? true,
    toolCallTransport: capabilities?.toolCallTransport || null,
    preferTextToolBridge: params.preferTextToolBridge,
  })
  if (dispatchDecision.preferTextToolBridge) return false
  if (dispatchDecision.transport === 'none') return false
  return looksLikeMissingNativeToolsReply(params.text)
}
