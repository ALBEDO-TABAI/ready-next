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

export const defaultRequestPatcher = (body: any, ctx?: any): any => {
  if (!body || typeof body !== 'object') return body
  if (body.stream_options && typeof body.stream_options === 'object') {
    if (body.stream_options.include_usage === undefined) {
      body.stream_options.include_usage = true
    }
  } else {
    body.stream_options = { include_usage: true }
  }
  if (body.stream_usage === undefined) body.stream_usage = true

  // Stage S (PR-S6 / W4.4) — reasoning_effort routing.
  //
  // Provider patcher gates `reasoning_effort` (in either the chat/completions
  // top-level form or the responses-API `reasoning.effort` nested form) on
  // the resolved capability `supportsThinking`. When the model does not
  // support thinking, strip the field from the wire payload — many
  // OpenAI-compatible relays will 400 on it. When the model does support
  // thinking, leave the caller-injected value alone (priority contract:
  // user > runtime resolver > patcher; patcher only fills `undefined`).
  //
  // Gate `check-reasoning-effort-routing.cjs` requires:
  //   (a) literal `reasoning_effort`
  //   (b) `supportsThinking` reference
  // both present in at least one provider patcher.
  //
  // Resolution avoids importing `../ai-providers` (circular) by reading
  // the merge layers directly: model.capabilityOverrides → provider
  // capabilityClass (this module) → conservative `false` default. The
  // `openai-compatible` provider's `capabilityClass.supportsThinking`
  // is `false` so by default we strip; users can opt-in per-model via
  // `capabilityOverrides.supportsThinking = true`.
  if (ctx && ctx.config) {
    const cfg = ctx.config as { model?: string; thinkingMode?: 'auto' | 'on' | 'off' }
    const userMode = cfg.thinkingMode
    const providerSupportsThinking = capabilityClass.supportsThinking === true
    // Walk the model overrides to mirror PR-S5's three-layer merge.
    const modelDef = def.models.find((m) => m.id === cfg.model)
    const modelOverride = modelDef?.capabilityOverrides?.supportsThinking
    const supportsThinking = userMode === 'on'
      ? true
      : userMode === 'off'
        ? false
        : (modelOverride ?? providerSupportsThinking)
    if (supportsThinking !== true) {
      if ('reasoning_effort' in body) {
        delete body.reasoning_effort
      }
      if (body.reasoning && typeof body.reasoning === 'object' && 'effort' in body.reasoning) {
        delete body.reasoning.effort
        if (Object.keys(body.reasoning).length === 0) {
          delete body.reasoning
        }
      }
    }
  }

  return body
}

export const defaultResponsePatcher: undefined = undefined
