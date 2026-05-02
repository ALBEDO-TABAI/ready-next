export const RENDERER_AGENT_METRICS = [
  'renderer_send_persistence_failed',
  'renderer_attachment_input_failed',
  'renderer_friendly_error_surfaced',
  'renderer_assistant_persistence_failed',
] as const

export type RendererAgentMetricName = typeof RENDERER_AGENT_METRICS[number]

const RENDERER_AGENT_METRIC_SET = new Set<string>(RENDERER_AGENT_METRICS)

export function isRendererAgentMetricName(value: unknown): value is RendererAgentMetricName {
  return typeof value === 'string' && RENDERER_AGENT_METRIC_SET.has(value)
}
