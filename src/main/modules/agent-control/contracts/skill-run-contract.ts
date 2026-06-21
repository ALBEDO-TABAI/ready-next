import type { TurnFrame } from '../runtime-core/turn-frame'
import type {
  SkillChildCloseEvent,
  SkillChildRunParentNextHint,
  SkillChildRunStatus,
} from '../skills/skill-child-run-types'

/**
 * ────────────────────────────────────────────────────────────────────────
 * SKILL RUN CONTRACT — additive amendment rule (Wave 1 → 2/3 interface lock)
 * ────────────────────────────────────────────────────────────────────────
 *
 * The `SkillRunContract` interface and the loader in
 * `skill-run-contract-loader.ts` are the durable source of truth that
 * survives across turns. They are the Wave 1 → Wave 2/3 interface that
 * producer teams (Gamma + Delta) emit patches for, and consumer teams
 * (Epsilon + Zeta) read action input from.
 *
 * Wave 2/3 teams MAY append optional fields to `SkillRunContract` without
 * re-opening Beta if and only if ALL of the following hold:
 *   1. The field is optional (`?:`) or nullable (`| null`).
 *   2. The field is appended at the end of the interface (no rename, no
 *      type narrowing of an existing field).
 *   3. `loadSkillRunContract(...)` is updated to populate the field or
 *      explicitly leave it null (no silent drop).
 *   4. `buildContractFramePatch(snapshot)` is updated so the new field
 *      flows through `framePatch.runContract`.
 *
 * Required fields, type narrowing, or rename → re-open Beta and block
 * downstream waves.
 * ────────────────────────────────────────────────────────────────────────
 */

// ────────────────────────────────────────────────────────────────────────
// SkillRunContract (Stage C — durable long-skill ownership)
// ────────────────────────────────────────────────────────────────────────

/**
 * `SkillRunContract` is the durable, cross-turn source of truth for a long
 * skill run. Where `TurnFrame` is per-turn coordination glue and
 * `TurnFramePatch` is intra-turn update messages, this contract preserves
 * the handles, paths, validated action input, status, liveness, progress,
 * and force-loop guard state needed to resume the run on the next turn.
 *
 * The contract is a READ MODEL over existing durable sources:
 *   - `<outputDir>/run_state.json` (Zeta, Wave 3)
 *   - `task_projection_records` (sibling row by stable identity / artifact)
 *   - `SkillTaskSupervisorSnapshot` (live runtime observation)
 *   - session continuity / reference-skill hint
 *
 * It is intentionally NOT a new SQLite table in this route.
 *
 * Shape per source-plan §5.1.
 */
export interface SkillRunContract {
  skillId: string
  skillName: string | null
  toolName: string | null
  action: string | null
  /** Validated or validate-ready input for the next typed action. */
  actionInput: Record<string, unknown> | null
  /** User/source input retained so action input can be rebuilt later. */
  originalInput: Record<string, unknown> | null
  sourceUrl: string | null
  taskRunId: string | null
  detachedTaskId: string | null
  jobId: string | null
  outputDir: string | null
  runStatePath: string | null
  /** Allowed read/write surface for current skill artifacts. */
  artifactRoots: string[]
  artifactPaths: {
    sceneScoresPath: string | null
    deliveryReportPath: string | null
  }
  status:
    | 'unknown'
    | 'running'
    | 'recoverable_paused'
    | 'budget_paused'
    | 'blocked'
    | 'ready_to_resume'
    | 'completed'
    | 'failed'
    | 'killed'
  liveness: TurnFrame['liveness']
  progress: TurnFrame['progress']
  blocker: {
    reason: string | null
    stale: boolean
  }
  projectionIdentity: {
    stableKey: string | null
    supersedesProjectionIds: string[]
  }
  /**
   * Cross-turn force-loop guard. Compared on `(toolName, inputDigest)` so
   * repeated identical force calls are blocked while genuinely new input
   * can still run. Owned by the contract — not a `turn-engine.ts` local —
   * so a new turn cannot rebuild the frame and force the same tool forever.
   */
  // migration-only. Phase 6: retired for skills with `childRunId` —
  // `shouldParentForceLongSkillTool(contract)` returns false in that case,
  // and the engine's force-tool dispatch + this guard's read+write are
  // both fenced by that helper. Other (non-VEA) migration paths still rely
  // on this field until they move to the child-loop architecture.
  forceLoopGuard: {
    lastForceToolName: string | null
    lastForceInputDigest: string | null
    lastForceToolDispatchedAt: string | null
    consecutiveForceCount: number
  }
  updatedAt: string
  /**
   * Phase 4 — child-run handle. When `childRunId` is present, the parent
   * MUST NOT derive the next internal action from `actionInput` — that's
   * the child driver's job. `actionInput` / `originalInput` and the legacy
   * handles below remain populated as SUMMARY ONLY.
   */
  childRunId?: string
  childStatus?: SkillChildRunStatus
  parentNextHint?: SkillChildRunParentNextHint
  childCloseEvent?: SkillChildCloseEvent | null
  /**
   * Phase 4 — surface raw legacy handles when no child-run row exists yet.
   * Phase 5's adoption path uses these to mint a child run that resumes the
   * legacy state. When BOTH `outputDir` and `runStatePath` are missing, the
   * loader sets `blockerReason` instead and refuses to mark the row done.
   */
  legacyAdoptableHandles?: {
    taskRunId?: string
    outputDir?: string
    runStatePath?: string
  }
  /**
   * Phase 4 — explicit blocker reason when a legacy row has no usable
   * handles. The loader NEVER silently completes such rows; the contract
   * stays `recoverable_paused` and Phase 5 decides what to do next.
   */
  blockerReason?: string
}
