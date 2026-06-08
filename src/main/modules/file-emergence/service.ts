import { basename } from 'path'

import {
  FILE_EMERGENCE_SETTING_KEY,
  createEmptyFileEmergenceBuckets,
  type FileEmergenceBucket,
  type FileEmergenceProject,
  type FileEmergenceSnapshot,
} from '../../../shared/file-emergence'
import { expandEventList } from '../calendar-engine/rrule-engine'
import { FileLinker } from './file-linker'
import {
  candidatesFromActivity,
  candidatesFromBrowserHistory,
  candidatesFromCalendar,
  candidatesFromConversations,
  candidatesFromReadingSessions,
  mergeCandidates,
  mergeInto,
} from './candidate-extractors'
import {
  buildProjectTitle,
  type DocumentTitleHint,
  normalizeRealPathKey,
  shouldMergeSemanticIntoDirectory,
} from './project-normalizer'
import { scoreProject } from './scoring'
import type {
  BrowserHistoryPort,
  CalendarSourcePort,
  ChatPort,
  DocumentMetadataPort,
  DocumentTitleMetadata,
  FileActivityPort,
  FileEmergenceCandidate,
  FileReadingSessionPort,
  SearchPort,
  SettingsPort,
} from './types'

const DAY_MS = 24 * 60 * 60 * 1000
const SNAPSHOT_TTL_MS = 10 * 60 * 1000
const ACTIVITY_WINDOW_MS = 90 * DAY_MS
const ACTIVITY_GENERATION_WINDOW_MS = 30 * DAY_MS
const ACTIVITY_MAX_ROWS = 10_000
const READING_SESSION_MAX_ROWS = 10_000
const READING_CONTINUATION_FUTURE_LIMIT = 3

export interface FileEmergenceServiceDeps {
  settings: SettingsPort
  activity: FileActivityPort
  readingSessions: FileReadingSessionPort
  calendar: CalendarSourcePort
  browser: BrowserHistoryPort
  chat: ChatPort
  search: SearchPort | null
  documentMetadata?: DocumentMetadataPort | null
  now?: () => number
}

export interface GetFileEmergenceSnapshotInput {
  workspaceRoots: string[]
  forceRefresh?: boolean
}

interface CacheEntry {
  snapshot: FileEmergenceSnapshot
  stale: boolean
}

export class FileEmergenceService {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly now: () => number

