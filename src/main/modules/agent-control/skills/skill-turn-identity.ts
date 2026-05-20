/**
 * Stage 4 SkillTurnIdentity — single decision point for "what skill (if
 * any) does this turn want to use, and why" plus the single mutator entry
 * that writes the corresponding state.
 *
 * Two phases:
 *
 *   - `resolveSkillTurnIdentity(snapshot)` (W1) — pure-read decision based
 *     on a frozen `SkillTurnIdentitySnapshot`. The CI gate
 *     `scripts/check-identity-resolver-pure-read.cjs` enforces that this
 *     file MUST NOT import any `remember*` / `clear*` / `getLast*` /
 *     `peek*` mutator or TTL-bumping read.
 *
 *   - `applySkillTurnIdentity(identity, ctx)` (W2) — dispatches on
 *     `identity.source` and calls the corresponding mutator. NO fall-
 *     through cascade between branches: each branch is the only place
 *     the resolver authorized; if its mutator can't persist, we keep the
 *     Point A initial state (matching legacy "rearmed.armed === false →
 *     no override") rather than silently re-trying a different source.
 *
 *     The W1 shadow comparator (`projectIdentityToLegacyShape` +
 *     `shadowMismatch` metric) was removed in W2 because the legacy A-F
 *     cascade is no longer running side-by-side, so mismatch is undefined
 *     post-cutover.
 *
 * The `shouldBindSkillContextForTurn` predicate (turn-engine.ts:~1716)
 * and Point F's `rememberExplicitReferenceSkillHint` stay in turn-engine
 * because they need locals (firstSkillMatch, hasActiveSkill, child cancel
 * intent) that the applier doesn't see.
 */

import type { ActiveSkillContext, ResolveActiveSkillContextInputs } from '../active-skill-context'
import type { ExplicitRunStateResourceCandidate } from '../task-projection/run-state-resource-resolver'
import type { SkillRunRecord } from '../session-continuity'
import type { SkillTaskSupervisorSnapshot } from './skill-task-supervisor'
import type { SkillTurnIdentitySnapshot } from './skill-turn-identity-snapshot'

// =============================================================================
// Public types
// =============================================================================

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

export type ReferenceSkillHintVia =
  | 'explicit'
  | 'lookback'
  | 'current'
  | 'history'
  | 'resource'
  | 'resource_history'

// =============================================================================
// resolveSkillTurnIdentity — pure-read decision over a frozen snapshot
// =============================================================================

