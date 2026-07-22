import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { logAgentMetric } from '../metrics'
import {
  collectResponseDigestProof,
  collectRunStateProof,
  collectArtifactProof,
  appendProofRefs
} from '../quality/proof-collector'
import { parseRunStateJson } from '../task-projection/run-state-schema'
import {
  adjudicateTerminalOutcome,
  appendCheckIns,
  type CheckInRecord
} from '../quality/task-adjudicator'
import {
  appendModelCriteria,
  normalizeDeliveryTarget,
  resolveCriteria,
  type SkillExecutionForm
} from '../quality/criteria-templates'
import type { TaskType } from '../../../../shared/task-types'
import {
  isRunMetaTerminalStatus,
  type RunMetaTerminalStatus
} from '../../../../shared/run-meta-terminal-status'
import type {
  BudgetWarningLevel,
  TaskBudget,
  TaskBudgetRuntime,
  TaskProjectionRecord,
} from '../contracts/run-contracts'
import { canResumeAsUserPoint } from '../contracts/resume-handle'
import type { DeliveryStateV1 } from '../../../../shared/dynamic-delivery'
import { assertDeliveryState } from '../../../../shared/dynamic-delivery'
import {
  getBudgetUsagePercent,
  rebindTaskBudgetRuntime,
} from '../task-projection/run-budget-policy'
import type { CanonicalAssistantMessageReceipt } from '../../../../shared/ipc-contracts/canonical-message'
import type {
  BrowserWorkflowCloseoutSeal,
  BrowserWorkflowCompletionVerifierReceipt,
} from '../../../../shared/browser-workflow-control'
import { workflowDigest } from '../../repositories/browser-workflow-codec'
import { closeoutBrowserTargetClaimsForRun } from '../../browser-engine/browser-target-claim-closeout'

export interface RunCloseMetric {
  runId: string
  terminalReason: string
  initiator: string
  toolCallsUsed: number
  durationMs: number
  /** P0-4 — effective task type (terminal patch wins over the stale row);
   *  coverage accounting for the Q4b promotion gate reads THIS. */
  taskType?: string | null
  lastProviderFailureHttpStatus?: number | null
  lastProviderFailureErrorKind?: string | null
}

export interface FinalizedRunOutcome {
  status: string
  terminalReason: string
  canonicalMessage?: CanonicalAssistantMessageReceipt['canonicalMessage']
  canonicalMessageDigest?: string
}

interface RunOutcomeTaskFacts {
  taskBudgetRuntime?: TaskBudgetRuntime | null
  providerDiagnostics?: RunOutcomeProviderDiagnostics | null
  usage?: RunOutcomeUsage | null
  workflowCloseoutSeal?: BrowserWorkflowCloseoutSeal | null
  workflowVerifierAcceptance?: Omit<
    BrowserWorkflowCompletionVerifierReceipt,
    'parentTaskId' | 'ownerRunId' | 'terminalQualityPatchDigest'
  > | null
  canonicalMessageReceipt?: CanonicalAssistantMessageReceipt | null
}

interface RunOutcomeProviderDiagnostics {
  provider?: string | null
  agentProtocol?: string | null
  wireApi?: string | null
  contextWindow?: number | null
  protocolSource?: 'explicit' | 'inferred' | null
  contextWindowSource?: 'explicit' | 'model' | 'fallback' | null
  usageSource?: 'provider' | 'estimated' | 'missing'
  providerCallCount?: number
  missingCallCount?: number
  lastProviderFailureHttpStatus?: number | null
  lastProviderFailureErrorKind?: string | null
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
      finalText?: string | null
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
    canonicalReceipt?: CanonicalAssistantMessageReceipt,
  ) => void | Promise<void>
  commitCanonicalCoreCloseout?: (input: {
    parentTaskId: string
    ownerRunId: string
    status: 'done' | 'error' | 'cancelled' | 'interrupted'
    terminalReason: string
    initiator: string
    durationMs: number
    finalText: string
    conversationId: string
    taskType?: string | null
    module?: string | null
    budget?: TaskBudget | null
    budgetUsagePercent?: number | null
    budgetWarningLevel?: BudgetWarningLevel | null
    providerDiagnostics?: Record<string, unknown> | null
    usage?: RunOutcomeUsage | null
    deliveryState?: DeliveryStateV1 | null
    workflowCloseoutSeal?: BrowserWorkflowCloseoutSeal | null
    terminalQualityPatch?: TerminalAdjudicationDecision['terminalQualityPatch'] | null
    completionVerifierReceipt?: BrowserWorkflowCompletionVerifierReceipt | null
  }) => Promise<CanonicalAssistantMessageReceipt>
  writeRunCloseMetric: (metric: RunCloseMetric) => void
  /** EP2-Q4a — projection store for shadow adjudication (CheckIn + proofs).
   *  Absent = adjudication skipped (legacy callers unchanged). */
  taskProjectionStore?: {
    get(taskId: string): TaskProjectionRecord | null
    update(
      taskId: string,
      patch: Partial<TaskProjectionRecord>,
      options?: { silent?: boolean; reasonHint?: string }
    ): void
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
    const rawVideoDir =
      typeof parsed.value.raw?.video_dir === 'string' ? parsed.value.raw.video_dir : ''
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
    taskType: metric.taskType ?? null
  })
}

