import type { BrowserHistoryEntry, CalendarEvent, ChatMessageRecord } from '../database/records'

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

export interface LongTermAttentionFact {
  fileKey: string
  path: string
  workspaceRoot: string
  lastActivityAt: number
  openCount: number
  saveCount: number
  activeDays: number
  readingMs: number
  progress: number | null
  markCount: number
  lastSurfacedAt: number | null
}

export interface AttentionPort {
  backfill(workspaceRoots: readonly string[], now: number): void
  listFacts(workspaceRoots: readonly string[]): LongTermAttentionFact[]
  activeIntentFileKeys(now: number): Set<string>
  recordSnapshot(projects: readonly { projectKey: string; fileKeys:string[];bucket: string; reasonCodes: string[]; rank:number;score:number;machineName:boolean }[], generatedAt: number, context:{workspaceRoots:readonly string[];rejectionReasons:Record<string,number>}): void
}

export interface FeedbackPort {
  resolve(projectKey:string,latestEvidenceAt:number,now:number):{visible:boolean;reason:'not_related'|'snoozed'|'hidden'|null;until:number|null}
  listProjectFilePaths(projectKey:string):string[]
  listSuppressedFilePaths(workspaceRoots:readonly string[],now:number):string[]
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
  readyProject?: string | null
  controlledTags?: ControlledTagFact[]
}

export interface ControlledTagFact {
  tagId: string
  facet: 'form' | 'domain' | 'entity' | 'use' | 'state'
  label: string
}

export interface DocumentMetadataPort {
  getTitleMetadata(
    paths: readonly string[],
    workspaceRoots: readonly string[],
  ): Map<string, DocumentTitleMetadata>
  findRelatedFiles?(
    tags: readonly ControlledTagFact[],
    workspaceRoots: readonly string[],
    excludePaths: readonly string[],
    limit: number,
  ): Array<{ fileKey: string; path: string; name: string; sharedTags: ControlledTagFact[] }>
}

export interface ProjectIdentityResolution {
  projectKey: string
  displayName: string
  source: string
  confidence: number
  files: Array<{ fileKey: string; currentPath: string }>
}

export interface FileProjectIdentityPort {
  resolveCurrentFile(workspaceRoot: string, observedPath: string): { fileKey: string; currentPath: string } | null
  resolveProject(input: {
    workspaceRoot: string
    displayName: string
    source: 'frontmatter' | 'tab_group' | 'task' | 'attachment' | 'directory_consensus' | 'fallback'
    confidence: number
    anchorPath?: string | null
    filePaths: readonly string[]
    evidence: Array<Record<string, unknown>>
    observedAt: number
  }): ProjectIdentityResolution
}

export interface StructuralProjectHint {
  source: 'tab_group' | 'task' | 'attachment'
  label: string
  paths: string[]
  updatedAt: number
}

export interface StructuralProjectHintPort {
  listHints(workspaceRoots: readonly string[]): StructuralProjectHint[]
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
  activeIntentScore?: number
  activeDays90?: number
  totalInvestmentScore?: number
  surfacedRecently?: boolean
}
