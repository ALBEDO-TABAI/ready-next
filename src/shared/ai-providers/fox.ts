/**
 * Stage S (PR-S3) — FoxCode / NewCLI Codex provider sub-module.
 *
 * Field-for-field copy from the legacy inline `AI_PROVIDERS[2]`
 * (src/shared/ai-providers.ts:179-198 prior to PR-S3).
 */

import type { AIProviderDef } from '../ai-providers'
import type { ProviderCapabilityClass } from './types'

export const def: AIProviderDef = {
  id: 'fox',
  label: 'FoxCode Codex',
  labelEn: 'FoxCode / NewCLI Codex',
  icon: '🦊',
  baseUrl: 'https://code.newcli.com/codex/v1',
  authHeader: 'Authorization',
  authPrefix: 'Bearer ',
  agentProtocol: 'openai',
  wireApi: 'responses',
  defaultReasoningEffort: 'high',
  models: [
    { id: 'gpt-5.4', label: 'GPT-5.4', category: 'chat', description: 'FoxCode 推荐模型' },
    { id: 'gpt-5', label: 'GPT-5', category: 'chat', description: 'Codex 通道' },
    { id: 'gpt-5-codex', label: 'GPT-5 Codex', category: 'chat', description: 'Codex 优化变体' },
    { id: '__custom__', label: '自定义模型 ID', category: 'chat', description: '手动输入，如 gpt-5.4' },
  ],
  apiKeyPlaceholder: 'sk-ant-...',
  helpUrl: 'https://foxcode.rjj.cc/api-keys',
}

export const capabilityClass: ProviderCapabilityClass = {
  supportsVision: false,
  supportsThinking: false,
  supportsLongContext: false,
}

export const defaultRequestPatcher: undefined = undefined
export const defaultResponsePatcher: undefined = undefined
