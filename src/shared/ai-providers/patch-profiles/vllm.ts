/**
 * Stage S (PR-S4 / W3.5) — vLLM patch profile.
 *
 * Match contract (defensive — rejects all official providers):
 *   - if `config.provider` is `'openai' | 'anthropic' | 'gemini'` → never match
 *     (the runtime `AIModelConfig` field is `provider`, not `id`)
 *   - baseUrl must end with `/v1` or `/v1/`
 *   - model must `startsWith('vllm/')` OR match
 *     `/llm-|qwen-|baichuan-|chatglm-|deepseek-r1/i`
 *
 * Why this exists: many vLLM deployments expose an OpenAI-compatible
 * surface but only stream usage when both `stream_options.include_usage
 * = true` and the legacy `stream_usage = true` mirror are present.
 * The patcher fills both fields when the caller has not set them.
 *
 * Priority: profile patcher runs *after* provider-default, so user
 * config (merged into `body` by the caller before patching) is still
 * authoritative — we only assert the final values when no value was
 * supplied.
 */

import type { PatchProfile } from '../types'

export const profileId = 'vllm' as const

export const matchPredicate = (
  config: any,
  baseUrl: string | null,
  model: string,
): boolean => {
  // Defensive: explicit official-provider exclusion comes first.
  // NB: AIModelConfig's runtime field is `provider`, not `id`; we read both
  // to stay defensive against shape drift from older callers.
  if (config && typeof config === 'object') {
    const provider = (config as any).provider ?? (config as any).id
    if (provider === 'openai' || provider === 'anthropic' || provider === 'gemini') return false
  }
  if (!baseUrl || typeof model !== 'string' || model.length === 0) return false
  if (!/\/v1\/?$/.test(baseUrl)) return false
  if (model.startsWith('vllm/')) return true
  return /llm-|qwen-|baichuan-|chatglm-|deepseek-r1/i.test(model)
}

export const requestPatcher = (body: any, _ctx: any): any => {
  if (!body || typeof body !== 'object') return body
  // Force include_usage when missing; preserve user-supplied falsy values.
  if (body.stream_options && typeof body.stream_options === 'object') {
    if (body.stream_options.include_usage === undefined) {
      body.stream_options.include_usage = true
    }
  } else {
    body.stream_options = { include_usage: true }
  }
  // Legacy mirror — some vLLM builds key off `stream_usage` directly.
  if (body.stream_usage === undefined) {
    body.stream_usage = true
  }
  return body
}

export const responsePatcher: undefined = undefined

export const profile: PatchProfile = {
  profileId,
  matchPredicate,
  requestPatcher,
  responsePatcher,
}
