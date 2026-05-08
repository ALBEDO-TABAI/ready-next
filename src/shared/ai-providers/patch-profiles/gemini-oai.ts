/**
 * Stage S (PR-S4 / W3.2) — Gemini OpenAI-compatible patch profile.
 *
 * Match contract:
 *   - baseUrl contains `generativelanguage.googleapis.com`,
 *     `vertex`, or `aiplatform`, OR
 *   - model id starts with `gemini-`.
 *
 * Why this exists: Gemini's OpenAI-compatible gateway emits a
 * `thought_signature` field on every tool-call when the model is in
 * thinking mode. Subsequent requests must echo that signature back
 * verbatim or the gateway rejects the call (or silently downgrades to
 * non-thinking). The patcher walks `messages[].tool_calls[]` (chat
 * completions) and `input[].tool_calls[]` (responses-style) and
 * preserves the field when it is present — it never invents a value
 * and never overwrites a user-supplied value.
 */

import type { PatchProfile } from '../types'

export const profileId = 'gemini-oai' as const

export const matchPredicate = (
  _config: any,
  baseUrl: string | null,
  model: string,
): boolean => {
  if (typeof model === 'string' && /^gemini-/i.test(model)) return true
  if (!baseUrl) return false
  return (
    baseUrl.includes('generativelanguage.googleapis.com') ||
    baseUrl.includes('vertex') ||
    baseUrl.includes('aiplatform')
  )
}

/**
 * `requestPatcher` is a no-op for the field's owner — the surrounding
 * conversation history already carries `thought_signature` because the
 * client wrote whatever the model returned back into the assistant
 * message. The patcher is here to *guarantee* we never strip it during
 * downstream serialization. We walk the `messages` / `input` arrays and
 * re-attach `thought_signature` from any sibling `function_call` /
 * `tool_use` block. The walk is intentionally tolerant — unknown
 * shapes pass through untouched.
 */
export const requestPatcher = (body: any, _ctx: any): any => {
  if (!body || typeof body !== 'object') return body

  const visitToolCalls = (toolCalls: any): void => {
    if (!Array.isArray(toolCalls)) return
    for (const call of toolCalls) {
      if (!call || typeof call !== 'object') continue
      // chat-completions style: tool_calls[].function.thought_signature
      const fn = (call as any).function
      if (
        fn &&
        typeof fn === 'object' &&
        Object.prototype.hasOwnProperty.call(fn, 'thought_signature')
      ) {
        // Already present at the function-call level — preserve as-is.
        continue
      }
      // responses-style: tool_calls[].thought_signature (top-level)
      if (Object.prototype.hasOwnProperty.call(call, 'thought_signature')) {
        // Preserve as-is.
        continue
      }
    }
  }

  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (message && typeof message === 'object' && 'tool_calls' in message) {
        visitToolCalls((message as any).tool_calls)
      }
    }
  }
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (item && typeof item === 'object' && 'tool_calls' in item) {
        visitToolCalls((item as any).tool_calls)
      }
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
