import {
  normalizeDeliveryTarget,
  type SkillExecutionForm,
} from '../quality/criteria-templates'
import type { TaskProjectionRecord } from '../contracts/run-contracts'
import type { RunFinalizerDeps, RunOutcome } from './run-finalizer-contracts'

export interface EffectiveTaskFacts {
  taskType: string | null
  taskTypeSource: 'projection_patch' | 'projection_row' | 'budget_runtime' | 'missing'
  module: string | null
  skillExecutionForm: SkillExecutionForm | null
  browserCollectionRequired: boolean | null
}

function normalizeSkillExecutionForm(value: unknown): SkillExecutionForm | null {
  return value === 'direct' || value === 'child_loop' || value === 'python' ? value : null
}

const DOCUMENT_PROGRESS_STEP_IDS = new Set(['document_create', 'document_write', 'document_save'])
const LEARNING_PROOF_KINDS: ReadonlySet<string> = new Set([
  'artifact',
  'transaction_confirmed',
  'run_state',
  'task_event'
])

function stepRequiresCompletionProof(step: unknown): boolean {
  if (!step || typeof step !== 'object') return false
  const id = String((step as { id?: unknown }).id || '')
  const status = String((step as { status?: unknown }).status || '')
  return !DOCUMENT_PROGRESS_STEP_IDS.has(id) || status !== 'done'
}

export function hasPlannedStepsRequiringProof(
  projection: TaskProjectionRecord,
  projectionPatch?: Record<string, unknown> | null
): boolean {
  const storedSteps = Array.isArray(projection.steps) ? projection.steps : []
  const patchSteps = Array.isArray(projectionPatch?.steps) ? projectionPatch.steps : []
  return [...storedSteps, ...patchSteps].some(stepRequiresCompletionProof)
}

export function hasProofKind(proofRefs: ReadonlyArray<unknown>, kinds: ReadonlySet<string>): boolean {
  return proofRefs.some((row) => row && typeof row === 'object'
    && kinds.has(String((row as Record<string, unknown>).kind || '')))
}

export function deriveLearningRefs(proofRefs: ReadonlyArray<unknown>): unknown[] {
  return proofRefs.filter((row) => {
    if (!row || typeof row !== 'object') return false
    const record = row as Record<string, unknown>
    if (LEARNING_PROOF_KINDS.has(String(record.kind || ''))) return true
    const path = record.path ?? record.relPath
    return typeof path === 'string' && path.trim().length > 0
  })
}

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
      byId.set(id, step as Record<string, unknown>)
    }
  }
  absorb(projection.steps)
  absorb(projectionPatch?.steps)
  for (const id of order) absorbTargets(byId.get(id)?.expectedOutputs)
  return targets
}

export function hasDocumentDeliveryProof(proofRefs: ReadonlyArray<unknown>): boolean {
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

export function resolveEffectiveTaskFacts(
  outcome: RunOutcome,
  deps: RunFinalizerDeps
): EffectiveTaskFacts {
  const patch = outcome.projectionPatch as {
    taskType?: unknown
    module?: unknown
    skillExecutionForm?: unknown
    browserCollectionRequired?: unknown
  } | null | undefined
  let rowTaskType: string | null = null
  let rowModule: string | null = null
  if (deps.taskProjectionStore && outcome.taskId) {
    try {
      const row = deps.taskProjectionStore.get(outcome.taskId)
      rowTaskType = row?.taskType ?? null
      rowModule = row?.module ?? null
    } catch {
      /* facts degrade to patch-only */
    }
  }
  const patchTaskType = typeof patch?.taskType === 'string' && patch.taskType ? patch.taskType : null
  const budgetTaskType = outcome.taskBudgetRuntime?.taskType || null
  const taskType = budgetTaskType || patchTaskType || rowTaskType || null
  return {
    taskType,
    taskTypeSource: budgetTaskType
      ? 'budget_runtime'
      : patchTaskType
        ? 'projection_patch'
        : rowTaskType
          ? 'projection_row'
          : 'missing',
    module: typeof patch?.module === 'string' && patch.module ? patch.module : rowModule,
    skillExecutionForm: normalizeSkillExecutionForm(patch?.skillExecutionForm),
    browserCollectionRequired: typeof patch?.browserCollectionRequired === 'boolean'
      ? patch.browserCollectionRequired
      : null
  }
}

export function isBrowserTransactionTask(facts?: EffectiveTaskFacts | null): boolean {
  return facts?.taskType === 'browser_transaction'
}

export function isStrictEvidenceTask(facts?: EffectiveTaskFacts | null): boolean {
  return facts?.taskType === 'artifact_task'
    || facts?.taskType === 'transaction_task'
    || facts?.taskType === 'research_artifact_task'
    || (facts?.taskType === 'research' && facts.module === 'skill')
}
