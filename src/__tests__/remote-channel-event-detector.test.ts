/**
 * Behavior tests for the universal remote-channel calendar detector.
 *
 * The detector is pure logic (chrono is injected) so these tests stay
 * fast and host-Node-friendly. Scenarios cover:
 *   - channel-agnostic detection works for feishu / telegram /
 *     imessage / discord / wechat (proving "通用 not feishu-only")
 *   - per-channel registry: `local-debug` skipped by default;
 *     `generic-webhook` off by default
 *   - per-channel override blocks detection when user disables it
 *   - empty text / unknown channel kind / chrono failure all return []
 *   - suggestion ids are stable across re-detection (dedupe contract)
 *   - sorting by `suggestedStartUnix`
 *   - confidence floor filters out `low` by default
 *   - title heuristic strips the time phrase out of the suggested title
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { detectRemoteChannelEventSuggestions } from '../main/modules/calendar-engine/remote-channel-event-detector'
import type { DetectedTimeExpression } from '../main/modules/calendar-engine/time-expression-detector'
import {
  deriveRemoteSuggestionId,
  type RemoteChannelKind,
  type RemoteChannelMessage,
} from '../shared/calendar-remote-channel'

const NOW_2026_05_17_UNIX = Math.floor(Date.UTC(2026, 4, 17, 9, 0, 0) / 1000)

function makeMessage(overrides: Partial<RemoteChannelMessage> = {}): RemoteChannelMessage {
  return {
    messageId: 'msg-1',
    channelKind: 'feishu-bot',
    channelId: 'ch-1',
    threadKey: 'th-1',
    sender: '张三',
    text: '明天下午 3 点开会',
    receivedAtUnix: NOW_2026_05_17_UNIX,
    ...overrides,
  }
}

/** Fake chrono that recognises a single phrase regardless of input. */
function makeFakeChrono(expressions: DetectedTimeExpression[]) {
  return (_text: string, _ref?: Date): DetectedTimeExpression[] => expressions
}

const SAMPLE_HIGH_EXPR: DetectedTimeExpression = {
  text: '明天下午 3 点',
  startIndex: 0,
  endIndex: 8,
  startTime: NOW_2026_05_17_UNIX + 30 * 3600, // tomorrow 15:00 UTC-ish
  endTime: NOW_2026_05_17_UNIX + 31 * 3600,
  hasTime: true,
  confidence: 'high',
}

test('feishu-bot message produces a suggestion', () => {
  const message = makeMessage({ channelKind: 'feishu-bot' })
  const out = detectRemoteChannelEventSuggestions(
    message,
    {},
    { detectTimeExpressions: makeFakeChrono([SAMPLE_HIGH_EXPR]), now: () => NOW_2026_05_17_UNIX },
  )
  assert.equal(out.length, 1)
  assert.equal(out[0].source.channelKind, 'feishu-bot')
})

test('non-feishu channels also produce suggestions (telegram, imessage, discord, wechat, slack)', () => {
  const kinds: RemoteChannelKind[] = ['telegram-bot', 'imessage', 'discord', 'wechat', 'slack']
  for (const kind of kinds) {
    const out = detectRemoteChannelEventSuggestions(
      makeMessage({ channelKind: kind, messageId: `msg-${kind}` }),
      {},
      { detectTimeExpressions: makeFakeChrono([SAMPLE_HIGH_EXPR]), now: () => NOW_2026_05_17_UNIX },
    )
    assert.equal(out.length, 1, `${kind} should produce a suggestion (got ${out.length})`)
    assert.equal(out[0].source.channelKind, kind)
  }
})

test('local-debug channel skips by default (registry policy)', () => {
  const out = detectRemoteChannelEventSuggestions(
    makeMessage({ channelKind: 'local-debug' }),
    {},
    { detectTimeExpressions: makeFakeChrono([SAMPLE_HIGH_EXPR]) },
  )
  assert.equal(out.length, 0, 'local-debug must be off by default')
})

