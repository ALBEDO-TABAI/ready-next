import type {
  ScopeRunResumableAction,
  ScopeRunTaskStep,
  ScopeRunWaitingFor,
} from './types'
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

interface SkillTaskProjectionState {
  module: 'skill'
  taskId: string
  taskTitle: string
  taskSummary: string
  steps: ScopeRunTaskStep[]
  currentStepId: string | null
  waitingFor: ScopeRunWaitingFor
  resumableActions: ScopeRunResumableAction[]
  blockedReason: string | null
  taskContinuation: {
    taskId?: string | null
    executionId?: string | null
    stepId?: string | null
    blockerType?: string | null
    todoId?: string | null
    todoTitle?: string | null
  } | null
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
      taskId,
      taskTitle: `技能执行 · ${skillName}`,
      taskSummary: '技能任务进行中',
      steps: [],
      currentStepId: null,
      waitingFor: 'none',
      resumableActions: ['none'],
      blockedReason: null,
      taskContinuation: null,
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

function findTaskRunForEvent(repository: SkillTaskRunRepository, event: SkillTaskEvent): SkillTaskRunRecord | null {
  if (event.detachedTaskId) {
    const detached = repository.findByDetachedTaskId(event.detachedTaskId)
    if (detached) return detached
  }
  const sessionId = event.sessionId || event.scopeId
  if (!sessionId || !event.skillId) return null
  const active = repository.listActiveBySession(sessionId, 20)
    .find((run) => run.skillId === event.skillId)
  if (active) return active
  if (event.runKind === 'typed_action' && event.status === 'running') return null
  return repository.findLatestRecoverable({
    sessionId,
    skillId: event.skillId,
    includeDone: true,
  })
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
    && runStatus === 'done'
    && (current.status === 'running' || current.status === 'blocked')
  try {
    repository.update(current.id, {
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
      currentStepId: stepId,
      artifacts,
      outputDir: paths.outputDir || current.outputDir || null,
      runStatePath: paths.runStatePath || current.runStatePath || null,
      sceneScoresPath: paths.sceneScoresPath || current.sceneScoresPath || null,
      deliveryReportPath: paths.deliveryReportPath || current.deliveryReportPath || null,
      failureKind: event.status === 'error' ? event.failureKind || current.failureKind || 'tool_error' : event.failureKind ?? null,
      failureDetail: event.status === 'error' ? event.failureDetail || event.message || current.failureDetail || null : event.failureDetail ?? null,
      jobId: event.jobId ?? current.jobId ?? null,
      detachedTaskId: event.detachedTaskId ?? current.detachedTaskId,
      resumePayload: buildResumePayload(event, stepId),
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

export function upsertDetachedSkillTaskRun(record: {
  id: string
  scopeId?: string | null
  sessionId?: string | null
  agent?: string | null
  skillId: string
  action: string
  params: Record<string, unknown>
  status: 'running' | 'done' | 'failed' | 'cancelled' | 'blocked'
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
  const step: SkillTaskRunStep = {
    id: stepId,
    title: '后台技能任务',
    status: record.status === 'failed' ? 'error' : record.status === 'cancelled' ? 'done' : record.status,
    detail: record.error || null,
    updatedAt: record.updatedAt,
  }
  const resumePayload = record.status === 'failed'
    ? {
      taskId: record.id,
      stepId,
      skillId: record.skillId,
      action: record.action,
      resumableActions: ['retry', 'cancel'],
    }
    : record.status === 'blocked'
      ? {
        taskId: record.id,
        stepId,
        skillId: record.skillId,
        action: record.action,
        resumableActions: ['continue', 'cancel'],
      }
      : null
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
      status: record.status,
      interactionState: record.status === 'blocked' ? 'suspended' : 'running',
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
      failureKind: record.status === 'failed' ? 'detached_task_failed' : null,
      failureDetail: record.status === 'failed' ? record.error ?? null : null,
      jobId: record.id,
      detachedTaskId: record.id,
      resumePayload,
      createdAt: record.startedAt,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      finishedAt: record.finishedAt ?? null,
      })
    } catch {
      // JSON persistence remains the source of last resort if SQLite is unavailable.
    }
    return
  }
  try {
    repository.update(existing.id, {
    scopeId: record.scopeId ?? existing.scopeId,
    sessionId: record.sessionId ?? existing.sessionId,
    agent: record.agent ?? existing.agent,
    status: record.status,
    interactionState: record.status === 'blocked' ? 'suspended' : 'running',
    params: record.params,
    steps: existing.steps.some((item) => item.id === stepId)
      ? existing.steps.map((item) => (item.id === stepId ? step : item))
      : [...existing.steps, step],
    currentStepId: stepId,
    outputDir: record.outputDir ?? existing.outputDir ?? null,
    runStatePath: record.runStatePath ?? existing.runStatePath ?? null,
    sceneScoresPath: record.sceneScoresPath ?? existing.sceneScoresPath ?? null,
    deliveryReportPath: record.deliveryReportPath ?? existing.deliveryReportPath ?? null,
    failureKind: record.status === 'failed' ? 'detached_task_failed' : null,
    failureDetail: record.status === 'failed' ? record.error ?? null : null,
    resumePayload,
    updatedAt: record.updatedAt,
    finishedAt: record.finishedAt ?? null,
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
