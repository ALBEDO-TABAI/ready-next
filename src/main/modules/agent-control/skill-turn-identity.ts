/**
 * Stage 4 W1 — pure-read SkillTurnIdentity resolver.
 *
 * Single source of truth for "what skill (if any) does this turn want to
 * use, and why". Replaces the 6 parallel rearm decision points in
 * turn-engine.ts:1340-1626 (Points A-F per v6 plan §9). W1 commit only
 * runs this in shadow mode — legacy A-F segments still mutate state and
 * decide observable behavior. W2 deletes the shadow comparison and lets
 * `applySkillTurnIdentity(identity, ctx)` (added in W2 same file) drive
 * mutation.
 *
 * IMPORTANT — pure-read invariant. The CI gate
 * `scripts/check-identity-resolver-pure-read.cjs` enforces that this file
 * MUST NOT import any of:
 *
 *   - rememberLastReferenceSkill / clearLastReferenceSkill /
 *     getLastReferenceSkill / peekLastReferenceSkill (the resolver uses
 *     `snapshot.referenceHintSnapshot`, never the live API)
 *   - rememberActiveSkillContext / clearActiveSkillContext /
 *     resolveActiveSkillContext (the resolver uses
 *     `snapshot.activeSkillContextSnapshot`, never live resolution)
 *   - inspectLatestSkillTask (the resolver uses `snapshot.supervisorSnapshot`)
 *   - getLatestSkillRun / resolveSkillRunForResume (snapshot has
 *     `latestSkillRunSnapshot` and `resumeCandidatesSnapshot`)
 *
 * If you need a new read in the resolver, add it to the snapshot collector
 * (`skill-turn-identity-snapshot.ts`) — never import a runtime read here.
 */

import type {
  RecentSkillRunForResume,
  SkillTurnIdentitySnapshot,
} from './skill-turn-identity-snapshot'

export type SkillTurnIdentityRelation = 'new' | 'resume' | 'observe' | 'repair' | 'cancel'

export type SkillTurnIdentityConfidence =
  | 'explicit'
  | 'trusted_handle'
  | 'active_task'
  | 'history'
  | 'hint'

export type SkillTurnIdentitySource =
  | 'explicit_user_mention'
  | 'run_state_resource'
  | 'prior_tool_use_lookback'
  | 'reference_hint'
  | 'skill_history'
  | 'config_repair_no_recoverable_task'
  | 'no_skill_signal'

export type SkillTurnIdentity =
  | {
      mode: 'none'
      reason: 'no_skill_signal' | 'config_repair_no_recoverable_task' | 'turn_not_skill_resume'
    }
  | {
      mode: 'skill'
      relation: SkillTurnIdentityRelation
      skillId: string
      skillName: string
      confidence: SkillTurnIdentityConfidence
      source: SkillTurnIdentitySource
      resumeHandle?: {
        taskId?: string | null
        childRunId?: string | null
        taskRunId?: string | null
        outputDir?: string | null
        runStatePath?: string | null
      }
      /**
       * Carried through to legacy `skillContextInjectionText` so downstream
       * skill detection (`findExplicitlyRequestedSkills`,
       * `buildPreferredSkillToolNames`, `maybeInjectExplicitSkillContext`)
       * keeps the same input shape. NOT a model-facing reminder string;
       * see v6 plan §1 修订表.
       */
      contextText: string
    }

/**
 * Pure logic. Determines identity from a frozen snapshot. No side effects.
 */
