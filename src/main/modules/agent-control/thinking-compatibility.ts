import {
  isMultiTurnThinkingPolicySafe,
  normalizeAIConfig,
  resolveAIConfigCapabilities,
  type AIModelConfig,
} from '../../../shared/ai-providers'
import type { MultiTurnThinkingPolicy } from '../../../shared/ai-providers/types'
import { ToolDomainError } from '../tools/tool-errors'
import { logAgentMetric } from './metrics'
import { TOOL_ERROR_METRICS } from './tools-runtime/tool-error-metrics'

function messageForPolicy(policy: MultiTurnThinkingPolicy): string {
  if (policy === 'unsupported') {
    return '当前供应商已确认不支持多轮 thinking 模式，请在设置中关闭思考模式或切换供应商。'
  }
  return '当前供应商的多轮 thinking 兼容性未验证，请在设置中关闭思考模式或切换到已验证的供应商。'
}

export function assertManualThinkingModeProviderSafe(
  config: AIModelConfig,
  route: string,
): void {
  const normalized = normalizeAIConfig(config)
  if (normalized.thinkingMode !== 'on') return

  const capabilities = resolveAIConfigCapabilities(normalized)
  const policy = capabilities?.multiTurnThinkingPolicy ?? 'unknown'
  if (isMultiTurnThinkingPolicySafe(policy)) return

  logAgentMetric(TOOL_ERROR_METRICS.providerThinkingEchoUnsupported, {
    route,
    provider: normalized.provider,
    model: normalized.model,
    policy,
  })
  throw new ToolDomainError(
    'provider_request_failed',
    messageForPolicy(policy),
    {
      recoverable: false,
      route,
      provider: normalized.provider,
      model: normalized.model,
      multiTurnThinkingPolicy: policy,
    },
  )
}
