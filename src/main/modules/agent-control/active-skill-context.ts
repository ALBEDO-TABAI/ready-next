import { dirname } from 'node:path'

import { getRepositoryDatabase } from '../repositories/database-accessor'
import { TaskProjectionRepository } from '../repositories/task-projection-repository'
import {
  SkillTaskRunRepository,
  type SkillTaskRunRecord,
} from '../repositories/skill-task-run-repository'
import { getLastReferenceSkill, type ReferenceSkillHint } from './skill-reference-hints'
import type { TaskProjectionRecord } from './run-contracts'
import {
  inspectLatestSkillTask,
  type SkillTaskSupervisorSnapshot,
} from './skill-task-supervisor'

export type ActiveSkillContextSource =
  | 'explicit'
  | 'supervisor'
  | 'projection'
  | 'task_run'
  | 'reference_hint'

export interface ActiveSkillContext {
  skillId: string
  skillName: string | null
  taskRunId: string | null
  detachedTaskId: string | null
  runStatePath: string | null
  outputDir: string | null
  sceneScoresPath: string | null
  deliveryReportPath: string | null
  action: string | null
  source: ActiveSkillContextSource
  confidence: number
  status: string | null
  staleBlockerReason: string | null
  observedAt: string
}

export interface ResolveActiveSkillContextInputs {
  sessionId?: string | null
  explicitSkillId?: string | null
  explicitSkillName?: string | null
  supervisorSnapshot?: SkillTaskSupervisorSnapshot | null
  projections?: TaskProjectionRecord[]
  taskRuns?: SkillTaskRunRecord[]
  referenceHint?: ReferenceSkillHint | null
  inspectSupervisor?: boolean
}

const ACTIVE_CONTEXT_TTL_MS = 30 * 60 * 1000
const rememberedContexts = new Map<string, ActiveSkillContext>()

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function sessionKey(sessionId?: string | null): string | null {
  const key = nonEmpty(sessionId)
  return key || null
}

function nowIso(): string {
  return new Date().toISOString()
}