export const defaultRunFinalizerDeps: RunFinalizerDeps = {
  writeRunCloseMetric
}

interface EffectiveTaskFacts {
  taskType: string | null
  taskTypeSource: 'projection_patch' | 'projection_row' | 'budget_runtime' | 'missing'
  module: string | null
  skillExecutionForm: SkillExecutionForm | null
  browserCollectionRequired: boolean | null
}

type TerminalFailureReason =
  | 'delivery_failed'
  | 'tool_unavailable'
  | 'no_artifact'
  | 'proof_gap'
  | 'adjudication_degraded'
  | 'browser_transaction_unconfirmed'

type EnforceMode = 'enforce' | 'degraded_visible'

function resolveEnforceMode(): EnforceMode {
  const flag = process.env.READY_ADJUDICATION_ENFORCE_MODE
  if (flag === 'enforce') return 'enforce'
  if (flag === 'degraded_visible') return 'degraded_visible'
  return 'degraded_visible'
}

interface TerminalAdjudicationDecision {
  verdict: CheckInRecord['verdict']
  blockers: string[]
  proofCount: number
  satisfiedCount: number
  derived: {
    checkIn: CheckInRecord
    projection: TaskProjectionRecord
    now: Date
    projectionPatch: Partial<TaskProjectionRecord>
    persistProjectionPatch: boolean
  }
  terminalQualityPatch?: {
    proofRefs: unknown[]
    checkins: unknown[]
    criteria: Record<string, unknown>
    learningRefs?: unknown[]
  }
}

export function resolveDynamicDeliveryFinalizerBlocker(
  state: DeliveryStateV1 | null | undefined,
): string | null {
  if (!state || state.decision === 'single_path') return null
  if (state.verifier.status !== 'accepted') return 'delivery_verifier_unsettled'
  if (state.decision === 'support_and_verify') {
    const requiredUnsettled = state.packages.some((entry) =>
      entry.criticality === 'required'
      && entry.status !== 'completed'
      && entry.status !== 'degraded',
    )
    if (requiredUnsettled) return 'delivery_required_package_unsettled'
  }
  return null
}

function canKeepProofBearingDegradedVisible(
  adjudication: TerminalAdjudicationDecision,
  projectionPatch: Record<string, unknown> | null | undefined,
  facts?: EffectiveTaskFacts | null
): boolean {
  if (isBrowserTransactionTask(facts)) return false
  if (projectionPatch?.browserResearchEssentialOutputSatisfied === false) return false
  if (adjudication.verdict !== 'degraded') return false
  if (adjudication.proofCount <= 0) return false
  if (adjudication.satisfiedCount <= 0) return false
  if (adjudication.blockers.some((blocker) => blocker === 'criteria_unsatisfied:s1')) return false
  if (readTerminalFailureReason(projectionPatch?.terminalFailureReason)) return false
  const terminalFailure = projectionPatch?.terminalFailure
  if (terminalFailure && typeof terminalFailure === 'object') {
    if (readTerminalFailureReason((terminalFailure as Record<string, unknown>).reason)) return false
  }
  return resolveEnforceMode() === 'degraded_visible'
}

const TERMINAL_FAILURE_REASONS = new Set<TerminalFailureReason>([
  'delivery_failed',
  'tool_unavailable',
  'no_artifact',
  'proof_gap',
  'adjudication_degraded',
  'browser_transaction_unconfirmed'
])

function isBrowserTransactionTask(facts?: EffectiveTaskFacts | null): boolean {
  return facts?.taskType === 'browser_transaction'
}

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
      blockerType: 'superseded'
    },
    updatedAt: params.updatedAt
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
      supersededByChildRunId: params.supersededByChildRunId
    } as TaskProjectionRecord['continuationRef'] & { supersededByChildRunId: string },
    steps: params.steps
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
    updatedAt: params.updatedAt
  }
}

export async function finalizeRunOutcome(
  outcome: RunOutcome,
  deps: RunFinalizerDeps
): Promise<FinalizedRunOutcome> {
  const terminalBudgetRuntime = reconcileTerminalTaskBudgetRuntime(
    outcome.taskBudgetRuntime,
    outcome.projectionPatch,
    outcome.toolCallsUsed
  )
  if (terminalBudgetRuntime !== outcome.taskBudgetRuntime) {
    outcome = { ...outcome, taskBudgetRuntime: terminalBudgetRuntime } as RunOutcome
  }

  if (outcome.kind === 'done') {
    const finalized = await writeTerminalOutcome(outcome, deps, 'done', outcome.terminalReason || 'done')
    closeoutBrowserClaimsIfOwned(outcome, deps, {
      ownerRunId: outcome.runId,
      resumable: false,
      suspensionCheckpointId: null,
      suspensionReason: null,
    })
    return finalized
  }

  if (outcome.kind === 'checkpoint') {
    if (
      requiresCheckpointContinuationHandle(outcome.terminalReason) &&
      !isValidContinuationHandle(outcome.continuationHandle)
    ) {
      writeRunMetaOutcome(outcome, deps, 'error', 'checkpoint_degraded_error')
      deps.writeRunCloseMetric(toRunCloseMetric(outcome, 'checkpoint_degraded_error'))
      throw new Error('checkpoint outcome requires a valid continuation handle')
    }

    const finalized = await writeTerminalOutcome(outcome, deps, 'checkpoint', outcome.terminalReason || 'checkpoint')
    closeoutBrowserClaimsIfOwned(outcome, deps, {
      ownerRunId: outcome.runId,
      resumable: true,
      suspensionCheckpointId: outcome.continuationHandle,
      suspensionReason: outcome.terminalReason || 'checkpoint',
    })
    return finalized
  }

  const finalized = await writeTerminalOutcome(
    outcome,
    deps,
    statusFromOutcomeKind(outcome.kind),
    outcome.terminalReason
  )
  const recoverable = Boolean(
    outcome.projectionPatch
    && ['recoverable_paused', 'paused'].includes(String(outcome.projectionPatch.status || '')),
  )
  closeoutBrowserClaimsIfOwned(outcome, deps, {
    ownerRunId: outcome.runId,
    resumable: recoverable,
    suspensionCheckpointId: recoverable
      ? String(outcome.projectionPatch?.continuationHandle || outcome.projectionPatch?.checkpointId || '') || null
      : null,
    suspensionReason: recoverable ? outcome.terminalReason : null,
  })
  return finalized
}

