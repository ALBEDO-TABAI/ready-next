import type { ActiveSkillContextSource } from '../session/active-skill-context'
// SkillRunContract lives in run-contracts.ts. Imported as a type so the
// frame schema can carry the durable contract without circular runtime
// dependencies.
import type { SkillRunContract } from '../contracts/run-contracts'
import { isVeaAction, isVeaStage, resolveVeaResumeAction } from '../vea-resume-action'

export type TurnTerminalReason =
  | 'done'
  | 'checkpoint_budget'
  | 'checkpoint_background'
  | 'checkpoint_user_input'
  | 'checkpoint_steered'
  | 'blocked_config'
  | 'blocked_external'
  | 'context_overflow'
  | 'blocked_tool_error'
  | 'adjudication_degraded'
  | 'failed_skill'
  | 'resume_launch_failed'
  | 'persistence_failed'
  | 'cancelled_user'
  | 'cancelled_runtime'

export type TurnUserIntent =
  | 'start'
  | 'continue'
  | 'repair_config'
  | 'inspect'
  | 'cancel'
  | 'unknown'

export type TurnFrameLiveness =
  | 'running_process'
  | 'recent_progress'
  | 'recoverable_paused'
  | 'blocked'
  | 'ready_to_resume'
  | 'done'
  | 'failed'
  | 'unknown'

export type TurnFrameMode =
  | 'general'
  | 'skill_resume'
  | 'skill_start'
  | 'skill_repair'
  | 'skill_inspect'

export interface TurnFrameSkillSlice {
  skillId: string
  skillName: string | null
  source: ActiveSkillContextSource
  confidence: number
  taskRunId: string | null
  detachedTaskId: string | null
  action: string | null
  runStatePath: string | null
  outputDir: string | null
  artifactPaths: {
    sceneScoresPath: string | null
    deliveryReportPath: string | null
  }
  status: string | null
  staleBlockerReason: string | null
  /**
   * Stage C — durable cross-turn skill run contract (Wave 1 → 2/3 lock).
   * Populated by `turn-frame-resolver` from supervisor + projection +
   * reference-hint signals; emitted by tool results via `framePatch.runContract`
   * (see `buildContractFramePatch`). The shape lives in `run-contracts.ts`.
   */
  runContract: SkillRunContract | null
}

/**
 * Stage E — `FrameAction` is the steering decision the turn engine forces
 * on the next iteration. It carries enough information for a deterministic
 * dispatch: `mode` selects the branch, `toolName` + `input` carry the
 * forced call, `inputDigest` keys the cross-turn force-loop guard, and
 * `missingInputs[]` lets the engine choose `checkpoint` over an empty
 * `force_tool` when a required field is unavailable.
 *
 * Wave 1 lock — Beta defines the shape; Epsilon (Wave 3) is the producer
 * that fills `input` from `runContract.actionInput` and writes back
 * `forceLoopGuard` after each dispatch.
 */
export interface FrameAction {
  mode: 'none' | 'ask_model' | 'force_tool' | 'checkpoint' | 'finish'
  toolName: string | null
  input: Record<string, unknown> | null
  inputDigest: string | null
  reason: string
  missingInputs: string[]
}