function parseTime(value: string | null | undefined): number {
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function metaString(meta: Record<string, unknown> | undefined, key: string): string | null {
  return nonEmpty(meta?.[key])
}

function artifactPathByOutputKey(
  projection: TaskProjectionRecord,
  key: string,
): string | null {
  for (const artifact of projection.recentArtifacts || []) {
    if (metaString(artifact.meta, 'outputKey') === key && artifact.path) return artifact.path
  }
  return null
}

function firstArtifactMetaString(projection: TaskProjectionRecord, key: string): string | null {
  for (const artifact of projection.recentArtifacts || []) {
    const value = metaString(artifact.meta, key)
    if (value) return value
  }
  return null
}

function pathEnding(projection: TaskProjectionRecord, filename: string): string | null {
  for (const artifact of projection.recentArtifacts || []) {
    const path = nonEmpty(artifact.path)
    if (path && path.split(/[\\/]/).pop() === filename) return path
  }
  return null
}

function skillIdFromProjection(projection: TaskProjectionRecord): string | null {
  const continuation = projection.continuationRef
  if (continuation?.skillId) return continuation.skillId
  const artifactSkill = firstArtifactMetaString(projection, 'skillId')
  if (artifactSkill) return artifactSkill
  const taskMatch = projection.taskId.match(/^skill:(?!detached:|run_state:|output:)[^:]+:(.+)$/)
  if (taskMatch?.[1]) return taskMatch[1]
  return null
}

function isProjectionRecoverable(projection: TaskProjectionRecord): boolean {
  if (!skillIdFromProjection(projection)) return false
  if (projection.status === 'blocked' || projection.status === 'running' || projection.status === 'failed') return true
  if (projection.interactionState === 'resuming' || projection.interactionState === 'suspended') return true
  return false
}

function contextFromProjection(projection: TaskProjectionRecord): ActiveSkillContext | null {
  const skillId = skillIdFromProjection(projection)
  if (!skillId || !isProjectionRecoverable(projection)) return null
  const continuation = projection.continuationRef
  const runStatePath =
    continuation?.runStatePath
    || artifactPathByOutputKey(projection, 'runStatePath')
    || pathEnding(projection, 'run_state.json')
  const outputDir =
    continuation?.outputDir
    || artifactPathByOutputKey(projection, 'outputDir')
    || (runStatePath ? dirname(runStatePath) : null)
  return {
    skillId,
    skillName: null,
    taskRunId: continuation?.taskRunId || null,
    detachedTaskId:
      continuation?.detachedTaskId
      || firstArtifactMetaString(projection, 'detachedTaskId')
      || (projection.runId.startsWith('dst-') ? projection.runId : null),
    runStatePath,
    outputDir,
    sceneScoresPath:
      artifactPathByOutputKey(projection, 'sceneScoresPath')
      || pathEnding(projection, 'scene_scores.json'),
    deliveryReportPath:
      artifactPathByOutputKey(projection, 'deliveryReportPath')
      || pathEnding(projection, 'delivery_report.json'),
    action:
      continuation?.action
      || firstArtifactMetaString(projection, 'action')
      || projection.currentStepId
      || null,
    source: 'projection',
    confidence: projection.module === 'skill' ? 84 : 78,
    status: projection.status,
    staleBlockerReason: projection.blockedReason || null,
    observedAt: projection.updatedAt,
  }
}

function contextFromSupervisor(snapshot: SkillTaskSupervisorSnapshot | null | undefined): ActiveSkillContext | null {
  if (!snapshot?.skillId) return null
  if (snapshot.closeAllowed && snapshot.status === 'done') return null
  const hasHandle = Boolean(
    snapshot.hasLiveWork
      || snapshot.hasRecentProgress
      || snapshot.runStatePath
      || snapshot.outputDir
      || snapshot.detachedTaskId
      || snapshot.taskRunId
      || snapshot.resumePayload,
  )
  if (!hasHandle) return null
  return {
    skillId: snapshot.skillId,
    skillName: null,
    taskRunId: snapshot.taskRunId,
    detachedTaskId: snapshot.detachedTaskId,
    runStatePath: snapshot.runStatePath,
    outputDir: snapshot.outputDir,
    sceneScoresPath: snapshot.sceneScoresPath,
    deliveryReportPath: snapshot.deliveryReportPath,
    action: snapshot.action,
    source: 'supervisor',
    confidence: 92,
    status: snapshot.status,
    staleBlockerReason: snapshot.blockers[0] || null,
    observedAt: snapshot.observedAt,
  }
}

function contextFromTaskRun(run: SkillTaskRunRecord | null | undefined): ActiveSkillContext | null {
  if (!run?.skillId) return null
  if (run.status === 'done' && !run.resumePayload && !run.runStatePath && !run.outputDir) return null
  return {
    skillId: run.skillId,
    skillName: run.skillName || null,
    taskRunId: run.id,
    detachedTaskId: run.detachedTaskId || null,
    runStatePath: run.runStatePath || null,
    outputDir: run.outputDir || null,
    sceneScoresPath: run.sceneScoresPath || null,
    deliveryReportPath: run.deliveryReportPath || null,
    action: run.action || run.toolName || null,
    source: 'task_run',
    confidence: run.status === 'running' || run.status === 'blocked' ? 72 : 62,
    status: run.status,
    staleBlockerReason: run.failureDetail || null,
    observedAt: run.updatedAt,
  }
}

function contextFromReferenceHint(hint: ReferenceSkillHint | null | undefined): ActiveSkillContext | null {
  if (!hint?.id) return null
  return {
    skillId: hint.id,
    skillName: hint.name || hint.id,
    taskRunId: null,
    detachedTaskId: null,
    runStatePath: null,
    outputDir: null,
    sceneScoresPath: null,
    deliveryReportPath: null,
    action: null,
    source: 'reference_hint',
    confidence: 20,
    status: null,
    staleBlockerReason: null,
    observedAt: new Date(hint.at || Date.now()).toISOString(),
  }
}

function newestContext(contexts: Array<ActiveSkillContext | null>): ActiveSkillContext | null {
  return contexts
    .filter((context): context is ActiveSkillContext => Boolean(context))
    .sort((left, right) => {
      const confidenceDelta = right.confidence - left.confidence
      if (confidenceDelta !== 0) return confidenceDelta
      return parseTime(right.observedAt) - parseTime(left.observedAt)
    })[0] || null
}

function readProjectionContexts(sessionId: string | null): ActiveSkillContext[] {
  if (!sessionId) return []
  try {
    const database = getRepositoryDatabase()
    if (!database.getRawDb()) return []
    const repository = new TaskProjectionRepository(database)
    return repository.listByScope(sessionId).map(contextFromProjection).filter(Boolean) as ActiveSkillContext[]
  } catch {
    return []
  }
}

function readTaskRunContexts(sessionId: string | null): ActiveSkillContext[] {
  if (!sessionId) return []
  try {
    const database = getRepositoryDatabase()
    if (!database.getRawDb()) return []
    const repository = new SkillTaskRunRepository(database)
    const active = repository.listActiveBySession(sessionId, 20)
    const latest = repository.findLatestRecoverable({ sessionId, includeDone: true })
    return [...active, latest].map(contextFromTaskRun).filter(Boolean) as ActiveSkillContext[]
  } catch {
    return []
  }
}

function rememberedContext(sessionId: string | null): ActiveSkillContext | null {
  if (!sessionId) return null
  const context = rememberedContexts.get(sessionId) || null
  if (!context) return null
  if (Date.now() - parseTime(context.observedAt) > ACTIVE_CONTEXT_TTL_MS) {
    rememberedContexts.delete(sessionId)
    return null
  }
  return context
}

export function getRememberedActiveSkillContext(sessionId?: string | null): ActiveSkillContext | null {
  return rememberedContext(sessionKey(sessionId))
}

export function rememberActiveSkillContext(sessionId: string | null | undefined, context: ActiveSkillContext | null): void {
  const key = sessionKey(sessionId)
  if (!key || !context) return
  rememberedContexts.set(key, { ...context, observedAt: context.observedAt || nowIso() })
}

export function clearActiveSkillContext(sessionId?: string | null): void {
  const key = sessionKey(sessionId)
  if (key) {
    rememberedContexts.delete(key)
    return
  }
  rememberedContexts.clear()
}

export function resolveActiveSkillContextFromInputs(
  inputs: ResolveActiveSkillContextInputs,
): ActiveSkillContext | null {
  const sessionId = sessionKey(inputs.sessionId)
  if (inputs.explicitSkillId) {
    return {
      skillId: inputs.explicitSkillId,
      skillName: inputs.explicitSkillName || inputs.explicitSkillId,
      taskRunId: null,
      detachedTaskId: null,
      runStatePath: null,
      outputDir: null,
      sceneScoresPath: null,
      deliveryReportPath: null,
      action: null,
      source: 'explicit',
      confidence: 100,
      status: null,
      staleBlockerReason: null,
      observedAt: nowIso(),
    }
  }

  const supervisor = contextFromSupervisor(inputs.supervisorSnapshot)
  if (supervisor) return supervisor

  const remembered = rememberedContext(sessionId)
  if (remembered) return remembered

  const projection = newestContext((inputs.projections || []).map(contextFromProjection))
  if (projection) return projection

  const taskRun = newestContext((inputs.taskRuns || []).map(contextFromTaskRun))
  if (taskRun) return taskRun

  return contextFromReferenceHint(inputs.referenceHint ?? null)
}

export function resolveActiveSkillContext(inputs: ResolveActiveSkillContextInputs = {}): ActiveSkillContext | null {
  const sessionId = sessionKey(inputs.sessionId)
  const explicitOrSupervisor = resolveActiveSkillContextFromInputs({
    ...inputs,
    referenceHint: null,
  })
  if (explicitOrSupervisor) return explicitOrSupervisor

  const inspectedSupervisor = inputs.inspectSupervisor === false || !sessionId
    ? null
    : contextFromSupervisor(inspectLatestSkillTask({ sessionId, scopeId: sessionId, skillId: inputs.explicitSkillId || null }))
  if (inspectedSupervisor) return inspectedSupervisor

  const projection = newestContext([
    ...(inputs.projections || []).map(contextFromProjection),
    ...readProjectionContexts(sessionId),
  ])
  if (projection) return projection

  const taskRun = newestContext([
    ...(inputs.taskRuns || []).map(contextFromTaskRun),
    ...readTaskRunContexts(sessionId),
  ])
  if (taskRun) return taskRun

  return contextFromReferenceHint(inputs.referenceHint ?? (sessionId ? getLastReferenceSkill(sessionId) : null))
}

export function hasActiveSkillContext(sessionId?: string | null, skillId?: string | null): boolean {
  const context = resolveActiveSkillContext({ sessionId })
  if (!context) return false
  if (skillId && context.skillId !== skillId) return false
  return true
}

export function summarizeActiveSkillContext(context: ActiveSkillContext | null): Record<string, unknown> | null {
  if (!context) return null
  return {
    skillId: context.skillId,
    source: context.source,
    hasRunState: Boolean(context.runStatePath),
    hasOutputDir: Boolean(context.outputDir),
    status: context.status || null,
  }
}