function closeoutBrowserClaimsIfOwned(
  outcome: RunOutcome,
  deps: RunFinalizerDeps,
  input: Parameters<typeof closeoutBrowserTargetClaimsForRun>[0],
): void {
  const projection = outcome.taskId && deps.taskProjectionStore
    ? deps.taskProjectionStore.get(outcome.taskId)
    : null
  const continuation = projection?.continuationRef
  const browserOwned = projection?.module === 'browser'
    || outcome.projectionPatch?.module === 'browser'
    || Boolean(
      continuation
      && typeof continuation === 'object'
      && (
        (continuation as Record<string, unknown>).kind === 'browser_checkpoint'
        || (continuation as Record<string, unknown>).browserTaskId
      ),
    )
  if (browserOwned) closeoutBrowserTargetClaimsForRun(input)
}

/**
 * A bootstrap budget is only a pre-run capacity guess. Once a zero-tool turn
 * closes with the terminal direct-answer patch, align that snapshot before
 * adjudication and persistence. Explicit task budgets remain authoritative so
 * research, browser transactions, continuations, and skill work cannot evade
 * their proof contract by returning prose without using their required tools.
 */
export function reconcileTerminalTaskBudgetRuntime(
  runtime: TaskBudgetRuntime | null | undefined,
  projectionPatch: Record<string, unknown> | null | undefined,
  toolCallsUsed: number
): TaskBudgetRuntime | null {
  if (!runtime) return null
  if (
    toolCallsUsed !== 0
    || projectionPatch?.taskType !== 'direct_answer'
    || !runtime.bootstrapBudget
  ) return runtime
  return rebindTaskBudgetRuntime(runtime, 'direct_answer', { bootstrapBudget: false })
}

function statusFromOutcomeKind(
  kind: Exclude<RunOutcome['kind'], 'done' | 'checkpoint'>
): RunMetaTerminalStatus {
  if (kind === 'error') return 'error'
  if (kind === 'interrupted') return 'interrupted'
  return 'cancelled'
}

function normalizeSkillExecutionForm(value: unknown): SkillExecutionForm | null {
  return value === 'direct' || value === 'child_loop' || value === 'python' ? value : null
}

const DOCUMENT_PROGRESS_STEP_IDS = new Set(['document_create', 'document_write', 'document_save'])

function stepRequiresCompletionProof(step: unknown): boolean {
  if (!step || typeof step !== 'object') return false
  const id = String((step as { id?: unknown }).id || '')
  const status = String((step as { status?: unknown }).status || '')
  return !DOCUMENT_PROGRESS_STEP_IDS.has(id) || status !== 'done'
}

function hasPlannedStepsRequiringProof(
  projection: TaskProjectionRecord,
  projectionPatch?: Record<string, unknown> | null
): boolean {
  const storedSteps = Array.isArray(projection.steps) ? projection.steps : []
  const patchSteps = Array.isArray(projectionPatch?.steps) ? projectionPatch.steps : []
  return [...storedSteps, ...patchSteps].some(stepRequiresCompletionProof)
}

function hasProofKind(proofRefs: ReadonlyArray<unknown>, kinds: ReadonlySet<string>): boolean {
  return proofRefs.some(
    (row) =>
      row &&
      typeof row === 'object' &&
      kinds.has(String((row as Record<string, unknown>).kind || ''))
  )
}

/** Durable proof kinds that constitute crystallizable "learning" evidence — a
 *  run's persistent outcomes (artifacts on disk, confirmed transactions,
 *  run-state / task-event completions), as opposed to transient chatter. */
const LEARNING_PROOF_KINDS: ReadonlySet<string> = new Set([
  'artifact',
  'transaction_confirmed',
  'run_state',
  'task_event'
])

/**
 * P2-5 — deterministically derive the learning refs the specialist evolution
 * pipeline reads, as the durable subset of the (already existence-verified)
 * proof set. Pure/repeatable transform → code, not model (CLAUDE.md §0).
 */
