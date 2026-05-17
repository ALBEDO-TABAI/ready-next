/**
 * Natural-language time-expression detector — main-process only.
 *
 * Wired by team L5-B-RSS-Time-Detection. Given a plain-text body (e.g.
 * the title + summary of an RSS item with HTML stripped), returns the
 * sub-strings that look like absolute or relative dates / times, with
 * their best-effort Unix-seconds resolution.
 *
 * Boundary notes:
 *
 *   - Runs in `main` to keep `chrono-node`'s locale dictionaries out of
 *     the renderer bundle (the en + zh dictionaries together add ~1-2 MB
 *     of JS that the renderer otherwise never needs).
 *
 *   - This is *pure renderer-side UI hinting* — the detector NEVER
 *     triggers the live-info intent path (per CLAUDE.md §6.9 the
 *     live-info-intent classifier reads only the user's primary
 *     instruction, not third-party article bodies). The detector's only
 *     output channel is the IPC handler `calendar:detectTimeExpressions`
 *     consumed by the RSS reader; nothing here writes to chat history,
 *     intent classifiers, or browser-task planners.
 *
 *   - Reference date defaults to "now" but can be overridden so that
 *     the caller can re-run detection against the article's
 *     `publishedAt` for time-relative phrases ("tomorrow", "next week")
 *     to remain meaningful when reading older items. The default is
 *     intentionally `now` because the user's perspective when *reading*
 *     the article is what matters for the "should I create a calendar
 *     event?" UX.
 *
 *   - Pure module: no IPC, no DB, no FS. The IPC handler in
 *     `ipc-handler.ts` is the thin shim that calls this.
 */

import * as chrono from 'chrono-node'

/**
 * A confidence tier. We deliberately keep this coarse:
 *
 *   - `high`   — full year + month + day + hour all certain
 *   - `medium` — at least a day + hour, OR a relative day phrase
 *     ("tomorrow", "next Friday") that chrono resolved into a concrete
 *     calendar day with or without time. This is the bulk of useful
 *     hits for "let's create an event" UX.
 *   - `low`    — vague relative phrases ("soon", "later", "稍后",
 *     "晚点") where chrono guessed at a time but the user almost
 *     certainly didn't mean a real schedule slot. The IPC handler
 *     filters these out by default but they can be returned for
 *     diagnostic tooling.
 */
export type DetectedTimeConfidence = 'high' | 'medium' | 'low'

export interface DetectedTimeExpression {
  /** The matched substring in the input, e.g. `"明天下午 3 点"`. */
  text: string
  /** Inclusive UTF-16 offset of the match in the input string. */
  startIndex: number
  /** Exclusive UTF-16 offset of the match end (`startIndex + text.length`). */
  endIndex: number
  /** Resolved start time, Unix seconds. */
  startTime: number
  /**
   * Resolved end time, Unix seconds. When chrono parsed an explicit end
   * (e.g. "tomorrow 3pm-5pm") we use it; otherwise we default to
   * `startTime + 3600` (one-hour event). `hasTime === false` (all-day)
   * still gets a synthetic 1-hour window so downstream code can
   * uniformly treat both shapes.
   */
  endTime: number
  /** Whether the expression carries an explicit clock time. */
  hasTime: boolean
  /** Coarse confidence tier — see {@link DetectedTimeConfidence}. */
  confidence: DetectedTimeConfidence
  /**
   * The locale that produced this hit (`'en'` or `'zh'`). Useful for
   * debugging when the same text matches both locales (we dedupe in
   * favour of zh for CJK ranges since chrono-en will sometimes
   * misalign offsets across CJK characters).
   */
  locale: 'en' | 'zh'
}

/**
 * Vague relative phrases that chrono.zh / chrono-en will *sometimes*
 * parse (rare; mostly chrono ignores them) but that almost never
 * indicate a real scheduling slot. We filter parses whose text matches
 * one of these (case-insensitive) down to `confidence: 'low'` and the
 * default IPC path drops low-confidence hits.
 */
const VAGUE_PHRASES = [
  '稍后',
  '晚点',
  '一会',
  '一会儿',
  '过会',
  '过一会',
  'soon',
  'later',
  'shortly',
  'in a while',
  'in a moment',
  'eventually',
]

function isVaguePhrase(text: string): boolean {
  const lowered = text.toLowerCase().trim()
  for (const phrase of VAGUE_PHRASES) {
    if (lowered.includes(phrase)) return true
  }
  return false
}

/**
 * Coarse confidence tier — see {@link DetectedTimeConfidence}.
 */
