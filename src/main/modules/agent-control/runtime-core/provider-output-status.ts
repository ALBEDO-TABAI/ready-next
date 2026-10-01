/** Read transport termination facts; textual headings cannot prove completion. */
export class ProviderOutputIncompleteError extends Error {
  constructor() { super('模型已返回，但明确报告输出未完整结束，本次未发布结果。'); this.name = 'ProviderOutputIncompleteError' }
}

export class ProviderOutputMissingTextError extends Error {
  constructor() { super('模型已确认响应完成，但没有返回可用的最终正文，本次未发布结果。'); this.name = 'ProviderOutputMissingTextError' }
}

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
