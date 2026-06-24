import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { logAgentMetric } from '../metrics'
import { collectResponseDigestProof, collectRunStateProof, collectArtifactProof, appendProofRefs } from '../quality/proof-collector'
import { parseRunStateJson } from '../task-projection/run-state-schema'
import { adjudicateTerminalOutcome, appendCheckIns, type CheckInRecord } from '../quality/task-adjudicator'
import { resolveCriteria, type SkillExecutionForm } from '../quality/criteria-templates'
import type { TaskType } from '../../../../shared/task-types'
import {
  isRunMetaTerminalStatus,
  type RunMetaTerminalStatus,
} from '../../../../shared/run-meta-terminal-status'
import type { TaskBudgetRuntime, TaskProjectionRecord } from '../contracts/run-contracts'
import { canResumeAsUserPoint } from '../contracts/resume-handle'

export interface RunCloseMetric {
  runId: string
  terminalReason: string
  initiator: string
  toolCallsUsed: number
  durationMs: number
  /** P0-4 — effective task type (terminal patch wins over the stale row);
   *  coverage accounting for the Q4b promotion gate reads THIS. */
  taskType?: string | null
}

export interface FinalizedRunOutcome {
  status: string
  terminalReason: string
}

interface RunOutcomeTaskFacts {
  taskBudgetRuntime?: TaskBudgetRuntime | null
  providerDiagnostics?: RunOutcomeProviderDiagnostics | null
  usage?: RunOutcomeUsage | null
}

interface RunOutcomeProviderDiagnostics {
  provider?: string | null
  agentProtocol?: string | null
  wireApi?: string | null
  contextWindow?: number | null
  protocolSource?: 'explicit' | 'inferred' | null
  contextWindowSource?: 'explicit' | 'model' | 'fallback' | null
}

interface RunOutcomeUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export type RunOutcome =
  | ({
    kind: 'done'
    runId: string
    taskId?: string | null
    scopeId?: string | null
    durationMs: number
    toolCallsUsed: number
    initiator: string
    projectionPatch?: Record<string, unknown> | null
    terminalReason?: string | null
    /** EP2-Q3 — the final assistant text as emitted to the user (incl. the
     *  default-text fallback branch). Q4a generates the response-digest
     *  proof from this INSIDE finalizeRunOutcome, before the verdict. */
    finalText?: string | null
  } & RunOutcomeTaskFacts)
  | ({
    kind: 'checkpoint'
    runId: string
    taskId?: string | null
    scopeId?: string | null
    continuationHandle: string | null
    durationMs: number
    toolCallsUsed: number
    initiator: string
    projectionPatch?: Record<string, unknown> | null
    terminalReason?: string | null
    /** EP2-Q3 — see the done variant. */
    finalText?: string | null
  } & RunOutcomeTaskFacts)
  | ({
    kind: 'error' | 'cancelled' | 'preempted' | 'interrupted'
    runId: string
    taskId?: string | null
    scopeId?: string | null
    durationMs: number
    toolCallsUsed: number
    initiator: string
    terminalReason: string
    projectionPatch?: Record<string, unknown> | null
  } & RunOutcomeTaskFacts)

export interface RunMetaRepositoryLike {
  get(runId: string): unknown | null
  create(input: Record<string, unknown>): unknown
  update(runId: string, patch: Record<string, unknown>): unknown
}

