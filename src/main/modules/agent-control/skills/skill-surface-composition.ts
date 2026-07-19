import type { ExclusiveScopeRef, SkillSurfaceComposition } from '../../../../shared/browser-workflow-control'
import { getSkillsRuntimeManager } from '../../skills-runtime/runtime-manager'
import type { SkillToolAuthorization } from './skill-tool-authorization'

export interface ResolvedSkillSurfaceComposition {
  composition: SkillSurfaceComposition
  exclusiveScopeRef: ExclusiveScopeRef | null
}

export function resolveSkillSurfaceComposition(
  authorization: SkillToolAuthorization,
  ownerRunId: string,
): ResolvedSkillSurfaceComposition {
  if (authorization.mode !== 'selected') {
    return { composition: 'additive', exclusiveScopeRef: null }
  }
  const skill = getSkillsRuntimeManager().listSkills()
    .find((candidate) => candidate.id === authorization.skillId)
  if (skill?.capabilitySurface?.composition !== 'exclusive') {
    return { composition: 'additive', exclusiveScopeRef: null }
  }
  return {
    composition: 'exclusive',
    exclusiveScopeRef: { kind: 'owner', ownerRunId },
  }
}
