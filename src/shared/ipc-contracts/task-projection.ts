/**
 * Stage U PR U4.1b–c — wire contracts for task-projection IPC payloads.
 *
 * Canonical home for renderer-facing task-projection types. Renderer
 * consumes these via `electronAPI.agent.listTaskProjections` /
 * `getTaskProjection` and the `agent:taskProjectionsChanged` push event.
 *
 * Sub-type policy (U4.1c):
 *   - TaskType / TaskInteractionState / TaskStep / TaskStepChildTask /
 *     TaskBudget / StepBudgetState / BudgetWarningLevel / RecoveryRecord /
 *     UnifiedTaskState — fully defined here (wire is canonical).
 *   - ScopeRun* sub-fields on TaskProjectionRecord (waitingFor /
 *     resumableActions / continuationRef / progress / recentArtifacts) —
 *     declared with permissive wire types so this module stays free of
 *     any `src/main/` import. Main-side callsites that need strict types
 *     narrow them via `as ScopeRun*`. Follow-up: collapse the ScopeRun
 *     family into a sibling wire module if the cast surface grows.
 */

import type { TaskType as SharedTaskType } from '../task-types'
import type { SkillChildRunStatus } from '../skill-child-run-status'

// ---------- task-type aliases ----------

export type TaskType = SharedTaskType

export type TaskInteractionState =
  | 'running'
  | 'awaiting_clarification'
  | 'awaiting_confirmation'
  | 'human_takeover'
  | 'suspended'
  | 'resuming'
  | 'check_in_pending'

export type TaskProjectionStatus = SkillChildRunStatus

// ---------- step + budget sub-shapes ----------

/**
 * Combined union of every TaskStep status the renderer can observe.
 * Main internal types narrow this further (ScopeRunTaskStepStatus has
 * 'running'/'blocked'/'error'; TaskStepStatus has 'in_progress'/
 * 'skipped'/'cancelled') — wire accepts the full superset so neither
 * branch fails serialization.
 */
export type TaskStepStatus =
  | 'pending'
  | 'in_progress'
  | 'running'
  | 'done'
  | 'blocked'
  | 'error'
  | 'failed'
  | 'skipped'
  | 'cancelled'

export interface TaskStepChildTask {
  taskId: string
  taskType: TaskType
  status: TaskProjectionStatus
  summary?: string | null
  artifactSummary?: string | null
  updatedAt?: string | null
}

export interface TaskStep {
  id: string
  description: string
  title?: string
  status?: TaskStepStatus
  detail?: string | null
  updatedAt?: string
  toolHints?: string[]
  budget?: number
  dependsOn?: string[]
  childTasks?: TaskStepChildTask[]
  /** R-CRIT (方案 b) — delivery targets this step promises to produce; the
   *  terminal adjudicator counts delivered-artifact coverage against them.
   *  Renderer-facing serialization superset — kept in sync with the runtime
   *  `run-contracts.ts` TaskStep. */
  expectedOutputs?: string[]
}

export interface StepBudgetState {
  stepId?: string | null
  maxIterations: number
  remainingIterations: number
}

export interface TaskBudget {
  taskType: TaskType
  maxIterations: number
  maxToolCalls: number
  maxParallelToolGroups: number
  reservedToolCalls?: number
  iterationsUsed?: number
  toolCallsUsed?: number
  parallelToolGroupsUsed?: number
  frozen?: boolean
  bootstrapBudget?: boolean
  stepBudget?: {
    stepId?: string | null
    maxIterations: number
    remainingIterations?: number
  } | null
}

export type BudgetWarningLevel = 'none' | 'warning' | 'converge' | 'exhausted'

// ---------- recovery + unified state ----------

export type RecoveryRecordKind =
  | 'rate_limit'
  | 'context_overflow'
  | 'timeout_model'
  | 'timeout_tool'
  | 'auth'
  | 'transient'
  | 'host_unavailable'

export type RecoveryRecordSource = 'model_request' | 'tool_execution' | 'runtime'

export interface RecoveryRecord {
  kind: RecoveryRecordKind
  source: RecoveryRecordSource
  message: string
  attempt: number
  recovered: boolean
  timestamp: string
}

// ---------- task projection record (wire canonical) ----------

export interface TaskProjectionRecord {
  taskId: string
  scopeId: string
  runId: string
  parentTaskId?: string | null
  parentStepId?: string | null
  taskType: TaskType
  module: string
  taskTitle?: string | null
  taskSummary?: string | null
  status: TaskProjectionStatus
  interactionState: TaskInteractionState
  /** Main owns the stricter ScopeRunWaitingFor union — wire keeps a
   *  permissive placeholder so the wire module has no `src/main/` deps. */
  waitingFor?: unknown
  steps: TaskStep[]
  currentStepId?: string | null
  budget?: TaskBudget | null
  budgetUsagePercent?: number | null
  budgetWarningLevel?: BudgetWarningLevel | null
  recoveryHistory?: RecoveryRecord[]
  degradationReason?: string | null
  blockedReason?: string | null
  resumableActions?: unknown[]
  continuationRef?: unknown
  progress?: unknown
  recentArtifacts?: unknown[]
  /**
   * Stage Q (Stage 11) — derived-at-read truth from main side. Renderer
   * must consume directly and NOT recompute from resumableActions /
   * taskRunId / interactionState (Stage Q audit §C-9 / contract C7).
   * Defensive default: when undefined or false, treat as not resumable.
   */
  canResume?: boolean
  /** EP2-Q1 — quality fields (wire keeps permissive shapes; main owns schemas). */
  criteria?: Record<string, unknown> | null
  checkins?: unknown[] | null
  proofRefs?: unknown[] | null
  learningRefs?: unknown[] | null
  /** EP3-A1 — task owner agent (read-only on the wire; A4 writes). */
  ownerAgentId?: string | null
  /** D4 — 模型经 declare_completion_criteria 声明的补充验收标准（整组替换写入；
   *  finalizer 终态经 appendModelCriteria 并入裁决，renderer 只读不派生）。 */
  modelCriteria?: string[] | null
  /** R-CRIT-P — 模型声明的最终文件目标（整组替换）；代码在终态按交付证据计数。 */
  expectedOutputs?: string[] | null
  /** EP3-PK1 — packet marker (parent|child|null) + reference list. */
  packetRole?: 'parent' | 'child' | null
  contextRefs?: string[] | null
  createdAt: string
  updatedAt: string
}

export interface UnifiedTaskState {
  taskId: string
  runId?: string | null
  scopeId?: string | null
  taskType: TaskType
  status: TaskProjectionStatus
  interactionState: TaskInteractionState
  waitingFor: unknown
  steps: TaskStep[]
  currentStepId?: string | null
  budget?: TaskBudget | null
  budgetUsagePercent?: number | null
  recoveryHistory?: RecoveryRecord[]
}

// ---------- change event (U4.1b) ----------

export type TaskProjectionChangeReason = 'create' | 'update' | 'delete' | 'supersede'

export interface TaskProjectionChangeEvent {
  scopeId: string
  changedTaskIds: string[]
  reason: TaskProjectionChangeReason
}
