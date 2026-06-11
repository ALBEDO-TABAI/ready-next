/**
 * S4-1 — follow-up intent classification (code-owned routing, model as
 * optional yes/no judge only).
 *
 * Replaces the bare `isBareContinuationInstruction` regex gate as the single
 * follow-up read: a short follow-up message is classified into one of four
 * kinds before any capability/exposure decision consumes it. Routing from the
 * classification to behavior stays in plain code (CLAUDE.md §0 "模型只做判断题").
 *
 * Kinds:
 *  - continue_task: "继续 / 接着弄 / resume" — resume the prior task lineage.
 *  - status_query:  "怎么样了 / 还在跑吗" — report state; must NOT restart work.
 *  - correction:    "第一篇少了图 / 不对，改成…" — prior output needs repair.
 *  - new_task:      substantive new instruction (default for real content).
 *
 * Negation guard: "不要采集了，先看看" must suppress the suppressed intent
 * family (collection) even though the verb "采集" appears.
 */

const CONTINUE_PATTERN =
  /(?:继续|接着(?:弄|做|来|跑|采|处理)?|接续|重试|再试|再来一次|再跑|再采|恢复|go on|continue|retry|keep going|try again|resume|carry on)/i

const STATUS_PATTERN =
  /(?:怎么样了?|进度|进展|还在(?:跑|采|弄|处理)?吗|跑完了?吗|采完了?吗|完成了吗|好了吗|结束了吗|状态如何|到哪一?步|查看?一下进度|看看进度|(?:继续|接着|重试|恢复|开始)(?:了|过)?吗|how'?s it going|status|progress|done yet)/i

const CORRECTION_PATTERN =
  /(?:不对|错了|搞错|漏了|少了|缺了|不是这个|不是那|改成|应该是|怎么只|你只|你没|漏掉|重新(?:采|来|弄)这|补一下|补齐|wrong|missed|only got)/i

const NEGATION_PATTERN =
  /(?:不要|别再?|先不要?|不用|暂停|停止|取消|停一下|don'?t|stop|cancel|hold off)/i

/** Verbs that a leading negation can suppress ("不要采集" → 采集 suppressed). */
const NEGATABLE_INTENT_VERBS: ReadonlyArray<{ family: FollowupNegationFamily; pattern: RegExp }> = [
  { family: 'collection', pattern: /(?:采集|收集|抓取|爬|保存笔记|collect|scrape)/i },
  { family: 'browser', pattern: /(?:打开|浏览|网页|browser|open)/i },
  { family: 'retry', pattern: /(?:重试|再试|retry)/i },
]

export type FollowupIntentKind = 'continue_task' | 'status_query' | 'correction' | 'new_task'
export type FollowupNegationFamily = 'collection' | 'browser' | 'retry'

/**
 * EP2-I1 — task-ref FACT fed into the classifier (05 §2.1 state-first order).
 * Status strings mirror the projection lifecycle; interactionState carries
 * check_in_pending so a pending-adjudication task still counts as continuable.
 */
export interface FollowupTaskRef {
  taskId: string
  status: string
  interactionState?: string | null
  summary?: string | null
  nextAction?: string | null
  blockerCategory?: string | null
}

const CONTINUABLE_STATUSES = new Set(['running', 'queued', 'blocked', 'recoverable_paused', 'budget_paused'])

/** True when at least one ref is active / blocked / pending adjudication. */
export function hasContinuableTaskRef(refs: ReadonlyArray<FollowupTaskRef>): boolean {
  return refs.some((ref) =>
    CONTINUABLE_STATUSES.has(ref.status) || ref.interactionState === 'check_in_pending')
}

export interface FollowupIntentContext {
  /** True when the scope has an unfinished / recently active task lineage. */
  hasActiveTaskContext: boolean
  /**
   * EP2-I1 — state facts for the lineage. `undefined` = facts unavailable
   * (legacy caller, S4-1 behavior preserved); an array — even empty — means
   * "we looked": zero continuable refs makes continuation semantics
   * impossible (hard rule, no memory digging).
   */
  taskRefs?: ReadonlyArray<FollowupTaskRef>
}

export interface FollowupIntentResult {
  kind: FollowupIntentKind
  /** 0..1 — heuristic certainty; judges only consulted below the threshold. */
  confidence: number
  /** Intent families a leading negation suppressed in this message. */
  negations: FollowupNegationFamily[]
  /** EP2-I1 — first continuable ref when kind=continue_task with facts. */
  targetTaskId?: string
}

/**
 * Optional ambiguity judge (yes/no question to a model). Pure-code callers and
 * tests pass nothing or a fake; production may wire the existing LLM channel.
 * The judge answers exactly one question: "is this a continuation of the
 * previous task (vs a new request)?".
 */
export type FollowupAmbiguityJudge = (text: string) => Promise<'continue_task' | 'new_task'>

const SHORT_FOLLOWUP_MAX_LENGTH = 36

export function detectNegations(text: string): FollowupNegationFamily[] {
  const out: FollowupNegationFamily[] = []
  if (!NEGATION_PATTERN.test(text)) return out
  for (const { family, pattern } of NEGATABLE_INTENT_VERBS) {
    const m = pattern.exec(text)
    if (!m) continue
    // Suppress only when a negation token appears shortly BEFORE the verb
    // ("不要采集" yes; "采集吧，不要太快" should not suppress collection).
    const windowStart = Math.max(0, m.index - 8)
    if (NEGATION_PATTERN.test(text.slice(windowStart, m.index))) out.push(family)
  }
  return out
}

export function classifyFollowupIntent(
  text: string | null | undefined,
  ctx: FollowupIntentContext,
): FollowupIntentResult {
  // Envelope markdown headers (## L1 会话上下文 …) are injected context, never
  // user instruction — strip them before classification so purity checks see
  // only what the user typed.
  const t = String(text || '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('##'))
    .join('\n')
    .trim()
  if (!t) return { kind: 'new_task', confidence: 0.3, negations: [] }

  const negations = detectNegations(t)
  const isShort = t.length <= SHORT_FOLLOWUP_MAX_LENGTH

  // Status questions outrank continuation: "还在跑吗" contains neither
  // continuation verb, but "继续了吗" contains both — the question form wins.
  // Review-team D1: a status question must be PURE — a compound message
  // ("怎么样了？另外帮我再采集 B 博主") carries a real instruction after the
  // status fragment and must NOT be narrowed to the read-only surface.
  if (STATUS_PATTERN.test(t) && (isShort || /[？?]\s*$/.test(t))) {
    const residue = t
      .replace(STATUS_PATTERN, '')
      .replace(/[？?！!。，,、\s]+/g, '')
      .replace(/^(?:现在|目前|那个|这个|任务|采集|进度)+/, '')
    if (residue.length <= 6) {
      return { kind: 'status_query', confidence: 0.9, negations }
    }
  }

  if (CORRECTION_PATTERN.test(t) && ctx.hasActiveTaskContext) {
    return { kind: 'correction', confidence: 0.85, negations }
  }

  // EP2-I1 — fact-fed status fallback: a short vague interrogative ("现在啥
  // 情况" / "卡在哪了" / "那个任务呢") that no regex above caught becomes a
  // status question precisely when a continuable task exists to report on.
  const continuable = ctx.taskRefs
    ? ctx.taskRefs.filter((ref) =>
      CONTINUABLE_STATUSES.has(ref.status) || ref.interactionState === 'check_in_pending')
    : null
  const VAGUE_INTERROGATIVE = /(?:[？?]\s*$|[吗呢]\s*$|啥情况|什么情况|卡在哪|到哪了)/
  if (
    continuable && continuable.length > 0 && isShort
    && VAGUE_INTERROGATIVE.test(t)
    && !CONTINUE_PATTERN.test(t)
  ) {
    return { kind: 'status_query', confidence: 0.6, negations }
  }

  // Review-team D1b: an explicit topic shift ("继续聊聊别的话题") contains a
  // continuation verb but is NOT a task continuation.
  const TOPIC_SHIFT = /(?:聊聊|换个|别的话题|其他话题|另一个话题|new topic|something else)/i
  if (isShort && CONTINUE_PATTERN.test(t) && negations.length === 0 && !TOPIC_SHIFT.test(t)) {
    // EP2-I1 state-first hard rule: facts present + zero continuable refs →
    // continuation semantics do not exist. new_task, no memory digging (P6).
    if (continuable) {
      if (continuable.length === 0) return { kind: 'new_task', confidence: 0.85, negations }
      return { kind: 'continue_task', confidence: 0.9, negations, targetTaskId: continuable[0].taskId }
    }
    return { kind: 'continue_task', confidence: 0.9, negations }
  }

  // Short messages with an active task that match nothing above are the
  // genuinely ambiguous band ("嗯然后呢", "接下来呢") — low confidence so an
  // injected judge may break the tie; without a judge they stay new_task.
  if (isShort && ctx.hasActiveTaskContext && !/[。.!！]/.test(t)) {
    return { kind: 'new_task', confidence: 0.45, negations }
  }

  return { kind: 'new_task', confidence: 0.8, negations }
}

export const FOLLOWUP_JUDGE_CONFIDENCE_THRESHOLD = 0.5

/**
 * Async wrapper consulting the optional judge inside the ambiguous band.
 * Heuristics stay the fast path; the judge is one bounded yes/no question.
 */
export async function classifyFollowupIntentWithJudge(
  text: string | null | undefined,
  ctx: FollowupIntentContext,
  judge?: FollowupAmbiguityJudge | null,
): Promise<FollowupIntentResult> {
  const heuristic = classifyFollowupIntent(text, ctx)
  if (!judge || heuristic.confidence >= FOLLOWUP_JUDGE_CONFIDENCE_THRESHOLD) return heuristic
  try {
    const judged = await judge(String(text || ''))
    return { ...heuristic, kind: judged, confidence: 0.6 }
  } catch {
    return heuristic
  }
}

/**
 * Bridge for existing collection-exposure call sites: bare continuation OR an
 * explicit status question keeps consulting recalled context, so the tool
 * surface survives "怎么样了" the same way it survives "继续". Negated
 * collection ("不要采集") never consults.
 */
export function followupConsultsRecalledContext(
  text: string | null | undefined,
  ctx: FollowupIntentContext,
): boolean {
  const result = classifyFollowupIntent(text, ctx)
  if (result.negations.includes('collection')) return false
  return result.kind === 'continue_task' || result.kind === 'status_query' || result.kind === 'correction'
}
