import { basename } from 'path'
import { stat } from 'fs/promises'

import {
  FILE_EMERGENCE_SETTING_KEY,
  createEmptyFileEmergenceBuckets,
  type FileEmergenceBucket,
  type FileEmergenceProject,
  type FileEmergenceIntentCard,
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
  isMachineProjectLabel,
  type DocumentTitleHint,
  normalizeRealPathKey,
  shouldMergeSemanticIntoDirectory,
} from './project-normalizer'
import { computeAttentionInvestmentScore, scoreProject } from './scoring'
import { fileKindFromPath } from './file-kind'
import type {
  BrowserHistoryPort,
  CalendarSourcePort,
  ChatPort,
  ControlledTagFact,
  DocumentMetadataPort,
  DocumentTitleMetadata,
  FileActivityPort,
  AttentionPort,
  FileEmergenceCandidate,
  FileReadingSessionPort,
  FileProjectIdentityPort,
  FeedbackPort,
  StructuralProjectHint,
  StructuralProjectHintPort,
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
  identity?: FileProjectIdentityPort | null
  structuralHints?: StructuralProjectHintPort | null
  attention?: AttentionPort | null
  feedback?: FeedbackPort | null
  now?: () => number
}

export interface GetFileEmergenceSnapshotInput {
  workspaceRoots: string[]
  forceRefresh?: boolean
  projectContext?: { tabGroups: Array<{ name: string; paths: string[] }> }
}

interface CacheEntry {
  snapshot: FileEmergenceSnapshot
  stale: boolean
  workspaceRoots: string[]
}

export class FileEmergenceService {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inFlight = new Map<string, Promise<FileEmergenceSnapshot>>()
  private readonly rootInvalidationRevision = new Map<string, number>()
  private readonly now: () => number

