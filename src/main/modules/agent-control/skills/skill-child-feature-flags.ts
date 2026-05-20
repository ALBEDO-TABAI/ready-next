/**
 * Production rollback flags for the skill child-runtime.
 *
 * Each flag returns `true` (enabled) by default; setting the env var to
 * `'0'`, `'false'`, or `'off'` (case-insensitive, after trim) disables.
 * The pattern mirrors `isChildInternalStrictAdmissionEnabled` in
 * `tool-definition.ts` so production降级 paths stay uniform.
 */

function readEnvFlag(
  env: { [key: string]: string | undefined },
  name: string,
): boolean {
  const raw = env[name]
  if (typeof raw !== 'string') return true
  const normalized = raw.trim().toLowerCase()
  return normalized !== '0' && normalized !== 'false' && normalized !== 'off'
}

/**
 * Controls whether the TurnEngine's child-resume branch is taken when a
 * child run sits in `recoverable_paused` / `budget_paused` and the user
 * issued a resume intent ("继续" / "继续推进"...).
 *
 * When disabled, the resume branch is skipped entirely; the turn falls
 * through to the normal model path so the assistant can talk about the
 * paused state without invoking `resumeSkillChildRun`. The runner itself
 * is unaffected — only the parent loop's automatic resume is gated.
 *
 * Env var: `READY_SKILL_CHILD_RESUME_ENABLED` (default `'1'`).
 * Metric on disabled path: `skill_child_resume_disabled_by_flag`
 * (registered in `TOOL_ERROR_METRICS`).
 */
export function isChildResumeEnabled(
  env: { [key: string]: string | undefined } = process.env as { [key: string]: string | undefined },
): boolean {
  return readEnvFlag(env, 'READY_SKILL_CHILD_RESUME_ENABLED')
}
