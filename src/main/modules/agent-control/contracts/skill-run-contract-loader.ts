import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { canResumeShape } from './resume-handle'
import { isDirectlyResumableTaskStatus, isPausedTaskStatus } from './task-open-status'
import type { SkillRunContract, TaskProjectionRecord } from './run-contracts'
import type { ReferenceSkillHint } from '../skills/skill-reference-hints'
import { decodeStoredSkillChildCloseEvent } from '../skills/skill-child-state-machine'
import type {
  SkillChildCloseEvent,
  SkillChildRunParentNextHint,
  SkillChildRunStatus,
} from '../skills/skill-child-run-types'
import type { SkillTaskSupervisorSnapshot } from '../skills/skill-task-supervisor'
import type { TurnFrame, TurnFramePatch } from '../runtime-core/turn-frame'
import type { SkillTaskRunRepository } from '../../repositories/skill-task-run-repository'

export interface LoadSkillRunContractParams {
  scopeId?: string | null
  sessionId?: string | null
  skillId?: string | null
  outputDir?: string | null
  runStatePath?: string | null
  supervisorSnapshot?: SkillTaskSupervisorSnapshot | null
  /**
   * Sibling projection row found by `outputDir` / `runStatePath` lookup.
   * Wave 1 callers may pass null; Zeta wires sibling lookup in Wave 3.
   */
  projectionSibling?: TaskProjectionRecord | null
  /** Reference-skill hint (`rememberLastReferenceSkill`) for the session. */
  referenceHint?: ReferenceSkillHint | null
  /** Original user/source input the contract should preserve for rebuilds. */
  originalInput?: Record<string, unknown> | null
  /** Source URL extracted from the original request, when known. */
  sourceUrl?: string | null
  /** Tool name expected to fulfil the next forced action. */
  toolName?: string | null
  /** Validated typed action input the next force-tool dispatch may use. */
  actionInput?: Record<string, unknown> | null
  /** Job id (typed action wrapper sets this when known). */
  jobId?: string | null
  /**
   * Phase 4 — optional child-run lookup. When provided, the loader looks
   * up the most recent active child-run row for the given skill (preferring
   * the matching `runStatePath` when known) and surfaces the child handle
   * + close event on the contract. When omitted, the contract falls back
   * to legacy supervisor + projection sources.
   *
   * T8 — when `childRunId` / `runStatePath` / `outputDir` / `singleFlightKey`
   * are explicit on the request, the loader binds to the EXACT matching
   * row instead of falling through to "latest active row by skill". The
   * `skillId` filter is applied BEFORE any path-similarity lookup so a
   * different-skill row sharing an outputDir is never attached.
   */
  skillTaskRunRepository?: SkillTaskRunRepository | null
  /**
   * T8 — explicit child-run handle. Wins over every other lookup when set.
   */
  childRunId?: string | null
  /**
   * T8 — explicit single-flight key. Used when the caller already knows
   * which collapse bucket the contract should bind to (e.g. resume from a
   * persisted handle). Lower priority than `runStatePath` / `outputDir`.
   */
  singleFlightKey?: string | null
}

