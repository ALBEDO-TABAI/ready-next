import { isChildRunCircuitBreakerEnabled } from './child-run-circuit-breaker'
import { isChildResumeEnabled } from './skill-child-feature-flags'
import { isChildInternalStrictAdmissionEnabled } from './tool-definition'

export type TurnFeatureFlags = Readonly<{
  childResumeEnabled: boolean
  childInternalStrictAdmission: boolean
  childRunCircuitBreakerEnabled: boolean
}>

export function snapshotTurnFeatureFlags(
  env: { [key: string]: string | undefined } = process.env as { [key: string]: string | undefined },
): TurnFeatureFlags {
  return Object.freeze({
    childResumeEnabled: isChildResumeEnabled(env),
    childInternalStrictAdmission: isChildInternalStrictAdmissionEnabled(env),
    childRunCircuitBreakerEnabled: isChildRunCircuitBreakerEnabled(env.READY_CHILD_RUN_CIRCUIT_BREAKER_ENABLED),
  })
}
