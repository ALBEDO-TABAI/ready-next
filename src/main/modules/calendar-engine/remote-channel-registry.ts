/**
 * Remote-channel registry for the calendar-event detector.
 *
 * One entry per supported channel kind — registry is data-only, not
 * runtime-stateful. The detector / renderer / settings UI consult it
 * to decide:
 *   - what to display ("飞书 (机器人)" vs "Telegram")
 *   - whether to default-on auto-detection (`local-debug` opts out)
 *   - whether a particular message should be pre-processed or skipped
 *     (channel-specific text cleaning; v1 mostly identity)
 *
 * Adding a new channel kind = append one entry here + render its icon
 * key in the renderer icon resolver. No detector / runtime changes.
 *
 * Pure module — no electron / better-sqlite3 imports.
 */

import type {
  RemoteChannelKind,
  RemoteChannelMessage,
  RemoteChannelRegistryEntry,
} from '../../../shared/calendar-remote-channel'

/**
 * Strip a leading bot @-mention so chrono doesn't have to ignore it.
 * Conservative: only handles ASCII @ + word chars + trailing space.
 */
function stripLeadingMention(text: string): string {
  return text.replace(/^@[A-Za-z0-9_-]+\s+/u, '')
}

/**
 * Built-in registry entries. Maintain alphabetical-ish ordering by
 * channel kind for predictable diffs. Adapter authors add new entries
 * here when introducing a new `ChannelAdapterType` upstream.
 */
const BUILTIN_ENTRIES: Record<string, RemoteChannelRegistryEntry> = {
  'feishu-bot': {
    kind: 'feishu-bot',
    displayName: '飞书 (机器人)',
    iconKey: 'feishu',
    autoDetectByDefault: true,
    preprocessText: stripLeadingMention,
  },
  'feishu-app': {
    kind: 'feishu-app',
    displayName: '飞书 (应用)',
    iconKey: 'feishu',
    autoDetectByDefault: true,
    preprocessText: stripLeadingMention,
  },
  'telegram-bot': {
    kind: 'telegram-bot',
    displayName: 'Telegram',
    iconKey: 'telegram',
    autoDetectByDefault: true,
    preprocessText: stripLeadingMention,
  },
  'wechat-openclaw': {
    kind: 'wechat-openclaw',
    displayName: '微信',
    iconKey: 'wechat',
    autoDetectByDefault: true,
  },
  imessage: {
    kind: 'imessage',
    displayName: 'iMessage',
    iconKey: 'apple-messages',
    autoDetectByDefault: true,
  },
  discord: {
    kind: 'discord',
    displayName: 'Discord',
    iconKey: 'discord',
    autoDetectByDefault: true,
    preprocessText: stripLeadingMention,
  },
  wechat: {
    kind: 'wechat',
    displayName: '微信',
    iconKey: 'wechat',
    autoDetectByDefault: true,
  },
  slack: {
    kind: 'slack',
    displayName: 'Slack',
    iconKey: 'slack',
    autoDetectByDefault: true,
    preprocessText: stripLeadingMention,
  },
  'generic-webhook': {
    kind: 'generic-webhook',
    displayName: '自定义 Webhook',
    iconKey: 'webhook',
    // Generic-webhook traffic is highly varied; off by default to avoid
    // noisy suggestions on debug / integration channels.
    autoDetectByDefault: false,
  },
  'local-debug': {
    kind: 'local-debug',
    displayName: '本地调试',
    iconKey: 'bug',
    // Test fixtures should not spawn calendar prompts.
    autoDetectByDefault: false,
    shouldSkip: (message: RemoteChannelMessage) => message.text.startsWith('[debug]'),
  },
}

/**
 * Neutral fallback for any channel kind not in `BUILTIN_ENTRIES`. The
 * adapter author should add a real entry; we don't crash on unknown
 * kinds because new adapters can land in dev / nightly before the
 * registry is updated.
 */
const FALLBACK_ENTRY: RemoteChannelRegistryEntry = {
  kind: 'generic-webhook',
  displayName: '远程渠道',
  iconKey: 'webhook',
  autoDetectByDefault: false,
}

/** Lookup; never throws. */
export function getRemoteChannelEntry(kind: RemoteChannelKind): RemoteChannelRegistryEntry {
  const key = String(kind)
  return BUILTIN_ENTRIES[key] ?? { ...FALLBACK_ENTRY, kind }
}

/** Frozen snapshot for renderer enumeration (settings list). */
export function listRemoteChannelEntries(): ReadonlyArray<RemoteChannelRegistryEntry> {
  return Object.values(BUILTIN_ENTRIES)
}

/**
 * Resolve the effective auto-detect policy for a message, blending:
 *   1. per-channel user override (`agent_channels.config_json.calendar
 *      .autoDetectCalendarEvents`) when not null.
 *   2. registry default (`entry.autoDetectByDefault`) when override is null.
 *
 * Adapter / sidecar code threads the override through; the detector
 * never reads SQLite directly.
 */
export function resolveAutoDetectPolicy(
  kind: RemoteChannelKind,
  override: boolean | null,
): boolean {
  if (override === true) return true
  if (override === false) return false
  return getRemoteChannelEntry(kind).autoDetectByDefault
}
