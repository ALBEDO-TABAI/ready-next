/**
 * Stage S (PR-S4 / W3.3) — DeepSeek patch profile.
 *
 * Match contract:
 *   - baseUrl contains `.deepseek.com` or `.deepseek.ai`, OR
 *   - model id starts with `deepseek-`.
 *
 * Why this exists: DeepSeek-R1 and successor reasoning models return
 * `reasoning_content` separate from `content`. On multi-turn tool-use
 * loops the API requires every prior assistant turn to keep its
 * `reasoning_content` field intact — dropping or merging it changes
 * the trace and degrades quality on the next turn.
 *
 * The patcher only enforces preservation: if the caller already
 * carries `reasoning_content` on history messages, leave it alone;
 * never drop it; never invent it. (Strictly speaking, dropping is
 * what we are *preventing* — `applyProviderRequestPatch` runs after
 * provider-default and after caller-supplied merging so we are the
 * last line of defense before `JSON.stringify`.)
 */

import type { PatchProfile } from '../types'

export const profileId = 'deepseek' as const

export const matchPredicate = (
  _config: any,
  baseUrl: string | null,
  model: string,
): boolean => {
  if (typeof model === 'string' && /^deepseek-/i.test(model)) return true
  if (!baseUrl) return false
  return /\.deepseek\.(com|ai)/i.test(baseUrl)
}

export const requestPatcher = (body: any, _ctx: any): any => {
  if (!body || typeof body !== 'object') return body
  if (!Array.isArray(body.messages)) return body
  // Walk every assistant message; if it carries `reasoning_content`,
  // simply re-assert (no-op when already present). The defensive
  // pass exists so that an upstream serializer that strips unknown
  // fields would still see them as known here.
  for (const message of body.messages) {
    if (
      message &&
      typeof message === 'object' &&
      message.role === 'assistant' &&
      Object.prototype.hasOwnProperty.call(message, 'reasoning_content')
    ) {
      // Preserve as-is. Explicit re-assignment ensures any
      // surrounding shallow clone also keeps the field.
      ;(message as any).reasoning_content = (message as any).reasoning_content
    }
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
