/**
 * Stage 4 W1 — frozen read snapshot consumed by `resolveSkillTurnIdentity`.
 *
 * Per v6 plan §4 W1, the resolver MUST be pure-read. To guarantee that, its
 * only input is this snapshot type — every field is a frozen value, not a
 * function. The resolver cannot accidentally trigger a TTL bump, an expired
 * entry deletion, or a remembered-context write because the snapshot has
 * already finished collecting before the resolver runs.
 *
 * The collector itself runs in turn-engine right before the legacy A-F
 * skill rearm sections (turn-engine.ts:1340-1626). It accepts ONE TTL bump
 * on `getCurrentReferenceSkillHint` per turn, matching the worst-case
 * legacy path (D at turn-engine.ts:1492). On turns where legacy would not
 * have read the hint at all, shadow over-bumps by 1 — accepted per v6
 * plan §1 (TTL window is 30 min, the bump is bounded and observable).
 */

import type {
  ActiveSkillContext,
  ResolveActiveSkillContextInputs,
} from '../active-skill-context'
import { resolveActiveSkillContextReadOnly } from '../active-skill-context'
import type { SkillTaskSupervisorSnapshot } from './skill-task-supervisor'
import type { SkillRunRecord } from '../session-continuity'
import type { ContinuationState } from '../continuation-state'
import type { ExplicitRunStateResourceCandidate } from '../run-state-resource-resolver'

/** Mirrors the private alias in turn-engine.ts (line 791). */
export type RecentSkillRunForResume = SkillRunRecord

/** Read API for the snapshot collector — orchestrator-style. */
export interface SkillContextOrchestratorReadApi {
  findExplicitlyRequestedSkills(
    text: string,
  ): ReadonlyArray<{ skillId?: string; id?: string; name?: string }>
  getCurrentReferenceSkillHint?(
    sessionId?: string,
  ): { id: string; name: string } | null
  buildPreferredSkillToolNames?(
    text: string,
    sessionId?: string,
  ): string[] | null
  // Stage Q (Stage 11) — `hasActiveSkillExecution?` removed from interface.
}

/**
 * Reference hint snapshot. The collector calls
 * `getCurrentReferenceSkillHint` at most once per turn and freezes the
 * result here. The resolver must NOT call the orchestrator again.
 */
export type ReferenceHintSnapshot =
  | { id: string; name: string }
  | null

/**
 * Frozen identity-resolver inputs for one turn. All fields are values, not
 * callbacks — guarantees the resolver cannot reach back into mutable state.
 */
export interface SkillTurnIdentitySnapshot {
  // Already-computed turn-engine locals.
  readonly request: { readonly sessionId?: string; readonly primaryInstruction: string; readonly pureUserText: string }
  readonly contextualUserInput: string
  readonly currentTurnResumeText: string
  readonly explicitRunStateResourceForTurn: ExplicitRunStateResourceCandidate | null
  readonly providedContinuationState: ContinuationState | null
  readonly isSkillResumeTurnDetected: boolean
  readonly isSkillRestartTurnDetected: boolean
  readonly isConfigRepairTurnDetected: boolean
  readonly previousAssistantSkillToolUses: ReadonlyArray<string>
  readonly firstSkillMatch: { readonly text: string; readonly skills: ReadonlyArray<{ skillId?: string; id?: string; name?: string }> } | null
  readonly firstExplicitSkillId: string | null
  readonly runStateResourceVia: 'resource' | 'resource_history' | null

  // Frozen reads from the orchestrator + read-only context resolvers.
  readonly explicitlyRequestedSkillsBySkillIdProbe: ReadonlyArray<{ skillId?: string; id?: string; name?: string }>
  readonly referenceHintSnapshot: ReferenceHintSnapshot
  // Stage Q (Stage 11) — `hasActiveSkillExecutionSnapshot` removed.
  readonly activeSkillContextSnapshot: Readonly<ActiveSkillContext> | null
  readonly hasStrongActiveSkillContext: boolean
  readonly latestSkillRunSnapshot: Readonly<RecentSkillRunForResume> | null
  readonly supervisorSnapshot: Readonly<SkillTaskSupervisorSnapshot> | null
  readonly resumeCandidatesSnapshot: ReadonlyArray<RecentSkillRunForResume>
}

