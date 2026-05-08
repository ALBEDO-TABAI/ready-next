/**
 * Stage S (PR-S3) — vLLM patch profile (stub).
 *
 * PR-S4 will implement vLLM-specific request shaping:
 *  - force `stream_options.include_usage = true` (covered by the
 *    stream_usage gate);
 *  - excludes the official providers (`api.openai.com`, etc.) per
 *    `scripts/check-vllm-excludes-official-providers.cjs`.
 */

import type { PatchProfile } from '../types'

export const profileId = 'vllm' as const

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
