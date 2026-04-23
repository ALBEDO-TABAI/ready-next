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

/**
 * Session-gated workflow-control tools (5 names). When the static fallback
 * path runs during early boot — before the runtime-manager is ready — we
 * deliberately REFUSE to advertise these names: the model would otherwise see
 * `skill_submit_input` while no execution exists yet, fabricate an id, and
 * loop. Patch A2.
 */
const EXECUTION_CONTROL_GATED_TOOL_NAMES: string[] = [
  'skill_submit_input',
  'skill_submit_confirmation',
  'skill_submit_agent_result',
  'skill_restart_from_step',
  'skill_cancel_execution',
]

/** Read-only execution tool — always safe to advertise. */
const EXECUTION_CONTROL_READ_ONLY_TOOL_NAMES: string[] = [
  'skill_get_state',
]

const EXECUTION_CONTROL_TOOL_NAMES: string[] = [
  ...EXECUTION_CONTROL_READ_ONLY_TOOL_NAMES,
  ...EXECUTION_CONTROL_GATED_TOOL_NAMES,
]

// B Phase 1 — skill primitives are also kind='execution_control' from the
// registry's perspective, but are session-gated separately. Names included
// here so static-fallback tool enumeration still lists them when the runtime
// manager isn't ready yet (boot path). `skill_ask_user` lands with Phase 1
// PR2; do not list it until its handler is live, otherwise the static
// fallback advertises a tool that the dispatch layer would answer with
// "Unknown skill tool".
const PRIMITIVE_TOOL_NAMES: string[] = [
  'skill_run_shell',
  'skill_write_artifact',
  'skill_read_artifact',
]

/**
 * Full static tool list — includes the 5 gated tools. Use for documentation,
 * snapshot comparisons, or callers that will subsequently filter by session
 * state. Do NOT feed this directly to the LLM during early boot; use
 * `STATIC_SKILL_TOOL_NAMES_BOOT_SAFE` instead.
 */
export const STATIC_SKILL_TOOL_NAMES: string[] = [
  ...Object.values(STATIC_SKILL_TOOL_NAMES_BY_ACTION),
  ...EXECUTION_CONTROL_TOOL_NAMES,
  ...PRIMITIVE_TOOL_NAMES,
]

/**
 * Boot-safe subset: skill action tools + `skill_get_state` + primitives, but
 * excludes the 5 gated submit/restart/cancel tools. This is what the
 * ToolRegistry's static fallback advertises while the runtime-manager is
 * booting. The gated tools re-appear dynamically via session-aware providers
 * (`filterExecutionControlToolsBySession`) once a session actually has an
 * active execution. Patch A2.
 */
export const STATIC_SKILL_TOOL_NAMES_BOOT_SAFE: string[] = [
  ...Object.values(STATIC_SKILL_TOOL_NAMES_BY_ACTION),
  ...EXECUTION_CONTROL_READ_ONLY_TOOL_NAMES,
  ...PRIMITIVE_TOOL_NAMES,
]