/**
 * Pure logic. Determines identity from a frozen snapshot. No side effects.
 *
 * Branch precedence (matches legacy A-F semantics from
 * turn-engine.ts:1342-1626):
 *
 *   1. `run_state_resource` — fires when (a) explicit run_state resource
 *      is present, (b) resume intent detected, (c) no providedContinuationState,
 *      AND (d) either no explicit user mention OR mention matches resource
 *      skillId. This precedes Point A because legacy Point B's
 *      `shouldArmFromResource` re-fired even after Point A had set
 *      hasExplicitSkill, as long as the skill IDs matched.
 *
 *   2. `explicit_user_mention` — fires when user explicitly named a skill
 *      and run_state did not arm above.
 *
 *   3. `prior_tool_use_lookback` — fires for non-config-repair resume
 *      intent with prior assistant skill tool uses and no strong active
 *      context.
 *
 *   4. `reference_hint` — fires for non-config-repair resume intent with
 *      a reference hint and no strong active context.
 *
 *   5. `skill_history` — fires for resume intent with a recoverable skill
 *      run (active context / continuity / projection / supervisor / task
 *      run).
 *
 *   6. config-repair fallback — when (5) returns nothing AND
 *      isConfigRepairTurnDetected, retry (3) → (4) → mode:'none' /
 *      reason:'config_repair_no_recoverable_task'. Mirrors legacy
 *      turn-engine.ts:1614-1647 inner fallback.
 *
 *   7. default — `mode:'none'`.
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
    isSkillRestartTurnDetected,
    isConfigRepairTurnDetected,
    previousAssistantSkillToolUses,
    referenceHintSnapshot,
    hasStrongActiveSkillContext,
    latestSkillRunSnapshot,
    activeSkillContextSnapshot,
    explicitlyRequestedSkillsBySkillIdProbe,
  } = snapshot
  void contextualUserInput
  void runStateResourceVia

  const hasExplicitMention = Boolean(firstSkillMatch && firstExplicitSkillId)

  // Branch 1 — run_state resource (legacy Point B; precedes Point A when
  // resource skillId matches user explicit, per legacy
  // `shouldArmFromResource` rule).
  if (
    explicitRunStateResourceForTurn
    && !providedContinuationState
    && isSkillResumeTurnDetected
  ) {
    const shouldArmFromResource = !hasExplicitMention
      || firstExplicitSkillId === explicitRunStateResourceForTurn.skillId
    if (shouldArmFromResource) {
      const skillId = explicitRunStateResourceForTurn.skillId
      const skillName = String(explicitRunStateResourceForTurn.skillName || skillId)
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
  }

  // Branch 2 — explicit user mention (legacy Point A's residual case
  // when run_state resource didn't arm).
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

  if (!providedContinuationState && isSkillRestartTurnDetected) {
    const historicalSkill = pickHistoricalSkillRun(snapshot)
    if (historicalSkill?.skillId) {
      const recovered = explicitlyRequestedSkillsBySkillIdProbe.find(
        (s) => s.id === historicalSkill.skillId || s.skillId === historicalSkill.skillId,
      )
      const skillName = String(recovered?.name || historicalSkill.skillId)
      return {
        mode: 'skill',
        relation: 'new',
        skillId: historicalSkill.skillId,
        skillName,
        confidence: activeSkillContextSnapshot ? 'active_task' : 'history',
        source: 'skill_history',
        resumeHandle: {
          outputDir: historicalSkill.outputDir ?? null,
          runStatePath: historicalSkill.runStatePath ?? null,
          taskRunId: historicalSkill.taskRunId ?? null,
          childRunId: historicalSkill.childRunId ?? null,
        },
        contextText: `用户希望重新开始使用 skill "${skillName}"`,
      }
    }
  }

  // Common gate for branches 3/4/5 — legacy `eligibleForRearm` predicate.
  const eligibleForRearm = !providedContinuationState && isSkillResumeTurnDetected

  // Branch 3 — prior tool use lookback (legacy Point C, NOT in config-repair).
  if (
    eligibleForRearm
    && !isConfigRepairTurnDetected
    && previousAssistantSkillToolUses.length > 0
    && !hasStrongActiveSkillContext
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

  // Branch 4 — current reference hint (legacy Point D, NOT in config-repair).
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

  // Branch 5 — skill history (legacy Point E).
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
        confidence: activeSkillContextSnapshot ? 'active_task' : 'history',
        source: 'skill_history',
        resumeHandle: {
          outputDir: historicalSkill.outputDir ?? null,
          runStatePath: historicalSkill.runStatePath ?? null,
          taskRunId: historicalSkill.taskRunId ?? null,
          childRunId: historicalSkill.childRunId ?? null,
        },
        contextText: `用户希望继续使用 skill "${skillName}"`,
      }
    }

    // Branch 6 — config-repair inner fallback (legacy
    // turn-engine.ts:1614-1647): try priorToolUses → hint → clarification.
    if (isConfigRepairTurnDetected) {
      if (previousAssistantSkillToolUses.length > 0) {
        const inferred = inferSkillFromToolNames(previousAssistantSkillToolUses)
        if (inferred) {
          return {
            mode: 'skill',
            relation: 'repair',
            skillId: inferred.skillId,
            skillName: inferred.skillName,
            confidence: 'history',
            source: 'prior_tool_use_lookback',
            contextText: `用户希望继续使用 skill "${inferred.skillName}"`,
          }
        }
      }
      if (referenceHintSnapshot) {
        return {
          mode: 'skill',
          relation: 'repair',
          skillId: referenceHintSnapshot.id,
          skillName: referenceHintSnapshot.name,
          confidence: 'hint',
          source: 'reference_hint',
          contextText: `用户希望继续使用 skill "${referenceHintSnapshot.name}"`,
        }
      }
      return { mode: 'none', reason: 'config_repair_no_recoverable_task' }
    }
  }

  return {
    mode: 'none',
    reason: isSkillResumeTurnDetected ? 'no_skill_signal' : 'turn_not_skill_resume',
  }
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Best-effort skillId/skillName recovery from a list of `skill_<id>_<action>`
 * tool names. The W2 applier consults the orchestrator's mutator (which
 * has access to the full skill registry) to recover the proper skill name
 * — this helper is only used by the resolver to pick a branch, with the
 * applier overriding `skillName` on success.
 */
