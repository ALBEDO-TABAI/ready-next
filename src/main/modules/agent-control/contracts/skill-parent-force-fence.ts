import { STATIC_SKILL_ACTIONS_BY_TOOL_NAME } from '../../tools/skills-tools-static'
import { isConfiguredChildLoopSkillAction } from '../../tools/child-loop-skill-actions'

/**
 * Phase 6 — Parent-force gate for long skill tools.
 *
 * Returns `false` when the contract carries a `childRunId`: the child-loop
 * runner now owns "what action runs next" for that skill, and the parent
 * turn-engine MUST NOT synthesize a typed-action `tool_use` (e.g.
 * `skill_video_expert_pipeline` with `{}`). The parent should either wait
 * for the structured close event (when `parentNextHint='wait_for_close_event'`)
 * or, on explicit user continuation, call `resumeSkillChildRun(childRunId)`
 * — never the legacy `force_tool` path.
 *
 * Returns `true` only when there is NO child-run handle on the contract;
 * the migration-only `forceLoopGuard` path remains for non-child-owned
 * skills until they're migrated.
 *
 * The function only inspects `contract.childRunId`. Other fields (status,
 * parentNextHint, …) are advisory and consulted by the engine separately.
 * Accepting `unknown` keeps the helper usable from tests that synthesize a
 * minimal contract shape (the Phase 1 red test passes a plain object).
 */
export function shouldParentForceLongSkillTool(contract: unknown): boolean {
  if (!contract || typeof contract !== 'object') return true
  const candidate = (contract as { childRunId?: unknown }).childRunId
  if (typeof candidate === 'string' && candidate.trim().length > 0) return false
  return true
}

/**
 * Stage N — manifest-aware fence. True when the supplied tool name maps to
 * a `child_loop.actions[]` entry of the owning skill (manifest-based, NOT
 * driver-registry based — the Phase 0.3 boot assertion ensures the two
 * agree, but this fence is intentionally manifest-only so a mis-registered
 * driver cannot accidentally re-open the parent-force path).
 *
 * Tool-name → (skillId, action) lookup uses
 * `STATIC_SKILL_ACTIONS_BY_TOOL_NAME` (`skills-tools-static.ts:42-47`) — the
 * computed reverse map of the canonical `STATIC_SKILL_TOOL_NAMES_BY_ACTION`
 * forward literal. For dynamic skill tool names that are not in the static
 * map, this returns `false` — Phase 0.4 ensures custom skills don't reach
 * this fence, and Phase 0.2 + Phase 0.3 keep embedded manifests'
 * child_loop actions in the static map.
 */
export function isParentForceForbiddenByManifest(
  toolName: string | null | undefined,
): boolean {
  if (typeof toolName !== 'string' || !toolName) return false
  const entry = STATIC_SKILL_ACTIONS_BY_TOOL_NAME[toolName]
  if (!entry) return false
  return isConfiguredChildLoopSkillAction(entry.skillId, entry.actionName)
}
