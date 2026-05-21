/**
 * Stage T (Theme T-B) — Parallel subagent orchestrator with hard cap +
 * AbortSignal cancel + serial frame patch merge.
 *
 * §6.20 frame single-source compliance: this orchestrator does NOT call
 * `applyTurnFramePatch` directly. Branches that need to mutate the turn
 * frame must return their own `TurnFramePatch` (or have the caller produce
 * one); the orchestrator exposes `mergePatchesSerially(...)` so the caller
 * can fold N branch patches into a single deterministic patch and apply
 * it once at a single point in the turn loop. This guarantees no two
 * branches concurrently apply patches to the live frame.
 *
 * Hard cap (`PARALLEL_BRANCH_HARD_CAP = 3`) mirrors deer-flow
 * `subagent_limit_middleware.py` — over-spawn is a no-op (returns null) +
 * emits `parallel_branch_hard_cap_reached` metric.
 *
 * Cancel semantics: each branch owns an independent `AbortController`. The
 * branch function MUST accept the signal and check it at blocking points
 * (`signal.aborted`, `signal.addEventListener('abort', ...)`); cancel()
 * calls `controller.abort()`. The orchestrator does not force-kill —
 * cooperative cancellation only.
 */

// IMPORTANT (gate `check-parallel-branch-frame-merge.cjs`): this file must
// NOT import or call `applyTurnFramePatch` — patch application is the
// caller's responsibility, performed serially after `awaitAll()` resolves.
// We only expose `mergePatchesSerially` which delegates to the canonical
// merge helper in `turn-frame.ts`.
import { mergeTurnFramePatches, type TurnFramePatch } from './turn-frame'
import { logAgentMetric } from '../metrics'

export const PARALLEL_BRANCH_HARD_CAP = 3 as const

export interface ParallelBranch {
  id: string
  task: string
  promise: Promise<unknown>
  startedAt: number
  abortController: AbortController
}

export interface ParallelBranchAwaitResult {
  branchId: string
  status: 'fulfilled' | 'rejected'
  value?: unknown
  reason?: unknown
}

export interface ParallelBranchOrchestrator {
  /**
   * Spawn a new branch. The branch function receives an `AbortSignal` it
   * MUST check cooperatively. Returns the spawned branch handle, or
   * `null` if the active count already reached `PARALLEL_BRANCH_HARD_CAP`
   * (a `parallel_branch_hard_cap_reached` metric is emitted in that case).
   */
  spawn(task: string, fn: (signal: AbortSignal) => Promise<unknown>): ParallelBranch | null

  /**
   * Await all currently active branches. Uses `Promise.allSettled` so a
   * single branch failure does not poison the others. The returned array
   * is in spawn order.
   */
  awaitAll(): Promise<ParallelBranchAwaitResult[]>

  /**
   * Round-1 (Codex) opt-in alternative — abort all sibling branches as
   * soon as any branch rejects. The returned array is still in spawn
   * order: the first rejecting branch surfaces with its real reason,
   * siblings that were aborted by this helper surface as `rejected` with
   * their abort reason (or `'aborted'`). Branches that had already
   * fulfilled before the first failure remain `fulfilled`.
   *
   * The default `awaitAll` is unchanged (allSettled). Callers that want
   * fail-fast cancellation must opt in explicitly.
   */
  awaitAllOrFirstFailure(): Promise<ParallelBranchAwaitResult[]>

  /**
   * Cancel a single branch by id (`controller.abort()`). No-op if the
   * branch has already settled or the id is unknown.
   */
  cancel(branchId: string): void

  /**
   * Snapshot of currently un-settled branches (defensive copy).
   */
  getActive(): ParallelBranch[]
}

/**
 * Serial merge of N branch-produced TurnFramePatches into one composite
 * patch. The caller then applies the merged patch to the live frame
 * exactly once via `applyTurnFramePatch`, preserving §6.20 single-source
 * semantics. Order is whatever the caller passes (typically branch
 * spawn order).
 *
 * Delegates to `mergeTurnFramePatches` so any future changes to the
 * canonical merge contract are reflected here automatically — single
 * source of truth for patch composition.
 */
export function mergePatchesSerially(patches: TurnFramePatch[]): TurnFramePatch {
  return mergeTurnFramePatches(patches)
}