function inferSkillFromToolNames(
  toolNames: ReadonlyArray<string>,
): { skillId: string; skillName: string } | null {
  for (let i = toolNames.length - 1; i >= 0; i -= 1) {
    const name = toolNames[i]
    const match = /^skill_([a-z0-9][a-z0-9_-]*)_[a-z0-9_]+$/i.exec(name)
    if (!match) continue
    const skillId = match[1]
    return { skillId, skillName: skillId }
  }
  return null
}

interface PickedHistoricalSkillRun {
  skillId: string
  outputDir?: string | null
  runStatePath?: string | null
  taskRunId?: string | null
  childRunId?: string | null
  action?: string | null
  summary?: string | null
}

function pickHistoricalSkillRun(snapshot: SkillTurnIdentitySnapshot): PickedHistoricalSkillRun | null {
  // Prefer `activeSkillContextSnapshot` since legacy Point E used the
  // composite `resolveSkillRunForResume` and `activeContextSkillRun` was
  // a primary candidate. Fall back to `latestSkillRunSnapshot` (continuity).
  if (snapshot.activeSkillContextSnapshot?.skillId) {
    const ctx = snapshot.activeSkillContextSnapshot
    return {
      skillId: ctx.skillId,
      outputDir: ctx.outputDir ?? null,
      runStatePath: ctx.runStatePath ?? null,
      taskRunId: ctx.taskRunId ?? null,
      action: ctx.action ?? null,
    }
  }
  if (snapshot.latestSkillRunSnapshot) {
    const run = snapshot.latestSkillRunSnapshot
    return {
      skillId: run.skillId,
      action: run.action ?? null,
      summary: run.summary ?? null,
    }
  }
  return null
}

// =============================================================================
// applySkillTurnIdentity — W2 mutator phase
// =============================================================================
//
// Single function that takes the resolver's identity decision plus a
// context bundle and produces the legacy turn-engine derived locals
// (`hasExplicitSkill`, `skillContextInjectionText`, `lookbackRearmedSkill`,
// `referenceSkillForMetrics`, `referenceSkillHintVia`). This is the ONLY
// place that calls reference-skill / active-context mutators after W2.
//
// Identity-driven dispatch (no fall-through cascade): the applier reads
// `identity.source` and calls exactly the corresponding mutator. If that
// mutator returns `armed: false`, the applier KEEPS Point A's initial
// state — it does NOT silently retry the next legacy branch. This
// matches legacy "rearmed.armed === false → no override" while ensuring
// that what the resolver decided is what the apply phase executes.

export interface ApplySkillTurnIdentityContext {
  // Turn locals already computed by turn-engine before the rearm phase.
  sessionId: string | undefined
  providedContinuationState: unknown
  isSkillResumeTurnDetected: boolean
  isConfigRepairTurnDetected: boolean
  previousAssistantSkillToolUses: ReadonlyArray<string>
  explicitRunStateResourceForTurn: ExplicitRunStateResourceCandidate | null
  runStateResourceVia: 'resource' | 'resource_history' | null
  firstExplicitSkillId: string | null
  contextualUserInput: string
  currentTurnResumeText: string

  // Initial state from Point A (turn-engine.ts:1346-1351).
  initialHasExplicitSkill: boolean
  initialSkillContextInjectionText: string

