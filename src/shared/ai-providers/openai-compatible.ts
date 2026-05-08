/**
 * Stage S (PR-S3) — Generic OpenAI-compatible provider sub-module.
 *
 * Field-for-field copy from the legacy inline `AI_PROVIDERS[6]`
 * (src/shared/ai-providers.ts:266-284 prior to PR-S3).
 *
 * Carries a built-in `defaultRequestPatcher` that turns on
 * `stream_options.include_usage` and the legacy `stream_usage` mirror
 * so token attribution does not silently drop on third-party
 * OpenAI-compatible endpoints. User-supplied values are preserved
 * (the patcher only fills in `undefined` slots).
 */

import type { AIProviderDef } from '../ai-providers'
import type { ProviderCapabilityClass } from './types'

export const def: AIProviderDef = {
  id: 'openai-compatible',
  label: '自定义 (OpenAI 兼容)',
  labelEn: 'OpenAI Compatible',
  icon: '🔧',
  baseUrl: '',
  authHeader: 'Authorization',
  authPrefix: 'Bearer ',
  agentProtocol: 'openai',
  models: [
    { id: 'newcli-codex', label: 'NewCLI Codex', category: 'chat', description: 'FoxCode / NewCLI Codex 通道' },
    { id: 'free-codex', label: 'Free Codex', category: 'chat', description: 'FoxCode 免费 Codex 通道' },
    { id: 'newcli-codex-claude-sonnet', label: 'NewCLI Codex Claude Sonnet', category: 'chat', description: 'Claude Sonnet 风格 Codex 通道' },
    { id: 'newcli-codex-qwen-coder', label: 'NewCLI Codex Qwen Coder', category: 'chat', description: 'Qwen Coder 风格 Codex 通道' },
    { id: 'custom', label: '自定义模型', category: 'chat', description: '手动输入模型 ID' },
  ],
  apiKeyPlaceholder: 'sk-...',
  helpUrl: '',
}

export const capabilityClass: ProviderCapabilityClass = {
  supportsVision: false,
  supportsThinking: false,
  supportsLongContext: false,
}

export const defaultRequestPatcher = (body: any): any => {
  if (!body || typeof body !== 'object') return body
  if (body.stream_options && typeof body.stream_options === 'object') {
    if (body.stream_options.include_usage === undefined) {
      body.stream_options.include_usage = true
    }
  } else {
    body.stream_options = { include_usage: true }
  }
  if (body.stream_usage === undefined) body.stream_usage = true
  return body
}

export const defaultResponsePatcher: undefined = undefined
