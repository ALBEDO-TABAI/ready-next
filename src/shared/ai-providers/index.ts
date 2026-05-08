/**
 * Stage S (PR-S3) — sub-module barrel.
 *
 * Re-exports each provider sub-module under a namespace alias so
 * call-sites can do `import { moonshot } from '@/shared/ai-providers'`
 * and reach `moonshot.def` / `moonshot.capabilityClass` / etc.
 */

export * as moonshot from './moonshot'
export * as anthropic from './anthropic'
export * as fox from './fox'
export * as openai from './openai'
export * as gemini from './gemini'
export * as volcengine from './volcengine'
export * as openaiCompatible from './openai-compatible'

export {
  applyProviderRequestPatch,
  applyProviderResponsePatch,
} from './apply-provider-patch'
export type { PatchContext } from './apply-provider-patch'

export { resolveProviderPatchProfile } from './resolve-provider-patch-profile'

export type { ProviderCapabilityClass, PatchProfile } from './types'