  constructor(private readonly deps: FileEmergenceServiceDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  markStale(workspaceRoots: readonly string[]): void {
    const key = cacheKey(workspaceRoots)
    const entry = this.cache.get(key)
    if (entry) entry.stale = true
  }

  async getSnapshot(input: GetFileEmergenceSnapshotInput): Promise<FileEmergenceSnapshot> {
    const now = this.now()
    const roots = normalizeRoots(input.workspaceRoots)
    if (!isFileEmergenceEnabled(this.deps.settings)) {
      return {
        generatedAt: now,
        workspaceRoots: roots,
        enabled: false,
        buckets: createEmptyFileEmergenceBuckets(),
        refreshReason: input.forceRefresh ? 'manual' : 'initial',
        nextRefreshAt: null,
      }
    }

    const key = cacheKey(roots)
    const existing = this.cache.get(key)
    if (existing && !input.forceRefresh && !this.isStale(existing, now)) {
      return existing.snapshot
    }

    const refreshReason = input.forceRefresh
      ? 'manual'
      : !existing
        ? 'initial'
        : isSameLocalDay(existing.snapshot.generatedAt, now)
          ? 'stale'
          : 'scheduled'

    const snapshot = await this.generateSnapshot(roots, now, refreshReason)
    this.cache.set(key, { snapshot, stale: false })
    return snapshot
  }

  private isStale(entry: CacheEntry, now: number): boolean {
    if (entry.stale) return true
    if (entry.snapshot.generatedAt + SNAPSHOT_TTL_MS <= now) return true
    return !isSameLocalDay(entry.snapshot.generatedAt, now)
  }

  private async generateSnapshot(
    workspaceRoots: string[],
    now: number,
    refreshReason: NonNullable<FileEmergenceSnapshot['refreshReason']>,
  ): Promise<FileEmergenceSnapshot> {
    const degraded: Array<{ source: string; reason: string }> = []
    const activity = safeRead(
      'file_activity',
      degraded,
      () => {
        this.deps.activity.prune(now - ACTIVITY_WINDOW_MS, ACTIVITY_MAX_ROWS)
        return this.deps.activity.listRecent({
          workspaceRoots,
          since: now - ACTIVITY_GENERATION_WINDOW_MS,
          limit: 2_000,
        })
      },
      [],
    )

    const calendarEvents = safeRead(
      'calendar',
      degraded,
      () => {
        const start = Math.floor((now - 30 * DAY_MS) / 1000)
        const end = Math.floor((now + 60 * DAY_MS) / 1000)
        const nonRecurring = this.deps.calendar.getEvents(start, end)
        const recurring = this.deps.calendar.getRecurringEventsAndOverrides(start, end)
        return [
          ...nonRecurring,
          ...expandEventList(recurring.events, start, end, recurring.overridesByParent),
        ]
      },
      [],
    )

    const browserHistory = safeRead(
      'browser_history',
      degraded,
      () => this.deps.browser.getHistory(200),
      [],
    )

    const conversations = safeRead(
      'agent',
      degraded,
      () => this.deps.chat.listRecentConversations(50),
      [],
    )
    const messagesByConversation = new Map(
      conversations.map((conversation) => [
        conversation.id,
        safeRead(
          'agent',
          degraded,
          () => this.deps.chat.getMessages(conversation.id).slice(-12),
          [],
        ),
      ]),
    )

    const readingSessions = safeRead(
      'reading_session',
      degraded,
      () => {
        this.deps.readingSessions.prune(now - ACTIVITY_WINDOW_MS, READING_SESSION_MAX_ROWS)
        return this.deps.readingSessions.listRecent({
          workspaceRoots,
          since: now - ACTIVITY_WINDOW_MS,
          limit: 2_000,
        })
      },
      [],
    )

    const directoryCandidates = mergeCandidates([
      ...candidatesFromActivity(activity, workspaceRoots, now),
      ...candidatesFromReadingSessions(readingSessions, workspaceRoots, now),
    ])
    const semanticCandidates = mergeCandidates([
      ...candidatesFromCalendar(calendarEvents, now),
      ...candidatesFromConversations(conversations, messagesByConversation, now),
      ...candidatesFromBrowserHistory(browserHistory, now),
    ])

    const mergedCandidates = coordinateSemanticCandidates(directoryCandidates, semanticCandidates)
    const linker = new FileLinker(this.deps.search)
    const linkResult = await linker.linkFiles(mergedCandidates, workspaceRoots)
    degraded.push(...linkResult.degraded)
    const titleMetadata = this.loadDocumentTitleMetadata(
      workspaceRoots,
      mergedCandidates,
      linkResult.filesByCandidateId,
      degraded,
    )

    const buckets = createEmptyFileEmergenceBuckets()
    for (const candidate of mergedCandidates) {
      const files = linkResult.filesByCandidateId.get(candidate.id) || []
      const title = buildProjectTitle({
        rawLabels: candidate.rawLabels,
        evidence: candidate.evidence,
        anchorPath: candidate.anchorPath,
        documentTitleHints: documentTitleHintsFor(candidate, files, titleMetadata),
      })
      const scored = scoreProject({
        anchorType: candidate.anchorType,
        hasLinkedFiles: files.length > 0,
        evidence: candidate.evidence,
        now,
        lastOpenOrSaveAt: candidate.lastOpenOrSaveAt,
        upcomingCalendarAt: candidate.upcomingCalendarAt,
        todayActivityScore: candidate.todayActivityScore,
        recentActivityScore: candidate.recentActivityScore,
        historicalImportanceScore: candidate.historicalImportanceScore,
        fileClusterStrength: candidate.fileClusterStrength,
        agentIntentScore: candidate.agentIntentScore,
        browserIntentScore: candidate.browserIntentScore,
        completionIntentScore: candidate.completionIntentScore,
        readingContinuityScore: candidate.readingContinuityScore,
        readingDaysSinceLastRead: candidate.readingDaysSinceLastRead,
        readingProgressRatio: candidate.readingProgressRatio,
        todayReadingMinutes: candidate.todayReadingMinutes,
        recentReadingMinutes: candidate.recentReadingMinutes,
      })
      if (!scored.visible || !scored.assignedBucket || !scored.confidence) continue

      const project: FileEmergenceProject = {
        id: candidate.id,
        bucket: scored.assignedBucket,
        title: title.title,
        rawLabels: unique(candidate.rawLabels),
        anchorType: candidate.anchorType,
        anchorPath: candidate.anchorPath ?? null,
        titleSource: title.titleSource,
        score: scored.assignedScore,
        confidence: scored.confidence,
        status: scored.bucketScores.find((bucket) => bucket.bucket === scored.assignedBucket)?.status,
        files,
        evidence: candidate.evidence
          .sort((a, b) => b.score - a.score)
          .slice(0, 8),
        updatedAt: Math.max(...candidate.evidence.map((item) => item.timestamp ?? 0), now),
      }
      buckets[project.bucket].push(project)
    }

    for (const bucket of Object.keys(buckets) as FileEmergenceBucket[]) {
      buckets[bucket] = buckets[bucket]
        .sort((a, b) => b.score - a.score)
      if (bucket === 'future') {
        let continuationCount = 0
        buckets[bucket] = buckets[bucket].filter((project) => {
          if (project.status !== 'continuation') return true
          continuationCount += 1
          return continuationCount <= READING_CONTINUATION_FUTURE_LIMIT
        })
      }
      buckets[bucket] = buckets[bucket].slice(0, 10)
    }

    return {
      generatedAt: now,
      nextRefreshAt: now + SNAPSHOT_TTL_MS,
      refreshReason,
      workspaceRoots,
      enabled: true,
      buckets,
      degraded: degraded.length > 0 ? dedupeDegraded(degraded) : undefined,
    }
  }

  private loadDocumentTitleMetadata(
    workspaceRoots: readonly string[],
    candidates: readonly FileEmergenceCandidate[],
    filesByCandidateId: ReadonlyMap<string, readonly { path: string }[]>,
    degraded: Array<{ source: string; reason: string }>,
  ): Map<string, DocumentTitleMetadata> {
    if (!this.deps.documentMetadata) return new Map()
    const paths = collectDocumentTitlePaths(candidates, filesByCandidateId)
    if (paths.length === 0) return new Map()
    return safeRead(
      'document_metadata',
      degraded,
      () => this.deps.documentMetadata!.getTitleMetadata(paths, workspaceRoots),
      new Map<string, DocumentTitleMetadata>(),
    )
  }
}

export function isFileEmergenceEnabled(settings: SettingsPort): boolean {
  return settings.getSetting(FILE_EMERGENCE_SETTING_KEY) !== 'false'
}

function collectDocumentTitlePaths(
  candidates: readonly FileEmergenceCandidate[],
  filesByCandidateId: ReadonlyMap<string, readonly { path: string }[]>,
): string[] {
  const seen = new Set<string>()
  const paths: string[] = []
  const add = (path?: string | null) => {
    if (!path) return
    const key = normalizeRealPathKey(path)
    if (seen.has(key)) return
    seen.add(key)
    paths.push(path)
  }
  for (const candidate of candidates) {
    if (candidate.anchorType === 'document') add(candidate.anchorPath)
    for (const file of filesByCandidateId.get(candidate.id) || []) add(file.path)
    if (paths.length >= 300) break
  }
  return paths.slice(0, 300)
}

function documentTitleHintsFor(
  candidate: FileEmergenceCandidate,
  files: readonly { path: string }[],
  metadataByPath: ReadonlyMap<string, DocumentTitleMetadata>,
): DocumentTitleHint[] {
  const hints: DocumentTitleHint[] = []
  const seen = new Set<string>()
  const paths = [
    ...(candidate.anchorType === 'document' && candidate.anchorPath ? [candidate.anchorPath] : []),
    ...files.map((file) => file.path),
  ]
  for (const path of paths) {
    const metadata = metadataByPath.get(path)
    addTitleHint(hints, seen, stripTitleExtension(metadata?.name || basename(path)), 'file_name')
    addTitleHint(hints, seen, metadata?.metadataTitle || '', 'metadata')
    addTitleHint(hints, seen, metadata?.frontmatterTitle || '', 'frontmatter')
    if (hints.length >= 12) break
  }
  return hints
}

function addTitleHint(
  hints: DocumentTitleHint[],
  seen: Set<string>,
  raw: string,
  source: DocumentTitleHint['source'],
): void {
  const title = raw.trim()
  if (!title) return
  const key = title.toLocaleLowerCase()
  if (seen.has(key)) return
  seen.add(key)
  hints.push({ title, source })
}

function stripTitleExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return name
  const ext = name.slice(dot + 1)
  if (ext.length > 8 || /\s/.test(ext)) return name
  return name.slice(0, dot) || name
}

