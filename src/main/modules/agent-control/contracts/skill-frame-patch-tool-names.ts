/**
 * Canonical list of tool names whose results emit a `framePatch.runContract`
 * (or a structurally-equivalent contract update). Used by Gamma's Wave 2
 * parallelism gate (`tool-parallelism-policy.ts`) to ensure no
 * frame-mutating skill tool is ever marked read-only parallel-safe.
 *
 * Static names are listed verbatim. The dynamic typed action wrapper
 * `skill_<id>_<action>` is matched via `isFramePatchEmittingToolName(name)`
 * since the exact tool name varies per skill manifest.
 */
export const FRAME_PATCH_EMITTING_TOOL_NAMES: readonly string[] = [
  'skill_inspect_run_state',
  'skill_patch_config',
  'skill_start_detached',
  'skill_cancel_detached',
  'skill_inspect_detached',
] as const

/**
 * Predicate matching any tool name that emits a frame-patch `runContract`
 * update — both the static primitives in `FRAME_PATCH_EMITTING_TOOL_NAMES`
 * and the dynamic typed action wrappers `skill_<id>_<action>`.
 *
 * Gamma's parallelism gate must use this predicate (not the static list
 * alone) so typed actions are correctly excluded from the read-only
 * parallel-safe set.
 */
export function isFramePatchEmittingToolName(toolName: string): boolean {
  if (!toolName || typeof toolName !== 'string') return false
  if (FRAME_PATCH_EMITTING_TOOL_NAMES.includes(toolName)) return true
  // Dynamic typed actions are exposed as `skill_<id>_<action>`. The
  // primitives list above is exhaustive for non-typed names; anything
  // else that begins with `skill_` and is not a primitive is a typed
  // action emitter.
  if (!toolName.startsWith('skill_')) return false
  const PRIMITIVE_NAMES = new Set([
    'skill_ask_user',
    'skill_run_shell',
    'skill_write_artifact',
    'skill_read_artifact',
    'skill_patch_config',
    'skill_start_detached',
    'skill_inspect_detached',
    'skill_cancel_detached',
    'skill_inspect_run_state',
  ])
  return !PRIMITIVE_NAMES.has(toolName)
}