  // Mutator + read surface — orchestrator-style.
  skillContextOrchestrator: {
    findExplicitlyRequestedSkills(text: string): ReadonlyArray<{
      skillId?: string
      id?: string
      name?: string
    }>
    rememberReferenceSkillFromRunStateResource?(
      skillId: string,
      sessionId?: string,
    ): { armed: boolean; skillId?: string; skillName?: string }
    rememberReferenceSkillFromPriorToolUses?(
      toolNames: ReadonlyArray<string>,
      sessionId?: string,
    ): { armed: boolean; skillId?: string; skillName?: string }
    getCurrentReferenceSkillHint?(
      sessionId?: string,
    ): { id: string; name: string } | null
  }

  // Helpers passed from turn-engine (private file-scope helpers cannot be
  // imported here without circular deps). Real types from the underlying
  // modules — no `unknown` placeholders.
  inspectLatestSkillTaskForHost: (params: {
    sessionId?: string | null
    scopeId?: string | null
    skillId?: string | null
  }) => SkillTaskSupervisorSnapshot
  resolveActiveSkillContext: (
    inputs?: ResolveActiveSkillContextInputs,
  ) => ActiveSkillContext | null
  rememberActiveSkillContext: (
    sessionId: string | null | undefined,
    context: ActiveSkillContext | null,
  ) => void
  getLatestSkillRun: (sessionId: string | undefined) => SkillRunRecord | null
  resolveSkillRunForResume: (params: {
    sessionId?: string
    expectedTaskId?: string | null
    candidates?: Array<SkillRunRecord | null | undefined>
  }) => SkillRunRecord | null
  skillRunFromSupervisorSnapshot: (
    snapshot: SkillTaskSupervisorSnapshot | null | undefined,
  ) => SkillRunRecord | null
  skillRunFromActiveSkillContext: (
    context: ActiveSkillContext | null | undefined,
  ) => SkillRunRecord | null
  isSameSkillRunForResume: (
    left: SkillRunRecord | null | undefined,
    right: SkillRunRecord | null | undefined,
  ) => boolean
  extractTaskIdFromText: (text: string) => string | null
  buildSkillResumeContextPrompt: (params: {
    skillName: string
    skillId: string
    action?: string | null
    summary?: string | null
    userText: string
  }) => string
  resolveRecentSkillRun?: (sessionId: string | undefined) => SkillRunRecord | null
  resolveRecentSkillTaskRun?: (sessionId: string | undefined) => SkillRunRecord | null

  log: (line: string) => void
}

export interface ApplySkillTurnIdentityResult {
  hasExplicitSkill: boolean
  skillContextInjectionText: string
  lookbackRearmedSkill: { skillId?: string; skillName?: string } | null
  referenceSkillForMetrics: { id?: string; name?: string } | null
  referenceSkillHintVia: ReferenceSkillHintVia | null
  /**
   * Legacy Point E inner branch (turn-engine.ts:1576-1610): when a config-
   * repair turn has no recoverable skill task. Turn-engine consumes this
   * flag to emit the clarification text and `finish({success:true,
   * status:'done'})`. Resolver sets identity.mode='none' +
   * reason='config_repair_no_recoverable_task' for the same case but the
   * actual finish is the caller's responsibility.
   */
  shouldFinishWithClarification: boolean
  clarificationText: string | null
}

