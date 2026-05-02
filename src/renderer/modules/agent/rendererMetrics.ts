import type { RendererAgentMetricName } from '../../../shared/renderer-agent-metrics'

export function emitRendererAgentMetric(
  name: RendererAgentMetricName,
  payload: Record<string, unknown> = {},
): void {
  if (typeof window === 'undefined') return
  const emitMetric = window.electronAPI?.agent?.emitRendererMetric
  if (!emitMetric) return
  void emitMetric(name, payload).catch(() => {
    // silent-catch: renderer metrics are best-effort and must not affect user flow
  })
}
