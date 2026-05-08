import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ScopeRunSkillProgress,
  ScopeRunResumableAction,
  ScopeRunTaskStep,
  ScopeRunWaitingFor,
} from './types'
import type { SkillTaskLifecycleReason } from './run-contracts'
import { normalizeRunStateStatus, type NormalizedRunStateStatus } from './run-state-selection'
import { getRepositoryDatabase } from '../repositories/database-accessor'
import {
  SkillTaskRunRepository,
  createSkillTaskRunId,
  type SkillTaskRunArtifact,
  type SkillTaskRunRecord,
  type SkillTaskRunStatus,
  type SkillTaskRunStep,
} from '../repositories/skill-task-run-repository'

export type SkillTaskEventStatus = 'running' | 'done' | 'blocked' | 'error'
export type SkillParentTaskLifecycleState =
  | 'background_running'
  | 'budget_paused'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'cancelled'
export type SkillParentTaskLifecycleReason = SkillTaskLifecycleReason
export type SkillTaskProjectionStatus = 'running' | 'blocked' | 'done' | 'failed' | 'cancelled'

export interface SkillTaskEvent {
  scopeId?: string
  sessionId?: string
  runId?: string | null
  agent?: string | null
  skillId?: string
  skillName?: string
  toolName: string
  action?: string
  runKind?: 'typed_action' | 'primitive' | 'detached' | 'manual' | string
  status: SkillTaskEventStatus
  message?: string
  stepId?: string
  artifactPath?: string | null
  artifactLabel?: string | null
  artifacts?: Array<{
    path: string
    label: string
    kind?: string
    meta?: Record<string, unknown>
  }>
  params?: Record<string, unknown> | null
  outputDir?: string | null
  runStatePath?: string | null
  sceneScoresPath?: string | null
  deliveryReportPath?: string | null
  failureKind?: string | null
  failureDetail?: string | null
  goalText?: string | null
  resourceRefs?: unknown[]
  jobId?: string | null
  detachedTaskId?: string | null
  resumePayload?: Record<string, unknown> | null
}

export interface SkillParentTaskLifecycleEvent {
  scopeId?: string
  sessionId?: string
  runId?: string | null
  agent?: string | null
  skillId: string
  skillName?: string
  action?: string
  state: SkillParentTaskLifecycleState
  reason: SkillParentTaskLifecycleReason
  message?: string
  stepId?: string
  outputDir?: string | null
  runStatePath?: string | null
  sceneScoresPath?: string | null
  deliveryReportPath?: string | null
  failureKind?: string | null
  failureDetail?: string | null
  goalText?: string | null
  resourceRefs?: unknown[]
  params?: Record<string, unknown> | null
  jobId?: string | null
  detachedTaskId?: string | null
  taskRunId?: string | null
  childRunId?: string | null
  progressFingerprint?: string | null
  resumePayload?: Record<string, unknown> | null
  progress?: ScopeRunSkillProgress | null
}

interface SkillTaskContinuationState {
  taskId?: string | null
  executionId?: string | null
  stepId?: string | null
  blockerType?: string | null
  todoId?: string | null
  todoTitle?: string | null
  pauseReason?: string | null
  detachedTaskId?: string | null
  taskRunId?: string | null
  jobId?: string | null
  skillId?: string | null
  action?: string | null
  runStatePath?: string | null
  outputDir?: string | null
  childRunId?: string | null
  progressFingerprint?: string | null
}

interface SkillTaskProjectionState {
  module: 'skill'
  status: SkillTaskProjectionStatus
  taskId: string
  taskTitle: string
  taskSummary: string
  steps: ScopeRunTaskStep[]
  currentStepId: string | null
  waitingFor: ScopeRunWaitingFor
  resumableActions: ScopeRunResumableAction[]
  blockedReason: string | null
  taskContinuation: SkillTaskContinuationState | null
  progress: ScopeRunSkillProgress | null
  recentArtifacts: Array<{
    id: string
    module: string
    kind: string
    label: string
    path?: string | null
    createdAt: string
    meta?: Record<string, unknown>
  }>
}

const projectionsBySession = new Map<string, Map<string, SkillTaskProjectionState>>()
let injectedTaskRunRepository: SkillTaskRunRepository | null | undefined
let defaultTaskRunRepository: SkillTaskRunRepository | null | undefined

function sessionKey(sessionId?: string): string {
  return sessionId || '__global_skill_session__'
}

function skillKey(skillId?: string): string {
  return skillId || '__unknown_skill__'
}

function titleForTool(toolName: string): string {
  switch (toolName) {
    case 'skill_run_shell':
      return '执行技能脚本'
    case 'skill_ask_user':
      return '等待用户补充信息'
    case 'skill_write_artifact':
      return '写入技能产物'
    case 'skill_read_artifact':
      return '读取技能产物'
    case 'skill_patch_config':
      return '修复技能配置'
    default:
      return toolName.startsWith('skill_') ? '执行技能工具' : toolName
  }
}

function isMemoryOnlyEvent(event: SkillTaskEvent): boolean {
  return event.toolName === 'memory_capture'
}

function getTaskRunRepository(): SkillTaskRunRepository | null {
  if (injectedTaskRunRepository !== undefined) return injectedTaskRunRepository
  if (defaultTaskRunRepository !== undefined) return defaultTaskRunRepository
  try {
    const database = getRepositoryDatabase()
    if (!database.getRawDb()) {
      defaultTaskRunRepository = null
      return null
    }
    defaultTaskRunRepository = new SkillTaskRunRepository(database)
  } catch {
    defaultTaskRunRepository = null
  }
  return defaultTaskRunRepository
}

