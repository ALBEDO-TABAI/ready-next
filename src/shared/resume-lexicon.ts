/**
 * Shared single-source-of-truth lexicon for "this turn looks like the
 * user wants to resume / retry / continue something".
 *
 * Three judgers in three modules historically owned three independent regex
 * sets that disagreed on which Chinese phrasings counted as continuation:
 *
 *   - `isRetryOnlyTurn`            (skill-detection-inputs.ts)
 *   - `parseContinuationControlText.shouldResolveContinuation`
 *                                  (continuation-state.ts)
 *   - inline `/(继续|接着|恢复|上次|重试)/.test(...)` in turn-engine.ts
 *
 * The drift caused real production bugs: a user typing "你需要从头跑一轮" or
 * "从头重新跑一次看看" hit none of the three regexes, so VEA continuation never
 * armed and the turn fell through to the plain-answer channel where the model
 * could leak `<tool_call>` text into the chat panel. See audit Phase 2 §B1/B2.
 *
 * This module exposes ONE lexicon and three matching modes. Adding a new
 * natural phrase is a single-line edit here instead of three diverging diffs.
 */

/**
 * Canonical resume / retry / continue tokens. Order matters only for human
 * readability; matching is regex-based, not list-iterated. ENGLISH tokens
 * sit at the bottom — they are anchored and not used as partial matches.
 */
export const RESUME_KEYWORDS = [
  // CN — single-character roots (combine with quantity / verb suffixes)
  '继续',
  '续作',
  '接着',
  '恢复',
  '再来',
  '重做',
  '重新',
  '从头',
  '再试',
  '再跑',
  '上次',
  '重试',
  // EN — full-word matches
  'try again',
  'retry',
  'continue',
  'resume',
] as const

export const CONFIG_REPAIR_KEYWORDS = [
  'key',
  'api key',
  'token',
  '令牌',
  '模型',
  'model',
  'provider',
  '渠道',
  '供应商',
  '配置好了',
  '更新了',
  '修好了',
  '应该可以了',
] as const

/**
 * Mode picks which regex to apply.
 *
 *   - `strict`   — entire string equals one of the canonical short forms.
 *                  Used by `isRetryOnlyTurn` to detect a bare resume command
 *                  ("继续", "重新跑一次", "从头跑一轮"). These earn the
 *                  retry-only optimization (auto-attach recall, reuse last
 *                  goal) because they carry no new instructions.
 *
 *   - `liberal`  — text starts with a continuation root and is short. Used
 *                  by `isRetryOnlyTurn`'s G1 liberal path; combined with a
 *                  fresh-request marker check at the call site to reject
 *                  things like "继续帮我搜索一下" (new task).
 *
 *   - `anywhere` — text contains any continuation token. Used by
 *                  `parseContinuationControlText.shouldResolveContinuation`
 *                  and turn-engine's implicit continuation gate. Permissive
 *                  on purpose: a false positive only triggers a continuation
 *                  lookup that returns null when no candidate exists; a false
 *                  negative loses the resume entirely (Codex root cause).
 */
export type ResumeMode = 'strict' | 'liberal' | 'anywhere'

/**
 * Strict full-match: the entire (trimmed) input must equal one of these
 * canonical short forms.
 *
 * Build sources:
 *   - The historical `isRetryOnlyTurn` strict regex
 *   - + 重新跑 / 重新执行 / 重新做 / 从头跑 / 从头重新 / 再跑 family
 *   - + optional quantity suffix (一次 / 一下 / 一轮 / 一遍)
 */
