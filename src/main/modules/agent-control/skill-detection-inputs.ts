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

export function isRetryOnlyTurn(text: string): boolean {
  const normalized = String(text || '').trim()
  if (!normalized) return false
  if (normalized.length > 32) return false
  // Strict short forms (historical contract — kept verbatim)
  const strictTail = /^(再?重试(一次|一下)?|再试(一次|一下)?|再来(一次|一下)?|重新(试|来|开始)|继续(一下|处理|执行|刚才|上次|当前|这个|任务)?|接着(来|做|处理|执行)?|恢复(上次|刚才|当前)?|try again|retry|continue|resume)$/i
  if (strictTail.test(normalized)) return true
  // skill-resume G1 — liberal extension for natural Chinese continuation
  // phrasings that the strict regex misses, e.g.
  //   "继续之前任务", "继续上次的视频分析", "接着上次做",
  //   "继续未完成的任务", "继续完成视频分析"
  // Constraints to avoid false positives: short text (≤24 chars), starts with
  // a continuation root, contains no question/fresh-request markers.
  if (normalized.length > 24) return false
  if (!/^(继续|接着|恢复|再来|重做|继续完成|接着做|接着完成)/.test(normalized)) return false
  if (/[?？!!@()<>《》【】\[\]]|帮(我|忙)|请(帮|你|给)|我想|我要|可以吗|能不能|怎么|为什么|什么|哪个|多少|搜索|查询|查一下|搜一下|换个|换成|换一/.test(normalized)) return false
  return true
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
    params.contextualUserInput,
    params.primaryInstruction,
    params.pureUserText,
  ])
  const shouldReuseRecentGoals = currentInputs.some(isRetryOnlyTurn)
  if (!shouldReuseRecentGoals) return currentInputs

  return uniqueNonEmpty([
    ...currentInputs,
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