/** Collector dependency surface — turn-engine wires real implementations. */
export interface CollectIdentityReadSnapshotDeps {
  request: { sessionId?: string; primaryInstruction: string; pureUserText: string }
  contextualUserInput: string
  currentTurnResumeText: string
  explicitRunStateResourceForTurn: ExplicitRunStateResourceCandidate | null
  providedContinuationState: ContinuationState | null
  isSkillResumeTurnDetected: boolean
  isSkillRestartTurnDetected?: boolean
  isConfigRepairTurnDetected: boolean
  previousAssistantSkillToolUses: ReadonlyArray<string>
  firstSkillMatch: { text: string; skills: ReadonlyArray<{ skillId?: string; id?: string; name?: string }> } | null
  firstExplicitSkillId: string | null
  runStateResourceVia: 'resource' | 'resource_history' | null

  skillContextOrchestrator: SkillContextOrchestratorReadApi
  inspectLatestSkillTask?: (params: { sessionId?: string; scopeId?: string }) => SkillTaskSupervisorSnapshot | null
  resolveRecentSkillRun?: (sessionId: string | undefined) => RecentSkillRunForResume | null
  resolveRecentSkillTaskRun?: (sessionId: string | undefined) => RecentSkillRunForResume | null
  getLatestSkillRun?: (sessionId: string | undefined) => RecentSkillRunForResume | null
}

/**
 * Run all reads exactly once and return a frozen snapshot.
 *
 * Critical zero-behavior-drift invariant (v6 plan §4 W1, "0 行为变更"):
 * the snapshot collector MUST NOT trigger reads that legacy A-F would not
 * have made for the same turn. Legacy gates `inspectLatestSkillTask`,
 * `getLatestSkillRun`, `resolveRecentSkillRun`, `resolveRecentSkillTaskRun`,
 * and `resolveActiveSkillContext` on `eligibleForRearm` (= no explicit
 * mention AND no provided continuation AND `isSkillResumeTurnDetected`).
 * Outside that gate (e.g. unrelated browser turns), legacy never asks the
 * supervisor / continuity / task-run sources. Shadow must follow suit.
 *
 * `getCurrentReferenceSkillHint` is the only orchestrator read called in
 * every turn — it bumps TTL once per turn, matching worst-case legacy
 * Point D. v6 修订表 #5 forbids double-calling it.
 */
