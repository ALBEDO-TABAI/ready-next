/**
 * Stage S (PR-S3) — provider patch profile resolver.
 *
 * Iterates the registered profiles in order and returns the first
 * one whose `matchPredicate` says yes. Stage S only ships stub
 * predicates (all return `false`); PR-S4 wires real matchers and
 * patchers.
 */

import type { AIModelConfig } from '../ai-providers'
import type { PatchProfile } from './types'
import { profile as geminiOAIProfile } from './patch-profiles/gemini-oai'
import { profile as deepseekProfile } from './patch-profiles/deepseek'
import { profile as minimaxProfile } from './patch-profiles/minimax'
import { profile as vllmProfile } from './patch-profiles/vllm'

const PROFILES: PatchProfile[] = [
  geminiOAIProfile,
  deepseekProfile,
  minimaxProfile,
  vllmProfile,
]

export function resolveProviderPatchProfile(
  config: AIModelConfig | null,
  baseUrl: string | null,
  model: string,
): PatchProfile | null {
  for (const profile of PROFILES) {
    if (profile.matchPredicate(config, baseUrl, model)) return profile
  }
  return null
}

export { PROFILES as REGISTERED_PATCH_PROFILES }
