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
import { dirname, join } from 'node:path'

import { createToolExecutionOutput, type ToolExecutionOutput } from '../../agent-control/tool-result-types'
import { ToolDomainError } from '../tool-errors'
import { logAgentMetric } from '../../agent-control/metrics'
import { TOOL_ERROR_METRICS } from '../../agent-control/tool-error-metrics'
import { getDetachedSkillTaskTracker } from '../../agent-control/detached-skill-task-tracker'
import { selectRunStateCandidate, type RunStateCandidate } from '../../agent-control/run-state-selection'

const RUN_STATE_FILENAME = 'run_state.json'
const DEFAULT_MAX_RAW_BYTES = 16_384
const HARD_CAP_RAW_BYTES = 65_536
const SUBDIR_DEPTH_LIMIT = 1 // search at root then one level deep

export interface InspectRunStateArgs {
  outputDir?: string
  taskId?: string
  expectedTaskId?: string
  maxRawBytes?: number
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
    throw new ToolDomainError(
      'not_found',
      `outputDir does not exist or is not a directory: ${outputDir}`,
      { outputDir, resolvedFromTaskId },
    )
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
        parseError,
        raw: rawSlice,
        rawBytes: raw.length,
        truncated,
      },
    },
  )
}
