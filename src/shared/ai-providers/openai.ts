/**
 * Stage S (PR-S3) — OpenAI / GPT provider sub-module.
 *
 * Field-for-field copy from the legacy inline `AI_PROVIDERS[3]`
 * (src/shared/ai-providers.ts:201-221 prior to PR-S3).
 */

import type { AIProviderDef } from '../ai-providers'
import type { ProviderCapabilityClass } from './types'

export const def: AIProviderDef = {
  id: 'openai',
  label: 'OpenAI',
  labelEn: 'OpenAI',
  icon: '⚡',
  baseUrl: 'https://api.openai.com/v1',
  authHeader: 'Authorization',
  authPrefix: 'Bearer ',
  agentProtocol: 'openai',
  models: [
    { id: 'gpt-5.4', label: 'GPT-5.4', category: 'chat', description: '自定义新增模型' },
    { id: 'gpt-4o', label: 'GPT-4o', category: 'chat', description: '旗舰多模态' },
    { id: 'gpt-4o-mini', label: 'GPT-4o Mini', category: 'chat', description: '高性价比' },
    { id: 'o3-mini', label: 'o3-mini', category: 'chat', description: '高效推理' },
    { id: 'gpt-4-turbo', label: 'GPT-4 Turbo', category: 'chat', contextWindow: 128000 },
    { id: 'codex-mini-latest', label: 'Codex Mini', category: 'chat', description: '代码优化' },
    { id: '__custom__', label: '自定义模型 ID', category: 'chat', description: '手动输入，如 gpt-5.4-custom' },
  ],
  apiKeyPlaceholder: 'sk-...',
  helpUrl: 'https://platform.openai.com/docs/api-reference',
}

export const capabilityClass: ProviderCapabilityClass = {
  supportsVision: true,
  supportsThinking: false,
  supportsLongContext: true,
}

export const defaultRequestPatcher: undefined = undefined
export const defaultResponsePatcher: undefined = undefined
