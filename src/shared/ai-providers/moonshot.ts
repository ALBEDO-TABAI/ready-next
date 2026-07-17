/**
 * Stage S (PR-S3) — Moonshot / Kimi provider sub-module.
 *
 * Field-for-field copy from the legacy inline `AI_PROVIDERS[0]`
 * (src/shared/ai-providers.ts:137-155 prior to PR-S3).
 */

import type { AIProviderDef } from '../ai-providers'
import type { ProviderCapabilityClass } from './types'

export const def: AIProviderDef = {
  id: 'moonshot',
  label: 'Kimi (月之暗面)',
  labelEn: 'Moonshot AI',
  icon: '🌙',
  baseUrl: 'https://api.moonshot.cn/v1',
  authHeader: 'Authorization',
  authPrefix: 'Bearer ',
  agentProtocol: 'openai',
  models: [
    { id: 'k3', label: 'Kimi K3', category: 'chat', description: 'Coding Agent；支持 low / high / max 思考强度', capabilityOverrides: { supportsThinking: true, multiTurnThinkingPolicy: 'echo_required' } },
    { id: 'kimi-for-coding', label: 'Kimi For Coding', category: 'chat', description: 'Coding 专用（第三方 Agent 兼容）' },
    { id: 'moonshot-v1-128k', label: 'Moonshot V1 128K', category: 'chat', contextWindow: 128000, description: '超长上下文' },
    { id: 'moonshot-v1-32k', label: 'Moonshot V1 32K', category: 'chat', contextWindow: 32768 },
    { id: 'moonshot-v1-8k', label: 'Moonshot V1 8K', category: 'chat', contextWindow: 8192 },
    { id: 'kimi-latest', label: 'Kimi Latest', category: 'chat', description: '最新版本' },
  ],
  apiKeyPlaceholder: 'sk-...',
  helpUrl: 'https://platform.moonshot.cn/docs',
}

export const capabilityClass: ProviderCapabilityClass = {
  supportsVision: false,
  supportsThinking: false,
  supportsLongContext: true,
}

export const defaultRequestPatcher: undefined = undefined
export const defaultResponsePatcher: undefined = undefined
