/**
 * Stage S (PR-S3) — Volcano Engine (豆包 / Seedance / Seedream) provider sub-module.
 *
 * Field-for-field copy from the legacy inline `AI_PROVIDERS[5]`
 * (src/shared/ai-providers.ts:244-263 prior to PR-S3).
 */

import type { AIProviderDef } from '../ai-providers'
import type { ProviderCapabilityClass } from './types'

export const def: AIProviderDef = {
  id: 'volcengine',
  label: '火山方舟 (豆包)',
  labelEn: 'Volcano Engine',
  icon: '🌋',
  baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  authHeader: 'Authorization',
  authPrefix: 'Bearer ',
  agentProtocol: 'openai',
  models: [
    { id: 'doubao-1.5-pro-32k', label: '豆包 1.5 Pro', category: 'chat', contextWindow: 32768, description: '通用对话' },
    { id: 'doubao-1.5-lite-32k', label: '豆包 1.5 Lite', category: 'chat', contextWindow: 32768, description: '轻量对话' },
    { id: 'seedance-1.0-pro', label: 'Seedance 1.0 Pro', category: 'video', description: '文本转视频' },
    { id: 'seedance-1.0-lite', label: 'Seedance 1.0 Lite', category: 'video', description: '快速视频生成' },
    { id: 'seedream-3.0', label: 'Seedream 3.0', category: 'image', description: '文本转图像' },
    { id: 'seedream-2.0', label: 'Seedream 2.0', category: 'image', description: '图像生成' },
  ],
  apiKeyPlaceholder: 'ark-...',
  helpUrl: 'https://www.volcengine.com/docs/82379',
}

export const capabilityClass: ProviderCapabilityClass = {
  supportsVision: false,
  supportsThinking: false,
  supportsLongContext: false,
}

export const defaultRequestPatcher: undefined = undefined
export const defaultResponsePatcher: undefined = undefined