function coordinateSemanticCandidates(
  directories: readonly FileEmergenceCandidate[],
  semantics: readonly FileEmergenceCandidate[],
): FileEmergenceCandidate[] {
  const result = directories.map((candidate) => cloneCandidate(candidate))
  for (const semantic of semantics) {
    const title = buildProjectTitle({
      rawLabels: semantic.rawLabels,
      evidence: semantic.evidence,
      anchorPath: semantic.anchorPath,
    }).title
    const directory = result.find((candidate) => {
      if (!candidate.anchorPath) return false
      return shouldMergeSemanticIntoDirectory({
        semanticTitle: title,
        directoryPath: candidate.anchorPath,
        rawLabels: candidate.rawLabels,
        fileNames: candidate.directFiles.map((file) => basename(file.path)),
      })
    })
    if (directory) {
      mergeInto(directory, semantic)
    } else {
      result.push(cloneCandidate(semantic))
    }
  }
  return mergeCandidates(result)
}

function normalizeRoots(roots: readonly string[]): string[] {
  return Array.from(new Set(roots.map((root) => root.trim()).filter(Boolean)))
    .sort((a, b) => normalizeRealPathKey(a).localeCompare(normalizeRealPathKey(b)))
}

function cacheKey(roots: readonly string[]): string {
  return normalizeRoots(roots).map(normalizeRealPathKey).join('\n')
}

function safeRead<T>(
  source: string,
  degraded: Array<{ source: string; reason: string }>,
  fn: () => T,
  fallback: T,
): T {
  try {
    return fn()
  } catch (error) {
    degraded.push({ source, reason: error instanceof Error ? error.message : String(error) })
    return fallback
  }
}

function cloneCandidate(candidate: FileEmergenceCandidate): FileEmergenceCandidate {
  return {
    ...candidate,
    rawLabels: [...candidate.rawLabels],
    evidence: [...candidate.evidence],
    directFiles: [...candidate.directFiles],
  }
}

function isSameLocalDay(a: number, b: number): boolean {
  const left = new Date(a)
  const right = new Date(b)
  return left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
}

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
}

function dedupeDegraded(items: readonly { source: string; reason: string }[]): Array<{ source: string; reason: string }> {
  const seen = new Set<string>()
  const out: Array<{ source: string; reason: string }> = []
  for (const item of items) {
    const key = `${item.source}:${item.reason}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}
