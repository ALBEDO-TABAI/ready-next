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
  createCollectionLoopState,
  type CollectionPlan,
  type CollectionLoopState,
  type CollectionStopReason,
} from './agent-collection-plan'
import { collectNote, type NoteCollectFacade } from './browser-collector-actions'

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
}

export interface BrowserCollectionResult {
  collected: string[]
  failed: Array<{ url: string; reason: string }>
  rounds: number
  stopReason: CollectionStopReason
}

function progressOf(plan: CollectionPlan, state: CollectionLoopState, currentTitle: string | null, stopReason: CollectionStopReason): BrowserCollectionProgress {
  return { total: plan.notes.length, completed: state.collected.length, failed: state.failed.length, currentTitle, stopReason }
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
  let state = initialState ?? createCollectionLoopState(deps.now())
  let rounds = 0

  while (true) {
    const external = deps.shouldStop?.() ?? null
    if (external) {
      return { collected: state.collected, failed: state.failed, rounds, stopReason: external }
    }
    const step = planNextNote(plan, state, deps.now())
    if (step.stop || !step.note) {
      const stopReason = step.stop ?? 'completed'
      deps.onProgress?.(progressOf(plan, state, null, stopReason))
      return { collected: state.collected, failed: state.failed, rounds, stopReason }
    }

    const note = step.note
    rounds += 1
    deps.onProgress?.(progressOf(plan, state, note.title ?? note.url, null))

    const result = await collectNote(
      deps.facade,
      { noteUrl: note.url, title: note.title, outputDir: plan.outputRootDir },
      deps.pathJoin,
    )
    state = recordNoteResult(state, note, { success: result.success, reason: result.reason })
    await deps.onCheckpoint?.(state, progressOf(plan, state, note.title ?? note.url, null))
  }
}
