/**
 * browser-collector engine (plan §3.3) — the deterministic per-note collection
 * loop the background sub-agent runs.
 *
 * Combines the validated CollectionPlan + per-note loop state
 * (agent-collection-plan) with the per-note action (browser-collector-actions),
 * driving: planNextNote → collectNote → recordNoteResult → checkpoint, until a
 * stop condition. It owns NO IO and NO Electron — the facade, checkpoint, and
 * path-join are injected, so the whole loop is unit-testable. The background
 * task lifecycle (start/resume/cancel/projection) wraps this engine.
 */

import {
  planNextNote,
  recordNoteResult,
  recordRetryNoteResult,
  createCollectionLoopState,
  normalizeCollectionLoopState,
  retryableCollectionFailures,
  type CollectionPlan,
  type CollectionNote,
  type CollectionLoopState,
  type CollectionNoteOutput,
  type CollectionStopReason,
} from './agent-collection-plan'
import { collectCardNote, collectNote, type NoteCollectFacade, type NoteCollectFileOps, type NoteCollectResult } from './browser-collector-actions'

const MAX_FINAL_ITEM_RETRIES = 2

export interface BrowserCollectionProgress {
  total: number
  completed: number
  failed: number
  currentTitle: string | null
  stopReason: CollectionStopReason
}

