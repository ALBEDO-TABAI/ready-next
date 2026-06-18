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

export interface CriteriaItem {
  id: string
  text: string
  kind: CriteriaKind
  source: 'template' | 'model'
  notApplicable?: { reason: string }
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
    item('c1', 'artifact', '产出报告文件'),
    item('c2', 'report_sources', '报告含足够数量的来源 ref'),
  ],
  media_task: [
    item('c1', 'media_file', '媒体产物文件存在且可打开'),
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
  options?: { skillExecutionForm?: SkillExecutionForm | null },
): ResolvedCriteria {
  const base = BASE_TEMPLATES[taskType] ?? BASE_TEMPLATES.short_task
  const overlay = OVERLAY_TEMPLATES[module] ?? []
  const items = [...base, ...overlay].map((entry) => ({ ...entry }))
  const resolvedItems = module === 'skill' && options?.skillExecutionForm === 'direct'
    ? items.map((entry) => entry.id === 's1'
      ? markNotApplicable(entry, 'direct skill 交付即 tool_result，无 run_state/delivery_report')
      : entry)
    : items
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
