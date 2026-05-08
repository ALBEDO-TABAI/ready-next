/**
 * Stage S (PR-S3) — MiniMax patch profile (stub).
 *
 * PR-S4 will implement reasoning split mapping (separating
 * `reasoning` payloads from the visible answer text) for MiniMax
 * thinking-mode endpoints.
 */

import type { PatchProfile } from '../types'

export const profileId = 'minimax' as const

export const matchPredicate = (
  _config: any,
  _baseUrl: string | null,
  _model: string,
): boolean => false

export const requestPatcher: undefined = undefined
export const responsePatcher: undefined = undefined

export const profile: PatchProfile = {
  profileId,
  matchPredicate,
  requestPatcher,
  responsePatcher,
}
