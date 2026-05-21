/**
 * Phase 5.1 — handler for `skill_inspect_run_state`. Reads the canonical
 * `run_state.json` written by long multi-step skills (VEA pipeline et al.)
 * and returns a structured summary so the LLM doesn't have to read the
 * raw file via `skill_read_artifact` and parse JSON blindly.
 *
 * Audit Phase 5 §E1 — without this primitive, models continuing a long
 * skill flow had no reliable way to answer "which step am I on / what
 * file am I waiting for / did the last step error". They'd often guess
 * wrong and fork a fresh shell run instead of resuming.
 *
 * The primitive accepts EITHER an explicit `outputDir` OR a `taskId`
 * (detached task id; outputDir resolved via DetachedSkillTaskTracker).
 * It searches for `run_state.json` at the root and one level deep, parses
 * it, and extracts well-known keys with defensive fallbacks (different
 * skills name the keys slightly differently — current_step vs currentStep
 * vs step). The raw JSON is also returned but bounded to `maxRawBytes`
 * (default 16K, max 64K) to avoid context pollution.
 *
 * Security: outputDir validation is permissive (skills are allowed to
 * write outside artifactRoot via user-specified params). The primitive
 * only reads run_state.json itself, never traverses into other files,
 * and bounds its output. Treat output as untrusted skill data.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname } from 'node:path'

import { createToolExecutionOutput, type ToolExecutionOutput } from '../../agent-control/tools-runtime/tool-result-types'
import { ToolDomainError } from '../tool-errors'
import { logAgentMetric } from '../../agent-control/metrics'
import { TOOL_ERROR_METRICS } from '../../agent-control/tools-runtime/tool-error-metrics'
import { getDetachedSkillTaskTracker } from '../../agent-control/detached-skill-task-tracker'
import { inspectSkillProgressArtifacts, type SkillProgressArtifacts } from '../../agent-control/skills/skill-progress-artifacts'
import { selectRunStateCandidate, type RunStateCandidate } from '../../agent-control/task-projection/run-state-selection'
import {
  buildContractFramePatch,
  loadSkillRunContract,
  type SkillRunContract,
} from '../../agent-control/contracts/run-contracts'
import type { TurnFrame, TurnFramePatch } from '../../agent-control/turn-frame'
import { resolveVeaResumeAction } from '../../agent-control/vea-resume-action'

const RUN_STATE_FILENAME = 'run_state.json'
const DEFAULT_MAX_RAW_BYTES = 16_384
const HARD_CAP_RAW_BYTES = 65_536
const SUBDIR_DEPTH_LIMIT = 1 // search at root then one level deep

export interface InspectRunStateArgs {
  outputDir?: string
  runStatePath?: string
  taskId?: string
  expectedTaskId?: string
  maxRawBytes?: number
  /**
   * Stage D3 — optional skill identifier supplied by the dispatch layer
   * (`skills-tools.ts`). Carried into the emitted `framePatch.runContract`
   * so the next frame can anchor the contract to a specific skill. When
   * absent, the contract still emits but downstream `applyTurnFramePatch`
   * may decline to create a fresh contract object without a skillId anchor.
   */
  skillId?: string
}

interface RunStateSummary {
  schemaVersion: unknown
  taskId: unknown
  pid: unknown
  startedAt: unknown
  activeOutputDir: unknown
  currentStage: unknown
  currentStep: unknown
  completedStages: unknown
  completedSteps: unknown
  waitingFor: unknown
  lastError: unknown
  totalScenes: unknown
  completedScenes: unknown
  coverageRatio: unknown
  status: unknown
  updatedAt: unknown
  knownKeysFound: string[]
}

/**
 * Defensive key extraction — different skills name keys slightly differently
 * (snake_case vs camelCase, "step" vs "current_step"). Try the well-known
 * variants and record which keys were actually found so the LLM can tell
 * "the file exists but doesn't have a current_step key" from "no file".
 */
