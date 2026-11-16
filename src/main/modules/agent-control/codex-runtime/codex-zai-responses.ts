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

/** What the public Responses API echoes from the request onto its `response` object. None of it is model output. */
const RESPONSES_API_REQUEST_ECHO = [
  'background', 'billing', 'completed_at', 'conversation', 'instructions', 'max_output_tokens', 'max_tool_calls',
  'metadata', 'parallel_tool_calls', 'previous_response_id', 'prompt', 'prompt_cache_key', 'prompt_cache_retention',
  'reasoning', 'safety_identifier', 'service_tier', 'store', 'temperature', 'text', 'tool_choice', 'tools',
  'top_logprobs', 'top_p', 'truncation', 'user',
]

/**
 * The public Responses API as an API-key provider speaks it: the request echo, empty `annotations` / `logprobs`
 * and the `obfuscation` padding on delta events are dropped. Anything else Ready does not know is left in place
 * for validation to refuse.
 */
export function normalizeResponsesApiEvent(payload: JsonObject): JsonObject {
  const result = normalizeZaiResponseEvent(payload)
  if (typeof result.obfuscation === 'string') delete result.obfuscation
  if (record(result.response)) {
    const response = { ...result.response }
    for (const key of RESPONSES_API_REQUEST_ECHO) delete response[key]
    result.response = response
  }
  for (const key of ['item', 'part'] as const) {
    const value = result[key]
    if (record(value) && Array.isArray(value.logprobs) && value.logprobs.length === 0) {
      const { logprobs: _logprobs, ...rest } = value
      result[key] = rest
    }
  }
  return result
}
