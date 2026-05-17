/**
 * Universal "remote-channel message → calendar event suggestion"
 * detector. Replaces the original L5-C "Feishu-only auto trigger" idea
 * with a channel-agnostic pipeline:
 *
 *   feishu / telegram / imessage / discord / wechat / slack /
 *   generic-webhook / future adapters
 *           │
 *           ▼  one `RemoteChannelMessage` envelope per inbound message
 *   `detectRemoteChannelEventSuggestions`
 *           │  consults `remote-channel-registry` for per-kind policy
 *           │  reuses `time-expression-detector` (chrono-node zh/en)
 *           ▼
 *   `RemoteCalendarEventSuggestion[]`  — channel-agnostic, JSON-safe
 *           │
 *           ▼  pushed via IPC `calendar:remoteEventSuggested`
 *   renderer modal: "在 <channel> 上识别到 'tomorrow 3pm' — 创建日程?"
 *
 * Pure module — no electron / sqlite imports. Dependencies are passed
 * in via the deps parameter so tests can substitute the time-expression
 * detector with a fake.
 */

import {
  detectTimeExpressions,
  type DetectedTimeExpression,
} from './time-expression-detector'
import {
  getRemoteChannelEntry,
  resolveAutoDetectPolicy,
} from './remote-channel-registry'
import {
  deriveRemoteSuggestionId,
  type RemoteCalendarEventSuggestion,
  type RemoteChannelMessage,
} from '../../../shared/calendar-remote-channel'

/** Maximum text length we'll feed to chrono per message. Mirrors the
 *  ipc-handler's `MAX_TEXT_LEN` for the renderer-driven detection path. */
const MAX_REMOTE_MESSAGE_TEXT_LEN = 8192

/**
 * Default end-time when chrono only detected a start instant. One hour
 * matches the calendar UI's default new-event duration; the renderer
 * modal lets the user adjust before saving.
 */
const DEFAULT_DURATION_SECONDS = 60 * 60

export interface DetectRemoteChannelEventDeps {
  /** Hook to substitute the underlying time detector in tests. */
  detectTimeExpressions?: (text: string, ref?: Date) => DetectedTimeExpression[]
  /** Hook to read "now" deterministically in tests. */
  now?: () => number
}

export interface DetectRemoteChannelEventOptions {
  /**
   * Per-channel user override of auto-detection. `null` means "follow
   * registry default"; `false` blocks detection regardless of registry;
   * `true` forces detection on even when registry default is off.
   */
  autoDetectOverride?: boolean | null
  /**
   * Minimum chrono confidence to surface. Defaults to dropping `low`
   * (vague phrases like "稍后 / soon" already filtered upstream, but
   * `medium` may still produce noise from short messages; tighten to
   * `'medium'` if users complain).
   */
  minConfidence?: 'high' | 'medium' | 'low'
}

/**
 * Detect zero-or-more calendar suggestions in one inbound message.
 *
 * Contract:
 *   - Returns `[]` when policy says "don't detect", or when the channel
 *     entry's `shouldSkip` matches, or when chrono finds nothing.
 *   - NEVER throws; chrono parse failures fall back to `[]` + a
 *     `console.warn`.
 *   - Suggestion ids are stable across calls (`deriveRemoteSuggestionId`),
 *     so the renderer can dedupe a re-issued suggestion without coupling
 *     to detection-pipeline implementation details.
 *   - Suggestions are sorted by `suggestedStartUnix` ascending so the
 *     renderer / agent can take the first one as "next meeting".
 */