function extractKnownKeys(parsed: unknown): RunStateSummary {
  const knownKeysFound: string[] = []
  if (!parsed || typeof parsed !== 'object') {
    return {
      schemaVersion: null,
      taskId: null,
      pid: null,
      startedAt: null,
      activeOutputDir: null,
      currentStage: null,
      currentStep: null,
      completedStages: null,
      completedSteps: null,
      waitingFor: null,
      lastError: null,
      totalScenes: null,
      completedScenes: null,
      coverageRatio: null,
      status: null,
      updatedAt: null,
      knownKeysFound,
    }
  }
  const rec = parsed as Record<string, unknown>
  const pick = (canonical: string, ...keys: string[]): unknown => {
    for (const key of keys) {
      if (key in rec) {
        knownKeysFound.push(canonical)
        return rec[key]
      }
    }
    return null
  }
  return {
    schemaVersion: pick('schemaVersion', 'schema_version', 'schemaVersion'),
    taskId: pick('taskId', 'task_id', 'taskId'),
    pid: pick('pid', 'pid'),
    startedAt: pick('startedAt', 'started_at', 'startedAt'),
    activeOutputDir: pick('activeOutputDir', 'active_output_dir', 'activeOutputDir'),
    currentStage: pick('currentStage', 'current_stage', 'currentStage'),
    currentStep: pick('currentStep', 'current_step', 'currentStep', 'step'),
    completedStages: pick('completedStages', 'completed_stages', 'completedStages'),
    completedSteps: pick('completedSteps', 'completed_steps', 'completedSteps'),
    waitingFor: pick('waitingFor', 'waiting_for', 'waitingFor', 'pending', 'pendingHandoff'),
    lastError: pick('lastError', 'last_error', 'lastError', 'error'),
    totalScenes: pick('totalScenes', 'total_scenes', 'totalScenes'),
    completedScenes: pick('completedScenes', 'completed_scenes', 'completedScenes'),
    coverageRatio: pick('coverageRatio', 'coverage_ratio', 'coverageRatio'),
    status: pick('status', 'status'),
    updatedAt: pick('updatedAt', 'updated_at', 'updatedAt', 'lastUpdated'),
    knownKeysFound,
  }
}

function selectRunStateFile(params: {
  outputDir: string
  explicitRunStatePath?: string | null
  expectedTaskId?: string | null
}): { path: string | null; ambiguous: boolean; candidates: RunStateCandidate[] } {
  return selectRunStateCandidate({
    rootDir: params.outputDir,
    explicitRunStatePath: params.explicitRunStatePath,
    expectedTaskId: params.expectedTaskId,
    fileName: RUN_STATE_FILENAME,
    searchDepth: SUBDIR_DEPTH_LIMIT,
  })
}

function createMissingRunStateOutput(params: {
  outputDir: string
  resolvedFromTaskId: string | null
  expectedTaskId: string | null
  errorKind: 'not_found' | 'outputdir_not_found'
  message: string
}): ToolExecutionOutput {
  return createToolExecutionOutput(
    params.message,
    {
      shape: 'json',
      data: {
        outputDir: params.outputDir,
        resolvedFromTaskId: params.resolvedFromTaskId,
        expectedTaskId: params.expectedTaskId,
        found: false,
        ambiguous: false,
        identityMismatch: false,
        errorKind: params.errorKind,
        runStatePath: null,
        candidates: [],
        summary: null,
        raw: null,
      },
    },
  )
}

function normalizeStatus(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().toLowerCase() : null
}

function deriveReconciledLiveness(summary: RunStateSummary, artifactProgress: SkillProgressArtifacts): string {
  const status = normalizeStatus(summary.status)
  if (['completed', 'success', 'done'].includes(status || '')) return 'done'
  if (['failed', 'failure', 'error'].includes(status || '')) return 'failed'
  if (['blocked', 'pending_review', 'awaiting_input'].includes(status || '')) return 'blocked'
  if (['running', 'waiting_for_batches', 'ready_to_finalize', 'paused'].includes(status || '')) {
    if (artifactProgress.hasEvidence) return 'recoverable_paused'
    return 'unknown'
  }
  return 'unknown'
}

/**
 * Stage D3 — derive `SkillRunContract.status` from the reconciled liveness
 * value so the next frame's contract reflects what the inspect actually
 * observed. Falls back to `unknown` for indeterminate states.
 */
