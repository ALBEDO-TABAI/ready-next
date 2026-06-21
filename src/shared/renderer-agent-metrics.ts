export const RENDERER_AGENT_METRICS = [
  'renderer_send_persistence_failed',
  'renderer_send_failed_after_persisted_message',
  'renderer_attachment_input_failed',
  'renderer_friendly_error_surfaced',
  'renderer_assistant_persistence_failed',
  'renderer_assistant_done_finalize_failed',
  'legacy_handoff_text_fallback_used',
  'scope_create_persistence_failed',
  // Stage U (PR 1, B.5) — sendMessage's pre-send hook hit its 2000ms hard
  // cap while awaiting an ask_user_questions cancel IPC. The card stays
  // pending locally with `localDisabled=true` until the late cancel lands.
  'ask_user_questions_cancel_pre_send_timeout',
  // Stage X2.6 — the runtime driver's 60s infrastructure-timeout
  // safety net fired (no terminal event of any kind arrived after a
  // send). The originating session is auto-unlocked and a "Ready lost
  // track" toast is surfaced. See plan §7.2 last paragraph.
  'renderer_infrastructure_timeout_fired',
] as const

export type RendererAgentMetricName = typeof RENDERER_AGENT_METRICS[number]

const RENDERER_AGENT_METRIC_SET = new Set<string>(RENDERER_AGENT_METRICS)

export function isRendererAgentMetricName(value: unknown): value is RendererAgentMetricName {
  return typeof value === 'string' && RENDERER_AGENT_METRIC_SET.has(value)
}
