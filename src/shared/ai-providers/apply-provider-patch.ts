/**
 * Stage S (PR-S3) — provider patcher entry helper.
 *
 * Applies the provider-default patcher first, then the resolved
 * `PatchProfile` patcher. PR-S4 wires the four execution-client
 * serialization points (chat/completions request, chat/completions
 * stream, anthropic /messages, anthropic stream) through this helper.
 *
 * Priority contract:
 *  1. User-supplied config fields are the most authoritative —
 *     callers must merge user values into `body` *before* invoking
 *     `applyProviderRequestPatch`. Patchers may only fill
 *     `undefined` slots or overwrite profile-owned fields.
 *  2. Provider default patcher runs first (e.g. `openai-compatible`
 *     stream_usage default).
 *  3. Profile patcher runs last (it represents the most specific
 *     adapter — gemini-oai, deepseek, minimax, vllm).
 */

import type { AIModelConfig } from '../ai-providers'
import type { PatchProfile } from './types'

export interface PatchContext {
  config: AIModelConfig | null
  baseUrl: string | null
  model: string
  profile: PatchProfile | null
  providerDefaultRequestPatcher?: (body: any, ctx: PatchContext) => any
  providerDefaultResponsePatcher?: (resp: any, ctx: PatchContext) => any
}

export function applyProviderRequestPatch(body: any, ctx: PatchContext): any {
  let result = body
  if (typeof ctx.providerDefaultRequestPatcher === 'function') {
    result = ctx.providerDefaultRequestPatcher(result, ctx)
  }
  if (ctx.profile && typeof ctx.profile.requestPatcher === 'function') {
    result = ctx.profile.requestPatcher(result, ctx)
  }
  return result
}

export function applyProviderResponsePatch(resp: any, ctx: PatchContext): any {
  let result = resp
  if (typeof ctx.providerDefaultResponsePatcher === 'function') {
    result = ctx.providerDefaultResponsePatcher(result, ctx)
  }
  if (ctx.profile && typeof ctx.profile.responsePatcher === 'function') {
    result = ctx.profile.responsePatcher(result, ctx)
  }
  return result
}