export function applySkillTurnIdentity(
  identity: SkillTurnIdentity,
  ctx: ApplySkillTurnIdentityContext,
): ApplySkillTurnIdentityResult {
  // Default to Point A's initial state. Each `case` overrides only on
  // mutator success — preserves legacy "rearmed.armed === false → no
  // override" semantics without falling through to other branches.
  const baseResult: ApplySkillTurnIdentityResult = {
    hasExplicitSkill: ctx.initialHasExplicitSkill,
    skillContextInjectionText: ctx.initialSkillContextInjectionText,
    lookbackRearmedSkill: null,
    referenceSkillForMetrics: null,
    referenceSkillHintVia: null,
    shouldFinishWithClarification: false,
    clarificationText: null,
  }

  if (identity.mode === 'none') {
    if (identity.reason === 'config_repair_no_recoverable_task') {
      ctx.log('[skill_detection] No recent skill task is available to resume after config repair turn')
      return {
        ...baseResult,
        shouldFinishWithClarification: true,
        clarificationText: '我看到了你更新配置，但这里没有可恢复的 skill 任务。请告诉我要继续哪一个技能任务。',
      }
    }
    return baseResult
  }

  switch (identity.source) {
    case 'explicit_user_mention': {
      // Point A already populated initial state via firstSkillMatch.text.
      // No mutator call here — Point F (in turn-engine) will register the
      // explicit hint via rememberExplicitReferenceSkillHint.
      return {
        ...baseResult,
        hasExplicitSkill: true,
      }
    }

    case 'run_state_resource': {
      const rearmed = ctx.skillContextOrchestrator.rememberReferenceSkillFromRunStateResource?.(
        identity.skillId,
        ctx.sessionId,
      )
      if (!rearmed?.armed) {
        // Mutator failed to arm — keep initial state (legacy semantics:
        // `rearmed.armed === false` left state at Point A's values).
        return baseResult
      }
      const skillId = rearmed.skillId || identity.skillId
      const skillName = rearmed.skillName || identity.skillName
      ctx.log(
        `[skill_detection] reference_skill_rearmed_from_run_state_resource skillId=${skillId} skillName=${skillName}`,
      )
      return {
        ...baseResult,
        hasExplicitSkill: true,
        skillContextInjectionText: `用户希望继续使用 skill "${skillName}"`,
        lookbackRearmedSkill: { skillId, skillName },
        referenceSkillForMetrics: { id: skillId, name: skillName },
        referenceSkillHintVia:
          ctx.runStateResourceVia === 'resource_history' ? 'resource_history' : 'resource',
      }
    }

    case 'prior_tool_use_lookback': {
      const rearmed = ctx.skillContextOrchestrator.rememberReferenceSkillFromPriorToolUses?.(
        ctx.previousAssistantSkillToolUses,
        ctx.sessionId,
      )
      if (!rearmed?.armed || !rearmed.skillName) {
        return baseResult
      }
      const skillId = rearmed.skillId || identity.skillId
      const skillName = rearmed.skillName
      ctx.log(
        `[skill_detection] reference_skill_rearmed_from_lookback skillId=${skillId} skillName=${skillName}`,
      )
      return {
        ...baseResult,
        hasExplicitSkill: true,
        skillContextInjectionText: `用户希望继续使用 skill "${skillName}"`,
        lookbackRearmedSkill: { skillId, skillName },
        referenceSkillForMetrics: { id: skillId, name: skillName },
        referenceSkillHintVia: 'lookback',
      }
    }

    case 'reference_hint': {
      // No mutator — the hint is already armed in the snapshot. The
      // resolver only picks this branch when `referenceHintSnapshot` is
      // populated, so we trust identity's skillId/skillName.
      const skillId = identity.skillId
      const skillName = identity.skillName
      ctx.log(
        `[skill_detection] reference_skill_rearmed_from_current_hint skillId=${skillId} skillName=${skillName}`,
      )
      return {
        ...baseResult,
        hasExplicitSkill: true,
        skillContextInjectionText: `用户希望继续使用 skill "${skillName}"`,
        lookbackRearmedSkill: { skillId, skillName },
        referenceSkillForMetrics: { id: skillId, name: skillName },
        referenceSkillHintVia: 'current',
      }
    }

    case 'skill_history': {
      // Re-resolve the live skill run record. The resolver picked
      // skill_history because the snapshot contained at least one of
      // (active context | continuity | projection | task run | supervisor),
      // but legacy used the composite `resolveSkillRunForResume` to merge
      // candidates and pick the canonical record. We recompute that here
      // so the prompt builder has the freshest action/summary.
      const continuitySkillRun = ctx.getLatestSkillRun(ctx.sessionId)
      const supervisorSnapshot = ctx.inspectLatestSkillTaskForHost({
        sessionId: ctx.sessionId,
        scopeId: ctx.sessionId,
      })
      const supervisorSkillRun = ctx.skillRunFromSupervisorSnapshot(supervisorSnapshot)
      const activeSkillContext = ctx.resolveActiveSkillContext({
        sessionId: ctx.sessionId,
        supervisorSnapshot,
        inspectSupervisor: false,
      })
      const activeContextSkillRun = ctx.skillRunFromActiveSkillContext(activeSkillContext)
      const projectionSkillRun = ctx.resolveRecentSkillRun?.(ctx.sessionId) || null
      const taskRunSkillRun = ctx.resolveRecentSkillTaskRun?.(ctx.sessionId) || null
      const latestSkillRun = ctx.resolveSkillRunForResume({
        sessionId: ctx.sessionId,
        expectedTaskId: ctx.extractTaskIdFromText(ctx.currentTurnResumeText || ctx.contextualUserInput),
        candidates: [
          supervisorSkillRun,
          activeContextSkillRun,
          taskRunSkillRun,
          projectionSkillRun,
          continuitySkillRun,
        ],
      })

      if (!latestSkillRun?.skillId) {
        // Re-resolve disagreed with snapshot — keep initial state. This
        // is a corner case (snapshot took a stale view). The legacy code
        // would have fallen through to config-repair / clarification but
        // identity already accounted for those cases via the resolver's
        // own snapshot pass; if the live re-fetch is null and config-
        // repair was already considered, just honour the resolver.
        return baseResult
      }

      const latestSkillRunSource = ctx.isSameSkillRunForResume(supervisorSkillRun, latestSkillRun)
        ? 'supervisor'
        : ctx.isSameSkillRunForResume(activeContextSkillRun, latestSkillRun)
          ? activeSkillContext?.source || 'active_context'
          : ctx.isSameSkillRunForResume(continuitySkillRun, latestSkillRun)
            ? 'session_continuity'
            : ctx.isSameSkillRunForResume(taskRunSkillRun, latestSkillRun)
              ? 'skill_task_run'
              : ctx.isSameSkillRunForResume(projectionSkillRun, latestSkillRun)
                ? 'task_projection'
                : 'none'

      const skillId = latestSkillRun.skillId
      const recoveredSkill = ctx.skillContextOrchestrator
        .findExplicitlyRequestedSkills(`skill ${skillId}`)
        .find((skill) => skill.id === skillId)
      const skillName = String(recoveredSkill?.name || identity.skillName || skillId)
      const userText = ctx.currentTurnResumeText || ctx.contextualUserInput
      const skillContextInjectionText = identity.relation === 'new'
        ? [
          `系统补充：这是一次 skill 重新开始请求。优先使用 skill "${skillName}" (${skillId})，按同一目标重新发起，不要沿用旧进度。`,
          latestSkillRun.action ? `上一轮技能动作：${latestSkillRun.action}` : '',
          latestSkillRun.summary ? `上次摘要/目标、输出目录或 artifact、失败原因：${latestSkillRun.summary}` : '',
          `用户本轮补充内容：${userText || '重新开始当前任务。'}`,
        ].filter(Boolean).join('\n')
        : ctx.buildSkillResumeContextPrompt({
          skillName,
          skillId,
          action: latestSkillRun.action ?? null,
          summary: latestSkillRun.summary ?? null,
          userText,
        })
      if (
        activeSkillContext
        && ctx.isSameSkillRunForResume(activeContextSkillRun, latestSkillRun)
        // Stage Q (Stage 11) — restart relation='new' must NOT re-remember
        // the old active context. Audit §E found that this line was
        // running for restart turns too (the apply branch was relation-
        // agnostic), so 重新开始 cemented the stale context for future
        // turns. Plan §3.6 contract C9.
        && identity.relation !== 'new'
      ) {
        ctx.rememberActiveSkillContext(ctx.sessionId, activeSkillContext)
      }
      ctx.log(
        `[skill_detection] reference_skill_rearmed_from_skill_history source=${latestSkillRunSource} skillId=${skillId} skillName=${skillName}`,
      )
      return {
        ...baseResult,
        hasExplicitSkill: true,
        skillContextInjectionText,
        lookbackRearmedSkill: { skillId, skillName },
        referenceSkillForMetrics: { id: skillId, name: skillName },
        referenceSkillHintVia: 'history',
      }
    }

    default: {
      ctx.log(
        `[skill_detection] applySkillTurnIdentity unknown source=${identity.source}`,
      )
      return baseResult
    }
  }
}
