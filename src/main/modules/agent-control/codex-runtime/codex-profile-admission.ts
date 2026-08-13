import type { AIModelConfig } from '../../../../shared/ai-providers'
import {
  assertAIWorkspaceAdmissionAllowed,
  type AppSettingsRepository,
} from '../../repositories/app-settings-repository'
import { createCodexUpstreamProfileSnapshot } from './codex-model-gateway-contract'
import { READY_GATEWAY_MAX_CONTROLLED_RETRIES } from './codex-model-gateway-retry'

export function createCodexProfileRouteSnapshot(input: {
  profileId: string
  config: AIModelConfig
}): ReturnType<typeof createCodexUpstreamProfileSnapshot> {
  return createCodexUpstreamProfileSnapshot({
    ...input,
    maxRetries: READY_GATEWAY_MAX_CONTROLLED_RETRIES,
  })
}

export function assertCodexProfileRouteCurrent(input: {
  settings: Pick<AppSettingsRepository, 'getAIWorkspace'>
  expected: ReturnType<typeof createCodexUpstreamProfileSnapshot>
}): void {
  assertAIWorkspaceAdmissionAllowed()
  const profileId = input.expected.snapshot.profileId
  const currentProfile = input.settings.getAIWorkspace().profiles.find(
    (candidate) => candidate.id === profileId,
  )
  if (!currentProfile) throw new Error('codex_upstream_profile_changed_before_admission')
  let current: ReturnType<typeof createCodexUpstreamProfileSnapshot>
  try {
    current = createCodexProfileRouteSnapshot({
      profileId,
      config: currentProfile.config,
    })
  } catch {
    throw new Error('codex_upstream_profile_changed_before_admission')
  }
  if (
    current.snapshotRef !== input.expected.snapshotRef
    || current.snapshotDigest !== input.expected.snapshotDigest
  ) throw new Error('codex_upstream_profile_changed_before_admission')
}
