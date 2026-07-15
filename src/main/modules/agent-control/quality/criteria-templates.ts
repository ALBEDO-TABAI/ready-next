/**
 * EP2-Q2 — criteria template engine (02 §3.2).
 *
 * Two-dimensional lookup: every task gets a code-owned base template by
 * task_type, plus an overlay when its module carries domain criteria
 * (browser collection / skill child run / document edit). The model may
 * APPEND task-specific criteria at planning time (C4.2a) — it can never
 * delete or override template items, and dropping a criteria item requires
 * an explicit not_applicable reason.
 *
 * Key discipline: base keys are derived from the HEAD TASK_TYPES enum at
 * module load; a drift between this table and the enum fails the matrix
 * test (模板键错配 = 框架落空).
 */

import { TASK_TYPES, type TaskType } from '../../../../shared/task-types'

export type CriteriaKind =
  | 'response_digest'
  | 'tool_call'
  | 'steps_complete'
  | 'artifact'
  | 'report_sources'
  | 'media_file'
  | 'collection_verdict'
  | 'result_parseable'
  | 'skill_run_state'
  | 'document_diff'
  | 'scope_compliance'
  | 'transaction_confirmed'
  // R-CRIT (方案 b) — count how many declared delivery targets are backed by a
  // delivered artifact proof (one-to-one). Replaces c1(steps_complete) ONLY for
  // skill-primitive multi_step/continuation runs that declared expected outputs,
  // so complete delivery is no longer a proof-kind false-negative AND
  // under-delivery still fails (a single artifact can't satisfy two targets).
  | 'delivery_coverage'

export interface CriteriaItem {
  id: string
  text: string
  kind: CriteriaKind
  source: 'template' | 'model'
  notApplicable?: { reason: string }
  /** R-CRIT (方案 b) — only set on `delivery_coverage` items: the declared
   *  delivery targets the adjudicator counts delivered-artifact coverage over. */
  expected?: string[]
}

export type SkillExecutionForm = 'direct' | 'child_loop' | 'python'

export interface ResolvedCriteria {
  taskType: TaskType
  module: string
  items: CriteriaItem[]
  /** What kind of proof satisfies the zero-proof hard rule for this task. */
  proofExpectation: 'assistant_response_digest' | 'tool_or_artifact_proof'
  /** direct_answer turns that DECLARE actions get re-judged as this type (C1.2 守卫). */
  actionDeclarationReclassify?: TaskType
}

function item(id: string, kind: CriteriaKind, text: string): CriteriaItem {
  return { id, kind, text, source: 'template' }
}

/** R-CRIT (方案 b) — normalize a declared delivery target (or a delivered path)
 *  for coverage comparison: strip wrapping quotes/whitespace, unify separators,
 *  drop trailing slashes. Shared by the criteria producer-filter here and the
 *  adjudicator counter (task-adjudicator imports this) so BOTH sides agree on
 *  which targets are real — a target that normalizes empty (e.g. "/") must
 *  never create a delivery_coverage item the adjudicator then can't count.
 *
 *  IDEMPOTENT by construction (fixpoint loop): stripping a trailing slash can
 *  expose a trailing quote (and vice-versa), so a single ordered pass is NOT
 *  idempotent (`/"/` → `/"` on pass 1, then `""` on pass 2). The producer stores
 *  the result and the adjudicator re-normalizes it; a non-idempotent normalizer
 *  makes the two sites disagree on whether a token is real. Looping to a fixpoint
 *  guarantees normalize(normalize(x)) === normalize(x). */
