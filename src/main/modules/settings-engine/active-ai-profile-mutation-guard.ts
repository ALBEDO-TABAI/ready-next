import type { AIProviderWorkspace } from '../../../shared/ai-providers'
import { createCodexProfileRouteSnapshot } from '../agent-control/codex-runtime/codex-profile-admission'

export type ActiveAIProfileUsage = {
  profileId: string
  snapshotDigest: string
}

function profileSnapshotDigest(
  workspace: AIProviderWorkspace,
  profileId: string,
): string | null {
  const profile = workspace.profiles.find((candidate) => candidate.id === profileId)
  if (!profile) return null
  try {
    return createCodexProfileRouteSnapshot({
      profileId,
      config: profile.config,
    }).snapshotDigest
  } catch {
    return null
  }
}

export class ActiveAIProfileMutationGuard {
  constructor(private readonly readActiveProfileUsages: () => readonly ActiveAIProfileUsage[]) {}

  assertWorkspaceMutationAllowed(
    _current: AIProviderWorkspace,
    next: AIProviderWorkspace,
  ): void {
    for (const usage of this.readActiveProfileUsages()) {
      if (profileSnapshotDigest(next, usage.profileId) !== usage.snapshotDigest) {
        throw new Error('ai_profile_in_use_by_active_turn')
      }
    }
  }

  assertProfileMutationAllowed(profileId: string): void {
    if (this.readActiveProfileUsages().some((usage) => usage.profileId === profileId)) {
      throw new Error('ai_profile_in_use_by_active_turn')
    }
  }
}