export interface RunFinalizerDeps {
  runMetaRepository?: RunMetaRepositoryLike | null
  writeProjectionTerminalPatch?: (
    projectionPatch: Record<string, unknown> | null,
    terminalReason: string,
    status: string,
  ) => void | Promise<void>
  writeRunCloseMetric: (metric: RunCloseMetric) => void
  /** EP2-Q4a — projection store for shadow adjudication (CheckIn + proofs).
   *  Absent = adjudication skipped (legacy callers unchanged). */
  taskProjectionStore?: {
    get(taskId: string): TaskProjectionRecord | null
    update(taskId: string, patch: Partial<TaskProjectionRecord>, options?: { silent?: boolean; reasonHint?: string }): void
  } | null
  /** EP2-Q4a — injectable clock for the adjudication timestamp. */
  now?: () => Date
  /** EP4-B6 — optional site-card learning hook. Best-effort only: failures
   *  must not affect terminal outcome finalization. */
  learnFromCheckIn?: (input: {
    checkIn: CheckInRecord
    projection: TaskProjectionRecord
    now: Date
    terminalStatus?: string | null
    terminalReason?: string | null
  }) => void
  /** P1 — real validation for the run_state COMPLETION proof: a `run_state`
   *  proof may only be seeded when run_state.json is terminally done AND its
   *  delivery report exists (a skill child emits runStatePath at START). Default
   *  reads + parses the file; injectable for tests. */
  verifyRunStateTerminal?: (runStatePath: string) => boolean
  /** P1 — existence check for handle-derived artifact proofs (outputDir/…). */
  verifyArtifactExists?: (path: string) => boolean
}

const DELIVERY_REPORT_FILE = 'delivery_report.json'

/** Default run_state COMPLETION validator: run_state.json must parse to a
 *  terminal `done` status AND a delivery report must exist on disk. Real skills
 *  (e.g. VEA) do NOT back-fill the report path into run_state — they write
 *  `delivery_report.json` beside the outputs — so we resolve it from, in order:
 *  the explicit `deliveryReportPath`, the run_state's `video_dir`/`outputDir`,
 *  then the run_state's own directory. Still running/blocked, failed, or
 *  report-missing → NOT verified. All failures degrade to "not verified". */
export function defaultVerifyRunStateTerminal(runStatePath: string): boolean {
  try {
    if (!runStatePath || !existsSync(runStatePath)) return false
    const parsed = parseRunStateJson(readFileSync(runStatePath, 'utf-8'), { path: runStatePath })
    if (!parsed.ok || parsed.value.status !== 'done') return false
    const explicit = parsed.value.deliveryReportPath
    if (explicit && existsSync(explicit)) return true
    const rawVideoDir = typeof parsed.value.raw?.video_dir === 'string' ? parsed.value.raw.video_dir : ''
    const candidateDirs = [rawVideoDir, parsed.value.outputDir ?? '', dirname(runStatePath)]
      .map((dir) => String(dir || '').trim())
      .filter((dir) => dir.length > 0)
    return candidateDirs.some((dir) => existsSync(join(dir, DELIVERY_REPORT_FILE)))
  } catch {
    return false
  }
}

export function writeRunCloseMetric(metric: RunCloseMetric): void {
  logAgentMetric('run_close', {
    runId: metric.runId,
    terminalReason: metric.terminalReason,
    initiator: metric.initiator,
    toolCallsUsed: metric.toolCallsUsed,
    durationMs: metric.durationMs,
    taskType: metric.taskType ?? null,
  })
}

export const defaultRunFinalizerDeps: RunFinalizerDeps = {
  writeRunCloseMetric,
}

interface EffectiveTaskFacts {
  taskType: string | null
  module: string | null
  skillExecutionForm: SkillExecutionForm | null
}

type TerminalFailureReason = 'delivery_failed' | 'tool_unavailable' | 'no_artifact' | 'proof_gap' | 'adjudication_degraded'

interface TerminalAdjudicationDecision {
  verdict: CheckInRecord['verdict']
  blockers: string[]
  proofCount: number
}

const TERMINAL_FAILURE_REASONS = new Set<TerminalFailureReason>([
  'delivery_failed',
  'tool_unavailable',
  'no_artifact',
  'proof_gap',
  'adjudication_degraded',
])

export function buildTerminalProjectionPatch(params: {
  nextTaskId: string
  updatedAt: string
}): Partial<TaskProjectionRecord> {
  return {
    status: 'killed',
    interactionState: 'suspended',
    waitingFor: 'none',
    taskSummary: '已被新消息接管',
    // killed-by-supersede is terminal, not blocked — blockedReason stays null
    // (legacy supersede contract, see task-projection-supersede.test.ts)
    blockedReason: null,
    resumableActions: ['none'],
    continuationRef: {
      taskId: params.nextTaskId,
      blockerType: 'superseded',
    },
    updatedAt: params.updatedAt,
  }
}

