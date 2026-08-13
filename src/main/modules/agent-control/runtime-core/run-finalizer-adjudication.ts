import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { logAgentMetric } from '../metrics'
import { collectResponseDigestProof, collectRunStateProof, collectArtifactProof, appendProofRefs } from '../quality/proof-collector'
import { parseRunStateJson } from '../task-projection/run-state-schema'
import { adjudicateTerminalOutcome, appendCheckIns } from '../quality/task-adjudicator'
import { appendModelCriteria, resolveCriteria } from '../quality/criteria-templates'
import type { TaskType } from '../../../../shared/task-types'
import type { RunMetaTerminalStatus } from '../../../../shared/run-meta-terminal-status'
import type { TaskBudget, TaskBudgetRuntime, TaskProjectionRecord } from '../contracts/run-contracts'
import type { DeliveryStateV1 } from '../../../../shared/dynamic-delivery'
import type { RunFinalizerDeps, RunOutcome, TerminalAdjudicationDecision } from './run-finalizer-contracts'
import { deriveCoverageTargets, deriveLearningRefs, hasDocumentDeliveryProof, hasPlannedStepsRequiringProof, hasProofKind, isBrowserTransactionTask, type EffectiveTaskFacts } from './run-finalizer-task-facts'

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

export function readExistingTerminalQualityPatch(
  projection: TaskProjectionRecord,
): NonNullable<TerminalAdjudicationDecision['terminalQualityPatch']> {
  return {
    proofRefs: projection.proofRefs ?? [],
    checkins: projection.checkins ?? [],
    criteria: projection.criteria ?? { items: [], satisfiedCount: 0, totalCount: 0 },
    ...(projection.learningRefs?.length ? { learningRefs: projection.learningRefs } : {}),
  }
}

export type TerminalFailureReason =
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

export function canKeepProofBearingDegradedVisible(
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

function readTerminalFailureReason(value: unknown): TerminalFailureReason | null {
  return typeof value === 'string' && TERMINAL_FAILURE_REASONS.has(value as TerminalFailureReason)
    ? (value as TerminalFailureReason)
    : null
}

export function resolveTerminalFailureReason(
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

export function continuationFromProjectionPatch(
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

export function terminalTaskBudgetSnapshot(runtime: TaskBudgetRuntime | null | undefined): TaskBudget | null {
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
export function recordTerminalAdjudication(
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

export function runTerminalAdjudicationDerivedEffects(input: {
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
