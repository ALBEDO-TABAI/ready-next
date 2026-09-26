import type { AIModelConfig, AIReasoningEffort } from '../ai-providers'

export function isZaiResponsesConfig(config: Pick<AIModelConfig, 'baseUrl' | 'model' | 'wireApi'>): boolean {
  return config.baseUrl.replace(/\/+$/, '') === 'https://api.z.ai/api/v1'
    && ['glm-5.3', 'glm-5.3-flash'].includes(config.model)
    && (!config.wireApi || config.wireApi === 'responses')
}

export function zaiReasoningEffort(effort: AIReasoningEffort): string {
  if (effort === 'minimal') return 'low'
  if (effort === 'medium') return 'high'
  if (effort === 'xhigh') return 'max'
  return effort
}
