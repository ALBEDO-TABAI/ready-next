/**
 * Calendar × remote-channel integration contract.
 *
 * Background: a Ready conversation scope can be backed by many remote
 * channel types — feishu-bot, feishu-app, telegram-bot, …, eventually
 * imessage / discord / wechat / slack / generic-webhook. When ANY of
 * them delivers an inbound message that mentions a time
 * ("tomorrow 3pm meeting" / "下周三早上 9 点开会"), the calendar module
 * should detect that signal and surface a "create event?" suggestion
 * to the user — without each channel adapter implementing its own
 * detection.
 *
 * This file defines the SHARED shape both sides agree on:
 *   - `RemoteChannelMessage`: the channel-agnostic message envelope the
 *     detector accepts. Channel adapters / `runtime.ts` build it from
 *     their own inbound payload.
 *   - `RemoteCalendarEventSuggestion`: the channel-agnostic suggestion
 *     the detector returns + the IPC push channel carries to renderer.
 *   - `RemoteChannelRegistryEntry`: per-channel metadata
 *     (displayName / iconKey / default policy) the renderer uses to
 *     label notifications and the settings UI uses to toggle per-channel
 *     auto-detection.
 *
 * Pure TS — no electron / better-sqlite3 / DOM imports.
 */

/**
 * Canonical channel-kind identifier set. Mirrors `ChannelAdapterType` in
 * `src/main/modules/agent-control/types.ts` plus the channels the audit
 * named explicitly. Adapters can declare any string — the registry below
 * supplies metadata for known kinds; unknown kinds fall back to a
 * neutral default.
 */
export type RemoteChannelKind =
  | 'feishu-bot'
  | 'feishu-app'
  | 'telegram-bot'
  | 'wechat-openclaw'
  | 'imessage'
  | 'discord'
  | 'wechat'
  | 'slack'
  | 'generic-webhook'
  | 'local-debug'
  // Allow adapter authors to add new kinds without re-publishing this file.
  // Renderer / detector fall back to neutral metadata for unknown kinds.
  | (string & { __remoteChannelKindBrand?: never })

/**
 * Channel-agnostic envelope for an inbound message. Built by the
 * channel adapter (sidecar) or by `runtime.ts`'s `handleInboundChannel`
 * before invoking the detector. Mirrors the data we already extract
 * from feishu / telegram payloads — `id` / `channelId` / `thread` /
 * `sender` / `text` / `attachments` / `timestamp`.
 *
 * Time field semantics:
 *   - `receivedAtUnix`: Unix SECONDS at which Ready received this
 *     message. Used as the chrono reference date so phrases like
 *     "tomorrow" / "下周三" resolve forward.
 *   - Channel-side wall-clock timestamps stay inside `meta` (each
 *     channel has its own conventions).
 */
export interface RemoteChannelMessage {
  /** Sidecar-supplied message id; used to dedupe suggestions. */
  messageId: string
  channelKind: RemoteChannelKind
  /** Conversation scope key (matches `agent_channels.id`). */
  channelId: string
  /** Thread key inside the channel (group id, DM peer, chat id…). */
  threadKey: string
  /** Display name of the sender; null when the channel does not expose it. */
  sender: string | null
  /** Plain-text body. HTML or rich-text messages must be flattened by the
   *  adapter before reaching the detector. */
  text: string
  /** Optional channel-specific structured payload that adapters can
   *  forward verbatim (e.g. feishu interactive card JSON, telegram
   *  inline-keyboard descriptor). The detector ignores this in v1 but
   *  carries it through so future enhancements can use it. */
  meta?: Record<string, unknown>
  /** Unix seconds — chrono reference date. */
  receivedAtUnix: number
}

/**
 * What the detector returns: a calendar event suggestion derived from
 * one or more detected time expressions in a `RemoteChannelMessage`.
 *
 * Designed so the renderer can show it as a "create event?" prompt
 * without further main-process round trips — every field is plain JSON
 * and self-describing.
 */
