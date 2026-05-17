import test from 'node:test'
import assert from 'node:assert/strict'

import { buildRemoteSuggestionEventDraft } from '../renderer/modules/calendar/remoteSuggestion'
import type { RemoteCalendarEventSuggestion } from '../shared/calendar-remote-channel'

const baseSuggestion: RemoteCalendarEventSuggestion = {
  suggestionId: 'msg-1#1780509600',
  source: {
    messageId: 'msg-1',
    channelKind: 'feishu-bot',
    channelId: 'channel-1',
    threadKey: 'thread-1',
    sender: 'Alice',
    text: '明天下午 3 点开会，会议室 A。',
    receivedAtUnix: 1780423200,
  },
  suggestedTitle: '明天下午 3 点开会',
  suggestedStartUnix: 1780509600,
  suggestedEndUnix: 1780513200,
  hasTime: true,
  confidence: 'high',
  extractedText: '明天下午 3 点',
  textRange: { start: 0, end: 7 },
  detectedAtUnix: 1780423201,
}

test('remote channel suggestion builds a user-confirmed calendar event draft', () => {
  const draft = buildRemoteSuggestionEventDraft(baseSuggestion, 'cal-main')

  assert.equal(draft.calendarId, 'cal-main')
  assert.equal(draft.title, '明天下午 3 点开会')
  assert.equal(draft.startTime.toISOString(), '2026-06-03T18:00:00.000Z')
  assert.equal(draft.endTime.toISOString(), '2026-06-03T19:00:00.000Z')
  assert.equal(draft.allDay, false)
  assert.match(draft.description, /Alice/)
  assert.match(draft.description, /feishu-bot/)
  assert.match(draft.description, /会议室 A/)
})

test('remote channel suggestion falls back to a one-hour duration when end is invalid', () => {
  const draft = buildRemoteSuggestionEventDraft({
    ...baseSuggestion,
    suggestedEndUnix: baseSuggestion.suggestedStartUnix,
  }, 'cal-main')

  assert.equal(
    draft.endTime.getTime() - draft.startTime.getTime(),
    60 * 60 * 1000,
  )
})

test('remote channel suggestion rejects a non-finite start time before IPC create', () => {
  assert.throws(() => {
    buildRemoteSuggestionEventDraft({
      ...baseSuggestion,
      suggestedStartUnix: Number.NaN,
    }, 'cal-main')
  }, /开始时间无效/)
})