export function registerSkillTaskRunRepository(repository: SkillTaskRunRepository | null): void {
  injectedTaskRunRepository = repository
}

function getOrCreateProjection(event: SkillTaskEvent): SkillTaskProjectionState {
  const sKey = sessionKey(event.sessionId)
  const skKey = skillKey(event.skillId)
  let bySkill = projectionsBySession.get(sKey)
  if (!bySkill) {
    bySkill = new Map()
    projectionsBySession.set(sKey, bySkill)
  }
  let projection = bySkill.get(skKey)
  if (!projection) {
    const taskId = `skill:${sKey}:${skKey}`
    const skillName = event.skillName || event.skillId || 'skill'
    projection = {
      module: 'skill',
      status: 'running',
      taskId,
      taskTitle: `技能执行 · ${skillName}`,
      taskSummary: '技能任务进行中',
      steps: [],
      currentStepId: null,
      waitingFor: 'none',
      resumableActions: ['none'],
      blockedReason: null,
      taskContinuation: null,
      progress: null,
      recentArtifacts: [],
    }
    bySkill.set(skKey, projection)
  }
  return projection
}

function nextStepId(steps: Array<{ id: string }>, toolName: string): string {
  let max = 0
  const prefix = `${toolName}#`
  for (const step of steps) {
    if (!step.id.startsWith(prefix)) continue
    const n = Number.parseInt(step.id.slice(prefix.length), 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  return `${toolName}#${max + 1}`
}

function statusToRunStatus(status: SkillTaskEventStatus): SkillTaskRunStatus {
  if (status === 'error') return 'failed'
  return status
}

function statusToStepStatus(status: SkillTaskEventStatus): SkillTaskRunStep['status'] {
  return status === 'error' ? 'error' : status
}

function interactionStateFor(status: SkillTaskEventStatus): SkillTaskRunRecord['interactionState'] {
  if (status === 'blocked') return 'awaiting_clarification'
  if (status === 'running') return 'running'
  return 'suspended'
}

function lifecycleRunStatus(state: SkillParentTaskLifecycleState): SkillTaskRunStatus {
  if (state === 'background_running') return 'running'
  if (state === 'budget_paused' || state === 'blocked') return 'blocked'
  if (state === 'failed') return 'failed'
  return state
}

function lifecycleStepStatus(state: SkillParentTaskLifecycleState): ScopeRunTaskStep['status'] {
  if (state === 'background_running') return 'running'
  if (state === 'budget_paused' || state === 'blocked') return 'blocked'
  if (state === 'failed') return 'error'
  return 'done'
}

function lifecycleWaitingFor(state: SkillParentTaskLifecycleState): ScopeRunWaitingFor {
  if (state === 'background_running' || state === 'budget_paused') return 'background'
  if (state === 'blocked') return 'input'
  return 'none'
}

function lifecycleResumableActions(state: SkillParentTaskLifecycleState): ScopeRunResumableAction[] {
  if (state === 'background_running' || state === 'budget_paused' || state === 'blocked') return ['continue', 'cancel']
  if (state === 'failed') return ['retry', 'cancel']
  return ['none']
}

function lifecycleInteractionState(state: SkillParentTaskLifecycleState): SkillTaskRunRecord['interactionState'] {
  if (state === 'background_running' || state === 'budget_paused') return 'suspended'
  if (state === 'blocked') return 'awaiting_clarification'
  return 'suspended'
}

function lifecycleProjectionStatus(state: SkillParentTaskLifecycleState): SkillTaskProjectionStatus {
  if (state === 'background_running' || state === 'budget_paused') return 'running'
  if (state === 'blocked') return 'blocked'
  if (state === 'failed') return 'failed'
  if (state === 'cancelled') return 'cancelled'
  return 'done'
}

function eventProjectionStatus(status: SkillTaskEventStatus): SkillTaskProjectionStatus {
  if (status === 'blocked') return 'blocked'
  if (status === 'error') return 'failed'
  if (status === 'done') return 'done'
  return 'running'
}

function inferOutputPaths(event: SkillTaskEvent): Pick<
  SkillTaskRunRecord,
  'outputDir' | 'runStatePath' | 'sceneScoresPath' | 'deliveryReportPath'
> {
  const result: Pick<SkillTaskRunRecord, 'outputDir' | 'runStatePath' | 'sceneScoresPath' | 'deliveryReportPath'> = {
    outputDir: event.outputDir ?? null,
    runStatePath: event.runStatePath ?? null,
    sceneScoresPath: event.sceneScoresPath ?? null,
    deliveryReportPath: event.deliveryReportPath ?? null,
  }
  const allArtifacts = [
    ...(event.artifactPath ? [{ path: event.artifactPath, label: event.artifactLabel || event.artifactPath }] : []),
    ...(event.artifacts || []),
  ]
  for (const artifact of allArtifacts) {
    const key = typeof artifact.meta?.outputKey === 'string' ? artifact.meta.outputKey : ''
    if (key === 'outputDir') result.outputDir = result.outputDir || artifact.path
    if (key === 'runStatePath') result.runStatePath = result.runStatePath || artifact.path
    if (key === 'sceneScoresPath') result.sceneScoresPath = result.sceneScoresPath || artifact.path
    if (key === 'deliveryReportPath') result.deliveryReportPath = result.deliveryReportPath || artifact.path
    if (!result.runStatePath && artifact.path.endsWith('/run_state.json')) result.runStatePath = artifact.path
    if (!result.sceneScoresPath && artifact.path.endsWith('/scene_scores.json')) result.sceneScoresPath = artifact.path
    if (!result.deliveryReportPath && artifact.path.endsWith('/delivery_report.json')) result.deliveryReportPath = artifact.path
  }
  return result
}

function buildResumePayload(event: SkillTaskEvent, stepId: string): Record<string, unknown> | null {
  if (event.resumePayload) return event.resumePayload
  if (event.status !== 'blocked' && event.status !== 'error') return null
  return {
    taskId: event.runId || event.sessionId || null,
    stepId,
    toolName: event.toolName,
    skillId: event.skillId || null,
    action: event.action || event.toolName,
    resumableActions: event.status === 'error' ? ['retry', 'cancel'] : ['continue', 'cancel'],
  }
}

function buildLifecycleResumePayload(
  event: SkillParentTaskLifecycleEvent,
  stepId: string,
  taskId: string,
): Record<string, unknown> | null {
  if (event.resumePayload) return event.resumePayload
  const actions = lifecycleResumableActions(event.state)
  if (actions.length === 1 && actions[0] === 'none') return null
  return {
    taskId,
    stepId,
    blockerType: event.reason || event.state,
    todoId: stepId,
    todoTitle: '技能任务状态',
    pauseReason: event.reason || null,
    childRunId: event.childRunId ?? null,
    detachedTaskId: event.detachedTaskId ?? null,
    taskRunId: event.taskRunId ?? null,
    jobId: event.jobId ?? null,
    skillId: event.skillId,
    action: event.action ?? null,
    runStatePath: event.runStatePath ?? null,
    outputDir: event.outputDir ?? null,
    progressFingerprint: event.progressFingerprint ?? null,
    resumableActions: actions,
  }
}

function isChildRunRecord(record: SkillTaskRunRecord | null | undefined): boolean {
  if (!record) return false
  const payload = record.resumePayload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
  const childRun = (payload as Record<string, unknown>).childRun
  return record.runKind === 'child_run' || Boolean(childRun && typeof childRun === 'object' && !Array.isArray(childRun))
}

function createRunFromEvent(event: SkillTaskEvent, step: SkillTaskRunStep, nowIso: string): SkillTaskRunRecord | null {
  if (!event.skillId) return null
  const paths = inferOutputPaths(event)
  return {
    id: createSkillTaskRunId(),
    scopeId: event.scopeId || event.sessionId || null,
    sessionId: event.sessionId || event.scopeId || null,
    agent: event.agent ?? null,
    runId: event.runId ?? null,
    skillId: event.skillId,
    skillName: event.skillName ?? event.skillId,
    action: event.action || event.toolName,
    toolName: event.toolName,
    runKind: event.runKind || 'primitive',
    status: statusToRunStatus(event.status),
    interactionState: interactionStateFor(event.status),
    goalText: event.goalText ?? null,
    resourceRefs: event.resourceRefs || [],
    params: event.params || null,
    steps: [step],
    currentStepId: step.id,
    artifacts: [],
    ...paths,
    failureKind: event.status === 'error' ? event.failureKind || 'tool_error' : event.failureKind ?? null,
    failureDetail: event.status === 'error' ? event.failureDetail || event.message || null : event.failureDetail ?? null,
    jobId: event.jobId ?? null,
    detachedTaskId: event.detachedTaskId ?? null,
    resumePayload: buildResumePayload(event, step.id),
    createdAt: nowIso,
    startedAt: event.status === 'running' ? nowIso : null,
    updatedAt: nowIso,
    finishedAt: event.status === 'done' || event.status === 'error' ? nowIso : null,
  }
}

function createRunFromLifecycleEvent(
  event: SkillParentTaskLifecycleEvent,
  step: SkillTaskRunStep,
  nowIso: string,
  taskId: string,
): SkillTaskRunRecord {
  const runStatus = lifecycleRunStatus(event.state)
  return {
    id: createSkillTaskRunId(),
    scopeId: event.scopeId || event.sessionId || null,
    sessionId: event.sessionId || event.scopeId || null,
    agent: event.agent ?? null,
    runId: event.runId ?? null,
    skillId: event.skillId,
    skillName: event.skillName ?? event.skillId,
    action: event.action || 'skill_lifecycle',
    toolName: 'skill_lifecycle',
    runKind: 'typed_action',
    status: runStatus,
    interactionState: lifecycleInteractionState(event.state),
    goalText: event.goalText ?? null,
    resourceRefs: event.resourceRefs || [],
    params: event.params || null,
    steps: [step],
    currentStepId: step.id,
    artifacts: [],
    outputDir: event.outputDir ?? null,
    runStatePath: event.runStatePath ?? null,
    sceneScoresPath: event.sceneScoresPath ?? null,
    deliveryReportPath: event.deliveryReportPath ?? null,
    failureKind: event.state === 'failed' ? event.failureKind || 'skill_task_failed' : event.failureKind ?? null,
    failureDetail: event.state === 'failed' ? event.failureDetail || event.message || null : event.failureDetail ?? null,
    jobId: event.jobId ?? null,
    detachedTaskId: event.detachedTaskId ?? null,
    resumePayload: buildLifecycleResumePayload(event, step.id, taskId),
    createdAt: nowIso,
    startedAt: runStatus === 'running' ? nowIso : null,
    updatedAt: nowIso,
    finishedAt: runStatus === 'done' || runStatus === 'failed' || runStatus === 'cancelled' ? nowIso : null,
  }
}

// Stage Q (Stage 11) — module-load snapshot of the runKind invariant flag.
// Tests can override via env before importing this module. PR-3 ships the
// code-level partition; PR-5 adds the boot CHECK constraint that makes
// flag=false incompatible with the schema (see assertSkillTaskRunInvariantConsistency).
// Parsing aligned with `turn-feature-flags.ts` `isFlagEnabled()` style:
// trim + lower-case, accept ('0' | 'false' | 'off') as disable.
const SKILL_TASK_RUN_INVARIANT_ENFORCED = (() => {
  const raw = (process.env.READY_SKILL_TASK_RUN_INVARIANT_ENFORCED ?? '').trim().toLowerCase()
  if (raw === '') return true // default enabled (matches turn-feature-flags default)
  return !(raw === '0' || raw === 'false' || raw === 'off')
})()

function findTaskRunForEvent(repository: SkillTaskRunRepository, event: SkillTaskEvent): SkillTaskRunRecord | null {
  if (event.detachedTaskId) {
    const detached = repository.findByDetachedTaskId(event.detachedTaskId)
    if (detached) return detached
  }
  const sessionId = event.sessionId || event.scopeId
  if (!sessionId || !event.skillId) return null
  // Stage Q.3a — partition active row matching by runKind so a primitive
  // event does not reuse a typed_action parent's row (and vice versa).
  // Normalize undefined event.runKind to 'primitive' to match
  // `createRunFromEvent`'s default (`event.runKind || 'primitive'`).
  // Falls back to legacy match when flag disabled.
  const eventRunKind = event.runKind || 'primitive'
  const active = repository.listActiveBySession(sessionId, 20)
    .find((run) => run.skillId === event.skillId
      && !isChildRunRecord(run)
      && (!SKILL_TASK_RUN_INVARIANT_ENFORCED || run.runKind === eventRunKind))
  if (active) return active
  if (event.runKind === 'typed_action' && event.status === 'running') return null
  const latest = repository.findLatestRecoverable({
    sessionId,
    skillId: event.skillId,
    includeDone: true,
  })
  if (!latest || isChildRunRecord(latest)) return null
  // Stage Q.3a — same partition rule on the latest-recoverable fallback.
  if (SKILL_TASK_RUN_INVARIANT_ENFORCED && latest.runKind !== eventRunKind) return null
  return latest
}

function findTaskRunForLifecycleEvent(
  repository: SkillTaskRunRepository,
  event: SkillParentTaskLifecycleEvent,
): SkillTaskRunRecord | null {
  // Stage Q.3a — exact-handle lookups must also refuse primitive rows.
  // Otherwise lifecycle could mutate a primitive row's `tool_name` to
  // 'skill_lifecycle', producing the very `run_kind='primitive' AND
  // tool_name='skill_lifecycle'` violation Stage Q schema CHECK forbids.
  if (event.taskRunId) {
    const exact = repository.get(event.taskRunId)
    if (exact && !isChildRunRecord(exact)) {
      if (SKILL_TASK_RUN_INVARIANT_ENFORCED && exact.runKind === 'primitive') {
        // fall through; lifecycle should NOT reuse a primitive row.
      } else {
        return exact
      }
    }
  }
  if (event.detachedTaskId) {
    const detached = repository.findByDetachedTaskId(event.detachedTaskId)
    if (detached && !isChildRunRecord(detached)) {
      if (SKILL_TASK_RUN_INVARIANT_ENFORCED && detached.runKind === 'primitive') {
        // fall through.
      } else {
        return detached
      }
    }
  }
  const sessionId = event.sessionId || event.scopeId
  if (!sessionId || !event.skillId) return null
  // Stage Q.3a — lifecycle events MUST NOT reuse a primitive row. Lifecycle
  // mutates `tool_name` to 'skill_lifecycle' which, on a primitive row,
  // would create the very contradiction Stage Q schema CHECK forbids
  // (`run_kind='primitive' AND tool_name='skill_lifecycle'`). Restrict the
  // active fallback to typed_action rows when the flag is on.
  const active = repository.listActiveBySession(sessionId, 20)
    .find((run) => run.skillId === event.skillId
      && !isChildRunRecord(run)
      && (!SKILL_TASK_RUN_INVARIANT_ENFORCED || run.runKind === 'typed_action'))
  if (active) return active
  const latest = repository.findLatestRecoverable({
    sessionId,
    skillId: event.skillId,
    includeDone: true,
  })
  if (!latest || isChildRunRecord(latest)) return null
  if (SKILL_TASK_RUN_INVARIANT_ENFORCED && latest.runKind !== 'typed_action') return null
  return latest
}

/**
 * Stage Q (Stage 11) — boot-time fence: detect the incompatible
 * combination of `flag=false` AND a migrated CHECK constraint on
 * `skill_task_runs`. PR-3 lands the function body only; PR-5 wires it
 * into the runtime boot path immediately after `AgentControlRuntime`
 * construction at `runtime.ts:220-238` style position. Test-only callers
 * may invoke this directly with a synthetic database.
 *
 * Returns:
 *   - 'ok' when the schema and flag are mutually consistent
 *   - 'incompatible' when CHECK is enforced but the flag is OFF (caller
 *     should throw before any DB write so the user sees the error early)
 *   - 'unknown' when the schema cannot be inspected (no DB available)
 */
export function assertSkillTaskRunInvariantConsistency(params: {
  getCheckEnforcedSql: () => string | null
  invariantEnforced: boolean
}): 'ok' | 'incompatible' | 'unknown' {
  let sql: string | null
  try {
    sql = params.getCheckEnforcedSql()
  } catch {
    return 'unknown'
  }
  if (sql == null) return 'unknown'
  // Look for the literal CHECK clause emitted by Stage Q PR-5 migration 033.
  const hasCheck = /CHECK\s*\(\s*NOT\s*\(\s*run_kind\s*=\s*'primitive'\s+AND\s+tool_name\s*=\s*'skill_lifecycle'\s*\)\s*\)/i.test(sql)
  if (hasCheck && !params.invariantEnforced) return 'incompatible'
  return 'ok'
}

function buildRunArtifacts(event: SkillTaskEvent, stepId: string, nowIso: string): SkillTaskRunArtifact[] {
  const artifacts = [
    ...(event.artifactPath
      ? [{
        path: event.artifactPath,
        label: event.artifactLabel || event.artifactPath.split(/[\\/]/).pop() || '技能产物',
        kind: event.toolName === 'skill_read_artifact' ? 'read_artifact' : 'artifact',
      }]
      : []),
    ...(event.artifacts || []),
  ]
  return artifacts
    .filter((artifact) => typeof artifact.path === 'string' && artifact.path.trim().length > 0)
    .map((artifact) => ({
      id: `${stepId}:${artifact.label}:${nowIso}`,
      module: 'skill',
      kind: artifact.kind || 'artifact',
      label: artifact.label,
      path: artifact.path,
      createdAt: nowIso,
      meta: artifact.meta,
    }))
}

function shouldPreserveParentProjection(projection: SkillTaskProjectionState, event: SkillTaskEvent): boolean {
  if (
    projection.taskContinuation?.childRunId
    && event.runKind === 'typed_action'
    && (event.status === 'done' || event.status === 'running')
  ) {
    return true
  }
  if (event.runKind !== 'primitive' || (event.status !== 'done' && event.status !== 'running')) return false
  if (projection.waitingFor !== 'none' || projection.blockedReason || projection.taskContinuation) return true
  const currentStep = projection.currentStepId
    ? projection.steps.find((step) => step.id === projection.currentStepId)
    : null
  return currentStep?.status === 'running' || currentStep?.status === 'blocked'
}

function recordTaskRunEvent(event: SkillTaskEvent, stepId: string, nowIso: string): void {
  const repository = getTaskRunRepository()
  if (!repository || !event.skillId) return
  const step: SkillTaskRunStep = {
    id: stepId,
    title: titleForTool(event.toolName),
    status: statusToStepStatus(event.status),
    detail: event.message || null,
    updatedAt: nowIso,
  }
  let current: SkillTaskRunRecord | null = null
  try {
    current = findTaskRunForEvent(repository, event)
  } catch {
    return
  }
  if (!current) {
    const created = createRunFromEvent(event, step, nowIso)
    if (!created) return
    created.artifacts = buildRunArtifacts(event, stepId, nowIso)
    try {
      repository.create(created)
    } catch {
      // Projection updates must keep working even if SQLite is temporarily unavailable.
    }
    return
  }
  const existingStepIndex = current.steps.findIndex((item) => item.id === stepId)
  const steps = existingStepIndex >= 0
    ? current.steps.map((item, index) => (index === existingStepIndex ? step : item))
    : [...current.steps, step]
  const artifacts = [
    ...current.artifacts,
    ...buildRunArtifacts(event, stepId, nowIso),
  ].slice(-12)
  const paths = inferOutputPaths(event)
  const runStatus = statusToRunStatus(event.status)
  const preserveActiveParent = event.runKind === 'primitive'
    && (runStatus === 'done' || runStatus === 'running')
    && (current.status === 'running' || current.status === 'blocked')
  const nextResumePayload = preserveActiveParent
    ? current.resumePayload ?? null
    : buildResumePayload(event, stepId)
  try {
    repository.updateRowSync(current.id, {
      scopeId: event.scopeId || current.scopeId,
      sessionId: event.sessionId || current.sessionId,
      agent: event.agent ?? current.agent,
      runId: event.runId ?? current.runId,
      skillName: event.skillName ?? current.skillName,
      action: event.action || current.action,
      toolName: event.toolName,
      runKind: preserveActiveParent ? current.runKind : event.runKind || current.runKind,
      status: preserveActiveParent ? current.status : runStatus,
      interactionState: preserveActiveParent ? current.interactionState : interactionStateFor(event.status),
      goalText: event.goalText ?? current.goalText ?? null,
      resourceRefs: event.resourceRefs ?? current.resourceRefs ?? [],
      params: event.params || current.params,
      steps,
      currentStepId: preserveActiveParent ? current.currentStepId ?? stepId : stepId,
      artifacts,
      outputDir: paths.outputDir || current.outputDir || null,
      runStatePath: paths.runStatePath || current.runStatePath || null,
      sceneScoresPath: paths.sceneScoresPath || current.sceneScoresPath || null,
      deliveryReportPath: paths.deliveryReportPath || current.deliveryReportPath || null,
      failureKind: preserveActiveParent
        ? current.failureKind ?? null
        : event.status === 'error' ? event.failureKind || current.failureKind || 'tool_error' : event.failureKind ?? null,
      failureDetail: preserveActiveParent
        ? current.failureDetail ?? null
        : event.status === 'error' ? event.failureDetail || event.message || current.failureDetail || null : event.failureDetail ?? null,
      jobId: event.jobId ?? current.jobId ?? null,
      detachedTaskId: event.detachedTaskId ?? current.detachedTaskId,
      resumePayload: nextResumePayload,
      startedAt: current.startedAt || (event.status === 'running' ? nowIso : null),
      updatedAt: nowIso,
      finishedAt: preserveActiveParent
        ? current.finishedAt ?? null
        : runStatus === 'done' || runStatus === 'failed' || runStatus === 'cancelled'
          ? nowIso
          : null,
    })
  } catch {
    // Projection updates must keep working even if SQLite is temporarily unavailable.
  }
}

function recordLifecycleTaskRunEvent(
  event: SkillParentTaskLifecycleEvent,
  step: ScopeRunTaskStep,
  nowIso: string,
  taskId: string,
): void {
  const repository = getTaskRunRepository()
  if (!repository) return
  const runStep: SkillTaskRunStep = {
    id: step.id,
    title: step.title,
    status: step.status,
    detail: step.detail,
    updatedAt: step.updatedAt,
  }
  let current: SkillTaskRunRecord | null = null
  try {
    current = findTaskRunForLifecycleEvent(repository, event)
  } catch {
    return
  }
  if (!current) {
    const created = createRunFromLifecycleEvent(event, runStep, nowIso, taskId)
    try {
      repository.create(created)
    } catch {
      // Projection updates must keep working even if SQLite is temporarily unavailable.
    }
    return
  }

  const runStatus = lifecycleRunStatus(event.state)
  const existingStepIndex = current.steps.findIndex((item) => item.id === runStep.id)
  const steps = existingStepIndex >= 0
    ? current.steps.map((item, index) => (index === existingStepIndex ? runStep : item))
    : [...current.steps, runStep]
  try {
    repository.updateRowSync(current.id, {
      scopeId: event.scopeId || current.scopeId,
      sessionId: event.sessionId || current.sessionId,
      agent: event.agent ?? current.agent,
      runId: event.runId ?? current.runId,
      skillName: event.skillName ?? current.skillName,
      action: event.action || current.action,
      toolName: 'skill_lifecycle',
      runKind: current.runKind,
      status: runStatus,
      interactionState: lifecycleInteractionState(event.state),
      goalText: event.goalText ?? current.goalText ?? null,
      resourceRefs: event.resourceRefs ?? current.resourceRefs ?? [],
      params: event.params || current.params,
      steps,
      currentStepId: runStep.id,
      outputDir: event.outputDir ?? current.outputDir ?? null,
      runStatePath: event.runStatePath ?? current.runStatePath ?? null,
      sceneScoresPath: event.sceneScoresPath ?? current.sceneScoresPath ?? null,
      deliveryReportPath: event.deliveryReportPath ?? current.deliveryReportPath ?? null,
      failureKind: event.state === 'failed'
        ? event.failureKind || current.failureKind || 'skill_task_failed'
        : event.failureKind ?? null,
      failureDetail: event.state === 'failed'
        ? event.failureDetail || event.message || current.failureDetail || null
        : event.failureDetail ?? null,
      jobId: event.jobId ?? current.jobId ?? null,
      detachedTaskId: event.detachedTaskId ?? current.detachedTaskId,
      resumePayload: buildLifecycleResumePayload(event, runStep.id, taskId),
      updatedAt: nowIso,
      finishedAt: runStatus === 'done' || runStatus === 'failed' || runStatus === 'cancelled' ? nowIso : null,
    })
  } catch {
    // Projection updates must keep working even if SQLite is temporarily unavailable.
  }
}

export function recordSkillTaskEvent(event: SkillTaskEvent): { stepId: string } {
  if (isMemoryOnlyEvent(event)) {
    const projection = readSkillTaskProjection({
      sessionId: event.sessionId,
      skillId: event.skillId,
    })
    return { stepId: projection?.currentStepId || event.stepId || 'memory_capture' }
  }

  const projection = getOrCreateProjection(event)
  const updatedAt = new Date().toISOString()
  const stepId = event.stepId || nextStepId(projection.steps, event.toolName)
  const preserveParentProjection = shouldPreserveParentProjection(projection, event)
  const existingIndex = projection.steps.findIndex((step) => step.id === stepId)
  const step: ScopeRunTaskStep = {
    id: stepId,
    title: titleForTool(event.toolName),
    status: event.status,
    detail: event.message || null,
    updatedAt,
  }

  if (existingIndex >= 0) {
    projection.steps[existingIndex] = step
  } else {
    projection.steps.push(step)
  }

  if (!preserveParentProjection) {
    projection.status = eventProjectionStatus(event.status)
    projection.currentStepId = stepId
    projection.taskSummary = event.message || titleForTool(event.toolName)
    projection.blockedReason = event.status === 'blocked' || event.status === 'error'
      ? event.message || (event.status === 'blocked' ? '等待用户补充信息' : '技能执行失败')
      : null
    projection.waitingFor = event.status === 'blocked' ? 'input' : 'none'
    projection.resumableActions = event.status === 'blocked'
      ? ['continue', 'cancel']
      : event.status === 'error'
        ? ['retry', 'cancel']
        : event.artifactPath
          ? ['open_artifact']
          : ['none']
    projection.taskContinuation = event.status === 'blocked' || event.status === 'error'
      ? {
        taskId: projection.taskId,
        stepId,
        blockerType: event.status === 'blocked' ? 'need_input' : 'error',
        todoId: stepId,
        todoTitle: step.title,
      }
      : null
  }

  const artifacts = [
    ...(event.artifactPath
      ? [{
        path: event.artifactPath,
        label: event.artifactLabel || event.artifactPath.split(/[\\/]/).pop() || '技能产物',
        kind: event.toolName === 'skill_read_artifact' ? 'read_artifact' : 'artifact',
      }]
      : []),
    ...(event.artifacts || []),
  ]
  if (artifacts.length > 0) {
    const seen = new Set<string>()
    const nextArtifacts = artifacts.filter((artifact) => {
      const path = String(artifact.path || '').trim()
      if (!path || seen.has(path)) return false
      seen.add(path)
      return true
    })
    projection.recentArtifacts = [
      ...projection.recentArtifacts,
      ...nextArtifacts.map((artifact) => ({
        id: `${stepId}:${artifact.label}:${updatedAt}`,
        module: 'skill',
        kind: artifact.kind || 'artifact',
        label: artifact.label,
        path: artifact.path,
        createdAt: updatedAt,
        meta: {
          skillId: event.skillId || null,
          toolName: event.toolName,
          ...(artifact.meta || {}),
        },
      })),
    ].slice(-6)
  }
  recordTaskRunEvent(event, stepId, updatedAt)
  return { stepId }
}

export function recordSkillParentTaskLifecycleEvent(event: SkillParentTaskLifecycleEvent): { stepId: string } {
  const projection = getOrCreateProjection({
    scopeId: event.scopeId,
    sessionId: event.sessionId,
    runId: event.runId,
    agent: event.agent,
    skillId: event.skillId,
    skillName: event.skillName,
    toolName: 'skill_lifecycle',
    action: event.action,
    runKind: 'typed_action',
    status: event.state === 'failed' ? 'error' : event.state === 'done' ? 'done' : 'running',
  })
  const updatedAt = new Date().toISOString()
  const stepId = event.stepId || nextStepId(projection.steps, 'skill_lifecycle')
  const step: ScopeRunTaskStep = {
    id: stepId,
    title: '技能任务状态',
    status: lifecycleStepStatus(event.state),
    detail: event.message || null,
    updatedAt,
  }
  const existingIndex = projection.steps.findIndex((item) => item.id === stepId)
  if (existingIndex >= 0) {
    projection.steps[existingIndex] = step
  } else {
    projection.steps.push(step)
  }

  const waitingFor = lifecycleWaitingFor(event.state)
  const resumableActions = lifecycleResumableActions(event.state)
  projection.status = lifecycleProjectionStatus(event.state)
  projection.currentStepId = stepId
  projection.taskSummary = event.message || '技能任务状态已更新'
  projection.waitingFor = waitingFor
  projection.resumableActions = resumableActions
  projection.blockedReason = waitingFor !== 'none' || event.state === 'failed'
    ? event.message || (event.state === 'failed' ? '技能执行失败' : '技能任务等待继续')
    : null
  projection.taskContinuation = buildLifecycleResumePayload(event, stepId, projection.taskId) as SkillTaskContinuationState | null
  if (event.progress) projection.progress = { ...event.progress }

  recordLifecycleTaskRunEvent(event, step, updatedAt, projection.taskId)
  return { stepId }
}

export function readSkillTaskProjection(params: {
  sessionId?: string
  skillId?: string
}): SkillTaskProjectionState | null {
  const bySkill = projectionsBySession.get(sessionKey(params.sessionId))
  if (!bySkill) return null
  const values = Array.from(bySkill.values())
  const projection = bySkill.get(skillKey(params.skillId)) || values[values.length - 1] || null
  if (!projection) return null
  return {
    ...projection,
    steps: projection.steps.map((step) => ({ ...step })),
    recentArtifacts: projection.recentArtifacts.map((artifact) => ({ ...artifact })),
    taskContinuation: projection.taskContinuation ? { ...projection.taskContinuation } : null,
    progress: projection.progress ? { ...projection.progress } : null,
  }
}

/**
 * RE-AUDIT FIX 4.3 — "is this projection still in flight". The Phase 4.3
 * primitive-exposure fallback used a naive "projection exists" check, which
 * silently kept primitives exposed for the rest of the session even after a
 * skill ran to completion. With no automatic `clearSkillTaskProjection` on
 * task done, the next direct_answer turn could call skill_run_shell despite
 * the gating intent. This helper restricts the signal to live state
 * (`running` / `blocked` on the most recent step), which collapses to no-op
 * once the latest tool event marks `done` or `error`.
 *
 * Defensive: a projection with no steps or no currentStepId — both impossible
 * under the current event recorder but could appear under a hand-built
 * fixture — is treated as inactive.
 */
export function isSkillTaskProjectionLive(
  projection: SkillTaskProjectionState | null | undefined,
): boolean {
  if (!projection) return false
  const stepId = projection.currentStepId
  if (!stepId) return false
  const step = projection.steps.find((s) => s.id === stepId)
  if (!step) return false
  return step.status === 'running' || step.status === 'blocked'
}

export function getLatestActiveSkillTaskRun(sessionId?: string): SkillTaskRunRecord | null {
  if (!sessionId) return null
  const repository = getTaskRunRepository()
  if (!repository) return null
  try {
    return repository.listActiveBySession(sessionId, 20)
      .find((run) => run.status === 'running' || run.status === 'blocked') || null
  } catch {
    return null
  }
}

export function getLatestRecoverableSkillTaskRun(sessionId?: string): SkillTaskRunRecord | null {
  if (!sessionId) return null
  const active = getLatestActiveSkillTaskRun(sessionId)
  if (active) return active
  const repository = getTaskRunRepository()
  if (!repository) return null
  try {
    return repository.findLatestRecoverable({
      sessionId,
      includeDone: true,
    })
  } catch {
    return null
  }
}

export function hasActiveSkillTaskRun(sessionId?: string): boolean {
  return getLatestActiveSkillTaskRun(sessionId) !== null
}

type DetachedRunStatus = NormalizedRunStateStatus

function isDetachedTerminalStatus(status: DetachedRunStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled'
}

function readLiveRunStateStatus(runStatePath?: string | null, outputDir?: string | null): DetachedRunStatus | null {
  const candidates = [
    runStatePath || null,
    outputDir ? join(outputDir, 'run_state.json') : null,
  ].filter((item): item is string => Boolean(item && item.trim()))
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as Record<string, unknown>
      const status = normalizeRunStateStatus(parsed.status ?? parsed.state ?? parsed.phase)
      if (status === 'running' || status === 'blocked') return status
    } catch {
      continue
    }
  }
  return null
}

