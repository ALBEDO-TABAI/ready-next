type JsonObject = Record<string, unknown>
function record(value: unknown): value is JsonObject { return !!value && typeof value === 'object' && !Array.isArray(value) }

/** Z.ai echoes request metadata. It is not response authority or model output. */
export function normalizeZaiResponseEvent(payload: JsonObject): JsonObject {
  const part = (value: unknown): unknown => {
    if (!record(value) || !Array.isArray(value.annotations) || value.annotations.length) return value
    const { annotations: _annotations, ...rest } = value
    return rest
  }
  const item = (value: unknown): unknown => {
    if (!record(value)) return value
    return {
      ...value,
      ...(Array.isArray(value.content) ? { content: value.content.map(part) } : {}),
    }
  }
  const result = { ...payload }
  if (Array.isArray(result.logprobs) && result.logprobs.length === 0) delete result.logprobs
  if (record(result.response)) {
    const response = { ...result.response }
    for (const key of ['conversation_id', 'instructions', 'metadata', 'parallel_tool_calls', 'previous_response_id', 'prompt_cache_key']) delete response[key]
    if (Array.isArray(response.output)) response.output = response.output.map(item)
    result.response = response
  }
  if (result.item) result.item = item(result.item)
  if (result.part) result.part = part(result.part)
  return result
}
