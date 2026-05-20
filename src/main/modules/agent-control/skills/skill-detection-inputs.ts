import { matchesConfigRepairIntent, matchesResumeIntent } from '../resume-lexicon'

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const text = String(value || '').trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    result.push(text)
  }
  return result
}

/**
 * Phase 2.2 — fresh-request markers reject liberal matches that look like
 * NEW asks even though they start with a continuation root. Without this,
 * "继续帮我搜索一下" or "继续，我想换个方向" would auto-attach recall and arm
 * the previous skill's hint, polluting the next turn. Hoisted to a constant
 * so it's grep-able when adding new markers.
 */
const FRESH_REQUEST_MARKERS = /[?？!!@()<>《》【】[\]]|帮(我|忙)|请(帮|你|给)|我想|我要|可以吗|能不能|怎么|为什么|什么|哪个|多少|搜索|查询|查一下|搜一下|换个|换成|换一/

export function isRetryOnlyTurn(text: string): boolean {
  const normalized = String(text || '').trim()
  if (!normalized) return false
  // Phase 2.2 — hard cap raised 32→48 so natural Chinese phrasings like
  // "从头重新跑一次看看刚才的任务" still get a chance at the liberal path.
  // Anything above 48 chars almost certainly carries new instructions and
  // should be treated as a fresh task.
  if (normalized.length > 48) return false
  // Strict short forms — bare resume commands ("继续", "重新跑一次",
  // "从头跑一轮"). The lexicon is the single source for what counts.
  if (matchesResumeIntent(normalized, 'strict')) return true
  // Phase 2.2 — liberal extension for natural Chinese continuation
  // phrasings that the strict regex misses, e.g.
  //   "继续之前任务", "继续上次的视频分析", "接着上次做",
  //   "继续未完成的任务", "继续完成视频分析",
  //   "重新跑一次刚才的", "从头重新跑一次".
  // Constraints to avoid false positives: short text (≤32 chars, was 24),
  // starts with a continuation root, contains no question/fresh-request
  // markers.
  if (normalized.length > 32) return false
  if (!matchesResumeIntent(normalized, 'liberal')) return false
  if (FRESH_REQUEST_MARKERS.test(normalized)) return false
  return true
}

export function isConfigRepairTurn(text: string): boolean {
  return matchesConfigRepairIntent(text)
}

export function buildSkillDetectionInputs(params: {
  contextualUserInput: string
  primaryInstruction?: string | null
  pureUserText?: string | null
  previousPureUserInputs?: string[] | null
  /**
   * skill-resume A2 — list of recent skill tool-use names (e.g.
   * `skill_video_expert_pipeline`, `skill_run_shell`) extracted from prior
   * assistant messages. When the current turn is a bare retry intent, these
   * are appended so substring matching can re-discover the skill the agent
   * was using before, even when the user's text doesn't name it.
   */
  previousAssistantSkillToolUses?: string[] | null
}): string[] {
  const currentInputs = uniqueNonEmpty([
    params.primaryInstruction,
    params.pureUserText,
    params.contextualUserInput,
  ])
  // Phase 2.3 — detect retry-only on the SHORT primary+pure pair, not on
  // contextualUserInput. contextualUserInput often inherits a previous turn's
  // widget-attachment text (`### Widget 更新上下文`, `--- 文档内容开始 ---`
  // blobs), which is dozens of KB and would never match isRetryOnlyTurn even
  // when the user's actual ask ("继续") clearly does. Audit Phase 2 §B3.
  //
  // Fallback: if a caller doesn't pass primary/pure (some test fixtures and
  // legacy code paths), fall back to currentInputs so detection still runs.
  // The widget-pollution risk only exists when contextualUserInput is large
  // AND a separate primary/pure conveys the real ask; in the fallback path
  // contextualUserInput IS the only signal, so we keep it.
  const retryProbes = uniqueNonEmpty([params.primaryInstruction, params.pureUserText])
  const probesForRetryCheck = retryProbes.length > 0 ? retryProbes : currentInputs
  const shouldReuseRecentGoals = probesForRetryCheck.some((text) =>
    isRetryOnlyTurn(text) || isConfigRepairTurn(text),
  )
  if (!shouldReuseRecentGoals) return currentInputs

  // Phase 2.3 — when retry confirmed via primary/pure: drop contextualUserInput
  // from the appended inputs (widget pollution). When confirmed via the
  // currentInputs fallback (no primary/pure): keep currentInputs as-is so we
  // don't silently lose the user's command.
  const baseInputs = retryProbes.length > 0 ? retryProbes : currentInputs
  return uniqueNonEmpty([
    ...baseInputs,
    ...(params.previousPureUserInputs || []).slice(0, 6),
    ...(params.previousAssistantSkillToolUses || []).slice(0, 5),
  ])
}

/**
 * skill-resume A2 — extract `skill_<id>_*` tool-use names from recent assistant
 * messages. Returns deduped substrings suitable to feed into
 * findExplicitlyRequestedSkills (which uses substring match on skill id/name).
 *
 * `messages` accepts the loose role+content structure used by direct-chat /
 * turn-engine. Tool uses can appear either as Anthropic-style `content`
 * arrays of `{ type: 'tool_use', name }` blocks, or as plain text mentioning
 * the tool name. Both shapes are scanned defensively.
 */
export function collectRecentAssistantSkillToolUses(
  messages: ReadonlyArray<{ role?: string; content?: unknown }>,
  limit = 5,
): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  // Walk newest → oldest so we collect the most recent N skill names.
  for (let i = messages.length - 1; i >= 0 && result.length < limit; i -= 1) {
    const msg = messages[i]
    if (msg?.role !== 'assistant') continue
    const candidates: string[] = []
    if (Array.isArray(msg.content)) {
      for (const block of msg.content as unknown[]) {
        if (block && typeof block === 'object') {
          const rec = block as { type?: unknown; name?: unknown }
          if (rec.type === 'tool_use' && typeof rec.name === 'string' && /^skill_/.test(rec.name)) {
            candidates.push(rec.name)
          }
        }
      }
    } else if (typeof msg.content === 'string') {
      // Text-bridge transport: the LLM's tool calls land as text. Match the
      // canonical skill_<id>_<action> pattern.
      for (const match of msg.content.matchAll(/\bskill_[a-z][a-z0-9_]*\b/g)) {
        candidates.push(match[0])
      }
    }
    for (const name of candidates) {
      if (seen.has(name)) continue
      seen.add(name)
      result.push(name)
      if (result.length >= limit) break
    }
  }
  return result
}