export interface TurnFrame {
  ids: {
    sessionId: string | null
    requestId: string | null
  }
  mode: TurnFrameMode
  userIntent: TurnUserIntent
  skill: TurnFrameSkillSlice | null
  liveness: TurnFrameLiveness
  progress: {
    stage: string | null
    totalUnits: number | null
    completedUnits: number | null
    coverageRatio: number | null
    fingerprint: string | null
  }
  steering: {
    mode: 'none' | 'ask_model' | 'force_tool' | 'checkpoint' | 'finish'
    requiredToolName: string | null
    preferredToolNames: string[]
    systemReminder: string | null
    /**
     * Stage E — explicit FrameAction the next iteration should execute.
     * Carries `toolName`, `input`, `inputDigest`, `reason`, and
     * `missingInputs[]` so a forced dispatch can never use an empty `{}`
     * input. `null`/absent while no action is queued. Optional so the
     * Wave 1 schema lock does not break the existing Wave 1
     * `buildTurnFrameSteering` return (which Epsilon owns and rewrites in
     * Wave 3 to populate this slot).
     */
    action?: FrameAction | null
  }
  /** EP2-I2 — standing user negations (session lineage). Optional so the
   *  resolver's existing construction stays valid; absent = no negations. */
  negations?: {
    families: string[]
    updatedAt: string | null
  }
  budget: {
    leaseEndIteration: number | null
    hardCapIteration: number | null
    exhausted: boolean
  }
  /**
   * Stage D — durable read surface for the current turn. Tools that
   * discover new artifact roots (`skill_inspect_run_state`, typed action
   * wrappers) emit `framePatch.activeArtifactRoots`; `applyTurnFramePatch`
   * persists the union into this slot so the same-turn `skill_read_artifact`
   * call sees the freshly-discovered root without re-resolving from
   * session state.
   */
  activeArtifactRoots: string[]
  /**
   * Stage D — durable config repair / validation result for the current
   * turn. `skill_patch_config` emits `framePatch.configValidation`; the
   * frame slot persists across iterations so steering can see that the
   * blocker was cleared without re-reading the config file.
   */
  configValidation: NonNullable<TurnFramePatch['configValidation']> | null
  terminalReason: TurnTerminalReason | null
}

export function summarizeTurnFrame(frame: TurnFrame | null): Record<string, unknown> | null {
  if (!frame) return null
  return {
    sessionId: frame.ids.sessionId,
    requestId: frame.ids.requestId,
    mode: frame.mode,
    skillId: frame.skill?.skillId || null,
    source: frame.skill?.source || null,
    hasRunState: Boolean(frame.skill?.runStatePath),
    hasOutputDir: Boolean(frame.skill?.outputDir),
    liveness: frame.liveness,
    preferredToolNames: frame.steering.preferredToolNames,
    terminalReason: frame.terminalReason,
  }
}

/**
 * Stage 5 — `TurnFramePatch` is a structured update that a tool result can
 * carry back through `ToolExecutionOutput.framePatch`. After every tool
 * batch the turn engine merges the non-null patches and applies them to the
 * live frame so the next iteration's steering / dispatch decisions see
 * the freshly-discovered task handles, validated config, and active
 * artifact roots.
 *
 * Patches do NOT leak across turns: each new user turn rebuilds the frame
 * from scratch via `resolveTurnFrame(...)`, so this contract is purely
 * intra-turn iteration glue.
 */
