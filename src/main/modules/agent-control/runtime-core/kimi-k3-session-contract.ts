import type { AIModelConfig } from '../../../../shared/ai-providers'
import {
  inspectKimiK3History,
  isKimiK3Config,
} from '../../../../shared/ai-providers/kimi-k3'
import { PROVIDER_ERROR_KINDS } from '../contracts/error-kinds'
import { ToolDomainError } from '../../tools/tool-errors'
import { logAgentMetric } from '../metrics'

export function assertKimiK3HistoryCompatible(
  input: unknown,
  config: AIModelConfig,
  route: string,
): void {
  if (!isKimiK3Config(config)) return
  const inspection = inspectKimiK3History(input)
  if (inspection.compatible) return

  logAgentMetric('kimi_k3_history_incompatible', {
    route,
    provider: config.provider,
    model: config.model,
    reason: inspection.reason,
  })
  throw new ToolDomainError(
    PROVIDER_ERROR_KINDS.providerRequestFailed.code,
    'Kimi K3 不能接着使用其他模型或旧版不完整的会话历史。请新建会话后再使用 K3。',
    {
      recoverable: false,
      route,
      provider: config.provider,
      model: config.model,
      reason: 'kimi_k3_incompatible_history',
    },
  )
}
