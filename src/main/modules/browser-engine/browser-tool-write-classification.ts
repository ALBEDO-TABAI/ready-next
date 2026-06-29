/**
 * Read/write classification for every browser tool (counterplan §5.2.1-2, WP0.11).
 *
 * The Agent Browser write-lease guards *write* calls only. Per the review,
 * classification is by the ACTUAL EFFECT OF THIS CALL, never by tool name
 * alone: some tools (`browser_extract_structured`) are read-only when observing
 * the current page but become writes when an explicit `url` makes them open or
 * navigate a tab. `browser_execute_js` runs arbitrary code whose read-only-ness
 * is statically undecidable, so it is always classified `write` — we make no
 * false read-only promise.
 *
 * This static table is the single source of truth. A contract test asserts the
 * classification of every registered browser tool against it, so the table can
 * never silently drift from the catalog.
 *
 * Pure module — no Electron, no IO.
 */

export type BrowserToolEffect = 'read' | 'write'

/** Tools that never mutate page/tab state regardless of args. */
const ALWAYS_READ = new Set<string>([
  'browser_get_tabs',
  'browser_read_page',
  'browser_read_page_map',
  'browser_probe_readonly',
  'browser_capture_viewport',
  'browser_probe_workflow_state',
  'browser_locate_action_targets',
  'browser_locate_input_targets',
  'browser_analyze_viewport',
  'browser_list_upload_targets',
  'browser_collect_images',
  'browser_resolve_video',
  'browser_download_urls',
  'browser_download_collected_media',
  'browser_aggregate_results',
  'browser_get_task',
  'browser_cancel_task',
  'browser_confirm_collection_consent',
  'browser_ask_user_takeover',
  'browser_wait',
])

/** Tools that always mutate page/tab state (navigate, click, type, scroll, upload, run code, launch page-mutating work). */
const ALWAYS_WRITE = new Set<string>([
  'browser_navigate',
  'browser_search',
  'browser_click',
  'browser_click_text',
  'browser_type',
  'browser_type_smart',
  'browser_compose_message',
  'browser_upload_scope_attachment',
  'browser_click_at',
  'browser_type_at',
  'browser_scroll_at',
  'browser_send_keys',
  'browser_query_gemini',
  'browser_go_back',
  'browser_scroll_collect', // always scrolls the page (and navigates when url is present)
  'browser_run_workflow',
  'browser_start_task', // launches page-mutating background work that may reuse the active tab
  'browser_resume_task',
  'browser_download_gallery', // starts a scroll_collect task
  'browser_research_topic', // starts a navigating research task
  'browser_execute_js', // arbitrary code — undecidable, never a false read-only promise
  'browser_power_eval', // arbitrary code — Power Mode still mutates/executes in page context
  'browser_power_cdp', // CDP method effect is undecidable from the tool name; fail closed as write
  'browser_power_network_trace', // may navigate to url and attaches debugger/network domains
  'browser_power_resource_forensics', // may navigate/trace/play resource discovery
  'browser_power_script_run', // multi-step Power workflow
  'browser_media_download_advanced', // may run resource forensics and filesystem writes
  'browser_act_on_target',
  'browser_visible_collect',
  'browser_collect_notes', // ensures a background agent tab + launches page-mutating collection
])

/**
 * Tools whose effect depends on args. Each predicate returns true when THIS
 * call writes. The map is consulted before the static sets so a tool can live
 * in exactly one place.
 */
const CONDITIONAL: Record<string, (args: Record<string, unknown>) => BrowserToolEffect> = {
  // Reads the current page by default; opening/navigating a `url` makes it a write.
  browser_extract_structured: (args) =>
    typeof args.url === 'string' && args.url.trim().length > 0 ? 'write' : 'read',
  browser_inspect_resources: (args) =>
    typeof args.url === 'string' && args.url.trim().length > 0 ? 'write' : 'read',
  browser_stage_site_strategy: () => 'read',
  // Pure waiting is a read, but condition=custom_js runs page JS — that path is
  // a write under the same "any JS-executing call is a write" rule as execute_js.
  browser_wait_for_condition: (args) =>
    args.condition === 'custom_js' || (typeof args.custom_js === 'string' && args.custom_js.trim().length > 0)
      ? 'write'
      : 'read',
}

export function classifyBrowserToolCall(
  toolName: string,
  args: Record<string, unknown> = {},
): BrowserToolEffect {
  const conditional = CONDITIONAL[toolName]
  if (conditional) return conditional(args)
  if (ALWAYS_WRITE.has(toolName)) return 'write'
  if (ALWAYS_READ.has(toolName)) return 'read'
  // Unknown tools default to write: fail-closed so a new mutating tool cannot
  // slip past the lease just because someone forgot to register it.
  return 'write'
}

export function isClassifiedBrowserTool(toolName: string): boolean {
  return (
    toolName in CONDITIONAL ||
    ALWAYS_WRITE.has(toolName) ||
    ALWAYS_READ.has(toolName)
  )
}

/** Exposed for the contract test so it can enumerate the full registered table. */
export const BROWSER_TOOL_WRITE_CLASSIFICATION = {
  alwaysRead: ALWAYS_READ,
  alwaysWrite: ALWAYS_WRITE,
  conditional: CONDITIONAL,
}
