/**
 * Stage S (PR-S4 / W3.4) — MiniMax patch profile.
 *
 * Match contract:
 *   - baseUrl contains `api.minimax.chat` or `.minimaxi.com`, OR
 *   - model id starts with `MiniMax-`.
 *
 * Why this exists: when callers ask for `extra_body.reasoning_split=
 * true`, MiniMax returns `reasoning_details` (an array of reasoning
 * spans) on the message. Downstream code expects the LangChain-style
 * `additional_kwargs.reasoning_content` shape — the response patcher
 * normalises one to the other so the rest of the pipeline does not
 * have to special-case the provider.
 */

import type { PatchProfile } from '../types'

export const profileId = 'minimax' as const

export const matchPredicate = (
  _config: any,
  baseUrl: string | null,
  model: string,
): boolean => {
  if (typeof model === 'string' && /^MiniMax-/i.test(model)) return true
  if (!baseUrl) return false
  return (
    baseUrl.includes('api.minimax.chat') ||
    /\.minimaxi\.com/i.test(baseUrl)
  )
}

export const requestPatcher: undefined = undefined

export const responsePatcher = (resp: any, _ctx: any): any => {
  if (!resp || typeof resp !== 'object') return resp
  const choices = (resp as any).choices
  if (!Array.isArray(choices)) return resp
  for (const choice of choices) {
    const message = choice && typeof choice === 'object' ? (choice as any).message : null
    if (!message || typeof message !== 'object') continue
    const reasoningDetails = (message as any).reasoning_details
    if (!Array.isArray(reasoningDetails) || reasoningDetails.length === 0) continue
    const additional = (message as any).additional_kwargs && typeof (message as any).additional_kwargs === 'object'
      ? (message as any).additional_kwargs
      : ((message as any).additional_kwargs = {})
    // Preserve a caller-supplied value; otherwise materialise the
    // mapped reasoning content from `reasoning_details`.
    if (additional.reasoning_content === undefined) {
      additional.reasoning_content = reasoningDetails
        .map((entry: any) => {
          if (typeof entry === 'string') return entry
          if (entry && typeof entry === 'object' && typeof entry.text === 'string') return entry.text
          return ''
        })
        .filter((piece: string) => piece.length > 0)
        .join('\n')
    }
  }
  return resp
}

export const profile: PatchProfile = {
  profileId,
  matchPredicate,
  requestPatcher,
  responsePatcher,
}