function contractStatusFromReconciledLiveness(reconciled: string): SkillRunContract['status'] {
  switch (reconciled) {
    case 'done':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'blocked':
      return 'blocked'
    case 'recoverable_paused':
      return 'recoverable_paused'
    default:
      return 'unknown'
  }
}

/**
 * Stage D3 — translate reconciled liveness string into the strict
 * `TurnFrame['liveness']` enum. Anything that isn't an explicit terminal /
 * paused / blocked state falls back to `'unknown'` so the frame engine
 * doesn't treat an indeterminate inspect result as live progress.
 */
function frameLivenessFromReconciled(reconciled: string): TurnFrame['liveness'] {
  switch (reconciled) {
    case 'done':
    case 'failed':
    case 'blocked':
    case 'recoverable_paused':
      return reconciled
    default:
      return 'unknown'
  }
}

interface InspectContractInputs {
  outputDir: string
  runStatePath: string
  effectiveExpectedTaskId: string | null
  resolvedFromTaskId: string | null
  summary: RunStateSummary
  artifactProgress: SkillProgressArtifacts
  reconciledLiveness: string
  parseError: string | null
  skillId: string | null
}

/**
 * Stage D3 — build a `TurnFramePatch` that lets the next frame see the
 * artifacts the inspect just discovered without re-resolving from summary
 * text. Uses Beta's `loadSkillRunContract` + `buildContractFramePatch` so
 * Gamma + Delta producers stay symmetric.
 *
 * The patch carries:
 *   - `runContract` — handles (taskRunId / detachedTaskId / runStatePath /
 *     outputDir / action), discovered `artifactPaths.sceneScoresPath`
 *     (and `deliveryReportPath` when the run state references one), status
 *     derived from reconciled liveness, and progress fields.
 *   - `activeArtifactRoots` — the inspect's `outputDir` so a same-turn
 *     `skill_read_artifact` call can read the freshly-discovered run state.
 *   - `livenessHint` — the reconciled liveness value so frame.liveness
 *     upgrades correctly.
 *   - `skillStatusUpdates` — current run-state status string + any blocker
 *     reason derived from `summary.lastError` (kept independent of the
 *     contract status so producers can clear it explicitly later).
 */
/**
 * Stage M (M5a-inspect) return shape — caller needs the full
 * `SkillRunContract` (not the partial inside framePatch.runContract) to
 * populate `contextModifier.activeFrame.runContract`, which is typed
 * `SkillRunContract | null`. Returning `{ framePatch, contract }` lets the
 * wrapper pass the full object directly.
 */
export interface InspectFramePatchResult {
  framePatch: TurnFramePatch | null
  contract: SkillRunContract | null
}

