import type { RemoteCalendarEventSuggestion } from '../../../shared/calendar-remote-channel'

export interface RemoteSuggestionEventDraft {
  calendarId: string
  title: string
  description: string
  startTime: Date
  endTime: Date
  allDay: boolean
}

function truncateText(value: string, maxLength: number): string {
  const trimmed = value.trim()
  if (trimmed.length <= maxLength) return trimmed
  return `${trimmed.slice(0, maxLength - 3)}...`
}

function normalizeTitle(suggestion: RemoteCalendarEventSuggestion): string {
  const raw =
    suggestion.suggestedTitle?.trim() ||
    suggestion.extractedText?.trim() ||
    '远程消息日程'
  return truncateText(raw, 80)
}

export function buildRemoteSuggestionEventDraft(
  suggestion: RemoteCalendarEventSuggestion,
  calendarId: string,
): RemoteSuggestionEventDraft {
  if (!Number.isFinite(suggestion.suggestedStartUnix)) {
    throw new Error('远程消息里的开始时间无效')
  }

  const startUnix = suggestion.suggestedStartUnix
  const endUnix =
    Number.isFinite(suggestion.suggestedEndUnix) && suggestion.suggestedEndUnix > startUnix
      ? suggestion.suggestedEndUnix
      : startUnix + 3600

  const sender = suggestion.source.sender?.trim()
  const excerpt = truncateText(suggestion.source.text || suggestion.extractedText || '', 280)
  const description = [
    '来自远程消息',
    sender ? `发送者：${sender}` : null,
    `频道：${suggestion.source.channelKind}`,
    excerpt ? `原文：${excerpt}` : null,
  ].filter((line): line is string => Boolean(line)).join('\n')

  return {
    calendarId,
    title: normalizeTitle(suggestion),
    description,
    startTime: new Date(startUnix * 1000),
    endTime: new Date(endUnix * 1000),
    allDay: !suggestion.hasTime,
  }
}
