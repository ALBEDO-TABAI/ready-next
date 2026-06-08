import type { BrowserHistoryEntry, CalendarEvent, ChatMessageRecord } from '../database'
import type { EventInstance, EventOverride } from '../calendar-engine/rrule-engine'
import type {
  FileActivityEvent,
  FileEmergenceEvidence,
  FileEmergenceFileRef,
  FileEmergenceProject,
  FileReadingSession,
} from '../../../shared/file-emergence'

export type CalendarEventLike = CalendarEvent | EventInstance

export interface CalendarSourcePort {
  getEvents(startTime: number, endTime: number): CalendarEvent[]
  getRecurringEventsAndOverrides(startTime: number, endTime: number): {
    events: CalendarEvent[]
    overridesByParent: Map<string, EventOverride[]>
  }
}

export interface FileActivityPort {
  listRecent(options: {
    workspaceRoots: string[]
    since: number
    limit: number
  }): FileActivityEvent[]
  prune(cutoff: number, maxRows: number): void
}

export interface FileReadingSessionPort {
  listRecent(options: {
    workspaceRoots: string[]
    since: number
    limit: number
  }): FileReadingSession[]
  prune(cutoff: number, maxRows: number): void
}

export interface BrowserHistoryPort {
  getHistory(limit?: number): BrowserHistoryEntry[]
}

export interface RecentConversation {
  id: string
  title: string
  updatedAt: string
  agent?: string
}

export interface ChatPort {
  listRecentConversations(limit: number): RecentConversation[]
  getMessages(conversationId: string): ChatMessageRecord[]
}

export interface SettingsPort {
  getSetting(key: string): string | undefined
}

export interface SearchPort {
  search(
    query: string,
    options: { limit?: number; workspaceRoots?: string[]; sources?: string[] },
  ): Promise<{
    items: Array<{
      path: string
      name: string
      sourceType: string
      sourceMeta?: Record<string, unknown> | null
    }>
    degraded?: boolean
  }>
}

export interface DocumentTitleMetadata {
  path: string
  name?: string | null
  frontmatterTitle?: string | null
  metadataTitle?: string | null
}

export interface DocumentMetadataPort {
  getTitleMetadata(
    paths: readonly string[],
    workspaceRoots: readonly string[],
  ): Map<string, DocumentTitleMetadata>
}

export interface FileEmergenceCandidate {
  id: string
  anchorType: FileEmergenceProject['anchorType']
  anchorPath?: string | null
  rawLabels: string[]
  evidence: FileEmergenceEvidence[]
  directFiles: FileEmergenceFileRef[]
  lastOpenOrSaveAt?: number | null
  upcomingCalendarAt?: number | null
  todayActivityScore: number
  recentActivityScore: number
  historicalImportanceScore: number
  fileClusterStrength: number
  agentIntentScore: number
  browserIntentScore: number
  completionIntentScore: number
  readingContinuityScore: number
  readingDaysSinceLastRead?: number | null
  readingProgressRatio?: number | null
  todayReadingMinutes: number
  recentReadingMinutes: number
}
