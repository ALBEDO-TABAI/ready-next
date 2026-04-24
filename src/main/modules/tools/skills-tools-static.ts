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

const EXECUTION_CONTROL_TOOL_NAMES: string[] = [
  'skill_get_state',
  'skill_submit_input',
  'skill_submit_confirmation',
  'skill_submit_agent_result',
  'skill_restart_from_step',
  'skill_cancel_execution',
]

const STATIC_SKILL_PRIMITIVE_TOOL_NAMES: string[] = [
  'skill_ask_user',
  'skill_run_shell',
  'skill_write_artifact',
  'skill_read_artifact',
]

export const STATIC_SKILL_TOOL_NAMES: string[] = [
  ...Object.values(STATIC_SKILL_TOOL_NAMES_BY_ACTION),
  ...EXECUTION_CONTROL_TOOL_NAMES,
  ...STATIC_SKILL_PRIMITIVE_TOOL_NAMES,
]
