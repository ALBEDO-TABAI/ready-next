import type {
  CodexActionProjectionVersion,
  CodexActionSurfaceInvalidation,
} from '../../../shared/ipc-contracts/agent-runtime'

export function shouldHydrateCodexActionSurface(input: {
  event: CodexActionSurfaceInvalidation
  currentScopeId: string | null
  currentVersion: CodexActionProjectionVersion | null
}): boolean {
  const { event, currentScopeId, currentVersion } = input
  if (event.scopeId !== currentScopeId) return false
  if (!currentVersion) return true
  if (event.scopeEpoch !== currentVersion.scopeEpoch) {
    return event.scopeEpoch > currentVersion.scopeEpoch
  }
  if (event.aliasGeneration !== currentVersion.headGeneration) {
    return event.aliasGeneration > currentVersion.headGeneration
  }
  return event.actionProjectionSequence > currentVersion.actionProjectionSequence
}
