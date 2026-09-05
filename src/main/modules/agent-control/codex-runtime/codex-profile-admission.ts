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

/**
 * The current profile route no longer matches the one frozen during prepare.
 * This is a configuration change observed before any durable write, not a
 * persistence fault, so admission maps it to a named zero-write rejection that
 * asks the caller to re-read the action surface.
 */
export class CodexProfileRouteChangedError extends Error {
  readonly code = 'codex_upstream_profile_changed_before_admission'
  constructor() {
    super('codex_upstream_profile_changed_before_admission')
    this.name = 'CodexProfileRouteChangedError'
  }
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
  if (!currentProfile) throw new CodexProfileRouteChangedError()
  let current: ReturnType<typeof createCodexUpstreamProfileSnapshot>
  try {
    current = createCodexProfileRouteSnapshot({
      profileId,
      config: currentProfile.config,
    })
  } catch {
    throw new CodexProfileRouteChangedError()
  }
  if (
    current.snapshotRef !== input.expected.snapshotRef
    || current.snapshotDigest !== input.expected.snapshotDigest
  ) throw new CodexProfileRouteChangedError()
}