export function buildSupersededChildTerminalProjectionPatch(params: {
  baseContinuationRef: TaskProjectionRecord['continuationRef']
  supersededByChildRunId: string
  steps: TaskProjectionRecord['steps']
}): Partial<TaskProjectionRecord> {
  return {
    status: 'killed',
    interactionState: 'suspended',
    waitingFor: 'none',
    taskSummary: '已由后续技能子任务完成',
    blockedReason: null,
    degradationReason: 'superseded_by_child_run',
    resumableActions: ['none'],
    continuationRef: {
      ...(params.baseContinuationRef || {}),
      blockerType: 'superseded',
      pauseReason: 'superseded',
      supersededByChildRunId: params.supersededByChildRunId,
    } as TaskProjectionRecord['continuationRef'] & { supersededByChildRunId: string },
    steps: params.steps,
  }
}

export function buildManualSuspendProjectionPatch(params: {
  projection?: TaskProjectionRecord | null
  taskTitle?: string | null
  taskSummary?: string | null
  steps?: TaskProjectionRecord['steps'] | null
  currentStepId?: string | null
  continuationRef?: TaskProjectionRecord['continuationRef'] | null
  budget?: TaskProjectionRecord['budget'] | null
  budgetUsagePercent?: number | null
  budgetWarningLevel?: TaskProjectionRecord['budgetWarningLevel'] | null
  recoveryHistory?: TaskProjectionRecord['recoveryHistory'] | null
  updatedAt: string
}): Partial<TaskProjectionRecord> {
  const projection = params.projection || null
  const continuationRef = params.continuationRef ?? projection?.continuationRef ?? null
  const canResume = canResumeAsUserPoint(continuationRef)
  return {
    status: canResume ? 'recoverable_paused' : 'blocked',
    interactionState: 'suspended',
    waitingFor: 'none',
    taskTitle: params.taskTitle ?? projection?.taskTitle ?? null,
    taskSummary: params.taskSummary ?? projection?.taskSummary ?? '任务已暂停，等待继续。',
    steps: params.steps ?? projection?.steps ?? [],
    currentStepId: params.currentStepId ?? projection?.currentStepId ?? null,
    blockedReason: '任务已暂停，等待继续。',
    degradationReason: projection?.degradationReason ?? null,
    resumableActions: canResume ? ['continue', 'cancel'] : ['cancel'],
    continuationRef,
    budget: params.budget ?? projection?.budget ?? null,
    budgetUsagePercent: params.budgetUsagePercent ?? projection?.budgetUsagePercent ?? null,
    budgetWarningLevel: params.budgetWarningLevel ?? projection?.budgetWarningLevel ?? null,
    recoveryHistory: params.recoveryHistory ?? projection?.recoveryHistory ?? [],
    updatedAt: params.updatedAt,
  }
}

export async function finalizeRunOutcome(outcome: RunOutcome, deps: RunFinalizerDeps): Promise<FinalizedRunOutcome> {
  if (outcome.kind === 'done') {
    return writeTerminalOutcome(outcome, deps, 'done', outcome.terminalReason || 'done')
  }

  if (outcome.kind === 'checkpoint') {
    if (requiresCheckpointContinuationHandle(outcome.terminalReason) && !isValidContinuationHandle(outcome.continuationHandle)) {
      writeRunMetaOutcome(outcome, deps, 'error', 'checkpoint_degraded_error')
      deps.writeRunCloseMetric(toRunCloseMetric(outcome, 'checkpoint_degraded_error'))
      throw new Error('checkpoint outcome requires a valid continuation handle')
    }

    return writeTerminalOutcome(outcome, deps, 'checkpoint', outcome.terminalReason || 'checkpoint')
  }

  return writeTerminalOutcome(
    outcome,
    deps,
    statusFromOutcomeKind(outcome.kind),
    outcome.terminalReason,
  )
}

function statusFromOutcomeKind(kind: Exclude<RunOutcome['kind'], 'done' | 'checkpoint'>): RunMetaTerminalStatus {
  if (kind === 'error') return 'error'
  if (kind === 'interrupted') return 'interrupted'
  return 'cancelled'
}