export interface BrowserCollectionDeps {
  facade: NoteCollectFacade
  pathJoin: (...parts: string[]) => string
  now: () => number
  /** Persisted after every note so a crash/cancel resumes from here. */
  onCheckpoint?: (state: CollectionLoopState, progress: BrowserCollectionProgress) => void | Promise<void>
  onProgress?: (progress: BrowserCollectionProgress) => void
  /** Cooperative cancel/lease-loss probe checked before each note. */
  shouldStop?: () => CollectionStopReason | null
  /** Pace between notes on high-control platforms (plan §4.4 限速). 0 = no pace. */
  interNoteDelayMs?: number
  /** Injected sleep so pacing is unit-testable without real timers. */
  sleep?: (ms: number) => Promise<void>
  fileOps?: NoteCollectFileOps
  /**
   * Download-volume budget (plan §4.4): stop once this many images have been
   * saved across all notes. A practical proxy for a byte budget — the download
   * layer reports counts, not bytes. 0/undefined = no budget.
   */
  maxTotalImages?: number
  strategy?: 'url_batch' | 'card_loop'
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface BrowserCollectionResult {
  collected: string[]
  failed: Array<{ url: string; reason: string }>
  notes: CollectionNoteOutput[]
  rounds: number
  stopReason: CollectionStopReason
  state: CollectionLoopState
}

function progressOf(plan: CollectionPlan, state: CollectionLoopState, currentTitle: string | null, stopReason: CollectionStopReason): BrowserCollectionProgress {
  return { total: plan.notes.length, completed: state.collected.length, failed: state.failed.length, currentTitle, stopReason }
}

function normalizedTitle(value: string | undefined): string {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function isPartialImagesReason(reason: string | undefined): boolean {
  return String(reason || '').startsWith('partial_images')
}

function noteMatchesFailure(note: CollectionNote, url: string): boolean {
  return note.url === url || note.canonicalUrl === url || note.openUrl === url
}

/**
 * Run the collection. `initialState` lets a resumed task continue from the last
 * checkpoint instead of restarting.
 */
export async function runBrowserCollection(
  plan: CollectionPlan,
  deps: BrowserCollectionDeps,
  initialState?: CollectionLoopState,
): Promise<BrowserCollectionResult> {
  let state = normalizeCollectionLoopState(initialState ?? createCollectionLoopState(deps.now()))
  let rounds = 0
  let totalImages = 0
  const sleep = deps.sleep ?? defaultSleep
  const interNoteDelayMs = deps.interNoteDelayMs && deps.interNoteDelayMs > 0 ? deps.interNoteDelayMs : 0
  const maxTotalImages = deps.maxTotalImages && deps.maxTotalImages > 0 ? deps.maxTotalImages : 0
  const titleCounts = new Map<string, number>()
  for (const note of plan.notes) {
    const title = normalizedTitle(note.title)
    if (title) titleCounts.set(title, (titleCounts.get(title) || 0) + 1)
  }

  const collectPlannedNote = async (note: CollectionNote, index: number): Promise<{
    result: NoteCollectResult
    canonicalUrl: string
    openUrl: string
  }> => {
    const canonicalUrl = note.canonicalUrl || note.url
    const openUrl = note.openUrl || note.url
    const noteTitle = normalizedTitle(note.title)
    const collectOne = deps.strategy === 'card_loop' ? collectCardNote : collectNote
    let result = await collectOne(
      deps.facade,
      {
        noteUrl: openUrl,
        canonicalUrl,
        openUrl,
        title: note.title,
        titleConfidence: note.titleConfidence,
        sourceId: note.sourceId,
        order: note.order ?? index + 1,
        folderName: note.folderName,
        duplicateTitle: note.duplicateTitle ?? (noteTitle ? (titleCounts.get(noteTitle) || 0) > 1 : false),
        outputDir: plan.outputRootDir,
      },
      deps.pathJoin,
      deps.fileOps,
    )
    if (deps.strategy === 'card_loop' && result.reason === 'detail_not_opened' && plan.targetProfileUrl) {
      await deps.facade.run('browser_navigate', { url: plan.targetProfileUrl }).catch(() => '')
      await sleep(Math.max(800, Math.min(1500, interNoteDelayMs || 1000)))
      result = await collectOne(
        deps.facade,
        {
          noteUrl: openUrl,
          canonicalUrl,
          openUrl,
          title: note.title,
          titleConfidence: note.titleConfidence,
          sourceId: note.sourceId,
          order: note.order ?? index + 1,
          folderName: note.folderName,
          duplicateTitle: note.duplicateTitle ?? (noteTitle ? (titleCounts.get(noteTitle) || 0) > 1 : false),
          outputDir: plan.outputRootDir,
        },
        deps.pathJoin,
        deps.fileOps,
      )
    }
    return { result, canonicalUrl, openUrl }
  }

  const noteOutputFromResult = (
    note: CollectionNote,
    result: NoteCollectResult,
    canonicalUrl: string,
    openUrl: string,
  ): CollectionNoteOutput => ({
    url: result.canonicalUrl || canonicalUrl,
    canonicalUrl: result.canonicalUrl || canonicalUrl,
    openUrl: result.openUrl || openUrl,
    title: result.title,
    sourceId: result.sourceId,
    order: result.order,
    success: result.success,
    savedDir: result.savedDir,
    imageCount: result.imageCount,
    videoCount: result.videoCount,
    mediaKind: result.mediaKind,
    notePath: result.notePath,
    manifestPath: result.manifestPath,
    files: result.files,
    reason: result.reason,
    kind: result.mediaKind === 'video' ? 'video' : note.kind,
  })

  const runFinalRetryPass = async (): Promise<CollectionStopReason> => {
    let retryableFailures = retryableCollectionFailures(state)
    if (retryableFailures.length === 0) return null
    state = { ...state, retryCursor: retryableFailures.map((item) => item.url) }
    await deps.onCheckpoint?.(state, progressOf(plan, state, null, 'completed'))

    for (const failure of retryableFailures) {
      const noteIndex = plan.notes.findIndex((note) => noteMatchesFailure(note, failure.url))
      if (noteIndex < 0) continue
      const note = plan.notes[noteIndex]
      for (let retry = 0; retry < MAX_FINAL_ITEM_RETRIES; retry += 1) {
        const currentFailure = retryableCollectionFailures(state).find((item) => item.url === failure.url)
        if (!currentFailure) break
        const external = deps.shouldStop?.() ?? null
        if (external) return external
        rounds += 1
        deps.onProgress?.(progressOf(plan, state, note.title ?? note.url, null))
        const { result, canonicalUrl, openUrl } = await collectPlannedNote(note, noteIndex)
        if (result.reason === 'needs_verification' || isPartialImagesReason(result.reason)) {
          await deps.onCheckpoint?.(state, progressOf(plan, state, note.title ?? note.url, 'needs_verification'))
          return 'needs_verification'
        }
        totalImages += result.imageCount
        state = recordRetryNoteResult(state, note, {
          success: result.success,
          reason: result.reason,
          output: noteOutputFromResult(note, result, canonicalUrl, openUrl),
        })
        state = { ...state, retryCursor: retryableCollectionFailures(state).map((item) => item.url) }
        await deps.onCheckpoint?.(state, progressOf(plan, state, note.title ?? note.url, null))
        if (result.success) break
      }
      retryableFailures = retryableCollectionFailures(state)
    }
    return null
  }

  while (true) {
    const external = deps.shouldStop?.() ?? null
    if (external) {
      return { collected: state.collected, failed: state.failed, notes: state.outputs || [], rounds, stopReason: external, state }
    }
    if (maxTotalImages > 0 && totalImages >= maxTotalImages) {
      deps.onProgress?.(progressOf(plan, state, null, 'max_images'))
      return { collected: state.collected, failed: state.failed, notes: state.outputs || [], rounds, stopReason: 'max_images', state }
    }
    const step = planNextNote(plan, state, deps.now())
    if (step.stop || !step.note) {
      let stopReason = step.stop ?? 'completed'
      if (stopReason === 'completed') {
        stopReason = await runFinalRetryPass() ?? stopReason
      }
      deps.onProgress?.(progressOf(plan, state, null, stopReason))
      return { collected: state.collected, failed: state.failed, notes: state.outputs || [], rounds, stopReason, state }
    }

    const note = step.note
    // Pace between notes (not before the first) so high-control platforms see
    // human-like spacing. Re-check shouldStop after sleeping (cancel during wait).
    if (rounds > 0 && interNoteDelayMs > 0) {
      await sleep(interNoteDelayMs)
      const afterSleep = deps.shouldStop?.() ?? null
      if (afterSleep) {
        return { collected: state.collected, failed: state.failed, notes: state.outputs || [], rounds, stopReason: afterSleep, state }
      }
    }
    rounds += 1
    deps.onProgress?.(progressOf(plan, state, note.title ?? note.url, null))

    const { result, canonicalUrl, openUrl } = await collectPlannedNote(note, step.index)
    if (result.reason === 'needs_verification' || isPartialImagesReason(result.reason)) {
      await deps.onCheckpoint?.(state, progressOf(plan, state, note.title ?? note.url, 'needs_verification'))
      deps.onProgress?.(progressOf(plan, state, null, 'needs_verification'))
      return { collected: state.collected, failed: state.failed, notes: state.outputs || [], rounds, stopReason: 'needs_verification', state }
    }
    totalImages += result.imageCount
    state = recordNoteResult(state, note, {
      success: result.success,
      reason: result.reason,
      output: noteOutputFromResult(note, result, canonicalUrl, openUrl),
    })
    await deps.onCheckpoint?.(state, progressOf(plan, state, note.title ?? note.url, null))
  }
}
