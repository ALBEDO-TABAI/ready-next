/**
 * Stage R W1.1/W1.2 — fallback metric names for web tools.
 *
 * Lives in its own module per CLAUDE.md §6.11: tool-error metrics live in
 * `TOOL_ERROR_METRICS`, but other observability metrics (fallback edges,
 * resolution outcomes, …) stay close to their producers. These names are
 * emitted via `logAgentMetric(WEB_TOOL_FALLBACK_METRICS.X, payload)`.
 */

export const WEB_TOOL_FALLBACK_METRICS = {
  WEB_SEARCH_TAVILY_TO_DDG: 'web_search_tavily_to_ddg_fallback',
  WEB_FETCH_JINA_TO_TAVILY: 'web_fetch_jina_to_tavily_fallback',
} as const

export type WebToolFallbackMetric =
  (typeof WEB_TOOL_FALLBACK_METRICS)[keyof typeof WEB_TOOL_FALLBACK_METRICS]