function normalizeSkillExecutionForm(value: unknown): SkillExecutionForm | null {
  return value === 'direct' || value === 'child_loop' || value === 'python'
    ? value
    : null
}

/** P0-3 — the row in task_projections may still carry first-build defaults
 *  (short_task) at finalize time: the terminal projectionPatch is the
 *  authoritative correction and must win for adjudication AND coverage
 *  accounting, independent of patch-persistence timing. */
function resolveEffectiveTaskFacts(
  outcome: RunOutcome,
  deps: RunFinalizerDeps,
): EffectiveTaskFacts {
  const patch = outcome.projectionPatch as {
    taskType?: unknown
    module?: unknown
    skillExecutionForm?: unknown
  } | null | undefined
  let rowTaskType: string | null = null
  let rowModule: string | null = null
  if (deps.taskProjectionStore && outcome.taskId) {
    try {
      const row = deps.taskProjectionStore.get(outcome.taskId)
      rowTaskType = row?.taskType ?? null
      rowModule = row?.module ?? null
    } catch { /* facts degrade to patch-only */ }
  }
  return {
    taskType: (typeof patch?.taskType === 'string' && patch.taskType ? patch.taskType : rowTaskType),
    module: (typeof patch?.module === 'string' && patch.module ? patch.module : rowModule),
    skillExecutionForm: normalizeSkillExecutionForm(patch?.skillExecutionForm),
  }
}

async function writeTerminalOutcome(
  outcome: RunOutcome,
  deps: RunFinalizerDeps,
  status: RunMetaTerminalStatus,
  terminalReason: string,
): Promise<FinalizedRunOutcome> {
  const facts = resolveEffectiveTaskFacts(outcome, deps)
  const adjudication = recordTerminalAdjudication(outcome, deps, status, terminalReason, facts)
  let effectiveStatus: RunMetaTerminalStatus = status
  let effectiveTerminalReason = terminalReason
  if (status === 'done' && adjudication && adjudication.verdict !== 'accept') {
    const taskContinuation = continuationFromProjectionPatch(outcome.projectionPatch)
    if (canResumeAsUserPoint(taskContinuation)) {
      effectiveStatus = 'checkpoint'
      effectiveTerminalReason = 'checkpoint_budget'
    } else {
      effectiveStatus = 'error'
      effectiveTerminalReason = resolveTerminalFailureReason(outcome.projectionPatch, adjudication)
    }
  }
  writeRunMetaOutcome(outcome, deps, effectiveStatus, effectiveTerminalReason)
  if (deps.writeProjectionTerminalPatch) {
    await deps.writeProjectionTerminalPatch(outcome.projectionPatch || null, effectiveTerminalReason, effectiveStatus)
  }
  deps.writeRunCloseMetric({ ...toRunCloseMetric(outcome, effectiveTerminalReason), taskType: facts.taskType })
  return { status: effectiveStatus, terminalReason: effectiveTerminalReason }
}

function readTerminalFailureReason(value: unknown): TerminalFailureReason | null {
  return typeof value === 'string' && TERMINAL_FAILURE_REASONS.has(value as TerminalFailureReason)
    ? value as TerminalFailureReason
    : null
}

function resolveTerminalFailureReason(
  projectionPatch: Record<string, unknown> | null | undefined,
  adjudication: TerminalAdjudicationDecision,
): TerminalFailureReason {
  const directReason = readTerminalFailureReason(projectionPatch?.terminalFailureReason)
  if (directReason) return directReason

  const terminalFailure = projectionPatch?.terminalFailure
  if (terminalFailure && typeof terminalFailure === 'object') {
    const nestedReason = readTerminalFailureReason((terminalFailure as Record<string, unknown>).reason)
    if (nestedReason) return nestedReason
  }

  // Distinguish the two failure shapes for observability (P2): a genuine
  // zero-proof done → `proof_gap` (缺少完成证据); a run that DID produce proofs
  // but failed acceptance criteria → `adjudication_degraded` (完成判定未通过).
  // Conflating both as proof_gap hid the real cause (a degraded run looks like
  // "no evidence" when it actually had evidence but unmet criteria).
  if (adjudication.blockers.includes('zero_proof_done') || adjudication.proofCount === 0) {
    return 'proof_gap'
  }
  return 'adjudication_degraded'
}