function deriveConfidence(parsed: chrono.ParsedResult): DetectedTimeConfidence {
  if (isVaguePhrase(parsed.text)) return 'low'

  const hasYear = parsed.start.isCertain('year')
  const hasMonth = parsed.start.isCertain('month')
  const hasDay = parsed.start.isCertain('day')
  const hasHour = parsed.start.isCertain('hour')
  const hasWeekday = parsed.start.isCertain('weekday')

  if (hasYear && hasMonth && hasDay && hasHour) return 'high'
  if ((hasMonth && hasDay) || (hasWeekday && hasHour) || (hasDay && hasHour)) {
    return 'medium'
  }
  if (hasMonth && hasDay) return 'medium'
  if (hasDay || hasWeekday || hasHour) return 'medium'
  return 'low'
}

/**
 * chrono.zh's casual parser sometimes resolves "周三" (Wednesday) to
 * the same calendar day as the reference date even when that day is
 * not in fact a Wednesday. When `weekday` is certain but the resolved
 * date's actual weekday doesn't match, shift the date forward to the
 * next occurrence of the intended weekday. This is a known chrono.zh
 * limitation around casual day-of-week expressions; the strict parser
 * gets it right but loses any attached time-of-day, so we keep
 * casual + repair instead of falling back to strict.
 *
 * We only ever shift FORWARD (consistent with `forwardDate: true`),
 * never backward.
 */
function repairWeekdayDrift(parsed: chrono.ParsedResult): Date {
  const baseDate = parsed.date()
  if (!parsed.start.isCertain('weekday')) return baseDate
  const intendedWeekday = parsed.start.get('weekday')
  if (intendedWeekday === null) return baseDate
  // chrono uses 0 = Sunday … 6 = Saturday; same as JS getDay().
  const actualWeekday = baseDate.getDay()
  if (actualWeekday === intendedWeekday) return baseDate
  const dayShift = (intendedWeekday - actualWeekday + 7) % 7
  if (dayShift === 0) return baseDate
  const shifted = new Date(baseDate)
  shifted.setDate(baseDate.getDate() + dayShift)
  return shifted
}

/** Deterministic key for de-duping cross-locale matches at the same offset. */
function dedupeKey(parsed: chrono.ParsedResult): string {
  return `${parsed.index}:${parsed.text}`
}

/**
 * Returns the set of recognised time expressions in `text`, sorted by
 * `startIndex` ascending. Always returns a fresh array; the empty array
 * is the success-with-no-hits shape.
 */
export function detectTimeExpressions(
  text: string,
  referenceDate: Date = new Date(),
): DetectedTimeExpression[] {
  if (typeof text !== 'string' || text.length === 0) return []

  const seen = new Map<string, { parsed: chrono.ParsedResult; locale: 'en' | 'zh' }>()

  // Run zh FIRST so its offsets win in dedupe ties — chrono-en
  // occasionally produces a stray match inside a CJK string at an
  // offset that doesn't align cleanly with the CJK substring chrono.zh
  // correctly identified. zh offsets are deliberately the canonical
  // shape for CJK input.
  let zhResults: chrono.ParsedResult[] = []
  try {
    zhResults = chrono.zh.casual.parse(text, referenceDate, { forwardDate: true })
  } catch {
    zhResults = []
  }
  for (const parsed of zhResults) {
    seen.set(dedupeKey(parsed), { parsed, locale: 'zh' })
  }

  let enResults: chrono.ParsedResult[] = []
  try {
    enResults = chrono.casual.parse(text, referenceDate, { forwardDate: true })
  } catch {
    enResults = []
  }
  for (const parsed of enResults) {
    const key = dedupeKey(parsed)
    if (!seen.has(key)) {
      seen.set(key, { parsed, locale: 'en' })
    }
  }

  const expressions: DetectedTimeExpression[] = []
  for (const { parsed, locale } of seen.values()) {
    const startDate = repairWeekdayDrift(parsed)
    const hasTime = parsed.start.isCertain('hour')
    const startTime = Math.floor(startDate.getTime() / 1000)
    let endTime: number
    // chrono-node's TS declarations type `end` as `ParsedComponents?`
    // but at runtime it is sometimes the literal `null` rather than
    // `undefined`. Treat both as "no explicit end".
    const explicitEnd = parsed.end ?? null
    if (explicitEnd !== null) {
      // chrono produced a real end (e.g. "3pm-5pm"). Trust it after
      // mirroring the same weekday repair so a range starting on
      // "周三" doesn't drift either side independently.
      const endShift = startDate.getTime() - parsed.date().getTime()
      const rawEnd = explicitEnd.date().getTime() + endShift
      endTime = Math.floor(rawEnd / 1000)
      if (endTime <= startTime) endTime = startTime + 3600
    } else {
      // Default to a 1-hour event; downstream UI can let the user
      // adjust before creating.
      endTime = startTime + 3600
    }
    expressions.push({
      text: parsed.text,
      startIndex: parsed.index,
      endIndex: parsed.index + parsed.text.length,
      startTime,
      endTime,
      hasTime,
      confidence: deriveConfidence(parsed),
      locale,
    })
  }

  expressions.sort((a, b) => a.startIndex - b.startIndex)
  return expressions
}