export function upsertDetachedSkillTaskRun(record: {
  id: string
  scopeId?: string | null
  sessionId?: string | null
  agent?: string | null
  skillId: string
  action: string
  params: Record<string, unknown>
  status: DetachedRunStatus
  outputDir?: string | null
  runStatePath?: string | null
  sceneScoresPath?: string | null
  deliveryReportPath?: string | null
  error?: string | null
  startedAt: string
  updatedAt: string
  finishedAt?: string | null
}): void {
  const repository = getTaskRunRepository()
  if (!repository) return
  let existing: SkillTaskRunRecord | null = null
  try {
    existing = repository.findByDetachedTaskId(record.id)
  } catch {
    return
  }
  const stepId = 'detached_task#1'
  const liveStatus = isDetachedTerminalStatus(record.status)
    ? readLiveRunStateStatus(record.runStatePath ?? existing?.runStatePath ?? null, record.outputDir ?? existing?.outputDir ?? null)
    : null
  const effectiveStatus = liveStatus || record.status
  const step: SkillTaskRunStep = {
    id: stepId,
    title: '后台技能任务',
    status: effectiveStatus === 'failed' ? 'error' : effectiveStatus === 'cancelled' ? 'done' : effectiveStatus,
    detail: record.error || null,
    updatedAt: record.updatedAt,
  }
  const continuationPayload = {
    taskId: record.id,
    stepId,
    skillId: record.skillId,
    action: record.action,
    detachedTaskId: record.id,
    outputDir: record.outputDir ?? existing?.outputDir ?? null,
    runStatePath: record.runStatePath ?? existing?.runStatePath ?? null,
  }
  const resumePayload = effectiveStatus === 'failed'
    ? {
      ...continuationPayload,
      resumableActions: ['retry', 'cancel'],
    }
    : effectiveStatus === 'blocked' || effectiveStatus === 'running'
      ? {
        ...continuationPayload,
        resumableActions: ['continue', 'cancel'],
      }
      : null
  const finishedAt = isDetachedTerminalStatus(effectiveStatus) ? record.finishedAt ?? null : null
  const interactionState = 'suspended'
  if (!existing) {
    try {
      repository.create({
      id: createSkillTaskRunId(),
      scopeId: record.scopeId ?? record.sessionId ?? null,
      sessionId: record.sessionId ?? record.scopeId ?? null,
      agent: record.agent ?? null,
      runId: record.id,
      skillId: record.skillId,
      skillName: record.skillId,
      action: record.action,
      toolName: 'skill_start_detached',
      runKind: 'detached',
      status: effectiveStatus,
      interactionState,
      goalText: typeof record.params?.goal === 'string' ? record.params.goal : null,
      resourceRefs: [],
      params: record.params,
      steps: [step],
      currentStepId: stepId,
      artifacts: [],
      outputDir: record.outputDir ?? null,
      runStatePath: record.runStatePath ?? null,
      sceneScoresPath: record.sceneScoresPath ?? null,
      deliveryReportPath: record.deliveryReportPath ?? null,
      failureKind: effectiveStatus === 'failed' ? 'detached_task_failed' : null,
      failureDetail: effectiveStatus === 'failed' ? record.error ?? null : null,
      jobId: record.id,
      detachedTaskId: record.id,
      resumePayload,
      createdAt: record.startedAt,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      finishedAt,
      })
    } catch {
      // JSON persistence remains the source of last resort if SQLite is unavailable.
    }
    return
  }
  try {
    repository.updateRowSync(existing.id, {
    scopeId: record.scopeId ?? existing.scopeId,
    sessionId: record.sessionId ?? existing.sessionId,
    agent: record.agent ?? existing.agent,
    status: effectiveStatus,
    interactionState,
    params: record.params,
    steps: existing.steps.some((item) => item.id === stepId)
      ? existing.steps.map((item) => (item.id === stepId ? step : item))
      : [...existing.steps, step],
    currentStepId: stepId,
    outputDir: record.outputDir ?? existing.outputDir ?? null,
    runStatePath: record.runStatePath ?? existing.runStatePath ?? null,
    sceneScoresPath: record.sceneScoresPath ?? existing.sceneScoresPath ?? null,
    deliveryReportPath: record.deliveryReportPath ?? existing.deliveryReportPath ?? null,
    failureKind: effectiveStatus === 'failed' ? 'detached_task_failed' : null,
    failureDetail: effectiveStatus === 'failed' ? record.error ?? null : null,
    resumePayload,
    updatedAt: record.updatedAt,
    finishedAt,
    })
  } catch {
    // JSON persistence remains the source of last resort if SQLite is unavailable.
  }
}

export function clearSkillTaskProjection(sessionId?: string): void {
  if (sessionId) {
    projectionsBySession.delete(sessionKey(sessionId))
    return
  }
  projectionsBySession.clear()
}
