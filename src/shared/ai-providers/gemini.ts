/**
 * Stage S (PR-S3) — Google Gemini provider sub-module.
 *
 * Field-for-field copy from the legacy inline `AI_PROVIDERS[4]`
 * (src/shared/ai-providers.ts:224-241 prior to PR-S3).
 */

import type { AIProviderDef } from '../ai-providers'
import type { ProviderCapabilityClass } from './types'

export const def: AIProviderDef = {
  id: 'gemini',
  label: 'Gemini (Google)',
  labelEn: 'Google Gemini',
  icon: '💎',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  authHeader: 'Authorization',
  authPrefix: 'Bearer ',
  agentProtocol: 'openai',
  models: [
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', category: 'chat', description: '最新旗舰，支持思考' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', category: 'chat', description: '快速思考' },
    { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', category: 'chat', description: '快速多模态' },
    { id: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro', category: 'chat', contextWindow: 2000000, description: '200万上下文' },
  ],
  apiKeyPlaceholder: 'AIza...',
  helpUrl: 'https://ai.google.dev/gemini-api/docs',
}

export const capabilityClass: ProviderCapabilityClass = {
  supportsVision: true,
  supportsThinking: true,
  supportsLongContext: true,
}

export const defaultRequestPatcher: undefined = undefined
export const defaultResponsePatcher: undefined = undefined