export function collectIdentityReadSnapshot(
  deps: CollectIdentityReadSnapshotDeps,
): SkillTurnIdentitySnapshot {
  const sessionId = deps.request.sessionId

  // v6 修订表 #5 — read once, freeze copy. Avoid double-call.
  const hint = deps.skillContextOrchestrator.getCurrentReferenceSkillHint?.(sessionId)
  const referenceHintSnapshot: ReferenceHintSnapshot = hint
    ? Object.freeze({ id: hint.id, name: hint.name })
    : null

  // Mirror legacy `eligibleForRearm` (turn-engine.ts:1475/1491/1515 share guard).
  // Outside this gate, legacy A-F never reads supervisor/continuity/active-context.
  // Shadow MUST NOT add reads legacy didn't make — failing this drifts behavior.
  const hasExplicitMention = Boolean(deps.firstSkillMatch && deps.firstExplicitSkillId)
  const eligibleForExtraReads = Boolean(
    !hasExplicitMention
    && !deps.providedContinuationState
    && (deps.isSkillResumeTurnDetected || deps.isSkillRestartTurnDetected),
  )

  // Mirror legacy `hasStrongActiveSkillContext()` (turn-engine.ts:1430-1445)
  // which wraps the supervisor read in try/catch and treats throws as "no
  // strong context". Without this catch, a flaky supervisor would change the
  // observable outcome of the turn (legacy keeps going; shadow would crash).
  let supervisorFrozen: Readonly<SkillTaskSupervisorSnapshot> | null = null
  if (eligibleForExtraReads && deps.inspectLatestSkillTask) {
    try {
      const raw = deps.inspectLatestSkillTask({ sessionId, scopeId: sessionId })
      if (raw) {
        supervisorFrozen = Object.freeze(raw) as Readonly<SkillTaskSupervisorSnapshot>
      }
    } catch {
      supervisorFrozen = null
    }
  }

  // Pure-read active context (no expired-entry deletion, no TTL bump). Only
  // resolved when legacy would have called `resolveActiveSkillContext`.
  let activeSkillContextSnapshot: Readonly<ActiveSkillContext> | null = null
  if (eligibleForExtraReads) {
    const readOnlyInputs: ResolveActiveSkillContextInputs = {
      sessionId,
      supervisorSnapshot: supervisorFrozen,
      referenceHint: referenceHintSnapshot ? { ...referenceHintSnapshot, at: 0 } : null,
      inspectSupervisor: false,
    }
    try {
      const activeContext = resolveActiveSkillContextReadOnly(readOnlyInputs)
      activeSkillContextSnapshot = activeContext
        ? (Object.freeze({ ...activeContext }) as Readonly<ActiveSkillContext>)
        : null
    } catch {
      activeSkillContextSnapshot = null
    }
  }

  // Mirror legacy `hasStrongActiveSkillContext()` predicate (turn-engine.ts:1429-1446)
  // — pure read derived from the snapshot.
  const hasStrongActiveSkillContext = Boolean(
    activeSkillContextSnapshot
    && activeSkillContextSnapshot.source !== 'reference_hint',
  )

  const continuitySkillRun = eligibleForExtraReads ? (deps.getLatestSkillRun?.(sessionId) || null) : null
  const projectionSkillRun = eligibleForExtraReads ? (deps.resolveRecentSkillRun?.(sessionId) || null) : null
  const taskRunSkillRun = eligibleForExtraReads ? (deps.resolveRecentSkillTaskRun?.(sessionId) || null) : null

  const candidates: RecentSkillRunForResume[] = [
    projectionSkillRun,
    taskRunSkillRun,
    continuitySkillRun,
  ].filter((entry): entry is RecentSkillRunForResume => Boolean(entry))

  // Probe so resolver can recover skill name from skill_id (mirrors legacy
  // line 1556 `findExplicitlyRequestedSkills('skill ' + latestSkillRun.skillId)`).
  // Only fires when legacy would have probed (i.e. inside the eligible gate AND
  // a candidate exists). `findExplicitlyRequestedSkills` is pure-read but we
  // still avoid calling it where legacy wouldn't, to keep instrumented call
  // counts identical.
  const explicitlyRequestedSkillsBySkillIdProbe = !eligibleForExtraReads
    ? []
    : continuitySkillRun?.skillId
      ? deps.skillContextOrchestrator.findExplicitlyRequestedSkills(`skill ${continuitySkillRun.skillId}`)
      : projectionSkillRun?.skillId
        ? deps.skillContextOrchestrator.findExplicitlyRequestedSkills(`skill ${projectionSkillRun.skillId}`)
        : taskRunSkillRun?.skillId
          ? deps.skillContextOrchestrator.findExplicitlyRequestedSkills(`skill ${taskRunSkillRun.skillId}`)
          : []

  return Object.freeze({
    request: Object.freeze({
      sessionId: deps.request.sessionId,
      primaryInstruction: deps.request.primaryInstruction,
      pureUserText: deps.request.pureUserText,
    }),
    contextualUserInput: deps.contextualUserInput,
    currentTurnResumeText: deps.currentTurnResumeText,
    explicitRunStateResourceForTurn: deps.explicitRunStateResourceForTurn,
    providedContinuationState: deps.providedContinuationState,
    isSkillResumeTurnDetected: deps.isSkillResumeTurnDetected,
    isSkillRestartTurnDetected: Boolean(deps.isSkillRestartTurnDetected),
    isConfigRepairTurnDetected: deps.isConfigRepairTurnDetected,
    previousAssistantSkillToolUses: Object.freeze([...deps.previousAssistantSkillToolUses]),
    firstSkillMatch: deps.firstSkillMatch
      ? Object.freeze({
        text: deps.firstSkillMatch.text,
        skills: Object.freeze([...deps.firstSkillMatch.skills]),
      })
      : null,
    firstExplicitSkillId: deps.firstExplicitSkillId,
    runStateResourceVia: deps.runStateResourceVia,

    explicitlyRequestedSkillsBySkillIdProbe: Object.freeze([...explicitlyRequestedSkillsBySkillIdProbe]),
    referenceHintSnapshot,
    activeSkillContextSnapshot,
    hasStrongActiveSkillContext,
    latestSkillRunSnapshot: continuitySkillRun ? Object.freeze({ ...continuitySkillRun }) : null,
    supervisorSnapshot: supervisorFrozen,
    resumeCandidatesSnapshot: Object.freeze(candidates),
  }) as SkillTurnIdentitySnapshot
}
