/**
 * Stage 4 — local metric registry for the SkillTurnIdentity layer.
 *
 * Lives outside `TOOL_ERROR_METRICS` per CLAUDE.md §6.11 (these are
 * observability metrics, not tool dispatch error categories).
 *
 * Stage 4 W1 added a `shadowMismatch` metric that compared the resolver's
 * identity against the legacy A-F locals. W2 collapsed the legacy cascade
 * into `applySkillTurnIdentity`, so the comparison is undefined post-cutover
 * and the metric was removed (along with `projectIdentityToLegacyShape`).
 *
 * `modeApplied` is the post-W2 signal: emitted once per turn to record the
 * chosen identity mode/source. Operators use it to audit identity decisions
 * without parsing turn logs.
 */
export const SKILL_TURN_IDENTITY_METRICS = {
  modeApplied: 'skill_turn_identity_mode_applied',
} as const

export type SkillTurnIdentityMetricKey = keyof typeof SKILL_TURN_IDENTITY_METRICS
