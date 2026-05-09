/**
 * Stage S (PR-S4 / W3.5) — provider-default patcher resolver.
 *
 * The 7 provider sub-modules each export `defaultRequestPatcher` /
 * `defaultResponsePatcher` (currently only `openai-compatible.ts` ships
 * a non-undefined value, but the resolver is forward-compatible). The
 * execution clients call this helper to populate
 * `PatchContext.providerDefaultRequestPatcher /
 * providerDefaultResponsePatcher` so `applyProviderRequestPatch` runs
 * the provider default first and the profile patcher second — see
 * `apply-provider-patch.ts` for the priority contract.
 */

import * as moonshotModule from './moonshot'
import * as anthropicModule from './anthropic'
import * as foxModule from './fox'
import * as openaiModule from './openai'
import * as geminiModule from './gemini'
import * as volcengineModule from './volcengine'
import * as openaiCompatibleModule from './openai-compatible'

type Patcher<TIn> = (input: TIn, ctx: any) => TIn

interface ProviderDefaultPatchers {
  defaultRequestPatcher?: Patcher<any>
  defaultResponsePatcher?: Patcher<any>
}

const REGISTRY: Record<string, ProviderDefaultPatchers> = {
  moonshot: pickPatchers(moonshotModule),
  anthropic: pickPatchers(anthropicModule),
  fox: pickPatchers(foxModule),
  openai: pickPatchers(openaiModule),
  gemini: pickPatchers(geminiModule),
  volcengine: pickPatchers(volcengineModule),
  'openai-compatible': pickPatchers(openaiCompatibleModule),
}

function pickPatchers(mod: Record<string, unknown>): ProviderDefaultPatchers {
  const out: ProviderDefaultPatchers = {}
  if (typeof (mod as any).defaultRequestPatcher === 'function') {
    out.defaultRequestPatcher = (mod as any).defaultRequestPatcher
  }
  if (typeof (mod as any).defaultResponsePatcher === 'function') {
    out.defaultResponsePatcher = (mod as any).defaultResponsePatcher
  }
  return out
}

export function resolveProviderDefaultPatchers(
  providerId: string | null | undefined,
): ProviderDefaultPatchers {
  if (!providerId) return {}
  return REGISTRY[providerId] || {}
}
