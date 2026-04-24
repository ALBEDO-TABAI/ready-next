// Pure-data module: contains the static skill-tool name registry that is safe
// to import statically from any process (no electron / no runtime-manager).
//
// `tool-registry` imports this rather than `skills-tools.ts` so that the
// static-names path resolves at bundle time without falling back to the
// hardcoded list that was triggering `Cannot find module '../tools/skills-tools'`
// noise in `ready-agent-metrics.log`.

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

// B Phase 1 — skill primitives. Still session-gated via
// `filterSkillPrimitivesBySession` (reference-skill hint or active
// execution); static fallback lists them unconditionally so tool-registry
// inventory stays stable during early boot.
//
// B Phase 4 PR2 removed the 6 execution-control tool names (`skill_get_state`
// and the 5 `skill_submit_*` / `skill_restart_from_step` /
// `skill_cancel_execution` entries). They are retired alongside the state
// machine.
const PRIMITIVE_TOOL_NAMES: string[] = [
  'skill_ask_user',
  'skill_run_shell',
  'skill_write_artifact',
  'skill_read_artifact',
]

/**
 * Full static tool list — now equal to the boot-safe subset since the 5
 * gated execution-control names were retired in B Phase 4 PR2. Kept as a
 * separate export for stable import sites.
 */
export const STATIC_SKILL_TOOL_NAMES: string[] = [
  ...Object.values(STATIC_SKILL_TOOL_NAMES_BY_ACTION),
  ...PRIMITIVE_TOOL_NAMES,
]

/**
 * Boot-safe subset retained for backward-compat import paths. Post-PR2 this
 * matches `STATIC_SKILL_TOOL_NAMES` exactly; kept separate so callers that
 * used the boot-safe name continue to resolve without churn.
 */
export const STATIC_SKILL_TOOL_NAMES_BOOT_SAFE: string[] = [
  ...Object.values(STATIC_SKILL_TOOL_NAMES_BY_ACTION),
  ...PRIMITIVE_TOOL_NAMES,
]