function deriveLearningRefs(proofRefs: ReadonlyArray<unknown>): unknown[] {
  return proofRefs.filter((row) => {
    if (!row || typeof row !== 'object') return false
    const record = row as Record<string, unknown>
    if (LEARNING_PROOF_KINDS.has(String(record.kind || ''))) return true
    // A ref that points at a concrete on-disk path is durable evidence too.
    const path = record.path ?? record.relPath
    return typeof path === 'string' && path.trim().length > 0
  })
}

/**
 * R-CRIT (方案 b) — flatten the delivery targets declared by the run's planned
 * steps (steps_json expectedOutputs). Steps are deduped by id with the terminal
 * projectionPatch winning over the stored row (same P0-3 precedence as the task
 * facts), then each step's expectedOutputs are appended in step order. Empty →
 * c1 is left UNCHANGED (its pre-P1 steps_complete verdict), NOT converted and NOT
 * marked NA (the monotonic boundary — NA would fail-open; see resolveCriteria).
 */
export function deriveCoverageTargets(
  projection: TaskProjectionRecord,
  projectionPatch?: Record<string, unknown> | null
): string[] {
  const targets: string[] = []
  const seen = new Set<string>()
  const absorbTargets = (value: unknown): void => {
    if (!Array.isArray(value)) return
    for (const raw of value) {
      const target = normalizeDeliveryTarget(raw)
      if (!target || seen.has(target)) continue
      seen.add(target)
      targets.push(target)
    }
  }
  absorbTargets(projection.expectedOutputs)
  absorbTargets(projectionPatch?.expectedOutputs)

  const byId = new Map<string, Record<string, unknown>>()
  const order: string[] = []
  const absorb = (steps: unknown): void => {
    if (!Array.isArray(steps)) return
    for (const step of steps) {
      if (!step || typeof step !== 'object') continue
      const id = String((step as { id?: unknown }).id || '')
      if (!id) continue
      if (!byId.has(id)) order.push(id)
      byId.set(id, step as Record<string, unknown>) // patch (absorbed second) wins
    }
  }
  absorb(projection.steps)
  absorb(projectionPatch?.steps)
  for (const id of order) {
    absorbTargets(byId.get(id)?.expectedOutputs)
  }
  return targets
}

function hasDocumentDeliveryProof(proofRefs: ReadonlyArray<unknown>): boolean {
  const deliveredDocumentPaths = new Set<string>()
  const artifactPaths = new Set<string>()
  for (const row of proofRefs) {
    if (!row || typeof row !== 'object') continue
    const record = row as Record<string, unknown>
    const ref = typeof record.ref === 'string' ? record.ref : ''
    if (record.kind === 'tool_result' && ref.startsWith('document_save_tab:')) {
      const path = ref.slice('document_save_tab:'.length).trim()
      if (path) deliveredDocumentPaths.add(path)
    }
    if (record.kind === 'artifact' && ref) artifactPaths.add(ref)
  }
  return [...deliveredDocumentPaths].some((path) => artifactPaths.has(path))
}

/** P0-3 — the row in task_projections may still carry first-build defaults.
 *  A terminal direct-answer patch first rebinds a stale bootstrap budget;
 *  explicit non-bootstrap runtimes remain authoritative so evidence-bearing
 *  task types cannot be downgraded. Both beat the stale projection row. */
function resolveEffectiveTaskFacts(
  outcome: RunOutcome,
  deps: RunFinalizerDeps
): EffectiveTaskFacts {
  const patch = outcome.projectionPatch as
    | {
        taskType?: unknown
        module?: unknown
        skillExecutionForm?: unknown
        browserCollectionRequired?: unknown
      }
    | null
    | undefined
  let rowTaskType: string | null = null
  let rowModule: string | null = null
  if (deps.taskProjectionStore && outcome.taskId) {
    try {
      const row = deps.taskProjectionStore.get(outcome.taskId)
      rowTaskType = row?.taskType ?? null
      rowModule = row?.module ?? null
    } catch {
      /* silent-catch: facts degrade to patch-only */
    }
  }
  const patchTaskType =
    typeof patch?.taskType === 'string' && patch.taskType ? patch.taskType : null
  const budgetTaskType = outcome.taskBudgetRuntime?.taskType || null
  const taskType = budgetTaskType || patchTaskType || rowTaskType || null
  const taskTypeSource = budgetTaskType
    ? 'budget_runtime'
    : patchTaskType
      ? 'projection_patch'
      : rowTaskType
        ? 'projection_row'
        : 'missing'
  return {
    taskType,
    taskTypeSource,
    module: typeof patch?.module === 'string' && patch.module ? patch.module : rowModule,
    skillExecutionForm: normalizeSkillExecutionForm(patch?.skillExecutionForm),
    browserCollectionRequired: typeof patch?.browserCollectionRequired === 'boolean'
      ? patch.browserCollectionRequired
      : null
  }
}

