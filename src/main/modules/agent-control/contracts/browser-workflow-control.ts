export type {
  DurableRequestAnchor,
  ExclusiveScopeRef,
  GoalMutationReceipt,
  HumanTakeoverRef,
  BrowserPermissionSuspensionRequest,
  ParentSteeringReceipt,
  SkillSurfaceComposition,
} from '../../../../shared/browser-workflow-control'

import type { SkillTurnIdentity } from '../skills/skill-turn-identity'
import type {
  ExclusiveScopeRef,
  SkillSurfaceComposition,
} from '../../../../shared/browser-workflow-control'

export interface PreparedSkillTurnTruth {
  version: 1
  identity: SkillTurnIdentity
  requestOrResourceAnchorDigest: string
  authorizedTypedActions: string[]
  authorizedPrimitives: string[]
  authorizationDigest: string
  requiredFloorToolNames: string[]
  requiredFloorSources: string[]
  requiredFloorDigest: string
  surfaceComposition: SkillSurfaceComposition
  exclusiveScopeRef: ExclusiveScopeRef | null
}