  constructor(private readonly deps: FileEmergenceServiceDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  markStale(workspaceRoots: readonly string[]): void {
    const changedRoots = new Set(normalizeRoots(workspaceRoots))
    for (const root of changedRoots) {
      this.rootInvalidationRevision.set(root, (this.rootInvalidationRevision.get(root) ?? 0) + 1)
    }
    for (const entry of this.cache.values()) {
      if (entry.workspaceRoots.some((root) => changedRoots.has(root))) entry.stale = true
    }
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

    const contextualHints = normalizeContextualHints(input.projectContext, roots, now)
    const key = cacheKey(roots, contextualHints)
    const existing = this.cache.get(key)
    if (existing && !input.forceRefresh && !this.isStale(existing, now)) {
      return {
        ...existing.snapshot,
        diagnostics: existing.snapshot.diagnostics
          ? { ...existing.snapshot.diagnostics, cache: 'hit' }
          : undefined,
      }
    }

    const refreshReason = input.forceRefresh
      ? 'manual'
      : !existing
        ? 'initial'
        : isSameLocalDay(existing.snapshot.generatedAt, now)
          ? 'stale'
          : 'scheduled'

    const currentGeneration = this.inFlight.get(key)
    if (currentGeneration) return currentGeneration

    const invalidationRevisionAtStart = new Map(
      roots.map((root) => [root, this.rootInvalidationRevision.get(root) ?? 0]),
    )
    const generation = this.generateSnapshot(roots, now, refreshReason, contextualHints)
      .then((snapshot) => {
        const invalidatedDuringGeneration = roots.some(
          (root) => (this.rootInvalidationRevision.get(root) ?? 0) !== invalidationRevisionAtStart.get(root),
        )
        this.cache.set(key, { snapshot, stale: invalidatedDuringGeneration, workspaceRoots: roots })
        return snapshot
      })
      .finally(() => {
        if (this.inFlight.get(key) === generation) this.inFlight.delete(key)
      })
    this.inFlight.set(key, generation)
    return generation
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
    contextualHints: StructuralProjectHint[],
  ): Promise<FileEmergenceSnapshot> {
    const degraded: Array<{ source: string; reason: string }> = []
    const activity = safeRead(
      'file_activity',
      degraded,
      () => {
        this.deps.activity.prune(now - ACTIVITY_WINDOW_MS, ACTIVITY_MAX_ROWS)
        return this.deps.activity.listRecent({
          workspaceRoots,
          since: now - ACTIVITY_WINDOW_MS,
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
        const end = Math.floor((now + 365 * DAY_MS) / 1000)
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
    const structuralHints = [
      ...contextualHints,
      ...safeRead(
        'project_structure',
        degraded,
        () => this.deps.structuralHints?.listHints(workspaceRoots) ?? [],
        [],
      ),
    ]
    safeRead('attention_rollup', degraded, () => this.deps.attention?.backfill(workspaceRoots, now), undefined)
    const attentionFacts = safeRead('attention_rollup', degraded, () => this.deps.attention?.listFacts(workspaceRoots) ?? [], [])
    const attentionByFileKey = new Map(attentionFacts.map((fact) => [fact.fileKey, fact]))
    const activeIntentFiles = safeRead('project_intent', degraded, () => this.deps.attention?.activeIntentFileKeys(now) ?? new Set<string>(), new Set<string>())

    const rollupActivity = attentionFacts
      .filter((fact) => fact.lastActivityAt > 0 && fact.lastActivityAt >= now - 365 * DAY_MS)
      .map((fact) => ({
        id: `rollup-${fact.fileKey}`,
        path: fact.path,
        workspaceRoot: fact.workspaceRoot,
        eventType: fact.saveCount > 0 ? 'save' as const : 'open' as const,
        source: 'file_tree' as const,
        weight: Math.min(2, 0.5 + fact.activeDays / 5 + fact.readingMs / 7_200_000 + fact.markCount / 4),
        meta: { source: 'attention_rollup' },
        createdAt: fact.lastActivityAt,
      }))
    const directoryCandidates = mergeCandidates([
      ...candidatesFromActivity(activity, workspaceRoots, now),
      ...candidatesFromActivity(rollupActivity, workspaceRoots, now),
      ...candidatesFromReadingSessions(readingSessions, workspaceRoots, now),
    ])
    const semanticCandidates = mergeCandidates([
      ...candidatesFromCalendar(calendarEvents, now),
      ...candidatesFromConversations(conversations, messagesByConversation, now),
      ...candidatesFromBrowserHistory(browserHistory, now),
    ])

    const mergedCandidates = coordinateSemanticCandidates(directoryCandidates, semanticCandidates)
    if (this.deps.identity) {
      remapCandidateFilesThroughIdentity(mergedCandidates, workspaceRoots, this.deps.identity)
    }
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
    const suppressedFilePaths = new Set<string>(safeRead('user_feedback',degraded,()=>this.deps.feedback?.listSuppressedFilePaths(workspaceRoots,now)??[],[]))
    const candidatesById = new Map(mergedCandidates.map((candidate) => [candidate.id, candidate]))
    let rejectedCount = 0
    const rejectionReasons:Record<string,number>={}
    const suppressedCounts:Record<'not_related'|'snoozed'|'hidden',number>={not_related:0,snoozed:0,hidden:0}
    for (const candidate of mergedCandidates) {
      let files = [...(linkResult.filesByCandidateId.get(candidate.id) || [])]
      const controlledTags = controlledTagsForPaths(
        [candidate.anchorPath, ...files.map((file) => file.path)],
        titleMetadata,
      )
      const recallTags = controlledTags.filter((tag) => tag.facet === 'domain' || tag.facet === 'use' || tag.facet === 'form')
      if (files.length < 3 && recallTags.length > 0 && this.deps.documentMetadata?.findRelatedFiles) {
        const related = safeRead('controlled_tags', degraded, () => this.deps.documentMetadata!.findRelatedFiles!(
          recallTags,
          workspaceRoots,
          files.map((file) => file.path),
          3 - files.length,
        ), [])
        files = [...files, ...related.map((file) => ({
          fileKey: file.fileKey,
          path: file.path,
          name: file.name,
          kind: fileKindFromPath(file.path),
          score: 0.42,
          reason: `受控标签相关：${file.sharedTags.map((tag) => tag.label).join('、')}`,
          modifiedAt: null,
        }))].slice(0, 3)
      }
      const controlledTagStates = controlledTags.filter((tag) => tag.facet === 'state').map((tag) => tag.label)
      const title = buildProjectTitle({
        rawLabels: candidate.rawLabels,
        evidence: candidate.evidence,
        anchorPath: candidate.anchorPath,
        documentTitleHints: [
          ...documentTitleHintsFor(candidate, files, titleMetadata),
          ...structuralTitleHintsFor(candidate, files, structuralHints),
        ],
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
        activeIntentScore: candidate.directFiles.some((file) => file.fileKey && activeIntentFiles.has(file.fileKey)) ? 1 : 0,
        activeDays90: Math.max(0, ...candidate.directFiles.map((file) => file.fileKey ? attentionByFileKey.get(file.fileKey)?.activeDays ?? 0 : 0)),
        totalInvestmentScore: Math.max(0, ...candidate.directFiles.map((file) => {
          const fact = file.fileKey ? attentionByFileKey.get(file.fileKey) : null
          return fact ? computeAttentionInvestmentScore(fact) : 0
        })),
        surfacedRecently: candidate.directFiles.some((file) => {
          const at = file.fileKey ? attentionByFileKey.get(file.fileKey)?.lastSurfacedAt : null
          return at != null && at >= now - 14 * DAY_MS
        }),
        controlledTagStates,
      })
      if (!scored.visible || !scored.assignedBucket || !scored.confidence) {
        rejectedCount += 1
        incrementCount(rejectionReasons,controlledTagStates.includes('已归档')?'archived':'not_qualified')
        continue
      }

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
        evidence: [...candidate.evidence, ...controlledTags.map((tag) => ({
          source: 'controlled_tag' as const,
          label: `${tag.facet}: ${tag.label}`,
          score: tag.facet === 'state' ? 0.55 : 0.3,
          timestamp: now,
          ref: `tag:${tag.tagId}`,
        }))]
          .sort((a, b) => b.score - a.score)
          .slice(0, 8),
        updatedAt: latestEvidenceAt(candidate.evidence),
      }
      if (this.deps.identity) {
        const workspaceRoot = workspaceRootForProject(candidate.anchorPath, files, workspaceRoots)
        if (workspaceRoot) {
          const identity = this.deps.identity.resolveProject({
            workspaceRoot,
            displayName: title.title,
            source: identitySourceForTitle(title.titleSource, files.length),
            confidence: title.confidenceHint,
            anchorPath: candidate.anchorPath,
            filePaths: files.map((file) => file.path),
            evidence: candidate.evidence.slice(0, 8).map((item) => ({
              source: item.source,
              label: item.label,
              score: item.score,
              timestamp: item.timestamp ?? null,
            })),
            observedAt: now,
          })
          project.projectKey = identity.projectKey
          project.title = identity.displayName
          project.files = project.files.map((file) => ({
            ...file,
            fileKey: identity.files.find((item) => item.currentPath === file.path)?.fileKey ?? null,
          }))
        }
      }
      if(project.projectKey&&this.deps.feedback){
        const decision=safeRead('user_feedback',degraded,()=>this.deps.feedback!.resolve(project.projectKey!,project.updatedAt,now),{visible:true,reason:null,until:null})
        if(!decision.visible&&decision.reason){
          suppressedCounts[decision.reason]+=1
          rejectedCount+=1
          incrementCount(rejectionReasons,`feedback_${decision.reason}`)
          for(const path of this.deps.feedback.listProjectFilePaths(project.projectKey)) suppressedFilePaths.add(path)
          continue
        }
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

    const bucketCounts = Object.fromEntries(
      (Object.keys(buckets) as FileEmergenceBucket[]).map((bucket) => [bucket, buckets[bucket].length]),
    ) as Record<FileEmergenceBucket, number>
    const visibleCount = Object.values(bucketCounts).reduce((sum, count) => sum + count, 0)
    const historyCount = activity.length + readingSessions.length
    const suppressedTotal=Object.values(suppressedCounts).reduce((sum,count)=>sum+count,0)
    const emptyState = visibleCount > 0
      ? undefined
      : suppressedTotal > 0
        ? 'all_suppressed' as const
      : degraded.length > 0
        ? 'sources_degraded' as const
        : historyCount < 2
          ? 'insufficient_history' as const
          : 'no_trusted_candidates' as const
    const intentCards = await buildIntentCards(buckets, candidatesById, activeIntentFiles)

    const snapshot = {
      generatedAt: now,
      nextRefreshAt: now + SNAPSHOT_TTL_MS,
      refreshReason,
      workspaceRoots,
      enabled: true,
      buckets,
      intentCards,
      suppressedFilePaths: suppressedFilePaths.size > 0 ? [...suppressedFilePaths] : undefined,
      degraded: degraded.length > 0 ? dedupeDegraded(degraded) : undefined,
      emptyState,
      diagnostics: {
        sourceCounts: {
          file_activity: activity.length,
          reading_session: readingSessions.length,
          calendar: calendarEvents.length,
          browser_history: browserHistory.length,
          agent: conversations.length,
        },
        candidateCount: mergedCandidates.length,
        visibleCount,
        rejectedCount,
        bucketCounts,
        cache: 'generated',
        suppressedCounts:suppressedTotal>0?suppressedCounts:undefined,
      },
    } satisfies FileEmergenceSnapshot
    const rankedProjects=Object.values(buckets).flat().filter((project) => project.projectKey).sort((a,b)=>bucketEvaluationPriority(a.bucket)-bucketEvaluationPriority(b.bucket)||b.score-a.score)
    safeRead('prediction_snapshot', degraded, () => this.deps.attention?.recordSnapshot(
      rankedProjects.map((project,index) => ({
        projectKey: project.projectKey!, bucket: project.bucket,
        fileKeys:project.files.map((file)=>file.fileKey).filter((fileKey):fileKey is string=>Boolean(fileKey)),
        reasonCodes: project.evidence.slice(0, 4).map((item) => item.source),
        rank:index+1,score:project.score,machineName:isMachineProjectLabel(project.title),
      })), now,{workspaceRoots,rejectionReasons}), undefined)
    return snapshot
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

function incrementCount(counts:Record<string,number>,key:string):void{counts[key]=(counts[key]??0)+1}
function bucketEvaluationPriority(bucket:FileEmergenceBucket):number{return bucket==='today'?0:bucket==='future'?1:bucket==='past'?2:3}

async function buildIntentCards(
  buckets: Record<FileEmergenceBucket, FileEmergenceProject[]>,
  candidatesById: ReadonlyMap<string, FileEmergenceCandidate>,
  activeIntentFiles: ReadonlySet<string>,
): Promise<FileEmergenceIntentCard[]> {
  const cards: FileEmergenceIntentCard[] = []
  for (const project of Object.values(buckets).flat()) {
    if (!project.projectKey) continue
    const candidate = candidatesById.get(project.id)
    if (!candidate) continue
    if (project.bucket === 'future' && project.status === 'upcoming' && (
      candidate.upcomingCalendarAt != null ||
      (candidate.activeIntentScore ?? 0) >= 0.6 ||
      candidate.agentIntentScore >= 0.6 ||
      candidate.directFiles.some((file)=>Boolean(file.fileKey&&activeIntentFiles.has(file.fileKey)))
    )) {
      cards.push({
        id: `prepare:${project.projectKey}`,
        projectKey: project.projectKey,
        type: 'prepare',
        title: project.title,
        confidence: confidenceNumber(project.confidence),
        action: { kind:'open_project',ref:project.projectKey,targetPath:project.files[0]?.path ?? null,memberPaths:project.files.map((file)=>file.path) },
        evidence: project.evidence.slice(0, 4).map((item) => ({fact:item.label,ref:item.ref})),
      })
    }
    const sources = new Set(project.evidence.map((item) => item.source))
    if (project.bucket === 'today' && project.files.length >= 2 && (sources.size >= 2 || project.evidence.length >= 2)) {
      cards.push({
        id: `forming:${project.projectKey}`,
        projectKey: project.projectKey,
        type: 'forming',
        title: project.title,
        confidence: confidenceNumber(project.confidence),
        action: { kind:'open_project_group',ref:project.projectKey,targetPath:project.files[0]?.path ?? null,memberPaths:project.files.map((file)=>file.path) },
        evidence: project.files.slice(0, 3).map((file) => ({fact:file.reason,ref:`file:${file.path}`})),
      })
    }
    if (project.bucket === 'past' && candidate.completionIntentScore > 0.2) {
      const artifact = await firstExistingFile(project.files)
      if (artifact) cards.push({
        id: `harvest:${project.projectKey}`,
        projectKey: project.projectKey,
        type: 'harvest',
        title: project.title,
        confidence: confidenceNumber(project.confidence),
        action: { kind:'open_artifact',ref:artifact.path,targetPath:artifact.path,memberPaths:[artifact.path] },
        evidence: [{fact:`已完成产物：${artifact.name}`,ref:`file:${artifact.path}`}],
      })
    }
  }
  return cards.slice(0, 9)
}

async function firstExistingFile(files: readonly {path:string;name:string}[]): Promise<{path:string;name:string}|null> {
  for (const file of files) {
    const info = await stat(file.path).catch(() => null)
    if (info?.isFile()) return file
  }
  return null
}

function confidenceNumber(confidence: FileEmergenceProject['confidence']): number {
  return confidence === 'high' ? 0.85 : confidence === 'medium' ? 0.7 : 0.55
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
    addTitleHint(hints, seen, metadata?.readyProject || '', 'ready_project', path)
    addTitleHint(hints, seen, stripTitleExtension(metadata?.name || basename(path)), 'file_name', path)
    addTitleHint(hints, seen, metadata?.metadataTitle || '', 'metadata', path)
    addTitleHint(hints, seen, metadata?.frontmatterTitle || '', 'frontmatter', path)
    if (hints.length >= 12) break
  }
  return hints
}

function controlledTagsForPaths(
  paths: readonly (string | null | undefined)[],
  metadataByPath: ReadonlyMap<string, DocumentTitleMetadata>,
): ControlledTagFact[] {
  const byId = new Map<string, ControlledTagFact>()
  for (const path of paths) {
    if (!path) continue
    for (const tag of metadataByPath.get(path)?.controlledTags ?? []) byId.set(tag.tagId, tag)
  }
  return Array.from(byId.values())
}

function addTitleHint(
  hints: DocumentTitleHint[],
  seen: Set<string>,
  raw: string,
  source: DocumentTitleHint['source'],
  path?: string | null,
): void {
  const title = raw.trim()
  if (!title) return
  const key = title.toLocaleLowerCase()
  if (seen.has(key)) return
  seen.add(key)
  hints.push({ title, source, path })
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

function remapCandidateFilesThroughIdentity(
  candidates: FileEmergenceCandidate[],
  workspaceRoots: readonly string[],
  identity: FileProjectIdentityPort,
): void {
  for (const candidate of candidates) {
    candidate.directFiles = candidate.directFiles.map((file) => {
      const root = workspaceRootForPath(file.path, workspaceRoots)
      if (!root) return file
      const resolved = identity.resolveCurrentFile(root, file.path)
      return resolved ? { ...file, path: resolved.currentPath, fileKey: resolved.fileKey } : file
    })
    if (candidate.anchorType === 'document' && candidate.anchorPath) {
      const root = workspaceRootForPath(candidate.anchorPath, workspaceRoots)
      const resolved = root ? identity.resolveCurrentFile(root, candidate.anchorPath) : null
      if (resolved) candidate.anchorPath = resolved.currentPath
    }
  }
}

function workspaceRootForProject(
  anchorPath: string | null | undefined,
  files: readonly { path: string }[],
  workspaceRoots: readonly string[],
): string | null {
  for (const path of [anchorPath, ...files.map((file) => file.path)]) {
    if (!path) continue
    const root = workspaceRootForPath(path, workspaceRoots)
    if (root) return root
  }
  return null
}

function workspaceRootForPath(path: string, workspaceRoots: readonly string[]): string | null {
  const key = normalizeRealPathKey(path)
  return workspaceRoots
    .filter((root) => {
      const rootKey = normalizeRealPathKey(root)
      return key === rootKey || key.startsWith(`${rootKey}/`)
    })
    .sort((a, b) => b.length - a.length)[0] || null
}

function identitySourceForTitle(
  source: FileEmergenceProject['titleSource'],
  fileCount: number,
): 'frontmatter' | 'tab_group' | 'task' | 'attachment' | 'directory_consensus' | 'fallback' {
  if (source === 'frontmatter') return 'frontmatter'
  if (source === 'tab_group') return 'tab_group'
  if (source === 'task') return 'task'
  if (source === 'attachment') return 'attachment'
  if (source === 'directory' && fileCount >= 2) return 'directory_consensus'
  return 'fallback'
}

function normalizeRoots(roots: readonly string[]): string[] {
  return Array.from(new Set(roots.map((root) => root.trim()).filter(Boolean)))
    .sort((a, b) => normalizeRealPathKey(a).localeCompare(normalizeRealPathKey(b)))
}

function cacheKey(roots: readonly string[], contextualHints: readonly StructuralProjectHint[]): string {
  const rootKey = normalizeRoots(roots).map(normalizeRealPathKey).join('\n')
  const contextKey = contextualHints
    .map((hint) => `${hint.source}:${hint.label}:${hint.paths.map(normalizeRealPathKey).sort().join(',')}`)
    .sort()
    .join('\n')
  return `${rootKey}\n--context--\n${contextKey}`
}

function normalizeContextualHints(
  context: GetFileEmergenceSnapshotInput['projectContext'],
  workspaceRoots: readonly string[],
  now: number,
): StructuralProjectHint[] {
  if (!context?.tabGroups) return []
  return context.tabGroups
    .map((group) => ({
      source: 'tab_group' as const,
      label: String(group.name || '').trim(),
      paths: unique(group.paths.filter((path) => Boolean(workspaceRootForPath(path, workspaceRoots)))),
      updatedAt: now,
    }))
    .filter((hint) => hint.label.length > 0 && hint.paths.length >= 2)
}

function structuralTitleHintsFor(
  candidate: FileEmergenceCandidate,
  files: readonly { path: string }[],
  hints: readonly StructuralProjectHint[],
): DocumentTitleHint[] {
  const candidatePaths = unique([
    ...(candidate.anchorPath ? [candidate.anchorPath] : []),
    ...candidate.directFiles.map((file) => file.path),
    ...files.map((file) => file.path),
  ])
  const out: DocumentTitleHint[] = []
  for (const hint of hints) {
    const matchingPaths = hint.paths.filter((path) => candidatePaths.some((candidatePath) => (
      normalizeRealPathKey(path) === normalizeRealPathKey(candidatePath) ||
      normalizeRealPathKey(path).startsWith(`${normalizeRealPathKey(candidatePath)}/`) ||
      normalizeRealPathKey(candidatePath).startsWith(`${normalizeRealPathKey(path)}/`)
    )))
    if (matchingPaths.length === 0) continue
    for (const path of matchingPaths) out.push({ title: hint.label, source: hint.source, path })
  }
  return out
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

function latestEvidenceAt(evidence: readonly { timestamp?: number | null }[]): number {
  return evidence.reduce((latest, item) => {
    const timestamp = Number(item.timestamp)
    return Number.isFinite(timestamp) && timestamp > latest ? timestamp : latest
  }, 0)
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
