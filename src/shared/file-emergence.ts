export const FILE_EMERGENCE_SETTING_KEY = 'file_emergence_enabled'

export const FILE_EMERGENCE_BUCKETS = ['future', 'today', 'past', 'distant'] as const

export type FileEmergenceBucket = typeof FILE_EMERGENCE_BUCKETS[number]

export type FileEmergenceFileKind =
  | 'folder'
  | 'document'
  | 'code'
  | 'image'
  | 'video'
  | 'audio'
  | 'spreadsheet'
  | 'design'
  | 'other'

export type FileEmergenceEvidenceSource =
  | 'calendar'
  | 'file_activity'
  | 'agent'
  | 'browser_history'
  | 'search_index'
  | 'current_document'
  | 'reading_progress'
  | 'reading_session'
  | 'controlled_tag'

export type FileActivityEventType = 'open' | 'save' | 'select' | 'external_change'

export type FileActivitySource =
  | 'file_tree'
  | 'document_mode'
  | 'emergence'
  | 'watcher'
  | 'document_write'

export interface FileEmergenceFileRef {
  fileKey?: string | null
  path: string
  name: string
  kind: FileEmergenceFileKind
  score: number
  reason: string
  modifiedAt?: number | null
  isCurrent?: boolean
}

export interface FileEmergenceEvidence {
  source: FileEmergenceEvidenceSource
  label: string
  score: number
  timestamp?: number | null
  ref?: string | null
}

export interface FileEmergenceProject {
  projectKey?: string
  id: string
  bucket: FileEmergenceBucket
  title: string
  rawLabels: string[]
  anchorType: 'directory' | 'semantic' | 'document'
  anchorPath?: string | null
  titleSource:
    | 'user'
    | 'frontmatter'
    | 'tab_group'
    | 'task'
    | 'attachment'
    | 'directory'
    | 'calendar'
    | 'agent'
    | 'browser_history'
    | 'rule_refined'
    | 'llm_refined'
  score: number
  confidence: 'low' | 'medium' | 'high'
  status?: 'upcoming' | 'active' | 'continuation' | 'recently_finished' | 'dormant_important'
  files: FileEmergenceFileRef[]
  evidence: FileEmergenceEvidence[]
  updatedAt: number
}

export interface FileEmergenceIntentCard {
  id: string
  projectKey: string
  type: 'prepare' | 'harvest' | 'forming'
  title: string
  confidence: number
  action: {
    kind: string
    ref: string
    targetPath?: string | null
    memberPaths?: string[]
  }
  evidence: Array<{
    fact: string
    ref?: string | null
  }>
}

export interface FileEmergenceSnapshot {
  generatedAt: number
  nextRefreshAt?: number | null
  refreshReason?: 'initial' | 'stale' | 'manual' | 'source_changed' | 'scheduled'
  workspaceRoots: string[]
  enabled: boolean
  buckets: Record<FileEmergenceBucket, FileEmergenceProject[]>
  intentCards?: FileEmergenceIntentCard[]
  /** Paths currently suppressed by durable project feedback. Renderer-only
   * current-tab/reading overlays must never re-introduce these files. */
  suppressedFilePaths?: string[]
  degraded?: Array<{ source: string; reason: string }>
  emptyState?: 'no_trusted_candidates' | 'sources_degraded' | 'insufficient_history' | 'all_suppressed'
  diagnostics?: {
    sourceCounts: Partial<Record<FileEmergenceEvidenceSource | 'calendar' | 'agent' | 'browser_history', number>>
    candidateCount: number
    visibleCount: number
    rejectedCount: number
    bucketCounts: Record<FileEmergenceBucket, number>
    cache: 'generated' | 'hit'
    suppressedCounts?: Partial<Record<'not_related'|'snoozed'|'hidden',number>>
  }
}

export interface FileEmergenceGetSnapshotPayload {
  workspaceRoots: string[]
  forceRefresh?: boolean
  projectContext?: {
    tabGroups: Array<{ name: string; paths: string[] }>
  }
}

export interface FileEmergenceRecordActivityPayload {
  path: string
  eventType: Extract<FileActivityEventType, 'open' | 'save'>
  source: Extract<FileActivitySource, 'file_tree' | 'document_mode' | 'emergence'>
  workspaceRoots: string[]
  meta?: Record<string, unknown>
}

export interface FileEmergenceRenameProjectPayload {
  projectKey: string
  displayName: string
  workspaceRoots: string[]
}

export interface FileEmergenceAssignFilePayload {
  projectKey: string
  path: string
  workspaceRoots: string[]
}

export interface FileEmergenceCreateProjectForFilePayload {
  displayName: string
  path: string
  workspaceRoots: string[]
}

export interface FileEmergenceFeedbackPayload {
  projectKey: string
  action: 'not_related'|'snooze'|'hide'|'restore'
  workspaceRoots: string[]
  evidenceCutoff?: number | null
  snoozeUntil?: number | null
}

export type FileEmergenceReadingProgressKind = 'document' | 'pdf' | 'ebook'

export interface FileEmergenceReadingProgress {
  path: string
  title?: string | null
  kind: FileEmergenceReadingProgressKind
  progressRatio: number
  updatedAt: number
  detail?: string | null
  exists?: boolean
}

export interface FileEmergenceRecordReadingSessionPayload {
  path: string
  source: Extract<FileActivitySource, 'document_mode'>
  workspaceRoots: string[]
  startedAt: number
  endedAt: number
  activeMs: number
  progressStart?: number | null
  progressEnd?: number | null
  progressKind?: FileEmergenceReadingProgressKind | null
  meta?: Record<string, unknown>
}

export interface FileActivityEvent {
  id: string
  path: string
  workspaceRoot: string | null
  eventType: FileActivityEventType
  source: FileActivitySource
  weight: number
  meta: Record<string, unknown> | null
  createdAt: number
}

export interface FileReadingSession {
  id: string
  path: string
  workspaceRoot: string | null
  source: Extract<FileActivitySource, 'document_mode'>
  startedAt: number
  endedAt: number
  activeMs: number
  progressStart: number | null
  progressEnd: number | null
  progressKind: FileEmergenceReadingProgressKind | null
  meta: Record<string, unknown> | null
}

export function createEmptyFileEmergenceBuckets(): Record<FileEmergenceBucket, FileEmergenceProject[]> {
  return {
    future: [],
    today: [],
    past: [],
    distant: [],
  }
}
