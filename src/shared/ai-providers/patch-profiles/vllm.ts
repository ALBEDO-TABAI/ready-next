/**
 * Stage S (PR-S4 / W3.5) — vLLM patch profile.
 *
 * Match contract (positive + negative — explicit on both sides):
 *   1. if `config.provider` (or legacy `config.id`) is one of
 *      `'openai' | 'anthropic' | 'gemini'` → `return false` (never match).
 *      The three official providers ship their own SDK paths and must
 *      never be patched by the vLLM profile, regardless of baseUrl/model.
 *   2. if `config.provider` is `'openai-compatible'` → eligible to match,
 *      then check baseUrl + model below. Stage S round 2 made this
 *      positive check explicit (replacing the earlier `provider ?? id`
 *      fallback) so the matcher fails closed when the config carries an
 *      unknown provider id rather than silently relying on the negative
 *      list to catch every future official-provider name.
 *   3. if `config` is `null`/`undefined` → fall through to baseUrl/model
 *      check (legacy callers without a config still reach this profile
 *      through `resolve-provider-patch-profile`).
 *   4. baseUrl must end with `/v1` or `/v1/`.
 *   5. model must `startsWith('vllm/')` OR match
 *      `/llm-|qwen-|baichuan-|chatglm-|deepseek-r1/i`.
 *
 * Why this exists: many vLLM deployments expose an OpenAI-compatible
 * surface but only stream usage when streaming requests carry both
 * `stream_options.include_usage = true` and the legacy `stream_usage = true`
 * mirror. The patcher fills both fields on streaming calls when the caller
 * has not set them.
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
  // (1) Explicit official-provider rejection. Read both `provider` (the
  // runtime AIModelConfig field) and legacy `id` for defensiveness.
  if (config && typeof config === 'object') {
    const providerField = (config as any).provider
    const idField = (config as any).id
    if (providerField === 'openai' || providerField === 'anthropic' || providerField === 'gemini') {
      return false
    }
    if (idField === 'openai' || idField === 'anthropic' || idField === 'gemini') {
      return false
    }
    // (2) Stage S round 2 — positive match on `provider === 'openai-compatible'`.
    // When a provider field is present and it's NOT the openai-compatible id,
    // we fail closed: only the canonical compatible-provider id is allowed
    // to feed the vLLM profile path. Configs without a `provider` field
    // (legacy / null config) still fall through to baseUrl/model below.
    if (providerField !== undefined && providerField !== 'openai-compatible') {
      return false
    }
  }
  if (!baseUrl || typeof model !== 'string' || model.length === 0) return false
  if (!/\/v1\/?$/.test(baseUrl)) return false
  if (model.startsWith('vllm/')) return true
  return /llm-|qwen-|baichuan-|chatglm-|deepseek-r1/i.test(model)
}

export const requestPatcher = (body: any, _ctx: any): any => {
  if (!body || typeof body !== 'object') return body
  if (body.stream !== true) return body
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
