/**
 * Stage S (PR-S3) — Anthropic / Claude provider sub-module.
 *
 * Field-for-field copy from the legacy inline `AI_PROVIDERS[1]`
 * (src/shared/ai-providers.ts:158-176 prior to PR-S3).
 */

import type { AIProviderDef } from '../ai-providers'
import type { ProviderCapabilityClass } from './types'

export const def: AIProviderDef = {
  id: 'anthropic',
  label: 'Claude (Anthropic)',
  labelEn: 'Anthropic',
  icon: '🤖',
  baseUrl: 'https://api.anthropic.com',
  authHeader: 'x-api-key',
  authPrefix: '',
  agentProtocol: 'anthropic',
  extraHeaders: { 'anthropic-version': '2023-06-01' },
  models: [
    { id: 'claude-opus-4-20250514', label: 'Claude Opus 4', category: 'chat', description: '最强推理' },
    { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4', category: 'chat', description: '均衡性能' },
    { id: 'claude-haiku-3-5-20241022', label: 'Claude Haiku 3.5', category: 'chat', description: '快速低成本' },
    { id: '__custom__', label: '自定义模型 ID', category: 'chat', description: '手动输入，如 kimi-for-coding' },
  ],
  apiKeyPlaceholder: 'sk-ant-...',
  helpUrl: 'https://docs.anthropic.com',
}

export const capabilityClass: ProviderCapabilityClass = {
  supportsVision: true,
  supportsThinking: true,
  supportsLongContext: true,
}

export const defaultRequestPatcher: undefined = undefined
export const defaultResponsePatcher: undefined = undefined