export function detectRemoteChannelEventSuggestions(
  message: RemoteChannelMessage,
  options: DetectRemoteChannelEventOptions = {},
  deps: DetectRemoteChannelEventDeps = {},
): RemoteCalendarEventSuggestion[] {
  // -- Channel policy gate ------------------------------------------------
  const entry = getRemoteChannelEntry(message.channelKind)
  const allowed = resolveAutoDetectPolicy(message.channelKind, options.autoDetectOverride ?? null)
  if (!allowed) return []
  if (entry.shouldSkip && entry.shouldSkip(message)) return []

  // -- Text preprocessing -------------------------------------------------
  let text = message.text ?? ''
  if (typeof text !== 'string' || text.trim().length === 0) return []
  if (entry.preprocessText) {
    try {
      text = entry.preprocessText(text)
    } catch (error) {
      const m = error instanceof Error ? error.message : String(error)
      console.warn(`[remote-channel-event-detector] preprocessText threw for ${message.channelKind}: ${m}`)
      // fall through with original text — preprocessing failure must not
      // silently drop the message.
      text = message.text ?? ''
    }
  }
  if (text.length > MAX_REMOTE_MESSAGE_TEXT_LEN) text = text.slice(0, MAX_REMOTE_MESSAGE_TEXT_LEN)

  // -- Chrono detection ---------------------------------------------------
  const detector = deps.detectTimeExpressions ?? detectTimeExpressions
  let detected: DetectedTimeExpression[]
  try {
    detected = detector(text, new Date(message.receivedAtUnix * 1000))
  } catch (error) {
    const m = error instanceof Error ? error.message : String(error)
    console.warn(`[remote-channel-event-detector] chrono threw for ${message.channelKind}: ${m}`)
    return []
  }
  if (!detected || detected.length === 0) return []

  // -- Confidence filter --------------------------------------------------
  const minConfidence = options.minConfidence ?? 'medium'
  const filtered = detected.filter((d) => confidenceRank(d.confidence) >= confidenceRank(minConfidence))
  if (filtered.length === 0) return []

  // -- Map to suggestions -------------------------------------------------
  const nowSec = (deps.now ?? defaultNow)()
  const suggestions = filtered.map((expr) => buildSuggestion(message, text, expr, nowSec))

  // Sort ascending by start time so callers can take suggestions[0] as
  // "earliest detected event".
  suggestions.sort((a, b) => a.suggestedStartUnix - b.suggestedStartUnix)
  return suggestions
}

// ---------- helpers ----------

function defaultNow(): number {
  return Math.floor(Date.now() / 1000)
}

function confidenceRank(level: 'high' | 'medium' | 'low'): number {
  if (level === 'high') return 3
  if (level === 'medium') return 2
  return 1
}

function buildSuggestion(
  source: RemoteChannelMessage,
  preprocessedText: string,
  expr: DetectedTimeExpression,
  nowSec: number,
): RemoteCalendarEventSuggestion {
  const startUnix = expr.startTime
  const endUnix =
    expr.endTime > expr.startTime ? expr.endTime : startUnix + DEFAULT_DURATION_SECONDS
  // Suggested title = the smallest sentence-ish slice that contains the
  // extracted text, trimmed to 80 chars. Users can edit in the modal.
  const suggestedTitle = pickTitleFromContext(preprocessedText, expr)
  return {
    suggestionId: deriveRemoteSuggestionId(source.messageId, startUnix),
    source,
    suggestedTitle,
    suggestedStartUnix: startUnix,
    suggestedEndUnix: endUnix,
    hasTime: expr.hasTime,
    confidence: expr.confidence,
    extractedText: expr.text,
    textRange: { start: expr.startIndex, end: expr.endIndex },
    detectedAtUnix: nowSec,
  }
}

/**
 * Heuristic for the suggested title: take the sentence containing the
 * extracted time phrase, with the phrase itself removed (so we don't
 * literally name an event "3pm"). Falls back to the full preprocessed
 * text if no sentence boundary is found. Truncated to 80 chars.
 */
function pickTitleFromContext(text: string, expr: DetectedTimeExpression): string {
  const before = text.slice(0, expr.startIndex)
  const after = text.slice(expr.endIndex)
  // Sentence boundaries: full-width ， 。 ！ ？ and ASCII . ! ? ;
  // Falls back to newline / start-of-text.
  const sentenceStart = lastIndexOfAny(before, ['\n', '。', '！', '？', '.', '!', '?', ';']) + 1
  const sentenceEndOffset = firstIndexOfAny(after, ['\n', '。', '！', '？', '.', '!', '?', ';'])
  const sentenceEnd = sentenceEndOffset === -1 ? text.length : expr.endIndex + sentenceEndOffset
  const raw = text.slice(sentenceStart, sentenceEnd)
  // Drop the time phrase from the title (case-insensitive match on the
  // first occurrence — chrono indices already pinpoint the location, but
  // we re-extract here so the resulting title can be trimmed cleanly).
  const cleaned = raw.replace(expr.text, '').replace(/\s{2,}/g, ' ').trim()
  const candidate = cleaned.length > 0 ? cleaned : raw.trim()
  if (candidate.length === 0) return '远程消息建议的日程'
  return candidate.length > 80 ? candidate.slice(0, 80) + '…' : candidate
}

function lastIndexOfAny(haystack: string, needles: string[]): number {
  let best = -1
  for (const needle of needles) {
    const idx = haystack.lastIndexOf(needle)
    if (idx > best) best = idx
  }
  return best
}

function firstIndexOfAny(haystack: string, needles: string[]): number {
  let best = -1
  for (const needle of needles) {
    const idx = haystack.indexOf(needle)
    if (idx !== -1 && (best === -1 || idx < best)) best = idx
  }
  return best
}