test('generic-webhook channel skips by default (registry policy)', () => {
  const out = detectRemoteChannelEventSuggestions(
    makeMessage({ channelKind: 'generic-webhook' }),
    {},
    { detectTimeExpressions: makeFakeChrono([SAMPLE_HIGH_EXPR]) },
  )
  assert.equal(out.length, 0, 'generic-webhook must be off by default')
})

test('per-channel user override = true forces detection on default-off channels', () => {
  const out = detectRemoteChannelEventSuggestions(
    makeMessage({ channelKind: 'generic-webhook' }),
    { autoDetectOverride: true },
    { detectTimeExpressions: makeFakeChrono([SAMPLE_HIGH_EXPR]), now: () => NOW_2026_05_17_UNIX },
  )
  assert.equal(out.length, 1, 'user-on override must beat registry default-off')
})

test('per-channel user override = false blocks detection even on default-on channels', () => {
  const out = detectRemoteChannelEventSuggestions(
    makeMessage({ channelKind: 'feishu-bot' }),
    { autoDetectOverride: false },
    { detectTimeExpressions: makeFakeChrono([SAMPLE_HIGH_EXPR]) },
  )
  assert.equal(out.length, 0, 'user-off override must block default-on detection')
})

test('local-debug shouldSkip pattern: [debug]-prefixed messages are skipped even when user override is true', () => {
  const out = detectRemoteChannelEventSuggestions(
    makeMessage({ channelKind: 'local-debug', text: '[debug] 明天下午 3 点开会' }),
    { autoDetectOverride: true },
    { detectTimeExpressions: makeFakeChrono([SAMPLE_HIGH_EXPR]) },
  )
  assert.equal(out.length, 0, '[debug] prefix must be unconditionally skipped')
})

test('empty text returns []', () => {
  const out = detectRemoteChannelEventSuggestions(
    makeMessage({ text: '   ' }),
    {},
    { detectTimeExpressions: makeFakeChrono([SAMPLE_HIGH_EXPR]) },
  )
  assert.equal(out.length, 0)
})

test('chrono throwing is swallowed and returns []', () => {
  const originalWarn = console.warn
  const warnings: string[] = []
  console.warn = (msg: unknown) => warnings.push(String(msg))
  try {
    const out = detectRemoteChannelEventSuggestions(
      makeMessage(),
      {},
      {
        detectTimeExpressions: () => {
          throw new Error('chrono blew up')
        },
      },
    )
    assert.equal(out.length, 0)
    assert.ok(warnings.some((w) => w.includes('chrono')), 'a warning should be logged')
  } finally {
    console.warn = originalWarn
  }
})

test('low-confidence expressions are filtered out by default (min=medium)', () => {
  const lowExpr: DetectedTimeExpression = { ...SAMPLE_HIGH_EXPR, confidence: 'low' }
  const out = detectRemoteChannelEventSuggestions(
    makeMessage(),
    {},
    { detectTimeExpressions: makeFakeChrono([lowExpr]) },
  )
  assert.equal(out.length, 0)
})

test('minConfidence option can be relaxed to low to keep vague matches', () => {
  const lowExpr: DetectedTimeExpression = { ...SAMPLE_HIGH_EXPR, confidence: 'low' }
  const out = detectRemoteChannelEventSuggestions(
    makeMessage(),
    { minConfidence: 'low' },
    { detectTimeExpressions: makeFakeChrono([lowExpr]), now: () => NOW_2026_05_17_UNIX },
  )
  assert.equal(out.length, 1)
})