function continuationFromProjectionPatch(
  projectionPatch: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  const taskContinuation = projectionPatch?.taskContinuation
  if (taskContinuation && typeof taskContinuation === 'object') return taskContinuation as Record<string, unknown>
  const continuationRef = projectionPatch?.continuationRef
  if (continuationRef && typeof continuationRef === 'object') return continuationRef as Record<string, unknown>
  return null
}

/**
 * EP2-Q4a/G0 — enforced adjudication INSIDE the finalize funnel. Ordering hard
 * clause: the response-digest proof lands on the projection FIRST, then the
 * adjudicator judges with the refreshed proof set — a direct_answer run can
 * never be structurally zero-proof at judging time. Finalizer policy may
 * mutate lifecycle status after the CheckIn is recorded; divergence is logged
 * with both the new enforce metric and the legacy shadow metric name.
 * Failures degrade to a metric — adjudication never blocks finalize.
 */
function recordTerminalAdjudication(
  outcome: RunOutcome,
  deps: RunFinalizerDeps,
  status: string,
  terminalReason: string,
  facts?: EffectiveTaskFacts,
): TerminalAdjudicationDecision | null {
  const store = deps.taskProjectionStore
  const taskId = outcome.taskId
  if (!store || !taskId) return null
  try {
    const projection = store.get(taskId)
    if (!projection) return null
    const now = deps.now ? deps.now() : new Date()

    // ① response digest proof FIRST (Q3 collector; empty finalText → null), plus
    // proofs seeded from the run's durable continuation handle — but only after
    // REAL validation (a `runStatePath` string alone is a skill START, not a
    // completion). `skill_run_state`/`steps_complete` accept only the `run_state`
    // KIND, which no tool-output path mints; the finalizer is the sole minter and
    // it gates on run_state.json being terminally done + delivery report present.
    const finalText = outcome.kind === 'done' || outcome.kind === 'checkpoint' ? outcome.finalText : null
    const digestProof = collectResponseDigestProof(finalText ?? null, now)
    const continuation = continuationFromProjectionPatch(outcome.projectionPatch)
    const handleString = (key: string): string => {
      const value = continuation?.[key]
      return typeof value === 'string' ? value.trim() : ''
    }
    // run_state COMPLETION proof — gated on REAL validation: run_state.json must
    // be terminally done AND its delivery report must exist. A bare runStatePath
    // (skill child START) is NOT completion evidence, so a still-running / blocked
    // / failed / missing-delivery run can never spoof skill_run_state/steps_complete.
    const verifyRunStateTerminal = deps.verifyRunStateTerminal ?? defaultVerifyRunStateTerminal
    const verifyArtifactExists = deps.verifyArtifactExists ?? ((path: string) => existsSync(path))
    const runStatePath = handleString('runStatePath')
    const runStateDone = Boolean(runStatePath) && verifyRunStateTerminal(runStatePath)
    // A5 — media / python-skill outputs can reach the loop only via framePatch
    // (not data/projectionPatch). Seed artifact proofs from the durable handle's
    // output paths, but only for paths that actually exist on disk.
    const handleArtifactPaths = ['outputDir', 'deliveryReportPath', 'sceneScoresPath']
      .map(handleString)
      .filter((path) => path.length > 0 && verifyArtifactExists(path))
    const seededProofs = [
      ...(digestProof ? [digestProof] : []),
      ...(runStateDone ? [collectRunStateProof(runStatePath, now)] : []),
      ...handleArtifactPaths.map((path) => collectArtifactProof(path, now)),
    ]
    const proofRefs = seededProofs.length
      ? appendProofRefs(projection.proofRefs ?? [], seededProofs)
      : (Array.isArray(projection.proofRefs) ? projection.proofRefs : [])

    // ② verdict SECOND, judging the refreshed proof set with the EFFECTIVE
    // task facts (terminal patch wins over the stale row — P0-3)
    const effectiveTaskType = (facts?.taskType ?? projection.taskType) as TaskType
    const effectiveModule = String(facts?.module ?? projection.module ?? 'system')
    const criteria = resolveCriteria(effectiveTaskType, effectiveModule, {
      skillExecutionForm: facts?.skillExecutionForm ?? null,
    })
    const { verdict, checkIn } = adjudicateTerminalOutcome({
      terminalStatus: status,
      terminalReason,
      criteria: criteria.items,
      proofs: proofRefs,
      mode: 'enforce',
      now,
    })

    // ③ CheckIn + proofs land on the projection — lifecycle fields untouched
    store.update(taskId, {
      proofRefs,
      checkins: appendCheckIns(projection.checkins ?? [], checkIn),
    }, { silent: true, reasonHint: 'terminal_adjudication' })

    if (deps.learnFromCheckIn) {
      try {
        deps.learnFromCheckIn({ checkIn, projection, now, terminalStatus: status, terminalReason })
      } catch (error) {
        logAgentMetric('site_card_learning_checkin_failed', {
          runId: outcome.runId,
          taskId,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }

    // ④ divergence metric when the verdict disagrees with the actual terminal
    if (status === 'done' && verdict !== 'accept') {
      const divergencePayload = {
        runId: outcome.runId,
        taskId,
        taskType: (facts?.taskType ?? projection.taskType),
        verdict,
        actualStatus: status,
        terminalReason,
        proofCount: checkIn.proofCount,
        blockers: checkIn.blockers,
      }
      logAgentMetric('adjudicator_enforce_divergence', divergencePayload)
      logAgentMetric('adjudicator_shadow_divergence', { ...divergencePayload, compatibility: true })
    }
    return { verdict, blockers: checkIn.blockers, proofCount: checkIn.proofCount }
  } catch (error) {
    logAgentMetric('adjudication_failed', {
      runId: outcome.runId,
      taskId,
      reason: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

function writeRunMetaOutcome(
  outcome: RunOutcome,
  deps: RunFinalizerDeps,
  status: RunMetaTerminalStatus,
  terminalReason: string,
): void {
  if (!isRunMetaTerminalStatus(status)) {
    throw new Error(`Invalid terminal run_meta status: ${status}`)
  }
  const repository = deps.runMetaRepository
  if (!repository) return
  const providerDiagnostics = outcome.providerDiagnostics || null
  const taskBudgetRuntime = outcome.taskBudgetRuntime || null
  const usage = outcome.usage || null
  const patch: Record<string, unknown> = {
    runId: outcome.runId,
    taskId: outcome.taskId ?? null,
    scopeId: outcome.scopeId ?? null,
    status,
    terminalReason,
    initiator: outcome.initiator,
    durationMs: outcome.durationMs,
  }
  if (taskBudgetRuntime) {
    patch.taskType = taskBudgetRuntime.taskType || null
    patch.budget = {
      ...taskBudgetRuntime.budget,
      ...taskBudgetRuntime.usage,
    }
  }
  if (providerDiagnostics) {
    patch.providerProtocol = providerDiagnostics.agentProtocol || null
    patch.wireApi = providerDiagnostics.wireApi || null
    patch.contextWindow = providerDiagnostics.contextWindow || null
    patch.providerDiagnostics = providerDiagnostics
  }
  if (usage) {
    patch.inputTokens = usage.inputTokens ?? 0
    patch.outputTokens = usage.outputTokens ?? 0
    patch.totalTokens = usage.totalTokens ?? 0
  }
  if (repository.get(outcome.runId)) {
    repository.update(outcome.runId, patch)
  } else {
    repository.create(patch)
  }
}

function toRunCloseMetric(
  outcome: RunOutcome,
  terminalReason: string,
): RunCloseMetric {
  return {
    runId: outcome.runId,
    terminalReason,
    initiator: outcome.initiator,
    toolCallsUsed: outcome.toolCallsUsed,
    durationMs: outcome.durationMs,
  }
}

function isValidContinuationHandle(handle: string | null): handle is string {
  return typeof handle === 'string' && handle.trim().length > 0
}

function requiresCheckpointContinuationHandle(terminalReason?: string | null): boolean {
  return terminalReason !== 'checkpoint_user_input'
}
