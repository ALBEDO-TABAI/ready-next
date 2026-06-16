/**
 * Stage Q (Stage 11) — Restart intent classifier.
 *
 * Audit §C-9 / §E / plan §3.6 (PR-6 / Q.5). The bug:
 *   When the user types "重新开始 / 从头来过", the intent layer correctly
 *   classifies the request as `userIntent='start'` with `relation='new'`,
 *   but the turn engine's `shouldBindSkillContextForTurn` predicate
 *   loaded the OLD supervisor snapshot anyway. The frame ended up with
 *   `mode='skill_start'` BUT `liveness='blocked'/'recoverable_paused'`
 *   from a stale row, so steering immediately checkpoint_budget'd the
 *   "fresh" turn.
 *
 * The fix: classify the user's restart intent into 3 mutually-exclusive,
 * exhaustive classes BEFORE the structure layer loads any snapshot:
 *
 *   - `fresh`                 — user wants a clean slate; ignore all
 *                                 stale supervisor state
 *   - `resume`                — user wants to continue a paused/blocked
 *                                 task (the historical resume path)
 *   - `restart_from_existing` — user wants to restart but provided an
 *                                 explicit handle (`@[run_state.json]` etc)
 *                                 — read the handle as input, but DON'T
 *                                 borrow stale supervisor liveness
 *
 * Both `fresh` and `restart_from_existing` suppress stale-supervisor
 * liveness in the frame; only `resume` walks the legacy path.
 *
 * This file is pure-read: the classifier function takes a frozen
 * `RestartIntentInputs` and returns a class label. No state is mutated.
 *
 * Exhaustiveness invariant (enforced by
 * `scripts/check-restart-intent-exhaustiveness.cjs`):
 *   - The union `RestartIntentClass` has exactly 3 members.
 *   - The exported `RESTART_INTENT_CLASSES` array length === 3.
 *   - No code path produces a value outside this set.
 */
import { canResumeAsUserPoint, type ResumePointHandle } from './contracts/resume-handle'
import type { TurnUserIntent } from './runtime-core/turn-frame'

export type RestartIntentClass = 'fresh' | 'resume' | 'restart_from_existing'

export interface RestartIntentInputs {
  /**
   * The full TurnUserIntent union (including `'cancel'`, `'inspect'`,
   * etc) — Codex round 1 校对点 7. Anything other than `'start'` falls
   * straight into `resume` because the historical path handles those.
   */
  userIntent: TurnUserIntent
  /**
   * Whether the turn carries an explicit run-state resource (e.g. user
   * attached a run_state.json or an output dir was named).
   */
  explicitRunStateResource: unknown | null
  /**
   * Whether the turn carries a fully-formed continuation state from the
   * caller (renderer-side resume button, programmatic resume, etc).
   */
  providedContinuationState: unknown | null
  /**
   * The current projection's continuationRef. Used to detect "user
   * said 'restart' but we already have a real durable handle on file" —
   * that becomes `restart_from_existing` (read the handle but suppress
   * stale liveness), NOT `fresh`.
   */
  continuationRef: ResumePointHandle | null
}

/**
 * Pure classifier. Returns one of `RestartIntentClass`.
 *
 * Decision table:
 *
 *   userIntent        | hasHandle | →                       relation
 *   ----------------  | --------- | ----------------------- | --------
 *   != 'start'        | any       | resume                  | (n/a)
 *   'start'           | true      | restart_from_existing   | new
 *   'start'           | false     | fresh                   | new
 *
 * Where `hasHandle` = `explicitRunStateResource ‖ providedContinuationState
 * ‖ canResumeAsUserPoint(continuationRef)`.
 */
export function classifyRestartIntent(inputs: RestartIntentInputs): RestartIntentClass {
  if (inputs.userIntent !== 'start') return 'resume'
  const hasHandle = Boolean(
      inputs.explicitRunStateResource
      || inputs.providedContinuationState
      || canResumeAsUserPoint(inputs.continuationRef),
  )
  return hasHandle ? 'restart_from_existing' : 'fresh'
}

/**
 * Exported tuple — used by the exhaustiveness gate to verify the union
 * type and this array agree on length 3.
 */
export const RESTART_INTENT_CLASSES: readonly RestartIntentClass[] = [
  'fresh',
  'resume',
  'restart_from_existing',
]
