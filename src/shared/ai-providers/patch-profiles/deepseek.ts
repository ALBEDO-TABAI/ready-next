/**
 * Stage S (PR-S3) — DeepSeek patch profile (stub).
 *
 * PR-S4 will implement multi-turn `reasoning_content` mapping that
 * keeps DeepSeek's reasoning trace separate from the final answer
 * across turns.
 */

import type { PatchProfile } from '../types'

export const profileId = 'deepseek' as const

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