export function resolveSkillTurnIdentity(snapshot: SkillTurnIdentitySnapshot): SkillTurnIdentity {
  const {
    firstSkillMatch,
    firstExplicitSkillId,
    contextualUserInput,
    explicitRunStateResourceForTurn,
    runStateResourceVia,
    providedContinuationState,
    isSkillResumeTurnDetected,
    isConfigRepairTurnDetected,
    previousAssistantSkillToolUses,
    referenceHintSnapshot,
    hasStrongActiveSkillContext,
    latestSkillRunSnapshot,
    explicitlyRequestedSkillsBySkillIdProbe,
  } = snapshot

  // Mirror legacy line 1346: `let hasExplicitSkill = Boolean(firstSkillMatch)`.
  // We start with the same default the legacy initial state uses; subsequent
  // branches re-shape mode/relation as the rearm fallbacks would.
  const hasExplicitMention = Boolean(firstSkillMatch && firstExplicitSkillId)

  // Point A — explicit user mention (turn-engine.ts:1346-1351 → continues to F).
  if (hasExplicitMention && firstSkillMatch && firstExplicitSkillId) {
    const skillName = String(firstSkillMatch.skills[0]?.name || firstExplicitSkillId)
    const relation: SkillTurnIdentityRelation = providedContinuationState
      ? 'resume'
      : isConfigRepairTurnDetected
        ? 'repair'
        : 'new'
    return {
      mode: 'skill',
      relation,
      skillId: firstExplicitSkillId,
      skillName,
      confidence: 'explicit',
      source: 'explicit_user_mention',
      contextText: firstSkillMatch.text,
    }
  }

  // Point B — run_state resource rearm (turn-engine.ts:1454-1474).
  if (
    explicitRunStateResourceForTurn
    && !providedContinuationState
    && isSkillResumeTurnDetected
  ) {
    const skillId = explicitRunStateResourceForTurn.skillId
    const skillName = explicitRunStateResourceForTurn.skillName || skillId
    return {
      mode: 'skill',
      relation: 'resume',
      skillId,
      skillName,
      confidence: 'trusted_handle',
      source: 'run_state_resource',
      resumeHandle: {
        outputDir: explicitRunStateResourceForTurn.outputDir ?? null,
        runStatePath: explicitRunStateResourceForTurn.runStatePath ?? null,
      },
      contextText: `用户希望继续使用 skill "${skillName}"`,
    }
  }

  // Guards shared by Points C, D, E (turn-engine.ts:1475/1491/1515).
  const eligibleForRearm =
    !hasExplicitMention
    && !providedContinuationState
    && isSkillResumeTurnDetected

  // Point C — prior tool use lookback (turn-engine.ts:1475-1490).
  // Mirrors legacy guard: `previousAssistantSkillToolUses.length > 0 && !hasStrongActiveSkillContext()`
  // Note: legacy calls `rememberReferenceSkillFromPriorToolUses` (mutator)
  // which can armSkillId / armSkillName. Pure resolver cannot call it; W2's
  // applySkillTurnIdentity will. Resolver instead reports `confidence:'history'`
  // with the most recent skill_* tool name's skillId as best-effort signal.
  // The legacy mutator's return value is opaque from outside, so we can only
  // approximate; the precise shape will be reconciled in W2.
  if (
    eligibleForRearm
    && !isConfigRepairTurnDetected
    && previousAssistantSkillToolUses.length > 0
  ) {
    const inferred = inferSkillFromToolNames(previousAssistantSkillToolUses)
    if (inferred) {
      return {
        mode: 'skill',
        relation: 'resume',
        skillId: inferred.skillId,
        skillName: inferred.skillName,
        confidence: 'history',
        source: 'prior_tool_use_lookback',
        contextText: `用户希望继续使用 skill "${inferred.skillName}"`,
      }
    }
  }

  // Point D — current reference hint (turn-engine.ts:1491-1503).
  if (
    eligibleForRearm
    && !isConfigRepairTurnDetected
    && !hasStrongActiveSkillContext
    && referenceHintSnapshot
  ) {
    return {
      mode: 'skill',
      relation: 'resume',
      skillId: referenceHintSnapshot.id,
      skillName: referenceHintSnapshot.name,
      confidence: 'hint',
      source: 'reference_hint',
      contextText: `用户希望继续使用 skill "${referenceHintSnapshot.name}"`,
    }
  }

  // Point E — skill history (turn-engine.ts:1515-1612).
  if (eligibleForRearm) {
    const historicalSkill = pickHistoricalSkillRun(snapshot)
    if (historicalSkill?.skillId) {
      const recovered = explicitlyRequestedSkillsBySkillIdProbe.find(
        (s) => s.id === historicalSkill.skillId || s.skillId === historicalSkill.skillId,
      )
      const skillName = String(recovered?.name || historicalSkill.skillId)
      return {
        mode: 'skill',
        relation: 'resume',
        skillId: historicalSkill.skillId,
        skillName,
        confidence: 'history',
        source: 'skill_history',
        contextText: `用户希望继续使用 skill "${skillName}"`,
      }
    }

    // Config-repair clarification path (turn-engine.ts:1576-1610). When the
    // user submitted a config-repair turn but no recoverable history exists,
    // legacy emits a clarification and finishes the turn early. We surface
    // this state via mode:'none' + reason:'config_repair_no_recoverable_task'
    // so the W2 applier can preserve the legacy `finish(...)` behavior.
    if (isConfigRepairTurnDetected) {
      return {
        mode: 'none',
        reason: 'config_repair_no_recoverable_task',
      }
    }
  }

  // Default — no skill in this turn.
  return {
    mode: 'none',
    reason: isSkillResumeTurnDetected ? 'no_skill_signal' : 'turn_not_skill_resume',
  }
}

