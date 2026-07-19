import { createHash } from 'node:crypto'
import type { PreparedSkillTurnTruth } from '../contracts/browser-workflow-control'
import type { CapabilityFloors } from '../domain-adapters/capability-floors'
import type { ResolvedSkillSurfaceComposition } from './skill-surface-composition'
import {
  buildExplicitNoSkillAuthorization,
  buildSelectedSkillToolAuthorization,
  type SkillToolAuthorization,
} from './skill-tool-authorization'
import type { SkillTurnIdentity } from './skill-turn-identity'

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort()
}

export function preparedSkillDigest(value: unknown): string {
  const raw = JSON.stringify(value)
  if (typeof raw !== 'string') throw new Error('prepared_skill_value_not_serializable')
  return createHash('sha256').update(raw).digest('hex')
}

export function buildPreparedSkillTurnTruth(input: {
  identity: SkillTurnIdentity
  authorization: SkillToolAuthorization
  requestOrResourceAnchorDigest: string
  floors: CapabilityFloors
  surface: ResolvedSkillSurfaceComposition
}): PreparedSkillTurnTruth {
  if (
    input.identity.mode === 'none' !== (input.authorization.mode === 'none')
    || (
      input.identity.mode === 'skill'
      && input.authorization.mode === 'selected'
      && input.identity.skillId !== input.authorization.skillId
    )
  ) {
    throw new Error('prepared_skill_identity_authorization_mismatch')
  }
  const authorizedTypedActions = input.authorization.mode === 'selected'
    ? sortedUnique(input.authorization.allowedTypedActions)
    : []
  const authorizedPrimitives = input.authorization.mode === 'selected'
    ? sortedUnique(input.authorization.allowedPrimitives)
    : []
  const requiredFloorToolNames = sortedUnique(input.floors.toolNames)
  const requiredFloorSources = sortedUnique(input.floors.reasons)
  return {
    version: 1,
    identity: input.identity,
    requestOrResourceAnchorDigest: input.requestOrResourceAnchorDigest,
    authorizedTypedActions,
    authorizedPrimitives,
    authorizationDigest: preparedSkillDigest({
      identity: input.identity,
      authorizedTypedActions,
      authorizedPrimitives,
    }),
    requiredFloorToolNames,
    requiredFloorSources,
    requiredFloorDigest: preparedSkillDigest({ requiredFloorToolNames, requiredFloorSources }),
    surfaceComposition: input.surface.composition,
    exclusiveScopeRef: input.surface.exclusiveScopeRef,
  }
}

export type SavedSkillRevalidation =
  | {
      status: 'ready'
      authorization: SkillToolAuthorization
      effectiveSurface: ResolvedSkillSurfaceComposition
    }
  | {
      status: 'waiting'
      reason:
        | 'prepared_truth_corrupt'
        | 'request_anchor_changed'
        | 'skill_identity_changed'
        | 'skill_authorization_narrowed'
        | 'required_floor_unavailable'
        | 'surface_composition_changed'
      missingToolNames: string[]
    }

/** Build the current legal surface for a saved identity from registry facts
 * only. There is intentionally no user-text, reference-hint, or semantic
 * selection input on this boundary. */
export function resolveCurrentLegalAuthorizationForSavedSkill(input: {
  saved: PreparedSkillTurnTruth
  skillPresent: boolean
  currentActionOwners: ReadonlyMap<string, string>
  currentAllowedPrimitives: ReadonlySet<string>
}): SkillToolAuthorization {
  if (input.saved.identity.mode === 'none') {
    return buildExplicitNoSkillAuthorization(input.saved.identity.reason)
  }
  const skillId = input.saved.identity.skillId
  if (!input.skillPresent) return buildExplicitNoSkillAuthorization('no_skill_signal')
  return buildSelectedSkillToolAuthorization({
    skillId,
    allowedTypedActions: [...input.currentActionOwners.entries()]
      .filter(([, ownerSkillId]) => ownerSkillId === skillId)
      .map(([toolName]) => toolName),
    allowedPrimitives: input.currentAllowedPrimitives,
    source: 'trusted_resume',
    reason: 'checkpoint_registry_revalidation',
  })
}

/**
 * Pure resume revalidation. It can only keep or remove saved authority; it
 * never adds tools that became legal after the checkpoint was written.
 */