const EXACT_RETRY_FULL_MATCH = /^(?:(?:你|请你|麻烦你)?(?:再?重试(?:一次|一下|一轮|一遍)?|再试(?:一次|一下|一轮|一遍)?|再来(?:一次|一下|一轮|一遍)?|重新(?:试|来|开始|跑|执行|做)?(?:一次|一下|一轮|一遍)?|重新跑(?:一次|一下|一轮|一遍)?|重新执行(?:一次|一下|一轮|一遍)?|从头(?:跑|来|做|开始|重新)?(?:一次|一下|一轮|一遍)?|从头跑(?:一次|一下|一轮|一遍)?|从头重新(?:跑|来|做|开始)?(?:一次|一下|一轮|一遍)?|再+从头(?:跑|来|做|开始|重新)?(?:一次|一下|一轮|一遍)?|再+从头重新(?:跑|来|做|开始)?(?:一次|一下|一轮|一遍)?|再跑(?:一次|一下|一轮|一遍)?|重做(?:一次|一下|一遍)?|try again|retry))$/i
const STRICT_CONTINUATION_FULL_MATCH = /^(?:你|请你|麻烦你)?(?:继续(?:一下|处理|执行|做|跑|完成|刚才|上次|当前|这个|任务)?|续作(?:一下|处理|执行|做|跑|完成|刚才|上次|当前|这个|任务)?|接着(?:来|做|处理|执行|跑|完成)?|恢复(?:上次|刚才|当前)?|continue|resume)$/i
const STRICT_FULL_MATCH = new RegExp(`(?:${EXACT_RETRY_FULL_MATCH.source}|${STRICT_CONTINUATION_FULL_MATCH.source})`, 'i')

/** Exact task replay control; continuation and added instructions stay ordinary input. */
export function matchesExactRetryIntent(text: string): boolean {
  return EXACT_RETRY_FULL_MATCH.test(text.trim())
}


/**
 * Liberal start prefix: the (trimmed) text begins with a continuation root.
 * The call site combines this with a length cap and fresh-request marker
 * filter; this regex on its own intentionally accepts longer matches.
 */
const LIBERAL_START_PREFIX = /^(?:继续完成|继续处理|继续执行|继续做|继续跑|继续|续作完成|续作处理|续作执行|续作做|续作跑|续作|接着完成|接着做|接着|恢复|再+从头跑|再+从头重新|再+从头|再来|重做|重新跑|重新执行|重新来|重新|从头跑|从头重新|从头|再跑)/

/**
 * Anywhere-in-text: any of the canonical tokens appears anywhere in the
 * (trimmed) input. Permissive — see `anywhere` mode docs above.
 */
const ANYWHERE_PATTERN = /(?:继续|续作|接着|恢复|上次|重试|重新|从头|再试|再跑|再来|重做|try again|retry|continue|resume)/i

const CONFIG_REPAIR_PATTERN = /(?:(?:api\s*key|apikey|key|token|令牌|密钥|模型|model|provider|渠道|供应商)\s*(?:改成|改为|换成|换为|更新(?:为|成)?|设置成|设成|配置成)|(?:配置好了|更新了|修好了(?:再试)?|应该可以了|已经(?:配置|更新|修好)了|现在应该可以了))/i

/**
 * Returns true when the text matches the resume lexicon under the given mode.
 *
 * Caller responsibilities:
 *   - Length caps (strict has no cap; liberal expects ≤32 chars)
 *   - Fresh-request marker filter for liberal (questions / "帮我X" / "我想X")
 *   - Trimming is handled here; pass raw user text without pre-trim
 */
export function matchesResumeIntent(text: string, mode: ResumeMode): boolean {
  const normalized = String(text || '').trim()
  if (!normalized) return false
  switch (mode) {
    case 'strict':
      return STRICT_FULL_MATCH.test(normalized)
    case 'liberal':
      return LIBERAL_START_PREFIX.test(normalized)
    case 'anywhere':
      return ANYWHERE_PATTERN.test(normalized)
  }
}

export function matchesConfigRepairIntent(text: string): boolean {
  const normalized = String(text || '').trim()
  if (!normalized) return false
  return CONFIG_REPAIR_PATTERN.test(normalized)
}

/**
 * Test-only export — exposes the underlying regexes so the lexicon's three
 * modes can be cross-checked for self-consistency (e.g. a strict match must
 * also be an anywhere match).
 */
export const _LEXICON_INTERNALS_FOR_TESTS = {
  STRICT_FULL_MATCH,
  LIBERAL_START_PREFIX,
  ANYWHERE_PATTERN,
  CONFIG_REPAIR_PATTERN,
} as const