export interface TurnFramePatch {
  /**
   * EP2-I2 — standing-negation updates through the declared patch channel.
   * `add` merges (dedupe); `release` removes. Lifecycle = session lineage.
   */
  negationUpdates?: {
    add?: string[]
    release?: string[]
    updatedAt?: string
  }
  /**
   * Additional read-only roots to expose for `skill_read_artifact` lookups.
   * Merged with the existing skill slice's path data. Concat-and-dedupe
   * across multiple patches in a single batch.
   */
  activeArtifactRoots?: string[]
  /**
   * Result of a config repair / validation tool run. Carries forward into
   * the next iteration's steering decision so the model can see the
   * config-blocked status was cleared without re-reading the file.
   */
  configValidation?: {
    valid: boolean
    reason?: string
    message?: string
  }
  /**
   * Newly-discovered durable task handles. ADDITIVE — only fills empty
   * fields on the skill slice; never overrides handles a higher-priority
   * resolver already populated.
   */
  discoveredHandles?: Partial<
    Pick<
      TurnFrameSkillSlice,
      'taskRunId' | 'detachedTaskId' | 'runStatePath' | 'outputDir' | 'action'
    >
  >
  /**
   * Override the skill slice with explicit values. Last-write-wins across
   * patches. Use this for tool results that authoritatively know the
   * current skill state (e.g. patch_config returning `staleBlockerReason`).
   */
  skillStatusUpdates?: Partial<TurnFrameSkillSlice>
  /**
   * Hint about runtime liveness derived from a tool's structured output.
   * Only upgrades the frame's liveness when the hint is more concrete
   * than the current value (terminal reasons `done` / `failed` cannot be
   * downgraded by a `running_process` hint, etc.).
   */
  livenessHint?: TurnFrameLiveness
  /**
   * Stage C — partial update to the durable `SkillRunContract` slot on
   * `frame.skill.runContract`. Producers (Gamma + Delta) emit a partial
   * with whatever the tool result observed (handles, paths, validated
   * action input, status, force-loop guard). `mergeTurnFramePatches`
   * field-by-field merges scalars (last-write-wins) and concat-dedupes
   * arrays so multiple producers in the same batch combine cleanly.
   *
   * Use `Partial<SkillRunContract>` so producers do not have to fabricate
   * unrelated fields. The full contract is rebuilt by `loadSkillRunContract`
   * before next-turn steering reads it.
   */
  runContract?: Partial<SkillRunContract>
  /**
   * Stage M — durable budget update emitted by the lease controller after
   * each scoring window. `applyTurnFramePatch` writes the values into
   * `frame.budget`. Steering and dispatch must read `frame.budget` only;
   * `skillBudgetLeaseState` is the producer side and is not consulted by
   * any read path. Last-write-wins per scalar; explicit `null` resets.
   */
  budget?: {
    leaseEndIteration?: number | null
    hardCapIteration?: number | null
    exhausted?: boolean
  }
  /**
   * Stage M — terminal classification of the current turn. The turn engine
   * emits this once a terminal branch is decided. Patches with higher
   * priority override patches with lower or equal priority — see
   * `TURN_TERMINAL_REASON_RANK` and `shouldApplyTerminalReason`. This is
   * how the engine prevents a provisional `checkpoint_user_input` from
   * silently winning over a later real `checkpoint_budget` close.
   */
  terminalReason?: TurnTerminalReason
}

const TURN_FRAME_LIVENESS_RANK: Record<TurnFrameLiveness, number> = {
  unknown: 0,
  blocked: 1,
  recoverable_paused: 2,
  ready_to_resume: 2,
  recent_progress: 3,
  running_process: 4,
  done: 9,
  failed: 9,
}

/**
 * Stage M — priority ranks for `TurnTerminalReason`. Higher rank wins.
 *
 * Rationale:
 *   - `cancelled_user` always wins (user-initiated cancel is final).
 *   - `failed_skill` > `done`: a failure observed after a provisional `done`
 *     surfaces as failure (defensive — see plan §9.Q1).
 *   - `done` > all checkpoints: a child resume that completes must not be
 *     overwritten by a later iteration's budget/background marker.
 *   - `checkpoint_budget` > `checkpoint_user_input`: the real terminal cause
 *     (budget close) overrides a provisional user-input checkpoint marker.
 *   - `checkpoint_background` > `checkpoint_budget`: when a live worker exists,
 *     `turn-engine.ts:4239-4246` already prefers `checkpoint_background`.
 */
const TURN_TERMINAL_REASON_RANK: Record<TurnTerminalReason, number> = {
  cancelled_user: 100,
  cancelled_runtime: 90,
  failed_skill: 80,
  persistence_failed: 75,
  blocked_config: 70,
  blocked_external: 65,
  context_overflow: 65,
  blocked_tool_error: 60,
  adjudication_degraded: 60,
  resume_launch_failed: 55,
  done: 50,
  checkpoint_background: 30,
  checkpoint_budget: 20,
  checkpoint_steered: 15,
  checkpoint_user_input: 10,
}

/**
 * Stage M — should the patch's `terminalReason` replace the current frame
 * value? Returns true when there is no current value, when the new rank is
 * strictly higher, OR when ranks are equal (idempotent re-emits stay benign).
 * Returns false when the new rank is strictly lower (silent-drop guard).
 */
