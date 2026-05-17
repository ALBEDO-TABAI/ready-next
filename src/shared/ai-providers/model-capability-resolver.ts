/**
 * Stage S (PR-S7 / W4.5) — model-level capability resolver.
 *
 * Single, pure helper that materialises the three-layer merge that
 * `resolveAIConfigCapabilities` already performs internally, but at
 * the (provider, modelId) granularity. Callers that only care about
 * "does this model support vision / thinking / long-context?" go
 * through this resolver instead of growing yet another
 * `m === '<some-model-id>'` literal in heuristic helpers.
 *
 * Priority (highest first):
 *   1. model.capabilityOverrides   (per-model, narrowest)
 *   2. provider.capabilityClass    (per-provider, middle)
 *   3. fallback `false`            (conservative)
 *
 * Note: this resolver intentionally does NOT consult user-mode
 * toggles (`visionMode` / `thinkingMode` / `longContextMode`) — those
 * live on `AIModelConfig` and are still applied by
 * `resolveAIConfigCapabilities`. This helper answers the strictly
 * static question "what does the model+provider declaration say?"
 * which is what the legacy `isKnownTextOnlyModel` style branches
 * actually needed.
 */

import type { AIProviderDef } from '../ai-providers'
import type { MultiTurnThinkingPolicy, ProviderCapabilityClass } from './types'

export interface ResolvedModelCapabilities {
  supportsVision: boolean
  supportsThinking: boolean
  supportsLongContext: boolean
  multiTurnThinkingPolicy: MultiTurnThinkingPolicy
}

export function resolveModelCapabilities(
  provider: AIProviderDef,
  modelId: string,
): ResolvedModelCapabilities {
  const providerCap: ProviderCapabilityClass = provider.capabilityClass ?? {}
  const modelDef = provider.models?.find((m) => m.id === modelId)
  const modelCap = modelDef?.capabilityOverrides ?? {}
  return {
    supportsVision: modelCap.supportsVision ?? providerCap.supportsVision ?? false,
    supportsThinking: modelCap.supportsThinking ?? providerCap.supportsThinking ?? false,
    supportsLongContext: modelCap.supportsLongContext ?? providerCap.supportsLongContext ?? false,
    multiTurnThinkingPolicy: modelCap.multiTurnThinkingPolicy ?? providerCap.multiTurnThinkingPolicy ?? 'unknown',
  }
}