export interface RemoteCalendarEventSuggestion {
  /** Stable id for this suggestion. Equals
   *  `${messageId}#${startTimeUnix}` so re-detecting the same message
   *  yields the same id (dedupe on the renderer side). */
  suggestionId: string
  /** The originating channel envelope. Carried so the renderer can
   *  label the notification with channel display name + sender + an
   *  excerpt; also lets a future "open in channel" link work. */
  source: RemoteChannelMessage
  /** Suggested event title. v1: same as the message excerpt that
   *  triggered detection (`extractedText`), trimmed to first sentence;
   *  the renderer modal lets the user edit before saving. */
  suggestedTitle: string
  /** Unix seconds of the detected start instant. */
  suggestedStartUnix: number
  /** Unix seconds of the detected end instant. If chrono did not detect
   *  an end, the detector synthesises `start + 60 * 60` (one hour). */
  suggestedEndUnix: number
  /** True when chrono identified a wall-clock hour (not just a date).
   *  False → an all-day event is suggested. */
  hasTime: boolean
  /** Detector confidence — same scale as `time-expression-detector`. */
  confidence: 'high' | 'medium' | 'low'
  /** The original substring from `source.text` that produced this
   *  suggestion. Useful for the prompt UI ("识别到 '明天 3 点' …"). */
  extractedText: string
  /** Offsets within `source.text` (UTF-16 code units), inclusive start,
   *  exclusive end. Lets the renderer highlight the matched span. */
  textRange: { start: number; end: number }
  /** Detector pipeline produced this at this instant (Unix seconds). */
  detectedAtUnix: number
}

/**
 * Per-channel registry metadata. The detector / renderer / settings UI
 * all consult the SAME registry so a new channel kind only needs one
 * entry here to inherit:
 *   - display name + icon hint (for notifications + settings list)
 *   - default policy (whether auto-detection is on by default; some
 *     channels — like `local-debug` — should default OFF)
 *   - optional channel-specific filters / preprocessors (v1: noop, but
 *     the seam exists so a future feishu meeting-card extractor can
 *     plug in without changing core detector code).
 */
export interface RemoteChannelRegistryEntry {
  kind: RemoteChannelKind
  /** Short user-visible label, e.g. "飞书 (机器人)" / "Telegram". */
  displayName: string
  /** Icon registry key — renderer maps it to an `lucide-react` icon or
   *  a brand SVG without this file knowing about React. */
  iconKey: string
  /** Whether to auto-detect calendar events on this channel by default.
   *  Users override per-channel via the settings panel. `local-debug`
   *  defaults false so test traffic does not spam suggestions. */
  autoDetectByDefault: boolean
  /** Optional pre-processor: takes the raw message text and returns the
   *  text the detector should see. Allows channel-specific stripping
   *  (e.g. drop "@bot" mentions, decode HTML entities). v1: identity. */
  preprocessText?: (text: string) => string
  /** Optional filter: returns true to skip detection for this message
   *  (e.g. an obvious bot heartbeat). v1: never skip. */
  shouldSkip?: (message: RemoteChannelMessage) => boolean
}

/**
 * Per-channel user policy as persisted in `agent_channels.config_json`
 * under a stable key. The settings UI flips this; the detector reads it.
 *
 * Keeping the policy field name explicit avoids ambiguity with future
 * config keys. Default value is `null` (meaning "follow registry
 * default"); the runtime resolves null → registry entry's
 * `autoDetectByDefault`.
 */
export interface RemoteChannelCalendarPolicy {
  /** null → fall back to `RemoteChannelRegistryEntry.autoDetectByDefault`. */
  autoDetectCalendarEvents: boolean | null
}

/** Key under which the policy is persisted inside `agent_channels.config_json`. */
export const REMOTE_CHANNEL_CALENDAR_POLICY_KEY = 'calendar' as const

/**
 * Build the stable suggestion id from a source message + suggested
 * start. Centralized so detector + renderer / dedup logic share one
 * derivation rule.
 */
export function deriveRemoteSuggestionId(messageId: string, suggestedStartUnix: number): string {
  return `${messageId}#${suggestedStartUnix}`
}
