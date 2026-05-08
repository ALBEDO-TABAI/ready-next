import { isChildRunCircuitBreakerEnabled } from './child-run-circuit-breaker'
import { isChildResumeEnabled } from './skill-child-feature-flags'
import { isChildInternalStrictAdmissionEnabled } from './tool-definition'

export type TurnFeatureFlags = Readonly<{
  childResumeEnabled: boolean
  childInternalStrictAdmission: boolean
  childRunCircuitBreakerEnabled: boolean
  /**
   * Stage Q (Stage 11) — when `true` (default), reference/advisory skill
   * primitive calls do not write SkillTaskRun / session continuity.
   * Set `READY_REFERENCE_PRIMITIVE_LIFECYCLE_FENCE='0'` to disable.
   */
  referencePrimitiveLifecycleFence: boolean
  /**
   * Stage Q (Stage 11) — when `true` (default), tracker active-row matching
   * for primitive vs lifecycle vs typed_action events is partitioned by
   * runKind. Set `READY_SKILL_TASK_RUN_INVARIANT_ENFORCED='0'` to disable
   * (only valid before Stage Q.3b CHECK constraint lands; after that the
   * boot fence in `assertSkillTaskRunInvariantConsistency()` blocks the
   * downgrade combination).
   */
  skillTaskRunInvariantEnforced: boolean
}>

function isFlagEnabled(env: { [key: string]: string | undefined }, name: string, defaultEnabled: boolean): boolean {
  const raw = env[name]
  if (raw === undefined || raw === null || raw === '') return defaultEnabled
  const normalized = String(raw).trim().toLowerCase()
  if (normalized === '0' || normalized === 'false' || normalized === 'off') return false
  return true
}

export function snapshotTurnFeatureFlags(
  env: { [key: string]: string | undefined } = process.env as { [key: string]: string | undefined },
): TurnFeatureFlags {
  return Object.freeze({
    childResumeEnabled: isChildResumeEnabled(env),
    childInternalStrictAdmission: isChildInternalStrictAdmissionEnabled(env),
    childRunCircuitBreakerEnabled: isChildRunCircuitBreakerEnabled(env.READY_CHILD_RUN_CIRCUIT_BREAKER_ENABLED),
    referencePrimitiveLifecycleFence: isFlagEnabled(env, 'READY_REFERENCE_PRIMITIVE_LIFECYCLE_FENCE', true),
    skillTaskRunInvariantEnforced: isFlagEnabled(env, 'READY_SKILL_TASK_RUN_INVARIANT_ENFORCED', true),
  })
}