function buildInspectFramePatch(inputs: InspectContractInputs): InspectFramePatchResult {
  const {
    outputDir,
    runStatePath,
    effectiveExpectedTaskId,
    resolvedFromTaskId,
    summary,
    artifactProgress,
    reconciledLiveness,
  } = inputs

  const summaryTaskId = typeof summary.taskId === 'string' && summary.taskId.trim()
    ? summary.taskId.trim()
    : null
  const taskRunId = effectiveExpectedTaskId || resolvedFromTaskId || summaryTaskId
  const detachedTaskId = resolvedFromTaskId || null
  const currentStage = typeof summary.currentStage === 'string' && summary.currentStage.trim()
    ? summary.currentStage.trim()
    : null

  const sceneScoresPath = artifactProgress.sceneScoresPath || null
  const action = resolveVeaResumeAction(currentStage, { sceneScoresPath })
  // run_state.json may reference a delivery report path under various keys.
  // Defensive lookup so we don't fabricate one that isn't there.
  const summaryRecord = summary as unknown as Record<string, unknown>
  const deliveryReportPath = (() => {
    const candidates: unknown[] = [
      summaryRecord.deliveryReportPath,
      summaryRecord.delivery_report_path,
      summaryRecord.deliveryReport,
    ]
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim()
    }
    return null
  })()

  const status = contractStatusFromReconciledLiveness(reconciledLiveness)
  const liveness = frameLivenessFromReconciled(reconciledLiveness)
  const totalScenes = typeof summary.totalScenes === 'number'
    ? summary.totalScenes
    : (typeof artifactProgress.totalScenes === 'number' ? artifactProgress.totalScenes : null)
  const completedScenes = typeof summary.completedScenes === 'number'
    ? summary.completedScenes
    : (typeof artifactProgress.completedScenes === 'number' ? artifactProgress.completedScenes : null)
  const coverageRatio = typeof summary.coverageRatio === 'number'
    ? summary.coverageRatio
    : (typeof artifactProgress.coverageRatio === 'number' ? artifactProgress.coverageRatio : null)

  const blockerReason = typeof summary.lastError === 'string' && summary.lastError.trim().length > 0
    ? summary.lastError.trim()
    : null

  // Synthesize a minimal supervisor-shaped snapshot so `loadSkillRunContract`
  // can populate paths/status/progress consistently with the rest of the
  // pipeline. We only fill the fields the loader reads.
  const supervisorSnapshot = {
    taskRunId,
    detachedTaskId,
    skillId: null,
    scopeId: null,
    sessionId: null,
    action,
    status: (() => {
      switch (status) {
        case 'completed':
          return 'done' as const
        case 'failed':
          return 'failed' as const
        case 'blocked':
          return 'blocked' as const
        case 'recoverable_paused':
          return 'recoverable_paused' as const
        case 'running':
          return 'running' as const
        default:
          return 'running' as const
      }
    })(),
    hasLiveWork: reconciledLiveness === 'recoverable_paused' || reconciledLiveness === 'blocked',
    hasRecentProgress: artifactProgress.hasEvidence,
    closeAllowed: false,
    ambiguous: false,
    stale: false,
    outputDir,
    runStatePath,
    sceneScoresPath,
    deliveryReportPath,
    progress: {
      currentStage,
      totalScenes,
      completedScenes,
      coverageRatio,
    },
    blockers: blockerReason ? [blockerReason] : [],
    pauseReason: blockerReason,
    resumePayload: null,
    sourceObservations: [],
    progressFingerprint: null,
    observedAt: new Date().toISOString(),
    lastProgressAt: null,
  }

  const contract = loadSkillRunContract({
    skillId: inputs.skillId,
    outputDir,
    runStatePath,
    supervisorSnapshot: supervisorSnapshot as any,
    projectionSibling: null,
    referenceHint: null,
  })

  // Inject discovered artifact paths even if loadSkillRunContract returned a
  // null path (it relies on supervisor shape which we synthesize above —
  // belt-and-braces in case the field name drifts in the future).
  if (contract) {
    contract.artifactPaths = {
      sceneScoresPath,
      deliveryReportPath,
    }
    contract.progress = {
      ...contract.progress,
      stage: currentStage ?? contract.progress.stage,
      totalUnits: totalScenes ?? contract.progress.totalUnits,
      completedUnits: completedScenes ?? contract.progress.completedUnits,
      coverageRatio: coverageRatio ?? contract.progress.coverageRatio,
    }
    contract.status = status
    contract.liveness = liveness
    contract.blocker = {
      reason: blockerReason,
      stale: contract.blocker.stale,
    }
  }

  const patch = buildContractFramePatch({
    contract,
    activeArtifactRoots: [outputDir],
    livenessHint: liveness !== 'unknown' ? liveness : null,
  })

  // Carry per-skill-slice status updates so the frame's skill slice keeps
  // its `status` / `staleBlockerReason` fields aligned with this primitive's
  // observation, independent of the durable run contract.
  patch.skillStatusUpdates = {
    ...(patch.skillStatusUpdates || {}),
    status: typeof summary.status === 'string' ? summary.status : null,
    staleBlockerReason: blockerReason,
    runStatePath,
    outputDir,
    artifactPaths: { sceneScoresPath, deliveryReportPath },
    ...(action ? { action } : {}),
  }

  // Stage M (M5a-inspect) — return both `framePatch` AND the full
  // `contract` so the caller can populate `contextModifier.activeFrame.
  // runContract` (which requires `SkillRunContract | null`, not the
  // `Partial<SkillRunContract>` inside `framePatch.runContract`).
  return { framePatch: patch, contract }
}

