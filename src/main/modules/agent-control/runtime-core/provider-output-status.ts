/** Read transport termination facts; textual headings cannot prove completion. */
export function isProviderOutputIncomplete(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false
  const data = payload as Record<string, unknown>
  const unfinished = (value: unknown) => value === 'length' || value === 'content_filter' || value === 'max_tokens'
  const choices = Array.isArray(data.choices) ? data.choices : []
  const output = Array.isArray(data.output) ? data.output : []
  return data.status === 'incomplete' || data.status === 'failed'
    || unfinished(data.stop_reason) || unfinished(data.finish_reason)
    || [...choices, ...output].some((item) => item && typeof item === 'object' && unfinished(item.finish_reason))
}