export function normalizeDeliveryTarget(value: unknown): string {
  let text = String(value ?? '').replace(/\\/g, '/')
  let previous: string
  do {
    previous = text
    text = text.trim().replace(/^["'`]+|["'`]+$/g, '').replace(/\/+$/g, '')
  } while (text !== previous)
  return text
}

const BASE_TEMPLATES: Record<TaskType, CriteriaItem[]> = {
  // 默认免重判据（纯问答零开销）——但不是逃生门：行动宣告轮按 short_task 重判。
  direct_answer: [
    item('c1', 'response_digest', '最终回复存在且非空（assistant_response digest 即合法 proof）'),
  ],
  short_task: [
    item('c1', 'tool_call', '至少一次工具调用，或结构化声明"无需工具"（C1.2 守卫的数据化）'),
  ],
  multi_step_task: [
    item('c1', 'steps_complete', '计划内每步有完成标记或显式跳过说明（对接 C4.2a steps_json）'),
    item('c2', 'artifact', '至少一个产物或状态变更 proof'),
  ],
  continuation: [
    item('c1', 'steps_complete', '续跑步骤有完成标记或显式跳过说明'),
    item('c2', 'artifact', '至少一个产物或状态变更 proof'),
  ],
  research: [
    item('c1', 'response_digest', '向用户交付非空的研究结果或报告'),
    item('c2', 'report_sources', '结果含可核查的来源 ref'),
  ],
  media_task: [
    item('c1', 'media_file', '媒体产物文件存在且可打开'),
  ],
  browser_transaction: [
    item('t1', 'transaction_confirmed', '网页事务已由代码侧成功信号确认'),
  ],
}

const OVERLAY_TEMPLATES: Record<string, CriteriaItem[]> = {
  browser: [
    item('b1', 'collection_verdict', '采集项数达标，或空结果带 S3-2 诊断（判定矩阵事实即证据包）'),
    item('b2', 'result_parseable', '结果文件可解析'),
  ],
  skill: [
    item('s1', 'skill_run_state', 'run_state.json 终态 done 且 delivery_report 存在'),
  ],
  document: [
    item('d1', 'document_diff', '目标文档产生 diff'),
    item('d2', 'scope_compliance', '改动范围遵循用户指定'),
  ],
}

export const CRITERIA_BASE_TASK_TYPES: ReadonlyArray<TaskType> =
  Object.keys(BASE_TEMPLATES) as TaskType[]
export const CRITERIA_OVERLAY_MODULES: ReadonlyArray<string> = Object.keys(OVERLAY_TEMPLATES)

// Load-time drift guard — louder than waiting for the matrix test.
if (CRITERIA_BASE_TASK_TYPES.length !== TASK_TYPES.length
  || !TASK_TYPES.every((taskType) => taskType in BASE_TEMPLATES)) {
  throw new Error('[criteria-templates] base template keys drifted from TASK_TYPES')
}

export function resolveCriteria(
  taskType: TaskType,
  module: string,
  options?: {
    skillExecutionForm?: SkillExecutionForm | null
    skillHasRunStateHandle?: boolean
    hasPlannedSteps?: boolean
    hasStepCompletionProof?: boolean
    hasDocumentDeliveryProof?: boolean
    /** Browser observation/analysis does not owe persistent collection files. */
    browserCollectionRequired?: boolean
    /** R-CRIT (方案 b) — flattened delivery targets declared by the run's
     *  planned steps (steps_json expectedOutputs). Non-empty → c1 becomes a
     *  delivery_coverage criterion for skill-primitive runs. */
    coverageTargets?: string[]
  },
): ResolvedCriteria {
  const base = BASE_TEMPLATES[taskType] ?? BASE_TEMPLATES.short_task
  const overlay = taskType === 'browser_transaction' && module === 'browser'
    ? []
    : module === 'browser' && options?.browserCollectionRequired === false
    ? []
    : OVERLAY_TEMPLATES[module] ?? []
  const items = [...base, ...overlay].map((entry) => ({ ...entry }))
  // `s1`/skill_run_state can ONLY be satisfied by a `run_state` proof, minted
  // only when a child run actually produced run_state.json (done) +
  // delivery_report. A run is "child-bearing" — and so genuinely owes s1 — when
  // it either declares a child-run form (`child_loop`/`python`) OR carries a
  // run_state HANDLE (runStatePath/childRunId) the finalizer can verify. For a
  // run with NEITHER (a `direct` send_im, or a primitive-only run via
  // skill_run_shell/skill_write_artifact with no child run), s1 is structurally
  // unsatisfiable and would force-fail an otherwise-successful run, so it is
  // marked notApplicable; base criteria + artifact/tool_result proofs remain the
  // terminal evidence. We do NOT loosen CRITERIA_PROOF_MAP.skill_run_state — a
  // run that DID emit a handle still must verify it (an unverified handle stays
  // a real failure), so child-run contracts are not weakened.
  const skillForm = options?.skillExecutionForm ?? null
  const skillHasChildRunState = skillForm === 'child_loop' || skillForm === 'python'
    || options?.skillHasRunStateHandle === true
  const stepsStructurallyUnavailable =
    (taskType === 'multi_step_task' || taskType === 'continuation')
    && options?.hasPlannedSteps !== true
    && options?.hasStepCompletionProof !== true
    && options?.hasDocumentDeliveryProof === true
  const skillResolvedItems = module === 'skill' && !skillHasChildRunState
    ? items.map((entry) => entry.id === 's1'
      ? markNotApplicable(entry, skillForm === 'direct'
        ? 'direct skill 交付即 tool_result，无 run_state/delivery_report'
        : 'primitive skill 执行无 child run_state 句柄，artifact/tool_result 即终态证据')
      : entry)
    : items
  // R-CRIT (方案 b) — a skill-primitive multi_step/continuation run that DECLARED
  // planned steps never mints run_state/task_event, so c1(steps_complete) is a
  // structural false-negative (rejects even a complete delivery). Do NOT loosen
  // to a proof-kind any artifact can satisfy — that would re-mask under-delivery
  // (a single artifact would satisfy it while a second doc is missing).
  //
  // MONOTONIC boundary (P1 adversarial-review fix): only convert c1 when the run
  // DECLARED expected outputs — then c1 becomes a COUNTING delivery_coverage
  // criterion (one-to-one target↔artifact; under-coverage still fails, complete
  // delivery accepts). When NO targets are declared we DELIBERATELY leave c1
  // unchanged (its pre-existing steps_complete verdict), NOT NA: marking it NA
  // would drop it from the applicable set and let a single c2 artifact ACCEPT an
  // unverifiable delivery — a fail-open regression that would silently accept the
  // exact under-delivery incident this fix exists to catch. So P1 only ever
  // IMPROVES (adds discrimination when targets exist) and never regresses the
  // no-target default. Live activation awaits the deferred producer that
  // populates steps_json expectedOutputs (cross-phase per the plan).
  // Runs carrying a real run_state/task_event proof keep c1 as-is (not weakened).
  const skillPrimitiveStepsCoverable =
    module === 'skill' && !skillHasChildRunState
    && (taskType === 'multi_step_task' || taskType === 'continuation')
    && options?.hasPlannedSteps === true
    && options?.hasStepCompletionProof !== true
  const coverageTargets = Array.isArray(options?.coverageTargets)
    ? options!.coverageTargets.map(normalizeDeliveryTarget).filter(Boolean)
    : []
  const skillCoverageItems = skillPrimitiveStepsCoverable && coverageTargets.length > 0
    ? skillResolvedItems.map((entry) => (entry.id === 'c1' && entry.kind === 'steps_complete')
      ? {
        ...entry,
        kind: 'delivery_coverage' as CriteriaKind,
        text: `计划内每份预期产出都有对应的已交付 artifact（预期 ${coverageTargets.length} 份，逐一配对）`,
        expected: coverageTargets,
      }
      : entry)
    : skillResolvedItems
  const resolvedItems = stepsStructurallyUnavailable
    ? skillCoverageItems.map((entry) => entry.id === 'c1' && entry.kind === 'steps_complete'
      ? markNotApplicable(entry, '本轮无计划步骤/子任务状态来源，文档保存已由 document/artifact proof 证明')
      : entry)
    : skillCoverageItems
  return {
    taskType,
    module,
    // fresh copies — resolved sets are mutated downstream (model追加/裁决标注)
    items: resolvedItems,
    proofExpectation: taskType === 'direct_answer' ? 'assistant_response_digest' : 'tool_or_artifact_proof',
    ...(taskType === 'direct_answer' ? { actionDeclarationReclassify: 'short_task' as TaskType } : {}),
  }
}

/** Dropping a criteria item is only legal with a written reason — never silent. */
export function markNotApplicable(criteriaItem: CriteriaItem, reason: string): CriteriaItem {
  if (!reason || !reason.trim()) {
    throw new Error('[criteria-templates] not_applicable requires an explicit reason')
  }
  return { ...criteriaItem, notApplicable: { reason: reason.trim() } }
}

/**
 * Planning-stage model additions (02 §3.1): appended AFTER template items in
 * their own id namespace (m1, m2, …). Collisions with template ids cannot
 * override the template; empty texts are dropped.
 */
export function appendModelCriteria(
  templateItems: ReadonlyArray<CriteriaItem>,
  additions: ReadonlyArray<{ text: string }>,
): CriteriaItem[] {
  const out = templateItems.map((entry) => ({ ...entry }))
  let counter = 1
  for (const addition of additions) {
    const text = String(addition.text || '').trim()
    if (!text) continue
    out.push({ id: `m${counter}`, kind: 'artifact', text, source: 'model' })
    counter += 1
  }
  return out
}