export async function executeInspectRunState(
  args: InspectRunStateArgs,
): Promise<ToolExecutionOutput> {
  // Resolve outputDir from either explicit arg or detached task lookup.
  let outputDir: string | null = null
  let resolvedFromTaskId: string | null = null
  let explicitRunStatePath: string | null = null

  if (args.taskId) {
    const tracker = getDetachedSkillTaskTracker()
    if (!tracker) {
      logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveRejected, {
        primitive: 'skill_inspect_run_state',
        reason: 'detached_runtime_unavailable',
      })
      throw new ToolDomainError(
        'detached_runtime_unavailable',
        'Detached skill task runtime is not ready; cannot resolve outputDir from taskId.',
        { taskId: args.taskId },
      )
    }
    const record = tracker.inspect(args.taskId)
    if (!record) {
      logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveRejected, {
        primitive: 'skill_inspect_run_state',
        reason: 'detached_task_not_found',
        taskId: args.taskId,
      })
      throw new ToolDomainError(
        'not_found',
        `Detached task ${args.taskId} not found.`,
        { taskId: args.taskId },
      )
    }
    outputDir = record.outputDir || (record.runStatePath ? dirname(record.runStatePath) : null)
    explicitRunStatePath = record.runStatePath || null
    resolvedFromTaskId = args.taskId
  } else if (args.runStatePath) {
    explicitRunStatePath = args.runStatePath
    if (basename(args.runStatePath) !== RUN_STATE_FILENAME) {
      throw new ToolDomainError(
        'input_validation',
        `runStatePath must point to ${RUN_STATE_FILENAME}.`,
        { runStatePath: args.runStatePath },
      )
    }
    outputDir = dirname(args.runStatePath)
  } else if (args.outputDir) {
    outputDir = args.outputDir
  }

  if (!outputDir) {
    logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveRejected, {
      primitive: 'skill_inspect_run_state',
      reason: 'no_outputdir_resolved',
    })
    throw new ToolDomainError(
      'input_validation',
      'Provide either `outputDir` or `taskId`; both were missing or empty.',
      {},
    )
  }

  // Validate that outputDir is at least a real directory.
  if (!existsSync(outputDir) || !statSync(outputDir).isDirectory()) {
    logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveRejected, {
      primitive: 'skill_inspect_run_state',
      reason: 'outputdir_not_found',
      outputDir,
    })
    return createMissingRunStateOutput({
      outputDir,
      resolvedFromTaskId,
      expectedTaskId: args.expectedTaskId || resolvedFromTaskId || null,
      errorKind: explicitRunStatePath ? 'not_found' : 'outputdir_not_found',
      message: explicitRunStatePath
        ? `No run_state.json found at ${explicitRunStatePath}.`
        : `outputDir does not exist or is not a directory: ${outputDir}`,
    })
  }

  const effectiveExpectedTaskId = args.expectedTaskId || resolvedFromTaskId || null
  const selection = selectRunStateFile({
    outputDir,
    explicitRunStatePath,
    expectedTaskId: effectiveExpectedTaskId,
  })
  if (selection.ambiguous) {
    logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveRejected, {
      primitive: 'skill_inspect_run_state',
      reason: 'run_state_ambiguous',
      outputDir,
      candidateCount: selection.candidates.length,
    })
    return createToolExecutionOutput(
      `Multiple run_state.json files found under ${outputDir}; provide expectedTaskId to select the matching task.`,
      {
        shape: 'json',
        data: {
          outputDir,
          resolvedFromTaskId,
          expectedTaskId: effectiveExpectedTaskId,
          found: false,
          ambiguous: true,
          runStatePath: null,
          candidates: selection.candidates,
          summary: null,
          raw: null,
        },
      },
    )
  }

  const runStatePath = selection.path
  if (!runStatePath) {
    const identityMismatch = Boolean(effectiveExpectedTaskId && selection.candidates.length > 0)
    logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveRejected, {
      primitive: 'skill_inspect_run_state',
      reason: identityMismatch ? 'identity_mismatch' : 'run_state_not_found',
      outputDir,
      expectedTaskId: effectiveExpectedTaskId,
      candidateCount: selection.candidates.length,
    })
    return createToolExecutionOutput(
      identityMismatch
        ? `run_state.json candidates under ${outputDir} did not match expected task id ${effectiveExpectedTaskId}.`
        : `No run_state.json found under ${outputDir} (searched root + one level deep).`,
      {
        shape: 'json',
        data: {
          outputDir,
          resolvedFromTaskId,
          expectedTaskId: effectiveExpectedTaskId,
          found: false,
          ambiguous: false,
          identityMismatch,
          errorKind: identityMismatch ? 'identity_mismatch' : 'not_found',
          runStatePath: null,
          candidates: selection.candidates,
          summary: null,
          raw: null,
        },
      },
    )
  }

  // Read + parse run_state.json.
  let raw: string
  try {
    raw = readFileSync(runStatePath, 'utf-8')
  } catch (error) {
    throw new ToolDomainError(
      'read_failed',
      `Failed to read run_state.json: ${error instanceof Error ? error.message : String(error)}`,
      { runStatePath },
    )
  }
  let parsed: unknown
  let parseError: string | null = null
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    parsed = null
    parseError = error instanceof Error ? error.message : String(error)
    logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveRejected, {
      primitive: 'skill_inspect_run_state',
      reason: 'json_parse_failed',
      runStatePath,
    })
  }

  const summary = extractKnownKeys(parsed)
  const artifactProgress = inspectSkillProgressArtifacts({ outputDir })
  const reconciledLiveness = deriveReconciledLiveness(summary, artifactProgress)
  const cap = Math.min(
    typeof args.maxRawBytes === 'number' && args.maxRawBytes > 0
      ? args.maxRawBytes
      : DEFAULT_MAX_RAW_BYTES,
    HARD_CAP_RAW_BYTES,
  )
  const truncated = raw.length > cap
  const rawSlice = truncated ? raw.slice(0, cap) : raw

  logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveUsed, {
    primitive: 'skill_inspect_run_state',
    runStatePath,
    knownKeysFound: summary.knownKeysFound,
    parseError: Boolean(parseError),
    rawBytes: raw.length,
    truncated,
  })

  // Stage D3 — emit framePatch so the next iteration's frame sees the
  // run_state path, output dir, scene scores path, and reconciled status
  // without re-resolving from summary text. Beta's `applyTurnFramePatch`
  // persists the durable slots (`activeArtifactRoots`, `runContract`,
  // `configValidation`) into the next frame.
  //
  // Stage M (M5a-inspect) — buildInspectFramePatch now returns both the
  // framePatch AND the full SkillRunContract (or null) so we can also emit
  // a matching contextModifier. Same-batch dependent tools (e.g. an
  // immediately-following `skill_read_artifact run_state.json`) see the
  // freshly-discovered outputDir through `ToolRuntimeContext.activeFrame`
  // before the post-batch frame merge runs.
  const { framePatch, contract: inspectedContract } = buildInspectFramePatch({
    outputDir,
    runStatePath,
    effectiveExpectedTaskId,
    resolvedFromTaskId,
    summary,
    artifactProgress,
    reconciledLiveness,
    parseError,
    skillId: typeof args.skillId === 'string' && args.skillId.trim().length > 0
      ? args.skillId.trim()
      : null,
  })

  const inspectedRoots = framePatch?.activeArtifactRoots ?? []
  const inspectContextModifier = inspectedRoots.length > 0
    ? {
      activeFrame: {
        activeArtifactRoots: inspectedRoots,
        // Use the FULL `contract` (SkillRunContract | null), not the
        // `framePatch.runContract` which is `Partial<SkillRunContract>`.
        // Plan v8 fix.
        runContract: inspectedContract ?? null,
        discoveredHandles: [],
      },
    }
    : null

  return createToolExecutionOutput(
    `Inspected run_state at ${runStatePath}. Found keys: ${summary.knownKeysFound.join(', ') || '(none of the known keys)'}.`,
    {
      shape: 'json',
      data: {
        outputDir,
        resolvedFromTaskId,
        expectedTaskId: effectiveExpectedTaskId,
        found: true,
        ambiguous: false,
        runStatePath,
        candidates: selection.candidates,
        summary,
        artifactProgress,
        reconciledLiveness,
        parseError,
        raw: rawSlice,
        rawBytes: raw.length,
        truncated,
      },
      framePatch,
      contextModifier: inspectContextModifier,
    },
  )
}
