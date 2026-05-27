/**
 * Stage S (PR-S3) — sub-module local types.
 *
 * `ProviderCapabilityClass` mirrors the canonical shape of
 * `AIProviderDef.capabilityClass` (see `../ai-providers.ts`); kept
 * separately here so each sub-module can declare its capability class
 * without circular-importing the umbrella file.
 *
 * `PatchProfile` is the runtime-pluggable adapter shape resolved by
 * `resolveProviderPatchProfile`. Stage S only ships placeholder stubs;
 * PR-S4 wires real patchers.
 */

export type MultiTurnThinkingPolicy =
  | 'proven_safe'
  | 'echo_required'
  | 'unsupported'
  | 'unknown'

export interface ProviderCapabilityClass {
  supportsVision?: boolean
  supportsNativeVideo?: boolean
  supportsThinking?: boolean
  supportsLongContext?: boolean
  multiTurnThinkingPolicy?: MultiTurnThinkingPolicy
}

export interface PatchProfile {
  profileId: string
  matchPredicate: (config: any, baseUrl: string | null, model: string) => boolean
  requestPatcher?: (body: any, ctx: any) => any
  responsePatcher?: (resp: any, ctx: any) => any
}