function trimmed(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readStringField(
  source: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  if (!source || typeof source !== 'object') return null
  const value = (source as Record<string, unknown>)[key]
  return trimmed(value)
}

function readObjectField(
  source: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> | null {
  if (!source || typeof source !== 'object') return null
  const value = (source as Record<string, unknown>)[key]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function dedupePaths(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of values) {
    const t = trimmed(v)
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

function statusFromSupervisorSnapshot(
  snapshot: SkillTaskSupervisorSnapshot,
): SkillRunContract['status'] {
  // Phase 7 — supervisor now emits the public, normalized vocabulary.
  // `killed` MUST NOT collapse to `failed` (source plan §3 rule 7).
  switch (snapshot.status) {
    case 'running':
      return 'running'
    case 'recoverable_paused':
      return 'recoverable_paused'
    case 'budget_paused':
      return 'budget_paused'
    case 'blocked':
      return 'blocked'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'killed':
      return 'killed'
    default:
      return 'unknown'
  }
}

function livenessFromSupervisorSnapshot(
  snapshot: SkillTaskSupervisorSnapshot | null | undefined,
): TurnFrame['liveness'] {
  if (!snapshot) return 'unknown'
  // Phase 7 — supervisor public status uses `completed` / `killed` /
  // `failed`; map both terminal-but-not-failed exits (`completed`, `killed`)
  // to non-failed liveness so the renderer doesn't paint a cancellation as
  // a failure.
  if (snapshot.status === 'completed') return 'done'
  if (snapshot.status === 'failed') return 'failed'
  if (snapshot.status === 'killed') return 'done'
  if (snapshot.hasLiveWork) return 'running_process'
  if (snapshot.hasRecentProgress) return 'recent_progress'
  if (isDirectlyResumableTaskStatus(snapshot.status)) return 'recoverable_paused'
  if (isPausedTaskStatus(snapshot.status)) return 'blocked'
  return 'unknown'
}

function progressFromSnapshot(
  snapshot: SkillTaskSupervisorSnapshot | null | undefined,
): TurnFrame['progress'] {
  const p = snapshot?.progress || null
  return {
    stage: trimmed(p?.currentStage),
    totalUnits: typeof p?.totalScenes === 'number' ? p.totalScenes : null,
    completedUnits: typeof p?.completedScenes === 'number' ? p.completedScenes : null,
    coverageRatio: typeof p?.coverageRatio === 'number' ? p.coverageRatio : null,
    fingerprint: snapshot?.progressFingerprint || null,
  }
}

/**
 * Run-state JSON shape we care about. Only the fields the contract surfaces
 * are extracted; unknown / extra fields are tolerated. Field name aliases
 * mirror `skill-task-supervisor.ts::readRunStateInfo` so VEA's snake_case
 * vnext payload and any camelCase variants both work.
 */
interface ParsedRunState {
  status: string | null
  currentStage: string | null
  totalScenes: number | null
  completedScenes: number | null
  coverageRatio: number | null
}

function pickStringAlias(rec: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = rec[key]
    const t = trimmed(v)
    if (t) return t
  }
  return null
}

function pickNumberAlias(rec: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const v = rec[key]
    if (v === null || v === undefined) continue
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return null
}

/**
 * Wave 3 (Zeta) — read `<outputDir>/run_state.json` and extract the
 * progress/status fields the contract surfaces. Failures (file missing,
 * unreadable, malformed JSON) return `null` — the caller falls back to
 * supervisor / projection signals.
 */
function readRunStateForContract(outputDir: string | null, runStatePath: string | null): {
  parsed: ParsedRunState
  resolvedPath: string | null
} | null {
  const candidatePath = trimmed(runStatePath) || (outputDir ? join(outputDir, 'run_state.json') : null)
  if (!candidatePath) return null
  let raw: string
  try {
    raw = readFileSync(candidatePath, 'utf-8')
  } catch {
    return null
  }
  let rec: Record<string, unknown>
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    rec = parsed as Record<string, unknown>
  } catch {
    return null
  }
  const status = pickStringAlias(rec, ['status'])?.toLowerCase() || null
  const currentStage = pickStringAlias(rec, [
    'current_stage',
    'currentStage',
    'current_step',
    'currentStep',
  ])
  const totalScenes = pickNumberAlias(rec, ['total_scenes', 'totalScenes'])
  const completedScenes = pickNumberAlias(rec, ['completed_scenes', 'completedScenes'])
  const coverageRatio = pickNumberAlias(rec, ['coverage_ratio', 'coverageRatio'])
  return {
    parsed: {
      status,
      currentStage,
      totalScenes,
      completedScenes,
      coverageRatio,
    },
    resolvedPath: candidatePath,
  }
}

function statusFromRunStateString(status: string | null): SkillRunContract['status'] | null {
  if (!status) return null
  switch (status) {
    case 'running':
      return 'running'
    case 'recoverable_paused':
    case 'budget_paused':
    case 'paused':
      return 'recoverable_paused'
    case 'blocked':
      return 'blocked'
    case 'ready_to_resume':
      return 'ready_to_resume'
    case 'done':
    case 'completed':
      return 'completed'
    case 'failed':
    case 'error':
      return 'failed'
    case 'cancelled':
      return 'failed'
    default:
      return null
  }
}

/**
 * Build a fresh `SkillRunContract` as a read model over durable sources.
 *
 * Wave 1 minimum: synthesize from `SkillTaskSupervisorSnapshot` + projection
 * sibling row + reference-skill hint + caller-supplied original/typed input.
 * Returns `null` if there is not enough signal to anchor a real run
 * (no skillId AND no outputDir AND no taskRunId AND no detachedTaskId).
 *
 * Wave 3 (Zeta) — when `outputDir` (or `runStatePath`) is provided, the
 * loader also reads `<outputDir>/run_state.json` and uses any parsed
 * progress/status to fill fields the supervisor snapshot left empty.
 * Caller params and the snapshot still win; run_state is the lowest
 * priority source.
 */
export function loadSkillRunContract(
  params: LoadSkillRunContractParams,
): SkillRunContract | null {
  const snapshot = params.supervisorSnapshot || null
  const projection = params.projectionSibling || null
  const referenceHint = params.referenceHint || null

  const skillId = trimmed(params.skillId)
    || trimmed(snapshot?.skillId)
    || trimmed(referenceHint?.id)
  const outputDir = trimmed(params.outputDir) || trimmed(snapshot?.outputDir)
  const runStatePathInitial = trimmed(params.runStatePath) || trimmed(snapshot?.runStatePath)
  const taskRunId = trimmed(snapshot?.taskRunId)
  const detachedTaskId = trimmed(snapshot?.detachedTaskId)
  // Stage Q (Stage 11) — Audit §F-7 found the prior anchor predicate was
  // too low: `taskRunId` alone (a stale row id) made `loadSkillRunContract`
  // produce a "ghost" contract (empty artifactRoots + null actionInput)
  // that downstream steering then chased into checkpoint_budget. New
  // contract: anchor must be either a true durable handle (canResumeShape
  // includes childRunId / detachedTaskId / both outputDir+runStatePath)
  // OR a skillId — but skillId alone produces a meta-only contract and
  // the steering layer treats it as inert.
  const anchorIsDurable = canResumeShape({
    detachedTaskId,
    outputDir,
    runStatePath: runStatePathInitial,
  })

  // Minimum anchoring signal: need a durable handle OR a skillId.
  // Bare `taskRunId` no longer qualifies.
  if (!skillId && !anchorIsDurable) {
    return null
  }

  // Wave 3 (Zeta) — read run_state.json once for the lowest-priority
  // progress/status fallback. Caller params and supervisor snapshot still
  // win; run_state only fills fields they left empty.
  const runStateRead = readRunStateForContract(outputDir, runStatePathInitial)
  const runState = runStateRead?.parsed ?? null
  const runStatePath = runStatePathInitial || runStateRead?.resolvedPath || null

  const skillName = trimmed(referenceHint?.name) || skillId

  const action = trimmed(snapshot?.action)
  const sceneScoresPath = trimmed(snapshot?.sceneScoresPath)
  const deliveryReportPath = trimmed(snapshot?.deliveryReportPath)

  const blockerReason = snapshot && Array.isArray(snapshot.blockers) && snapshot.blockers.length > 0
    ? trimmed(snapshot.blockers[0])
    : trimmed(snapshot?.pauseReason)

  // Status priority: explicit supervisor snapshot wins; otherwise fall back
  // to run_state.json's recovered status; otherwise 'unknown'.
  let status: SkillRunContract['status']
  if (snapshot) {
    status = statusFromSupervisorSnapshot(snapshot)
  } else {
    status = statusFromRunStateString(runState?.status ?? null) || 'unknown'
  }

  const projectionStableKey = projection
    ? trimmed(projection.taskId) || `${projection.scopeId}:${projection.module}:${projection.taskType}`
    : null

  const artifactRoots = dedupePaths([outputDir])

  // Wave 1 contract: action input is whatever the caller supplied (typed
  // action wrapper, restart fixture). Zeta will widen this in W3 by reading
  // <outputDir>/run_state.json. Wave 3 (Epsilon) note: when the supervisor
  // snapshot's `resumePayload` carries `actionInput` / `originalInput`
  // (typed action wrapper writes these so a paused skill can resume), the
  // loader prefers caller params and otherwise falls back to the payload —
  // strictly additive, no required-field changes.
  const resumePayloadActionInput = readObjectField(snapshot?.resumePayload, 'actionInput')
  const resumePayloadOriginalInput = readObjectField(snapshot?.resumePayload, 'originalInput')

  const actionInput = params.actionInput && Object.keys(params.actionInput).length > 0
    ? { ...params.actionInput }
    : resumePayloadActionInput && Object.keys(resumePayloadActionInput).length > 0
      ? { ...resumePayloadActionInput }
      : null

  const originalInput = params.originalInput && Object.keys(params.originalInput).length > 0
    ? { ...params.originalInput }
    : resumePayloadOriginalInput && Object.keys(resumePayloadOriginalInput).length > 0
      ? { ...resumePayloadOriginalInput }
      : null

  const sourceUrl = trimmed(params.sourceUrl)
    || trimmed(readStringField(snapshot?.resumePayload, 'sourceUrl'))
    || trimmed(readStringField(snapshot?.resumePayload, 'url'))
    || (resumePayloadOriginalInput
      ? trimmed(readStringField(resumePayloadOriginalInput, 'url'))
      : null)

  // Phase 4 — child-run lookup. When a child-run row exists for this
  // skill (active status), we surface the handle + close event so the
  // parent stops deriving the next internal action from `actionInput`.
  // When `childRunId` is present, `actionInput` / `originalInput` are
  // SUMMARY ONLY: parent code MUST NOT use them to pick the next VEA
  // step — that's the child driver's job.
  let childRunId: string | undefined
  let childStatus: SkillChildRunStatus | undefined
  let childParentNextHint: SkillChildRunParentNextHint | undefined
  let childCloseEvent: SkillChildCloseEvent | null | undefined

  // Helper that hoists a `childRun` payload (the same shape the repository
  // writes via `setResumePayload`) onto the loader's local child-handle
  // slots. Both the repository row's `resumePayload.childRun` and the
  // supervisor snapshot's `resumePayload.childRun` use the same shape, so
  // we can drain either source through this single block.
  const readChildPayload = (payload: Record<string, unknown> | null): void => {
    if (!payload) return
    const candidateId = trimmed(payload.childRunId as unknown)
    if (!candidateId) return
    childRunId = candidateId
    const candidateStatus = trimmed(payload.status as unknown)
    if (candidateStatus) childStatus = candidateStatus as SkillChildRunStatus
    const candidateHint = trimmed(payload.parentNextHint as unknown)
    if (candidateHint === 'wait_for_close_event' || candidateHint === 'continue_other_work') {
      childParentNextHint = candidateHint
    }
    const candidateClose = payload.closeEvent
    if (candidateClose && typeof candidateClose === 'object' && !Array.isArray(candidateClose)) {
      childCloseEvent = decodeStoredSkillChildCloseEvent(candidateClose as unknown as SkillChildCloseEvent)
    } else {
      childCloseEvent = null
    }
  }

  if (params.skillTaskRunRepository && skillId) {
    // T8 — ordered lookup. Each step is a STRICT match; the `skillId`
    // filter is applied at every step so a different-skill row sharing an
    // outputDir / runStatePath is never attached.
    //
    // Order:
    //   1. explicit `childRunId`
    //   2. exact `runStatePath`
    //   3. exact `outputDir`
    //   4. exact `singleFlightKey`
    //   5. latest active row by `skillId / sessionId / scopeId` (last fallback)
    //
    // Each helper is best-effort — when the repository is missing one
    // (older fakes, partial mocks) the loader silently moves to the next
    // step instead of throwing.
    type Repo = NonNullable<typeof params.skillTaskRunRepository>
    const repo = params.skillTaskRunRepository as Repo & {
      findChildRunByRunStatePath?: (opts: { runStatePath: string; skillId?: string | null }) => unknown
      findChildRunByOutputDir?: (opts: { outputDir: string; skillId?: string | null }) => unknown
      findChildRunBySingleFlightKey?: (opts: { singleFlightKey: string; skillId?: string | null }) => unknown
    }
    let childRow: ReturnType<Repo['findLatestChildRunBySkill']> | null = null
    try {
      // Step 1 — explicit childRunId.
      const explicitChildRunId = trimmed(params.childRunId)
      if (!childRow && explicitChildRunId && typeof repo.get === 'function') {
        const candidate = repo.get(explicitChildRunId) as ReturnType<Repo['findLatestChildRunBySkill']> | null
        // Apply the skillId filter post-lookup so a stale or wrong-skill
        // explicit id never attaches.
        if (candidate && candidate.skillId === skillId) {
          childRow = candidate
        }
      }
      // Step 2 — exact runStatePath.
      if (!childRow && runStatePath && typeof repo.findChildRunByRunStatePath === 'function') {
        const candidate = repo.findChildRunByRunStatePath({ runStatePath, skillId }) as
          ReturnType<Repo['findLatestChildRunBySkill']> | null
        if (candidate) childRow = candidate
      }
      // Step 3 — exact outputDir.
      if (!childRow && outputDir && typeof repo.findChildRunByOutputDir === 'function') {
        const candidate = repo.findChildRunByOutputDir({ outputDir, skillId }) as
          ReturnType<Repo['findLatestChildRunBySkill']> | null
        if (candidate) childRow = candidate
      }
      // Step 4 — exact singleFlightKey.
      const explicitSingleFlightKey = trimmed(params.singleFlightKey)
      if (!childRow && explicitSingleFlightKey && typeof repo.findChildRunBySingleFlightKey === 'function') {
        const candidate = repo.findChildRunBySingleFlightKey({
          singleFlightKey: explicitSingleFlightKey,
          skillId,
        }) as ReturnType<Repo['findLatestChildRunBySkill']> | null
        if (candidate) childRow = candidate
      }
      // Step 5 — last-fallback: latest active row by skill / session / scope.
      if (!childRow) {
        childRow = repo.findLatestChildRunBySkill({
          sessionId: params.sessionId ?? null,
          scopeId: params.scopeId ?? null,
          skillId,
        })
      }
      const childPayload = childRow
        ? readObjectField(childRow.resumePayload, 'childRun')
        : null
      readChildPayload(childPayload)
    } catch {
      // Repository lookup is best-effort; missing DB / malformed rows fall
      // through to the legacy contract path.
    }
  }
  // Phase 6 — fallback: when no repository was provided (or it returned
  // nothing), read the same `childRun` payload off the supervisor
  // snapshot. The child runner persists the handle into the snapshot's
  // `resumePayload.childRun` block, so the contract reflects child
  // ownership even on call sites that don't carry a repository
  // reference (the turn-frame resolver, for example).
  if (!childRunId && snapshot?.resumePayload) {
    const supervisorChildPayload = readObjectField(snapshot.resumePayload, 'childRun')
    readChildPayload(supervisorChildPayload)
  }

  // Phase 4 — legacy adoption surface. When no child run exists yet but
  // the legacy row has at least one usable handle, surface the handles so
  // Phase 5 can detect "I should mint a child run that adopts this state".
  // When NEITHER handle is present, never silently complete the row: pin
  // the status to `recoverable_paused` (or whatever terminal status the
  // supervisor already chose) and set `blockerReason: 'no_usable_handles'`.
  let legacyAdoptableHandles: SkillRunContract['legacyAdoptableHandles']
  let blockerReasonOverride: string | undefined
  if (!childRunId) {
    if (outputDir || runStatePath) {
      const handles: NonNullable<SkillRunContract['legacyAdoptableHandles']> = {}
      if (taskRunId) handles.taskRunId = taskRunId
      if (outputDir) handles.outputDir = outputDir
      if (runStatePath) handles.runStatePath = runStatePath
      if (Object.keys(handles).length > 0) {
        legacyAdoptableHandles = handles
      }
    } else if ((taskRunId || detachedTaskId) && status !== 'failed' && status !== 'completed') {
      // Active legacy row with NO usable handles → cannot resume work, but
      // we must NEVER silently mark it `completed`. Pin to recoverable_paused
      // and surface a structured blocker.
      blockerReasonOverride = 'no_usable_handles'
    }
  }

  // Apply blocker override to status (never weaken a terminal status).
  let finalStatus: SkillRunContract['status'] = status
  if (blockerReasonOverride && finalStatus !== 'failed' && finalStatus !== 'completed') {
    finalStatus = 'recoverable_paused'
  }

  return {
    skillId: skillId || (skillName ?? '') || '',
    skillName,
    toolName: trimmed(params.toolName),
    action,
    actionInput,
    originalInput,
    sourceUrl,
    taskRunId,
    detachedTaskId,
    jobId: trimmed(params.jobId),
    outputDir,
    runStatePath,
    artifactRoots,
    artifactPaths: {
      sceneScoresPath,
      deliveryReportPath,
    },
    status: finalStatus,
    liveness: livenessFromSupervisorSnapshot(snapshot),
    progress: (() => {
      const fromSnapshot = progressFromSnapshot(snapshot)
      if (!runState) return fromSnapshot
      // Lowest priority — only fill when snapshot left the field empty.
      return {
        stage: fromSnapshot.stage ?? runState.currentStage,
        totalUnits: fromSnapshot.totalUnits ?? runState.totalScenes,
        completedUnits: fromSnapshot.completedUnits ?? runState.completedScenes,
        coverageRatio: fromSnapshot.coverageRatio ?? runState.coverageRatio,
        fingerprint: fromSnapshot.fingerprint,
      }
    })(),
    blocker: {
      reason: blockerReasonOverride ?? blockerReason,
      stale: Boolean(snapshot?.stale),
    },
    projectionIdentity: {
      stableKey: projectionStableKey,
      supersedesProjectionIds: [],
    },
    forceLoopGuard: {
      lastForceToolName: null,
      lastForceInputDigest: null,
      lastForceToolDispatchedAt: null,
      consecutiveForceCount: 0,
    },
    updatedAt: snapshot?.observedAt || new Date().toISOString(),
    ...(childRunId !== undefined ? { childRunId } : {}),
    ...(childStatus !== undefined ? { childStatus } : {}),
    ...(childParentNextHint !== undefined ? { parentNextHint: childParentNextHint } : {}),
    ...(childCloseEvent !== undefined ? { childCloseEvent } : {}),
    ...(legacyAdoptableHandles ? { legacyAdoptableHandles } : {}),
    ...(blockerReasonOverride ? { blockerReason: blockerReasonOverride } : {}),
  }
}

/**
 * Helper that producer teams (Gamma + Delta) call to produce a consistent
 * `TurnFramePatch` carrying a `runContract` partial. The returned patch
 * also forwards `activeArtifactRoots` and `livenessHint` so the same
 * snapshot drives the durable run-time slots.
 *
 * The patch's `runContract` is treated as a partial: only fields that the
 * loader populated (non-null / non-empty) are emitted, so downstream
 * `mergeTurnFramePatches` can field-by-field merge with last-write-wins
 * across multiple producers in the same batch.
 */
export function buildContractFramePatch(
  snapshot: {
    contract: SkillRunContract | null
    activeArtifactRoots?: string[] | null
    livenessHint?: TurnFrame['liveness'] | null
    configValidation?: TurnFramePatch['configValidation']
  },
): TurnFramePatch {
  const patch: TurnFramePatch = {}
  const contract = snapshot.contract
  if (contract) {
    patch.runContract = {
      skillId: contract.skillId,
      skillName: contract.skillName,
      toolName: contract.toolName,
      action: contract.action,
      actionInput: contract.actionInput,
      originalInput: contract.originalInput,
      sourceUrl: contract.sourceUrl,
      taskRunId: contract.taskRunId,
      detachedTaskId: contract.detachedTaskId,
      jobId: contract.jobId,
      outputDir: contract.outputDir,
      runStatePath: contract.runStatePath,
      artifactRoots: [...(contract.artifactRoots || [])],
      artifactPaths: { ...contract.artifactPaths },
      status: contract.status,
      liveness: contract.liveness,
      progress: { ...contract.progress },
      blocker: { ...contract.blocker },
      projectionIdentity: {
        stableKey: contract.projectionIdentity.stableKey,
        supersedesProjectionIds: [...contract.projectionIdentity.supersedesProjectionIds],
      },
      forceLoopGuard: { ...contract.forceLoopGuard },
      updatedAt: contract.updatedAt,
      ...(contract.childRunId !== undefined ? { childRunId: contract.childRunId } : {}),
      ...(contract.childStatus !== undefined ? { childStatus: contract.childStatus } : {}),
      ...(contract.parentNextHint !== undefined ? { parentNextHint: contract.parentNextHint } : {}),
      ...(contract.childCloseEvent !== undefined ? { childCloseEvent: contract.childCloseEvent } : {}),
      ...(contract.legacyAdoptableHandles
        ? { legacyAdoptableHandles: { ...contract.legacyAdoptableHandles } }
        : {}),
      ...(contract.blockerReason !== undefined ? { blockerReason: contract.blockerReason } : {}),
    }
    const handles: NonNullable<TurnFramePatch['discoveredHandles']> = {}
    if (contract.taskRunId) handles.taskRunId = contract.taskRunId
    if (contract.detachedTaskId) handles.detachedTaskId = contract.detachedTaskId
    if (contract.runStatePath) handles.runStatePath = contract.runStatePath
    if (contract.outputDir) handles.outputDir = contract.outputDir
    if (contract.action) handles.action = contract.action
    if (Object.keys(handles).length > 0) {
      patch.discoveredHandles = handles
    }
  }

  const allRoots = dedupePaths([
    ...(Array.isArray(snapshot.activeArtifactRoots) ? snapshot.activeArtifactRoots : []),
    ...(contract?.artifactRoots || []),
  ])
  if (allRoots.length > 0) {
    patch.activeArtifactRoots = allRoots
  }

  if (snapshot.livenessHint) {
    patch.livenessHint = snapshot.livenessHint
  } else if (contract?.liveness && contract.liveness !== 'unknown') {
    patch.livenessHint = contract.liveness
  }

  if (snapshot.configValidation) {
    patch.configValidation = { ...snapshot.configValidation }
  }

  return patch
}
