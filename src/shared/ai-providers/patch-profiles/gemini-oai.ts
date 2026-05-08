/**
 * Stage S (PR-S3) — Gemini OpenAI-compatible patch profile (stub).
 *
 * PR-S4 will:
 *  - implement `matchPredicate`: baseUrl matches
 *    `generativelanguage.googleapis.com` / `vertex` / `aiplatform`,
 *    or model id matches `gemini-*`.
 *  - implement `requestPatcher` / `responsePatcher` to preserve
 *    `thought_signature` round-trips for thinking models.
 */

import type { PatchProfile } from '../types'

export const profileId = 'gemini-oai' as const

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
