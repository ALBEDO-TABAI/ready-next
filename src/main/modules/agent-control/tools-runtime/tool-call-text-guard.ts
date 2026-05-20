/**
 * Phase 3.2 + post-audit hotfix — defense-in-depth against models leaking
 * tool-call markup as visible assistant text.
 *
 * Original Phase 3.2 only wrapped `session.messages.push({role:'assistant',
 * content:X})` sites in turn-engine, which protected the NEXT turn's history
 * fed back into the LLM. But the actual user-visible damage flows through
 * THREE other paths the original fix missed:
 *
 *   1. `TurnTranscript.emitOutput(chunk, 'text')` — streaming chunk pushed
 *      to the renderer chat panel. This is the primary user-visible source.
 *   2. `TurnTranscript.finalChunks` — accumulator the backend uses to build
 *      the final assistant message persisted server-side.
 *   3. `chat:saveMessage` IPC — renderer-initiated chat_messages DB write
 *      after streaming completes; raw text persisted unless sanitized.
 *
 * Extracting the helpers here lets `turn-engine.ts`, `turn-transcript.ts`,
 * and `claude-bridge/ipc-handler.ts` all import without circular deps
 * (turn-engine.ts ↔ turn-transcript.ts is a real cycle when the guard
 * lives in turn-engine).
 */

import { logAgentMetric } from '../metrics'
import { TOOL_ERROR_METRICS } from './tool-error-metrics'
import { parseTextToolBridgeResponse } from '../../claude-bridge/tool-bridge'

/**
 * Markers we treat as "this assistant text is leaking a tool call". Covers
 * the canonical `:::tool_call` JSON block (already handled by the parser but
 * defense-in-depth at push time) and the XML form some OpenAI-compatible
 * providers emit. Anchored on opening fragments so we don't false-positive
 * on prose that mentions tool names.
 *
 * Trade-off: legitimate prose that quotes the literal markers (e.g. a
 * developer asking "看一下 <tool_call> 的解析" inside the chat) gets
 * sanitized away. We accept this cost — silent prose loss is far less
 * harmful than letting unparsed XML markup render as user-visible chat
 * bubbles + persist into chat_messages. The metric `tool_call_text_intercepted`
 * surfaces every interception with `cleanedLen` so a regression to noisy
 * false-positive rate is observable.
 */
export const TOOL_CALL_TEXT_PATTERN = /<tool_calls?>|<function=|<parameter=|:::tool_call/i

export interface SanitizeAssistantTextOptions {
  sessionId?: string
  iteration?: number
  toolTransport?: 'native' | 'text'
  /**
   * Where the sanitization fired. Used by metric consumers to tell the
   * "session.messages push" leak path apart from the "transcript stream"
   * path apart from the "chat:saveMessage IPC" path. Default 'unknown'.
   */
  source?: 'session_push' | 'transcript_emit' | 'chat_save_message' | 'unknown'
}

/**
 * Return a copy of `text` with leaked tool-call markers stripped. Returns
 * the input unchanged when no markers are present (no allocation cost on
 * the common path). Emits `tool_call_text_intercepted` on every cleanup.
 *
 * Pure helper — does not push to a session. Use this when you need the
 * cleaned text for a multimodal content array OR for one-off sanitization
 * before persistence.
 */
export function sanitizeAssistantText(
  text: string,
  options: SanitizeAssistantTextOptions = {},
): string {
  if (!text || !TOOL_CALL_TEXT_PATTERN.test(text)) return text
  const parsed = parseTextToolBridgeResponse(text)
  const visibleText = TOOL_CALL_TEXT_PATTERN.test(parsed.visibleText)
    ? stripMalformedToolCallText(parsed.visibleText)
    : parsed.visibleText
  logAgentMetric(TOOL_ERROR_METRICS.toolCallTextIntercepted, {
    sessionId: options.sessionId ?? null,
    iteration: options.iteration ?? null,
    transport: options.toolTransport ?? 'unknown',
    source: options.source ?? 'unknown',
    originalLen: text.length,
    cleanedLen: visibleText.length,
    extractedToolCalls: parsed.toolCalls.length,
    extractedToolNames: parsed.toolCalls.map((call) => call.name).slice(0, 5),
  })
  return visibleText
}

function stripMalformedToolCallText(text: string): string {
  const markerIndex = text.search(TOOL_CALL_TEXT_PATTERN)
  if (markerIndex < 0) return text
  return text.slice(0, markerIndex).replace(/\n{2,}/g, '\n').trim()
}

export interface ToolCallOnlyFallback {
  text: string
  toolNames: string[]
}

export function buildToolCallOnlyFallbackText(text: string): ToolCallOnlyFallback | null {
  if (!text || !TOOL_CALL_TEXT_PATTERN.test(text)) return null
  const parsed = parseTextToolBridgeResponse(text)
  if (parsed.toolCalls.length === 0) return null
  if (parsed.visibleText.trim()) return null

  const toolNames = Array.from(new Set(
    parsed.toolCalls
      .map((call) => call.name)
      .filter(Boolean),
  ))
  const isBrowserLookup = toolNames.some((name) => name.startsWith('browser_'))
  const fallbackText = isBrowserLookup
    ? '这个问题需要网页查询来确认，但当前回合没有打开网页查询能力，所以没有拿到可信结果。'
    : '这轮需要调用工具继续处理，但当前回合没有进入对应的工具执行链路，所以没有拿到结果。'

  return {
    text: fallbackText,
    toolNames,
  }
}

/**
 * Defense-in-depth wrapper for `session.messages.push({role:'assistant',
 * content:text})`. Delegates to `sanitizeAssistantText` and only pushes
 * non-empty cleaned text.
 *
 * Returns whether the original text needed cleaning (for caller telemetry).
 */
export function pushAssistantTextSafely(
  session: { messages: Array<{ role: string; content: unknown }> },
  text: string,
  options: SanitizeAssistantTextOptions = {},
): { pushed: boolean; intercepted: boolean } {
  if (!text) {
    return { pushed: false, intercepted: false }
  }
  const cleaned = sanitizeAssistantText(text, { ...options, source: options.source ?? 'session_push' })
  const intercepted = cleaned !== text
  if (cleaned) {
    session.messages.push({ role: 'assistant', content: cleaned })
    return { pushed: true, intercepted }
  }
  return { pushed: false, intercepted }
}
