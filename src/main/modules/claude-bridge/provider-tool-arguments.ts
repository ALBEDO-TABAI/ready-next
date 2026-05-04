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
