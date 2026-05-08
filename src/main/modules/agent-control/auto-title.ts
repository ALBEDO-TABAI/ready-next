/**
 * Auto-title generation for newly created tasks.
 *
 * Stage R W5.4 — non-blocking, called by TaskCard projection after the
 * first agent turn completes. Falls back to a deterministic local truncation
 * if the LLM call fails or times out.
 *
 * Source: deer-flow agents/middlewares/title_middleware.py
 */

const FALLBACK_MAX_CHARS = 16
const TARGET_MAX_CHARS = 24

export interface AutoTitleContext {
  /** LLM call returns ≤24 char Chinese title */
  llmCall?: (firstMessage: string, firstAssistantTurn: string | null) => Promise<string>
  /** abort signal (optional) */
  abortSignal?: AbortSignal
}

export async function generateTaskTitle(
  firstUserMessage: string,
  firstAssistantTurn: string | null,
  ctx: AutoTitleContext = {},
): Promise<string> {
  if (ctx.llmCall) {
    try {
      const title = await ctx.llmCall(firstUserMessage, firstAssistantTurn)
      const trimmed = (title || '').trim()
      if (trimmed.length > 0 && trimmed.length <= TARGET_MAX_CHARS * 2) {
        return trimmed.slice(0, TARGET_MAX_CHARS)
      }
    } catch {
      // silent-catch: title generation is best-effort; fall through to local fallback
    }
  }
  return localFallbackTitle(firstUserMessage)
}

export function localFallbackTitle(firstUserMessage: string): string {
  const cleaned = (firstUserMessage || '').trim().replace(/\s+/g, ' ')
  if (cleaned.length === 0) return '未命名任务'
  if (cleaned.length <= FALLBACK_MAX_CHARS) return cleaned
  return cleaned.slice(0, FALLBACK_MAX_CHARS) + '…'
}