function shouldApplyTerminalReason(
  current: TurnTerminalReason | null,
  next: TurnTerminalReason,
): boolean {
  if (current == null) return true
  const currentRank = TURN_TERMINAL_REASON_RANK[current] ?? 0
  const nextRank = TURN_TERMINAL_REASON_RANK[next] ?? 0
  return nextRank >= currentRank
}

const VEA_SKILL_ID = 'video-expert-analyzer'

function isTerminalLiveness(value: TurnFrameLiveness): boolean {
  return value === 'done' || value === 'failed'
}

function shouldApplyLivenessHint(current: TurnFrameLiveness, hint: TurnFrameLiveness): boolean {
  if (isTerminalLiveness(current)) return false
  if (hint === 'blocked') return true
  const currentRank = TURN_FRAME_LIVENESS_RANK[current] ?? 0
  const hintRank = TURN_FRAME_LIVENESS_RANK[hint] ?? 0
  return hintRank >= currentRank
}

function dedupePreservingOrder(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

function normalizeVeaAction(value: unknown): string | null {
  if (isVeaAction(value)) return value
  if (typeof value === 'string' && value.startsWith('skill_')) {
    const unprefixed = value.slice('skill_'.length)
    if (isVeaAction(unprefixed)) return unprefixed
  }
  return null
}

function sanitizeVeaAction(args: {
  skillId?: string | null
  candidate: unknown
  fallback?: unknown
  sceneScoresPath?: string | null
}): string | null | undefined {
  if (args.candidate === undefined) return undefined
  if (args.candidate === null) return null
  if (typeof args.candidate !== 'string') return undefined
  if (args.skillId !== VEA_SKILL_ID) return args.candidate

  const manifestAction = normalizeVeaAction(args.candidate)
  if (manifestAction) return manifestAction

  if (isVeaStage(args.candidate)) {
    const resolved = resolveVeaResumeAction(args.candidate, {
      sceneScoresPath: args.sceneScoresPath,
    })
    if (resolved) return resolved
    const fallbackAction = normalizeVeaAction(args.fallback)
    if (fallbackAction) return fallbackAction
    return undefined
  }

  const resolved = resolveVeaResumeAction(args.candidate, {
    sceneScoresPath: args.sceneScoresPath,
  })
  if (resolved) return resolved

  if (isVeaStage(args.candidate)) {
    return undefined
  }

  return undefined
}

function sceneScoresPathForPatch(
  skill: TurnFrameSkillSlice,
  patch: TurnFramePatch,
): string | null {
  return patch.runContract?.artifactPaths?.sceneScoresPath
    || patch.skillStatusUpdates?.artifactPaths?.sceneScoresPath
    || skill.runContract?.artifactPaths.sceneScoresPath
    || skill.artifactPaths.sceneScoresPath
    || null
}

/**
 * Field-by-field merge of two `Partial<SkillRunContract>` patches. Scalar
 * fields use last-write-wins (later patch overrides). Arrays
 * (`artifactRoots`, `projectionIdentity.supersedesProjectionIds`) are
 * concat-deduped. Nested objects (`artifactPaths`, `progress`, `blocker`,
 * `projectionIdentity`, `forceLoopGuard`) merge by spread.
 *
 * `forceLoopGuard.consecutiveForceCount` increments correctly because the
 * later patch's value (the post-dispatch count) overrides the earlier one.
 */
function mergeRunContractPartials(
  prior: Partial<SkillRunContract> | undefined,
  next: Partial<SkillRunContract>,
): Partial<SkillRunContract> {
  if (!prior) return { ...next }
  const merged: Partial<SkillRunContract> = { ...prior, ...next }
  if (prior.artifactRoots || next.artifactRoots) {
    merged.artifactRoots = dedupePreservingOrder([
      ...(prior.artifactRoots || []),
      ...(next.artifactRoots || []),
    ])
  }
  if (prior.artifactPaths || next.artifactPaths) {
    merged.artifactPaths = {
      sceneScoresPath: null,
      deliveryReportPath: null,
      ...(prior.artifactPaths || {}),
      ...(next.artifactPaths || {}),
    }
  }
  if (prior.progress || next.progress) {
    merged.progress = {
      stage: null,
      totalUnits: null,
      completedUnits: null,
      coverageRatio: null,
      fingerprint: null,
      ...(prior.progress || {}),
      ...(next.progress || {}),
    }
  }
  if (prior.blocker || next.blocker) {
    merged.blocker = {
      reason: null,
      stale: false,
      ...(prior.blocker || {}),
      ...(next.blocker || {}),
    }
  }
  if (prior.projectionIdentity || next.projectionIdentity) {
    const supersedes = dedupePreservingOrder([
      ...(prior.projectionIdentity?.supersedesProjectionIds || []),
      ...(next.projectionIdentity?.supersedesProjectionIds || []),
    ])
    merged.projectionIdentity = {
      stableKey: null,
      ...(prior.projectionIdentity || {}),
      ...(next.projectionIdentity || {}),
      supersedesProjectionIds: supersedes,
    }
  }
  if (prior.forceLoopGuard || next.forceLoopGuard) {
    merged.forceLoopGuard = {
      lastForceToolName: null,
      lastForceInputDigest: null,
      lastForceToolDispatchedAt: null,
      consecutiveForceCount: 0,
      ...(prior.forceLoopGuard || {}),
      ...(next.forceLoopGuard || {}),
    }
  }
  return merged
}

/**
 * Merge a list of `TurnFramePatch`es into a single deterministic patch.
 * Later patches override earlier ones for scalar fields (`configValidation`,
 * `livenessHint`). For `activeArtifactRoots`, all roots are concatenated
 * and de-duplicated preserving the first-seen order. `discoveredHandles`
 * and `skillStatusUpdates` are shallow-merged with later overriding earlier.
 * `runContract` partials are field-by-field merged (last-write-wins
 * scalars, concat-dedupe arrays) so multiple producers in the same batch
 * combine cleanly.
 */
export function mergeTurnFramePatches(patches: TurnFramePatch[]): TurnFramePatch {
  const merged: TurnFramePatch = {}
  const allRoots: string[] = []
  for (const patch of patches) {
    if (!patch || typeof patch !== 'object') continue
    if (Array.isArray(patch.activeArtifactRoots) && patch.activeArtifactRoots.length > 0) {
      allRoots.push(...patch.activeArtifactRoots)
    }
    if (patch.configValidation && typeof patch.configValidation === 'object') {
      merged.configValidation = {
        valid: Boolean(patch.configValidation.valid),
        reason: patch.configValidation.reason,
        message: patch.configValidation.message,
      }
    }
    if (patch.discoveredHandles && typeof patch.discoveredHandles === 'object') {
      merged.discoveredHandles = { ...(merged.discoveredHandles || {}), ...patch.discoveredHandles }
    }
    if (patch.skillStatusUpdates && typeof patch.skillStatusUpdates === 'object') {
      merged.skillStatusUpdates = { ...(merged.skillStatusUpdates || {}), ...patch.skillStatusUpdates }
    }
    if (typeof patch.livenessHint === 'string') {
      merged.livenessHint = patch.livenessHint
    }
    if (patch.runContract && typeof patch.runContract === 'object') {
      merged.runContract = mergeRunContractPartials(merged.runContract, patch.runContract)
    }
    // Stage M — budget merge (last-write-wins per scalar; explicit `null`
    // values are preserved so callers can intentionally reset a field).
    if (patch.budget && typeof patch.budget === 'object') {
      merged.budget = { ...(merged.budget || {}), ...patch.budget }
    }
    // Stage M — terminalReason merge with priority ranking. A patch's
    // `terminalReason` only sticks if its rank is >= the currently merged
    // value. This is the silent-drop guard — see TURN_TERMINAL_REASON_RANK.
    if (typeof patch.terminalReason === 'string') {
      if (shouldApplyTerminalReason(merged.terminalReason ?? null, patch.terminalReason)) {
        merged.terminalReason = patch.terminalReason
      }
    }
  }
  if (allRoots.length > 0) {
    merged.activeArtifactRoots = dedupePreservingOrder(allRoots)
  }
  return merged
}

/**
 * Apply a `TurnFramePatch` to a frame, returning a NEW frame (pure / no
 * mutation of the input). Used by the turn engine after each tool batch.
 *
 * Rules:
 *   - `discoveredHandles` is ADDITIVE: only fills fields that are currently
 *     null/empty on the skill slice. A higher-priority resolver win is
 *     never overwritten.
 *   - `skillStatusUpdates` is OVERRIDE: every key in the partial replaces
 *     the corresponding skill slice field.
 *   - `livenessHint` only upgrades when the new hint is at least as
 *     concrete as the current liveness, AND the current liveness is not
 *     already terminal (`done` / `failed`).
 *   - `activeArtifactRoots` is DURABLE: union into `frame.activeArtifactRoots`
 *     so same-turn `skill_read_artifact` calls see freshly-discovered roots.
 *   - `configValidation` is DURABLE: latest value persists into
 *     `frame.configValidation` so steering can see the blocker was
 *     cleared without re-reading the config file.
 *   - `runContract` partial is field-by-field merged into
 *     `frame.skill.runContract` (last-write-wins scalars, concat-dedupe
 *     arrays). Survives across iterations within the turn.
 *   - Empty patch returns the input frame structurally unchanged (same
 *     object reference is fine because callers do not mutate).
 */
export function applyTurnFramePatch(frame: TurnFrame, patch: TurnFramePatch): TurnFrame {
  if (!patch || typeof patch !== 'object') return frame
  const hasActiveRoots = Boolean(patch.activeArtifactRoots && patch.activeArtifactRoots.length > 0)
  const hasConfig = Boolean(patch.configValidation)
  const hasContract = Boolean(patch.runContract && Object.keys(patch.runContract).length > 0)
  // Stage M — track new write surfaces so the no-op guard at the bottom
  // skips construction of a new frame when nothing changed.
  const hasBudget = Boolean(patch.budget && Object.keys(patch.budget).length > 0)
  const hasTerminalReason = typeof patch.terminalReason === 'string'
  const hasNegations = Boolean(patch.negationUpdates
    && ((patch.negationUpdates.add && patch.negationUpdates.add.length > 0)
      || (patch.negationUpdates.release && patch.negationUpdates.release.length > 0)))
  const hasAnything =
    hasNegations
    || hasActiveRoots
    || hasConfig
    || hasContract
    || Boolean(patch.discoveredHandles && Object.keys(patch.discoveredHandles).length > 0)
    || Boolean(patch.skillStatusUpdates && Object.keys(patch.skillStatusUpdates).length > 0)
    || typeof patch.livenessHint === 'string'
    || hasBudget
    || hasTerminalReason
  if (!hasAnything) return frame

  let nextSkill: TurnFrame['skill'] = frame.skill
  if (frame.skill) {
    const sceneScoresPath = sceneScoresPathForPatch(frame.skill, patch)
    const additive: Partial<TurnFrameSkillSlice> = {}
    if (patch.discoveredHandles) {
      const handles = patch.discoveredHandles
      if (frame.skill.taskRunId == null && handles.taskRunId != null) additive.taskRunId = handles.taskRunId
      if (frame.skill.detachedTaskId == null && handles.detachedTaskId != null) additive.detachedTaskId = handles.detachedTaskId
      if (frame.skill.runStatePath == null && handles.runStatePath != null) additive.runStatePath = handles.runStatePath
      if (frame.skill.outputDir == null && handles.outputDir != null) additive.outputDir = handles.outputDir
      if (frame.skill.action == null && handles.action != null) {
        const action = sanitizeVeaAction({
          skillId: frame.skill.skillId,
          candidate: handles.action,
          fallback: frame.skill.runContract?.action,
          sceneScoresPath,
        })
        if (action !== undefined) additive.action = action
      }
    }
    const overrides: Partial<TurnFrameSkillSlice> = patch.skillStatusUpdates && typeof patch.skillStatusUpdates === 'object'
      ? { ...patch.skillStatusUpdates }
      : {}
    if ('action' in overrides) {
      const action = sanitizeVeaAction({
        skillId: frame.skill.skillId,
        candidate: overrides.action,
        fallback: frame.skill.action || frame.skill.runContract?.action,
        sceneScoresPath,
      })
      if (action === undefined) {
        delete overrides.action
      } else {
        overrides.action = action
      }
    }
    let nextRunContract: SkillRunContract | null = frame.skill.runContract
    if (hasContract) {
      const partial: Partial<SkillRunContract> = { ...patch.runContract! }
      if ('action' in partial) {
        const action = sanitizeVeaAction({
          skillId: partial.skillId || frame.skill.skillId,
          candidate: partial.action,
          fallback: frame.skill.runContract?.action || frame.skill.action,
          sceneScoresPath,
        })
        if (action === undefined) {
          delete partial.action
        } else {
          partial.action = action
        }
      }
      const existing = frame.skill.runContract
      const merged = mergeRunContractPartials(
        existing ? (existing as unknown as Partial<SkillRunContract>) : undefined,
        partial,
      )
      // Only emit a fully-shaped contract if we either started with one or
      // the partial supplies the required `skillId` anchor. This avoids
      // creating a half-formed contract from an unrelated patch.
      if (existing) {
        nextRunContract = { ...existing, ...merged } as SkillRunContract
      } else if (typeof merged.skillId === 'string' && merged.skillId.length > 0) {
        nextRunContract = {
          skillId: merged.skillId,
          skillName: merged.skillName ?? null,
          toolName: merged.toolName ?? null,
          action: merged.action ?? null,
          actionInput: merged.actionInput ?? null,
          originalInput: merged.originalInput ?? null,
          sourceUrl: merged.sourceUrl ?? null,
          taskRunId: merged.taskRunId ?? null,
          detachedTaskId: merged.detachedTaskId ?? null,
          jobId: merged.jobId ?? null,
          outputDir: merged.outputDir ?? null,
          runStatePath: merged.runStatePath ?? null,
          artifactRoots: merged.artifactRoots ?? [],
          artifactPaths: merged.artifactPaths ?? { sceneScoresPath: null, deliveryReportPath: null },
          status: merged.status ?? 'unknown',
          liveness: merged.liveness ?? 'unknown',
          progress: merged.progress ?? { stage: null, totalUnits: null, completedUnits: null, coverageRatio: null, fingerprint: null },
          blocker: merged.blocker ?? { reason: null, stale: false },
          projectionIdentity: merged.projectionIdentity ?? { stableKey: null, supersedesProjectionIds: [] },
          forceLoopGuard: merged.forceLoopGuard ?? {
            lastForceToolName: null,
            lastForceInputDigest: null,
            lastForceToolDispatchedAt: null,
            consecutiveForceCount: 0,
          },
          childRunId: merged.childRunId,
          childStatus: merged.childStatus,
          parentNextHint: merged.parentNextHint,
          childCloseEvent: merged.childCloseEvent,
          legacyAdoptableHandles: merged.legacyAdoptableHandles,
          blockerReason: merged.blockerReason,
          updatedAt: merged.updatedAt ?? new Date().toISOString(),
        }
      }
    }
    const skillChanged =
      Object.keys(additive).length > 0
      || Object.keys(overrides).length > 0
      || nextRunContract !== frame.skill.runContract
    if (skillChanged) {
      nextSkill = { ...frame.skill, ...additive, ...overrides, runContract: nextRunContract }
    }
  }

  let nextLiveness: TurnFrameLiveness = frame.liveness
  if (typeof patch.livenessHint === 'string' && !isTerminalLiveness(frame.liveness)) {
    if (shouldApplyLivenessHint(frame.liveness, patch.livenessHint)) {
      nextLiveness = patch.livenessHint
    }
  }

  let nextActiveArtifactRoots: string[] = frame.activeArtifactRoots
  if (hasActiveRoots) {
    const merged = dedupePreservingOrder([
      ...(frame.activeArtifactRoots || []),
      ...(patch.activeArtifactRoots || []),
    ])
    if (merged.length !== (frame.activeArtifactRoots || []).length
        || merged.some((p, i) => p !== frame.activeArtifactRoots[i])) {
      nextActiveArtifactRoots = merged
    }
  }

  let nextConfigValidation = frame.configValidation
  if (hasConfig && patch.configValidation) {
    nextConfigValidation = {
      valid: Boolean(patch.configValidation.valid),
      reason: patch.configValidation.reason,
      message: patch.configValidation.message,
    }
  }

  // Stage M — budget update. Last-write-wins per scalar; explicit `null`
  // values are preserved so callers can intentionally reset a field. The
  // current frame.budget shape requires `leaseEndIteration: number | null`,
  // `hardCapIteration: number | null`, `exhausted: boolean` — keep the
  // contract by coalescing missing patch fields back to current frame values.
  let nextBudget: TurnFrame['budget'] = frame.budget
  if (hasBudget && patch.budget) {
    const incoming = patch.budget
    const candidateBudget: TurnFrame['budget'] = {
      leaseEndIteration: 'leaseEndIteration' in incoming
        ? (incoming.leaseEndIteration ?? null)
        : frame.budget.leaseEndIteration,
      hardCapIteration: 'hardCapIteration' in incoming
        ? (incoming.hardCapIteration ?? null)
        : frame.budget.hardCapIteration,
      exhausted: 'exhausted' in incoming
        ? Boolean(incoming.exhausted)
        : frame.budget.exhausted,
    }
    if (
      candidateBudget.leaseEndIteration !== frame.budget.leaseEndIteration
      || candidateBudget.hardCapIteration !== frame.budget.hardCapIteration
      || candidateBudget.exhausted !== frame.budget.exhausted
    ) {
      nextBudget = candidateBudget
    }
  }

  // Stage M — terminalReason update with priority ranking (silent-drop guard).
  let nextTerminalReason: TurnTerminalReason | null = frame.terminalReason
  if (hasTerminalReason && patch.terminalReason) {
    if (shouldApplyTerminalReason(frame.terminalReason, patch.terminalReason)) {
      nextTerminalReason = patch.terminalReason
    }
  }

  let nextNegations = frame.negations
  if (hasNegations && patch.negationUpdates) {
    const families = new Set(frame.negations?.families ?? [])
    for (const family of patch.negationUpdates.add ?? []) families.add(family)
    for (const family of patch.negationUpdates.release ?? []) families.delete(family)
    nextNegations = { families: [...families], updatedAt: patch.negationUpdates.updatedAt ?? frame.negations?.updatedAt ?? null }
  }

  if (
    nextSkill === frame.skill
    && nextLiveness === frame.liveness
    && nextActiveArtifactRoots === frame.activeArtifactRoots
    && nextConfigValidation === frame.configValidation
    && nextBudget === frame.budget
    && nextTerminalReason === frame.terminalReason
    && nextNegations === frame.negations
  ) {
    return frame
  }

  return {
    ...frame,
    ...(nextNegations !== undefined ? { negations: nextNegations } : {}),
    skill: nextSkill,
    liveness: nextLiveness,
    activeArtifactRoots: nextActiveArtifactRoots,
    configValidation: nextConfigValidation,
    budget: nextBudget,
    terminalReason: nextTerminalReason,
  }
}

// Stage M — exported helper rank table + predicate so tests and gate
// scripts can assert priority semantics without redefining them.
export { TURN_TERMINAL_REASON_RANK, shouldApplyTerminalReason }