async function writeTerminalOutcome(
  outcome: RunOutcome,
  deps: RunFinalizerDeps,
  status: RunMetaTerminalStatus,
  terminalReason: string
): Promise<FinalizedRunOutcome> {
  const facts = resolveEffectiveTaskFacts(outcome, deps)
  const deliveryState = (() => {
    const candidate = outcome.projectionPatch?.deliveryState
    if (candidate !== undefined) {
      assertDeliveryState(candidate)
      return candidate
    }
    if (!deps.taskProjectionStore || !outcome.taskId) return null
    return deps.taskProjectionStore.get(outcome.taskId)?.deliveryState ?? null
  })()
  const deliveryBlocker = status === 'done'
    ? resolveDynamicDeliveryFinalizerBlocker(deliveryState)
    : null
  const deliveryAccepted = Boolean(
    deliveryState
    && deliveryState.decision !== 'single_path'
    && deliveryState.verifier.status === 'accepted'
  )
  const handoffSuperseded = (() => {
    if (!deps.taskProjectionStore || !outcome.taskId) return false
    const projection = deps.taskProjectionStore.get(outcome.taskId)
    const continuation = projection?.continuationRef
    if (!continuation || typeof continuation !== 'object') return false
    const ref = continuation as Record<string, unknown>
    return ref.kind === 'handoff_takeover' && ref.priorRunId === outcome.runId
  })()
  const adjudication = handoffSuperseded || deliveryBlocker || status === 'checkpoint'
    ? null
    : recordTerminalAdjudication(outcome, deps, status, terminalReason, facts)
  let effectiveStatus: RunMetaTerminalStatus = status
  let effectiveTerminalReason = terminalReason
  if (deliveryBlocker) {
    effectiveStatus = 'error'
    effectiveTerminalReason = deliveryBlocker
  }
  if (!deliveryBlocker && !handoffSuperseded && status === 'done' && !adjudication && isBrowserTransactionTask(facts)) {
    effectiveStatus = 'error'
    effectiveTerminalReason = 'browser_transaction_unconfirmed'
  }
  if (
    !deliveryBlocker
    && !deliveryAccepted
    && !handoffSuperseded
    && status === 'done'
    && adjudication
    && adjudication.verdict !== 'accept'
  ) {
    const taskContinuation = continuationFromProjectionPatch(outcome.projectionPatch)
    if (isBrowserTransactionTask(facts)) {
      effectiveStatus = 'error'
      effectiveTerminalReason = resolveTerminalFailureReason(
        outcome.projectionPatch,
        adjudication,
        facts
      )
    } else if (canResumeAsUserPoint(taskContinuation)) {
      effectiveStatus = 'checkpoint'
      effectiveTerminalReason = 'checkpoint_budget'
    } else if (
      !(facts.taskType === 'research' && outcome.toolCallsUsed === 0)
      && canKeepProofBearingDegradedVisible(adjudication, outcome.projectionPatch, facts)
    ) {
      // P1: a run that DID satisfy part of its criteria stays
      // 'done' with a visible degraded reason — does not force-fail the run.
      // Proofs that satisfy no criteria are hard-converted in this mode.
      effectiveTerminalReason = 'adjudication_degraded'
    } else {
      effectiveStatus = 'error'
      effectiveTerminalReason = resolveTerminalFailureReason(
        outcome.projectionPatch,
        adjudication,
        facts
      )
    }
  }
  // P1 fix (2026-07-03, live regression) — a browser_transaction run that is
  // finalized DIRECTLY as kind:'error' (not via the done→adjudication path
  // above) previously kept a generic `proof_gap`/`adjudication_degraded`
  // reason, so the publish task surfaced as a hard "失败" instead of the
  // recoverable "网页操作还没有成功证据，可以继续". The ledger showed
  // browser_transaction + proof_gap rows for exactly this path. Normalize any
  // generic completion-evidence gap on a browser transaction to the
  // recoverable unconfirmed reason, regardless of which path set it.
  if (
    isBrowserTransactionTask(facts) &&
    effectiveStatus === 'error' &&
    (effectiveTerminalReason === 'proof_gap' || effectiveTerminalReason === 'adjudication_degraded')
  ) {
    effectiveTerminalReason = 'browser_transaction_unconfirmed'
  }
  let canonicalReceipt: CanonicalAssistantMessageReceipt | undefined = outcome.canonicalMessageReceipt || undefined
  const completionVerifierReceipt: BrowserWorkflowCompletionVerifierReceipt | null =
    outcome.workflowVerifierAcceptance
    && adjudication?.terminalQualityPatch
    && outcome.taskId
      ? {
          ...outcome.workflowVerifierAcceptance,
          parentTaskId: outcome.taskId,
          ownerRunId: outcome.runId,
          terminalQualityPatchDigest: workflowDigest(adjudication.terminalQualityPatch),
        }
      : null
  if (
    deps.commitCanonicalCoreCloseout
    && outcome.taskId
    && outcome.scopeId
    && effectiveStatus !== 'checkpoint'
    && typeof outcome.finalText === 'string'
    && outcome.finalText.trim()
  ) {
    canonicalReceipt = await deps.commitCanonicalCoreCloseout({
      parentTaskId: outcome.taskId,
      ownerRunId: outcome.runId,
      status: effectiveStatus === 'done'
        ? 'done'
        : effectiveStatus === 'cancelled'
          ? 'cancelled'
          : effectiveStatus === 'interrupted'
            ? 'interrupted'
            : 'error',
      terminalReason: effectiveTerminalReason,
      initiator: outcome.initiator,
      durationMs: outcome.durationMs,
      finalText: outcome.finalText,
      conversationId: outcome.scopeId,
      taskType: facts.taskType,
      module: facts.module,
      budget: terminalTaskBudgetSnapshot(outcome.taskBudgetRuntime),
      budgetUsagePercent: outcome.taskBudgetRuntime
        ? getBudgetUsagePercent(outcome.taskBudgetRuntime)
        : null,
      budgetWarningLevel: outcome.taskBudgetRuntime?.warningLevel ?? null,
      providerDiagnostics: outcome.providerDiagnostics
        ? { ...outcome.providerDiagnostics }
        : null,
      usage: outcome.usage || null,
      deliveryState,
      workflowCloseoutSeal: outcome.workflowCloseoutSeal || null,
      terminalQualityPatch: adjudication?.terminalQualityPatch || null,
      completionVerifierReceipt,
    })
  } else {
    writeRunMetaOutcome(outcome, deps, effectiveStatus, effectiveTerminalReason, facts)
  }
  if (adjudication) {
    runTerminalAdjudicationDerivedEffects({
      adjudication,
      deps,
      outcome,
      terminalStatus: effectiveStatus,
      terminalReason: effectiveTerminalReason,
    })
  }
  if (!handoffSuperseded && deps.writeProjectionTerminalPatch) {
    const terminalProjectionPatch = facts.taskType
      ? { ...(outcome.projectionPatch || {}), taskType: facts.taskType }
      : outcome.projectionPatch || null
    await deps.writeProjectionTerminalPatch(
      terminalProjectionPatch,
      effectiveTerminalReason,
      effectiveStatus,
      canonicalReceipt,
    )
  }
  deps.writeRunCloseMetric({
    ...toRunCloseMetric(outcome, effectiveTerminalReason),
    taskType: facts.taskType
  })
  return {
    status: effectiveStatus,
    terminalReason: effectiveTerminalReason,
    ...(canonicalReceipt || {}),
  }
}