/**
 * Best-effort skillId/skillName recovery from a list of `skill_<id>_<action>`
 * tool names. Mirrors legacy `rememberReferenceSkillFromPriorToolUses` shape
 * but pure — it can only see the tool name string, so it derives skillId by
 * pattern. The W2 applier is the canonical source for the actual rearm
 * (it calls the orchestrator's mutating implementation which has access to
 * the full skill registry).
 */
function inferSkillFromToolNames(
  toolNames: ReadonlyArray<string>,
): { skillId: string; skillName: string } | null {
  for (let i = toolNames.length - 1; i >= 0; i -= 1) {
    const name = toolNames[i]
    // skill_<id-with-underscores>_<action>
    const match = /^skill_([a-z0-9][a-z0-9_-]*)_[a-z0-9_]+$/i.exec(name)
    if (!match) continue
    const skillId = match[1]
    return { skillId, skillName: skillId }
  }
  return null
}

function pickHistoricalSkillRun(snapshot: SkillTurnIdentitySnapshot): RecentSkillRunForResume | null {
  // Legacy at turn-engine.ts:1532 uses resolveSkillRunForResume to pick the
  // best candidate. Resolver cannot call that (it's not pure-read in the
  // strictest sense); instead we approximate with snapshot's pre-computed
  // `latestSkillRunSnapshot` (from getLatestSkillRun) which mirrors the
  // continuity branch — the most common historical signal. Active context
  // already provides skillId via `activeSkillContextSnapshot`. Multiple
  // sources are merged: prefer activeSkillContextSnapshot when present.
  if (snapshot.activeSkillContextSnapshot?.skillId) {
    return Object.freeze({
      skillId: snapshot.activeSkillContextSnapshot.skillId,
      action: snapshot.activeSkillContextSnapshot.action || undefined,
    } as RecentSkillRunForResume)
  }
  return snapshot.latestSkillRunSnapshot
}

/**
 * Project a `SkillTurnIdentity` into the legacy turn-engine local fields
 * for the W1 shadow comparator. Used by the shadow-mismatch metric to
 * report mismatches in the same language as the legacy code.
 */
export interface ProjectedLegacyShape {
  hasExplicitSkill: boolean
  lookbackRearmedSkillId: string | null
  referenceSkillHintVia:
    | 'explicit'
    | 'lookback'
    | 'current'
    | 'history'
    | 'resource'
    | 'resource_history'
    | null
}

export function projectIdentityToLegacyShape(
  identity: SkillTurnIdentity,
  runStateResourceVia: 'resource' | 'resource_history' | null,
): ProjectedLegacyShape {
  if (identity.mode === 'none') {
    return { hasExplicitSkill: false, lookbackRearmedSkillId: null, referenceSkillHintVia: null }
  }
  let via: ProjectedLegacyShape['referenceSkillHintVia'] = null
  switch (identity.source) {
    case 'explicit_user_mention':
      via = 'explicit'
      break
    case 'run_state_resource':
      via = runStateResourceVia === 'resource_history' ? 'resource_history' : 'resource'
      break
    case 'prior_tool_use_lookback':
      via = 'lookback'
      break
    case 'reference_hint':
      via = 'current'
      break
    case 'skill_history':
      via = 'history'
      break
    default:
      via = null
  }
  const isLookbackOrigin =
    identity.source === 'run_state_resource'
    || identity.source === 'prior_tool_use_lookback'
    || identity.source === 'reference_hint'
    || identity.source === 'skill_history'
  return {
    hasExplicitSkill: true,
    lookbackRearmedSkillId: isLookbackOrigin ? identity.skillId : null,
    referenceSkillHintVia: via,
  }
}