let nextBranchSeq = 0
function generateBranchId(): string {
  nextBranchSeq += 1
  return `pb-${Date.now().toString(36)}-${nextBranchSeq.toString(36)}`
}

export function createParallelBranchOrchestrator(): ParallelBranchOrchestrator {
  // Map preserves insertion (spawn) order so awaitAll is deterministic.
  const branches: Map<string, ParallelBranch> = new Map()

  function getActiveList(): ParallelBranch[] {
    return Array.from(branches.values())
  }

  function spawn(
    task: string,
    fn: (signal: AbortSignal) => Promise<unknown>,
  ): ParallelBranch | null {
    if (branches.size >= PARALLEL_BRANCH_HARD_CAP) {
      logAgentMetric('parallel_branch_hard_cap_reached', {
        active: branches.size,
        hardCap: PARALLEL_BRANCH_HARD_CAP,
        task,
      })
      return null
    }
    const id = generateBranchId()
    const abortController = new AbortController()
    const startedAt = Date.now()
    let promise: Promise<unknown>
    try {
      promise = Promise.resolve(fn(abortController.signal))
    } catch (err) {
      // silent-catch: synchronous branch errors are converted into the branch promise.
      // Synchronous throw from `fn` — wrap into rejected promise so the
      // branch settles cleanly via awaitAll's Promise.allSettled.
      promise = Promise.reject(err)
    }
    const branch: ParallelBranch = { id, task, promise, startedAt, abortController }
    branches.set(id, branch)
    return branch
  }

  async function awaitAll(): Promise<ParallelBranchAwaitResult[]> {
    const snapshot = getActiveList()
    const settled = await Promise.allSettled(snapshot.map((b) => b.promise))
    const results: ParallelBranchAwaitResult[] = snapshot.map((branch, i) => {
      const r = settled[i]
      // After settle, drop from active map so a follow-up awaitAll only
      // sees newly-spawned branches.
      branches.delete(branch.id)
      if (r.status === 'fulfilled') {
        return { branchId: branch.id, status: 'fulfilled', value: r.value }
      }
      return { branchId: branch.id, status: 'rejected', reason: r.reason }
    })
    return results
  }

  async function awaitAllOrFirstFailure(): Promise<ParallelBranchAwaitResult[]> {
    const snapshot = getActiveList()
    if (snapshot.length === 0) return []
    // Race for the first rejection — Promise.any inverts and rejects only
    // when ALL succeed, so we use a custom racer that flips reject -> resolve.
    type FirstFailure = { index: number; reason: unknown }
    const firstFailure = new Promise<FirstFailure | null>((resolve) => {
      let pending = snapshot.length
      snapshot.forEach((branch, index) => {
        branch.promise.then(
          () => {
            pending -= 1
            if (pending === 0) resolve(null)
          },
          (reason) => {
            resolve({ index, reason })
          },
        )
      })
    })
    const failure = await firstFailure
    if (failure) {
      // Abort all still-pending siblings cooperatively. The branch
      // function decides whether to honour the signal — same contract
      // as `cancel`.
      for (let i = 0; i < snapshot.length; i += 1) {
        if (i === failure.index) continue
        const sibling = snapshot[i]
        if (!sibling.abortController.signal.aborted) {
          sibling.abortController.abort()
        }
      }
    }
    // Now drain everyone via allSettled — siblings that observed the
    // abort settle with whatever they returned (typically a rejection).
    const settled = await Promise.allSettled(snapshot.map((b) => b.promise))
    return snapshot.map((branch, i) => {
      const r = settled[i]
      branches.delete(branch.id)
      if (r.status === 'fulfilled') {
        return { branchId: branch.id, status: 'fulfilled', value: r.value }
      }
      return { branchId: branch.id, status: 'rejected', reason: r.reason }
    })
  }

  function cancel(branchId: string): void {
    const branch = branches.get(branchId)
    if (!branch) return
    if (!branch.abortController.signal.aborted) {
      branch.abortController.abort()
    }
  }

  function getActive(): ParallelBranch[] {
    return getActiveList()
  }

  return { spawn, awaitAll, awaitAllOrFirstFailure, cancel, getActive }
}