function readTerminalFailureReason(value: unknown): TerminalFailureReason | null {
  return typeof value === 'string' && TERMINAL_FAILURE_REASONS.has(value as TerminalFailureReason)
    ? (value as TerminalFailureReason)
    : null
}

function resolveTerminalFailureReason(
  projectionPatch: Record<string, unknown> | null | undefined,
  adjudication: TerminalAdjudicationDecision,
  facts?: EffectiveTaskFacts | null
): TerminalFailureReason {
  const directReason = readTerminalFailureReason(projectionPatch?.terminalFailureReason)
  if (directReason) return directReason

  const terminalFailure = projectionPatch?.terminalFailure
  if (terminalFailure && typeof terminalFailure === 'object') {
    const nestedReason = readTerminalFailureReason(
      (terminalFailure as Record<string, unknown>).reason
    )
    if (nestedReason) return nestedReason
  }

  // Distinguish the two failure shapes for observability (P2): a genuine
  // zero-proof done → `proof_gap` (缺少完成证据); a run that DID produce proofs
  // but failed acceptance criteria → `adjudication_degraded` (完成判定未通过).
  // Conflating both as proof_gap hid the real cause (a degraded run looks like
  // "no evidence" when it actually had evidence but unmet criteria).
  if (adjudication.blockers.includes('zero_proof_done') || adjudication.proofCount === 0) {
    if (isBrowserTransactionTask(facts)) return 'browser_transaction_unconfirmed'
    return 'proof_gap'
  }
  if (
    isBrowserTransactionTask(facts) ||
    adjudication.blockers.includes('criteria_unsatisfied:t1')
  ) {
    return 'browser_transaction_unconfirmed'
  }
  return 'adjudication_degraded'
}

function continuationFromProjectionPatch(
  projectionPatch: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  const taskContinuation = projectionPatch?.taskContinuation
  if (taskContinuation && typeof taskContinuation === 'object')
    return taskContinuation as Record<string, unknown>
  const continuationRef = projectionPatch?.continuationRef
  if (continuationRef && typeof continuationRef === 'object')
    return continuationRef as Record<string, unknown>
  return null
}

