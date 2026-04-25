// Pure-data module: contains the static skill-tool name registry that is safe
// to import statically from any process (no electron / no runtime-manager).
//
// `tool-registry` imports this rather than `skills-tools.ts` so that the
// static-names path resolves at bundle time without falling back to the
// hardcoded list that was triggering `Cannot find module '../tools/skills-tools'`
// noise in `ready-agent-metrics.log`.
//
// Phase 4: the 6 execution-control tool names (skill_get_state /
// skill_submit_* / skill_restart_from_step / skill_cancel_execution) were
// removed from the registry along with the skill_executions state machine.

const STATIC_SKILL_TOOL_NAMES_BY_ACTION: Record<string, string> = {
  'video-expert-analyzer:video_expert_pipeline': 'skill_video_expert_pipeline',
  'video-expert-analyzer:video_expert_ai_analyze': 'skill_video_expert_ai_analyze',
  'video-copy-analyzer:video_copy_analyze': 'skill_video_copy_analyze',
  'lets-go-rss:rss_add': 'skill_rss_add',
  'lets-go-rss:rss_update': 'skill_rss_update',
  'lets-go-rss:rss_status': 'skill_rss_status',
  'lets-go-rss:rss_list': 'skill_rss_list',
  'lets-go-rss:rss_stats': 'skill_rss_stats',
}

// B Phase 1 — skill primitives names. Session-gated at runtime via
// `filterSkillPrimitivesBySession` (only exposed when a reference-skill hint
// is armed). Names included here so static-fallback tool enumeration still
// lists them when the runtime manager isn't ready yet (boot path).
const PRIMITIVE_TOOL_NAMES: string[] = [
  'skill_ask_user',
  'skill_run_shell',
  'skill_write_artifact',
  'skill_read_artifact',
]

/**
 * Full static tool list — skill_action + 4 primitives. Boot-path callers
 * (ToolRegistry static fallback) use this unchanged; session-aware filtering
 * runs at dispatch time through filterSkillPrimitivesBySession.
 */
export const STATIC_SKILL_TOOL_NAMES: string[] = [
  ...Object.values(STATIC_SKILL_TOOL_NAMES_BY_ACTION),
  ...PRIMITIVE_TOOL_NAMES,
]

/**
 * Boot-safe subset (identical to STATIC_SKILL_TOOL_NAMES since Phase 4
 * retired the gated execution-control tools). Kept as a separate export for
 * backward compatibility with the tool-registry import site.
 */
export const STATIC_SKILL_TOOL_NAMES_BOOT_SAFE: string[] = STATIC_SKILL_TOOL_NAMES
