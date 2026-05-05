/**
 * Stage 4 W1 — local metric registry for the SkillTurnIdentity layer.
 *
 * Lives outside `TOOL_ERROR_METRICS` per CLAUDE.md §6.11 (these are
 * observability metrics, not tool dispatch error categories). Two phases:
 *
 *   - `shadowMismatch` is emitted by W1 shadow comparison. W2 deletes it
 *     when the legacy A-F segments are removed — at that point the
 *     resolver is the source of truth and there is no "legacy" to mismatch
 *     against.
 *   - `modeApplied` is emitted by W2 `applySkillTurnIdentity` once per turn
 *     to record the chosen mode/relation/source. Operators use this to
 *     audit identity decisions without parsing turn logs.
 */
export const SKILL_TURN_IDENTITY_METRICS = {
  shadowMismatch: 'skill_turn_identity_shadow_mismatch',
  modeApplied: 'skill_turn_identity_mode_applied',
} as const

export type SkillTurnIdentityMetricKey = keyof typeof SKILL_TURN_IDENTITY_METRICS