function terminalTaskBudgetSnapshot(runtime: TaskBudgetRuntime | null | undefined): TaskBudget | null {
  if (!runtime) return null
  return {
    taskType: runtime.taskType,
    ...runtime.budget,
    ...runtime.usage,
    stepBudget: runtime.stepBudget ? { ...runtime.stepBudget } : null,
    frozen: runtime.frozen,
    bootstrapBudget: runtime.bootstrapBudget,
  }
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
  facts?: EffectiveTaskFacts
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
    const finalText =
      outcome.kind === 'done' || outcome.kind === 'checkpoint' ? outcome.finalText : null
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
      ...handleArtifactPaths.map((path) => collectArtifactProof(path, now, outcome.runId))
    ]
    const proofRefs = seededProofs.length
      ? appendProofRefs(projection.proofRefs ?? [], seededProofs)
      : Array.isArray(projection.proofRefs)
        ? projection.proofRefs
        : []

    // ② verdict SECOND, judging the refreshed proof set with the EFFECTIVE
    // task facts (terminal patch wins over the stale row — P0-3)
    const effectiveTaskType = (facts?.taskType ?? projection.taskType) as TaskType
    const effectiveModule = String(facts?.module ?? projection.module ?? 'system')
    // A skill run is child-bearing (and so genuinely owes s1) when it carries a
    // run_state handle the finalizer can verify — runStatePath / childRunId /
    // detachedTaskId. Primitive-only runs (no handle) get s1 exempted upstream.
    const skillHasRunStateHandle =
      Boolean(runStatePath) ||
      Boolean(handleString('childRunId')) ||
      Boolean(handleString('detachedTaskId'))
    const criteria = resolveCriteria(effectiveTaskType, effectiveModule, {
      skillExecutionForm: facts?.skillExecutionForm ?? null,
      skillHasRunStateHandle,
      hasPlannedSteps: hasPlannedStepsRequiringProof(projection, outcome.projectionPatch),
      hasStepCompletionProof: hasProofKind(proofRefs, new Set(['run_state', 'task_event'])),
      hasDocumentDeliveryProof: hasDocumentDeliveryProof(proofRefs),
      browserCollectionRequired: effectiveModule === 'browser'
        ? facts?.browserCollectionRequired === true
        : undefined,
      coverageTargets: deriveCoverageTargets(projection, outcome.projectionPatch)
    })
    // D4 — 模型经 declare_completion_criteria 声明的补充标准并入裁决：
    // m1/m2 命名空间追加在模板项之后，模板不可被覆盖（appendModelCriteria 合同）。
    const declaredModelCriteria = Array.isArray(projection.modelCriteria)
      ? projection.modelCriteria.filter(
          (text): text is string => typeof text === 'string' && text.trim().length > 0
        )
      : []
    const criteriaItems =
      declaredModelCriteria.length > 0
        ? appendModelCriteria(criteria.items,
            declaredModelCriteria.map((text) => ({ text }))
          )
        : criteria.items
    if (declaredModelCriteria.length > 0) {
      logAgentMetric('model_criteria_merged', {
        taskId: outcome.taskId,
        templateCount: criteria.items.length,
        modelCount: declaredModelCriteria.length
      })
    }
    // P2-5 — derive durable LEARNING refs from the verified proof set. These
    // are the run's persistent evidence (artifacts on disk, confirmed
    // transactions, run-state/task-event outcomes) that the specialist
    // task-evolution pipeline drafts proposals from. It was previously never
    // written, so `projection.learningRefs` stayed empty and every proposal
    // skipped `missing_learning_refs` — the growth loop never fired.
    const learningRefs = deriveLearningRefs(proofRefs)
    const { verdict, checkIn, criteriaResolutions } = adjudicateTerminalOutcome({
      terminalStatus: status,
      terminalReason,
      criteria: criteriaItems,
      proofs: proofRefs,
      learningRefs,
      mode: 'enforce',
      now
    })
    // R-CRIT (方案 b) — surface how the skill-primitive completion criterion
    // resolved: coverage_count (delivered/expected) when targets were declared,
    // else na when c1 was exempted for lack of a run_state handle + targets.
    if (effectiveModule === 'skill') {
      const coverageResolution = criteriaResolutions.find(
        (resolution) => resolution.kind === 'delivery_coverage'
      )
      const c1Item = criteria.items.find((item) => item.id === 'c1')
      if (coverageResolution) {
        logAgentMetric('adjudicator_criteria_resolved', {
          runId: outcome.runId,
          taskId,
          item: coverageResolution.id,
          module: 'skill',
          mode: 'coverage_count',
          delivered: coverageResolution.coverage?.delivered ?? 0,
          expected: coverageResolution.coverage?.expected ?? 0,
          satisfied: coverageResolution.satisfied
        })
      } else if (c1Item?.notApplicable) {
        logAgentMetric('adjudicator_criteria_resolved', {
          runId: outcome.runId,
          taskId,
          item: 'c1',
          module: 'skill',
          mode: 'na'
        })
      }
    }

    // ③ CheckIn + proofs + learning refs land on the projection — lifecycle
    //    fields untouched. Only write learningRefs when the run actually learned
    //    (accept + durable evidence); otherwise leave the column null so a
    //    downstream degrade/retry doesn't inherit stale learning evidence.
    const adjudicationPatch: Partial<TaskProjectionRecord> = {
        proofRefs,
        checkins: appendCheckIns(projection.checkins ?? [], checkIn),
        // P2-2 — persist the resolved acceptance criteria (previously computed for
        // adjudication + logged in the divergence metric, but never stored). This
        // makes the criteria the run was judged against observable on the
        // projection and gives the daily-task-index criteriaProgress a data source.
        criteria: {
          items: criteria.items,
          satisfiedCount: checkIn.satisfiedCount,
          totalCount: checkIn.totalCount
        },
        ...(checkIn.learningDecision?.learned ? { learningRefs } : {})
      }
    // ④ divergence metric when the verdict disagrees with the actual terminal
    if (status === 'done' && verdict !== 'accept') {
      const divergencePayload = {
        runId: outcome.runId,
        taskId,
        taskType: facts?.taskType ?? projection.taskType,
        verdict,
        actualStatus: status,
        terminalReason,
        proofCount: checkIn.proofCount,
        blockers: checkIn.blockers
      }
      logAgentMetric('adjudicator_enforce_divergence', divergencePayload)
      logAgentMetric('adjudicator_shadow_divergence', { ...divergencePayload, compatibility: true })
    }
    return {
      verdict,
      blockers: checkIn.blockers,
      proofCount: checkIn.proofCount,
      satisfiedCount: checkIn.satisfiedCount,
      derived: {
        checkIn,
        projection,
        now,
        projectionPatch: adjudicationPatch,
        persistProjectionPatch: !projection.requestAnchor,
      },
      ...(projection.requestAnchor
        ? {
            terminalQualityPatch: {
              proofRefs,
              checkins: appendCheckIns(projection.checkins ?? [], checkIn),
              criteria: {
                items: criteria.items,
                satisfiedCount: checkIn.satisfiedCount,
                totalCount: checkIn.totalCount,
              },
              ...(checkIn.learningDecision?.learned ? { learningRefs } : {}),
            },
          }
        : {}),
    }
  } catch (error) {
    logAgentMetric('adjudication_failed', {
      runId: outcome.runId,
      taskId,
      reason: error instanceof Error ? error.message : String(error)
    })
    return null
  }
}

