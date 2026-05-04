/**
 * Stage 2.1a — pure parser for the `arguments` string a provider returns
 * inside a `tool_calls[*].function.arguments` (Chat Completions) or
 * `output[*].arguments` (Responses API) field.
 *
 * Lives in its own module (no Electron deps, no provider client coupling)
 * so unit tests can exercise every shape under plain Node, matching the
 * 2.4a / 2.2 precedents (`direct-chat-ai-config.ts`,
 * `direct-chat-attachment-metrics.ts`).
 *
 * Contract:
 * - Empty string / undefined / null / `'{}'` → `ok: true, input: {}`
 *   (preserves the legitimate "tool needs no arguments" path; the helper
 *   must not flag a real provider behaviour as corrupt).
 * - JSON parses to a plain non-array object → `ok: true, input: parsed`.
 * - JSON parses but is an array / string / number / boolean / null → corrupt.
 * - JSON.parse throws → corrupt.
 *
 * `rawSample` is truncated to 200 characters so a 50KB malformed payload
 * cannot dominate the metric log line.
 *
 * The helper does NOT call `logAgentMetric` itself — emitting is the
 * caller's responsibility because the call site has the provider-route
 * context (`'chat_completions'` vs `'responses'`) and the per-call
 * `toolName` / `callId` that operators need on the dashboard.
 */
export type ParsedProviderToolArguments =
  | { ok: true; input: Record<string, unknown> }
  | { ok: false; reason: 'corrupt'; rawSample: string }

const RAW_SAMPLE_MAX = 200

export function parseProviderToolArguments(
  text: string | null | undefined,
): ParsedProviderToolArguments {
  const raw = text == null ? '' : String(text)
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed === '{}') {
    return { ok: true, input: {} }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { ok: false, reason: 'corrupt', rawSample: trimmed.slice(0, RAW_SAMPLE_MAX) }
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return { ok: true, input: parsed as Record<string, unknown> }
  }
  return { ok: false, reason: 'corrupt', rawSample: trimmed.slice(0, RAW_SAMPLE_MAX) }
}

/**
 * Stage 2.1a follow-up — dispatch helpers for the two provider routes.
 *
 * Pulled out of `OpenAIExecutionClient` so tests can pin both wirings:
 * a future commit cannot quietly bypass the parser without breaking the
 * `buildChatCompletionsToolCalls` / `buildResponsesToolCalls` test
 * contracts.
 *
 * Helpers do NOT call `logAgentMetric`. Each call site emits the metric
 * with its own `route` label, so the helper stays pure / route-agnostic.
 */
export interface ProviderToolCallFailure {
  toolName: string | null
  callId: string | null
  rawSample: string
}

export interface ProviderToolCallBuildResult {
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>
  failures: ProviderToolCallFailure[]
}

interface ChatCompletionsToolCallSource {
  id?: string
  function?: { name?: string; arguments?: string }
}

export function buildChatCompletionsToolCalls(
  raw: ChatCompletionsToolCallSource[] | null | undefined,
): ProviderToolCallBuildResult {
  const result: ProviderToolCallBuildResult = { toolCalls: [], failures: [] }
  for (const tc of raw || []) {
    const toolName =
      typeof tc.function?.name === 'string' && tc.function.name.length > 0
        ? tc.function.name
        : null
    const callId = typeof tc.id === 'string' && tc.id.length > 0 ? tc.id : null
    const parsed = parseProviderToolArguments(tc.function?.arguments)
    if (!parsed.ok) {
      result.failures.push({ toolName, callId, rawSample: parsed.rawSample })
      continue
    }
    result.toolCalls.push({
      id: tc.id || '',
      name: tc.function?.name || '',
      input: parsed.input,
    })
  }
  return result
}

interface ResponsesFunctionCallSource {
  type?: string
  call_id?: unknown
  name?: unknown
  arguments?: unknown
}

export function buildResponsesToolCalls(
  raw: ResponsesFunctionCallSource[] | null | undefined,
  generateFallbackId: () => string,
): ProviderToolCallBuildResult {
  const result: ProviderToolCallBuildResult = { toolCalls: [], failures: [] }
  for (const item of raw || []) {
    if (item.type !== 'function_call') continue
    const callId =
      typeof item.call_id === 'string' && item.call_id.length > 0 ? item.call_id : null
    const toolName =
      typeof item.name === 'string' && item.name.length > 0 ? item.name : null
    const argumentsText = typeof item.arguments === 'string' ? item.arguments : '{}'
    const parsed = parseProviderToolArguments(argumentsText)
    if (!parsed.ok) {
      result.failures.push({ toolName, callId, rawSample: parsed.rawSample })
      continue
    }
    result.toolCalls.push({
      id: callId || generateFallbackId(),
      name: typeof item.name === 'string' ? item.name : '',
      input: parsed.input,
    })
  }
  return result
}
