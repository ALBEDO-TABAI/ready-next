type JsonObject = Record<string, unknown>
function record(value: unknown): value is JsonObject { return !!value && typeof value === 'object' && !Array.isArray(value) }

/** Providers without phases reveal tool intent only after streaming their prose. */
export function createProviderMessagePhaseNormalizer(): (event: JsonObject) => JsonObject[] {
  const pending: JsonObject[] = []
  const phases = new Map<string, string>()
  const flush = (final: boolean): JsonObject[] => pending.splice(0).map((event, index, all) => {
    const item = event.item as JsonObject
    const phase = final && index === all.length - 1 ? 'final_answer' : 'commentary'
    phases.set(String(item.id), phase)
    return { ...event, item: { ...item, phase } }
  })
  return (event) => {
    if (event.type === 'response.output_item.done' && record(event.item)
      && event.item.type === 'message' && event.item.phase === undefined) {
      pending.push(event)
      return []
    }
    if (event.type === 'response.output_item.added' && record(event.item) && event.item.type === 'function_call') {
      return [...flush(false), event]
    }
    if (['response.completed', 'response.incomplete', 'response.failed'].includes(String(event.type))) {
      const done = flush(event.type === 'response.completed')
      const response = event.response
      return [...done, record(response) && Array.isArray(response.output) ? {
        ...event, response: { ...response, output: response.output.map((item) => (
          record(item) && item.type === 'message' && item.phase === undefined && phases.has(String(item.id))
            ? { ...item, phase: phases.get(String(item.id)) } : item
        )) },
      } : event]
    }
    return [event]
  }
}