function runTerminalAdjudicationDerivedEffects(input: {
  adjudication: TerminalAdjudicationDecision
  deps: RunFinalizerDeps
  outcome: RunOutcome
  terminalStatus: RunMetaTerminalStatus
  terminalReason: string
}): void {
  const { adjudication, deps, outcome, terminalStatus, terminalReason } = input
  const taskId = outcome.taskId
  if (!taskId) return
  if (adjudication.derived.persistProjectionPatch && deps.taskProjectionStore) {
    try {
      deps.taskProjectionStore.update(
        taskId,
        adjudication.derived.projectionPatch,
        { silent: true, reasonHint: 'terminal_adjudication' },
      )
    } catch (error) {
      logAgentMetric('terminal_adjudication_projection_repair_failed', {
        runId: outcome.runId,
        taskId,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }
  if (
    terminalStatus !== 'done'
    || adjudication.verdict !== 'accept'
    || !adjudication.derived.checkIn.learningDecision?.learned
    || !deps.learnFromCheckIn
  ) return
  try {
    deps.learnFromCheckIn({
      checkIn: adjudication.derived.checkIn,
      projection: adjudication.derived.projection,
      now: adjudication.derived.now,
      terminalStatus,
      terminalReason,
    })
  } catch (error) {
    logAgentMetric('site_card_learning_checkin_failed', {
      runId: outcome.runId,
      taskId,
      reason: error instanceof Error ? error.message : String(error),
    })
  }
}

function writeRunMetaOutcome(
  outcome: RunOutcome,
  deps: RunFinalizerDeps,
  status: RunMetaTerminalStatus,
  terminalReason: string,
  facts?: EffectiveTaskFacts | null
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
    durationMs: outcome.durationMs
  }
  // run_meta 行内 task_type 必须与同行写入的 budget 同源——两者都来自实际
  // 管辖本 run 的 budget runtime（显式传入或 checkpoint 续跑恢复），否则
  // research 档预算配 direct_answer 类型的自相矛盾行会落库；facts 的推断
  // patch 只在没有 budget runtime 时兜底。taskTypeSource:'missing' 一律
  // 降级为不写（EP2-T1 07 §1.3）：stamping null 会经 spread-merge 清掉旧值。
  const closeoutTaskType = taskBudgetRuntime?.taskType || facts?.taskType || null
  if (closeoutTaskType) {
    patch.taskType = closeoutTaskType
  }
  if (taskBudgetRuntime) {
    patch.budget = {
      ...taskBudgetRuntime.budget,
      ...taskBudgetRuntime.usage
    }
  }
  const usageDiagnostics = usage && typeof usage === 'object'
    ? {
      usageSource: (usage as RunOutcomeUsage & { usageSource?: 'provider' | 'estimated' | 'missing' }).usageSource,
      providerCallCount: (usage as RunOutcomeUsage & { providerCallCount?: number }).providerCallCount,
      missingCallCount: (usage as RunOutcomeUsage & { missingCallCount?: number }).missingCallCount,
    }
    : null
  const persistedProviderDiagnostics = providerDiagnostics || usageDiagnostics
    ? { ...(providerDiagnostics || {}), ...(usageDiagnostics || {}) }
    : null
  if (providerDiagnostics) {
    patch.providerProtocol = providerDiagnostics.agentProtocol || null
    patch.wireApi = providerDiagnostics.wireApi || null
    patch.contextWindow = providerDiagnostics.contextWindow || null
  }
  if (persistedProviderDiagnostics) patch.providerDiagnostics = persistedProviderDiagnostics
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

function toRunCloseMetric(outcome: RunOutcome, terminalReason: string): RunCloseMetric {
  const metric: RunCloseMetric = {
    runId: outcome.runId,
    terminalReason,
    initiator: outcome.initiator,
    toolCallsUsed: outcome.toolCallsUsed,
    durationMs: outcome.durationMs,
  }
  if (outcome.providerDiagnostics?.lastProviderFailureHttpStatus !== undefined) {
    metric.lastProviderFailureHttpStatus = outcome.providerDiagnostics.lastProviderFailureHttpStatus
  }
  if (outcome.providerDiagnostics?.lastProviderFailureErrorKind !== undefined) {
    metric.lastProviderFailureErrorKind = outcome.providerDiagnostics.lastProviderFailureErrorKind
  }
  return metric
}

function isValidContinuationHandle(handle: string | null): handle is string {
  return typeof handle === 'string' && handle.trim().length > 0
}

function requiresCheckpointContinuationHandle(terminalReason?: string | null): boolean {
  return terminalReason !== 'checkpoint_user_input' && terminalReason !== 'manual_suspend'
}