export function revalidateSavedSkillAuthorization(input: {
  saved: PreparedSkillTurnTruth
  currentLegalAuthorization: SkillToolAuthorization
  currentlyAvailableToolNames: ReadonlySet<string>
  currentSurface: ResolvedSkillSurfaceComposition
  requestOrResourceAnchorDigest: string
  ownerTransition?: {
    fromOwnerRunId: string
    toOwnerRunId: string
    receiptClaimed: boolean
  } | null
}): SavedSkillRevalidation {
  const { saved } = input
  const expectedAuthorizationDigest = preparedSkillDigest({
    identity: saved.identity,
    authorizedTypedActions: saved.authorizedTypedActions,
    authorizedPrimitives: saved.authorizedPrimitives,
  })
  const expectedFloorDigest = preparedSkillDigest({
    requiredFloorToolNames: saved.requiredFloorToolNames,
    requiredFloorSources: saved.requiredFloorSources,
  })
  if (
    saved.version !== 1
    || saved.authorizationDigest !== expectedAuthorizationDigest
    || saved.requiredFloorDigest !== expectedFloorDigest
  ) {
    return { status: 'waiting', reason: 'prepared_truth_corrupt', missingToolNames: [] }
  }
  if (saved.requestOrResourceAnchorDigest !== input.requestOrResourceAnchorDigest) {
    return { status: 'waiting', reason: 'request_anchor_changed', missingToolNames: [] }
  }
  let effectiveSurface = input.currentSurface
  const savedScope = saved.exclusiveScopeRef
  const ownerTransitionClosesScope = Boolean(savedScope
    && input.ownerTransition?.receiptClaimed === true
    && input.ownerTransition.fromOwnerRunId === savedScope.ownerRunId
    && input.ownerTransition.toOwnerRunId !== savedScope.ownerRunId)
  if (ownerTransitionClosesScope) {
    effectiveSurface = { composition: 'additive', exclusiveScopeRef: null }
  } else if (
    saved.surfaceComposition !== input.currentSurface.composition
    || JSON.stringify(saved.exclusiveScopeRef) !== JSON.stringify(input.currentSurface.exclusiveScopeRef)
  ) {
    return { status: 'waiting', reason: 'surface_composition_changed', missingToolNames: [] }
  }
  if (saved.identity.mode === 'none') {
    if (input.currentLegalAuthorization.mode !== 'none') {
      // Do not broaden a no-skill checkpoint with a newly available skill.
      return {
        status: 'ready',
        authorization: buildExplicitNoSkillAuthorization(saved.identity.reason),
        effectiveSurface,
      }
    }
    return { status: 'ready', authorization: input.currentLegalAuthorization, effectiveSurface }
  }
  if (
    input.currentLegalAuthorization.mode !== 'selected'
    || input.currentLegalAuthorization.skillId !== saved.identity.skillId
  ) {
    return { status: 'waiting', reason: 'skill_identity_changed', missingToolNames: [] }
  }
  const currentSelectedAuthorization = input.currentLegalAuthorization
  const missingAuthorization = [
    ...saved.authorizedTypedActions.filter((name) => !currentSelectedAuthorization.allowedTypedActions.has(name)),
    ...saved.authorizedPrimitives.filter((name) => !currentSelectedAuthorization.allowedPrimitives.has(name)),
  ]
  if (missingAuthorization.length > 0) {
    return {
      status: 'waiting',
      reason: 'skill_authorization_narrowed',
      missingToolNames: sortedUnique(missingAuthorization),
    }
  }
  const missingFloors = saved.requiredFloorToolNames
    .filter((name) => !input.currentlyAvailableToolNames.has(name))
  if (missingFloors.length > 0) {
    return {
      status: 'waiting',
      reason: 'required_floor_unavailable',
      missingToolNames: sortedUnique(missingFloors),
    }
  }
  return {
    status: 'ready',
    authorization: buildSelectedSkillToolAuthorization({
      skillId: saved.identity.skillId,
      allowedTypedActions: saved.authorizedTypedActions,
      allowedPrimitives: saved.authorizedPrimitives,
      source: currentSelectedAuthorization.source,
      reason: 'checkpoint_revalidated_exact_surface',
    }),
    effectiveSurface,
  }
}