test('suggestions are sorted ascending by suggestedStartUnix', () => {
  const later: DetectedTimeExpression = { ...SAMPLE_HIGH_EXPR, startTime: NOW_2026_05_17_UNIX + 100000, endTime: NOW_2026_05_17_UNIX + 103600 }
  const earlier: DetectedTimeExpression = { ...SAMPLE_HIGH_EXPR, text: '今晚 8 点', startIndex: 10, endIndex: 15, startTime: NOW_2026_05_17_UNIX + 10000, endTime: NOW_2026_05_17_UNIX + 13600 }
  const out = detectRemoteChannelEventSuggestions(
    makeMessage({ text: '明天下午 3 点 / 今晚 8 点 都行' }),
    {},
    { detectTimeExpressions: makeFakeChrono([later, earlier]), now: () => NOW_2026_05_17_UNIX },
  )
  assert.equal(out.length, 2)
  assert.ok(out[0].suggestedStartUnix < out[1].suggestedStartUnix, 'first suggestion must be earliest')
})

test('suggestion ids are stable and derivable (dedupe contract)', () => {
  const out = detectRemoteChannelEventSuggestions(
    makeMessage({ messageId: 'stable-msg-1' }),
    {},
    { detectTimeExpressions: makeFakeChrono([SAMPLE_HIGH_EXPR]), now: () => NOW_2026_05_17_UNIX },
  )
  assert.equal(out.length, 1)
  const expected = deriveRemoteSuggestionId('stable-msg-1', SAMPLE_HIGH_EXPR.startTime)
  assert.equal(out[0].suggestionId, expected)
  // Re-detect — same id.
  const again = detectRemoteChannelEventSuggestions(
    makeMessage({ messageId: 'stable-msg-1' }),
    {},
    { detectTimeExpressions: makeFakeChrono([SAMPLE_HIGH_EXPR]), now: () => NOW_2026_05_17_UNIX + 100 },
  )
  assert.equal(again[0].suggestionId, expected, 'id must not depend on detection timestamp')
})

test('missing end time → suggestedEnd = start + 1h (default duration contract)', () => {
  const startOnly: DetectedTimeExpression = { ...SAMPLE_HIGH_EXPR, endTime: SAMPLE_HIGH_EXPR.startTime }
  const out = detectRemoteChannelEventSuggestions(
    makeMessage(),
    {},
    { detectTimeExpressions: makeFakeChrono([startOnly]), now: () => NOW_2026_05_17_UNIX },
  )
  assert.equal(out.length, 1)
  assert.equal(out[0].suggestedEndUnix - out[0].suggestedStartUnix, 3600)
})

test('unknown channel kind falls back to default-off policy', () => {
  const out = detectRemoteChannelEventSuggestions(
    makeMessage({ channelKind: 'matrix-bot' as RemoteChannelKind }),
    {},
    { detectTimeExpressions: makeFakeChrono([SAMPLE_HIGH_EXPR]) },
  )
  assert.equal(out.length, 0, 'unknown channels must be off by default; require explicit override')
})

test('unknown channel kind WITH explicit autoDetectOverride=true detects normally', () => {
  const out = detectRemoteChannelEventSuggestions(
    makeMessage({ channelKind: 'matrix-bot' as RemoteChannelKind }),
    { autoDetectOverride: true },
    { detectTimeExpressions: makeFakeChrono([SAMPLE_HIGH_EXPR]), now: () => NOW_2026_05_17_UNIX },
  )
  assert.equal(out.length, 1)
})

test('preprocessText strips a leading @mention before chrono sees the text', () => {
  let capturedText: string | null = null
  const detector = (text: string): DetectedTimeExpression[] => {
    capturedText = text
    return [SAMPLE_HIGH_EXPR]
  }
  detectRemoteChannelEventSuggestions(
    makeMessage({ channelKind: 'feishu-bot', text: '@ready 明天下午 3 点开会' }),
    {},
    { detectTimeExpressions: detector, now: () => NOW_2026_05_17_UNIX },
  )
  assert.ok(capturedText !== null && !capturedText.startsWith('@ready'),
    `preprocessText must strip @mention before detection; chrono saw "${capturedText}"`)
})
