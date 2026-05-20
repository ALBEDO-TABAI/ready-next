import { dirname } from 'node:path'

import { getRepositoryDatabase } from '../repositories/database-accessor'
import { TaskProjectionRepository } from '../repositories/task-projection-repository'
import {
  SkillTaskRunRepository,
  type SkillTaskRunRecord,
} from '../repositories/skill-task-run-repository'
import { getLastReferenceSkill, type ReferenceSkillHint } from './skills/skill-reference-hints'
import type { TaskProjectionRecord } from './run-contracts'
import {
  inspectLatestSkillTask,
  type SkillTaskSupervisorSnapshot,
} from './skills/skill-task-supervisor'
import { isVeaAction, resolveVeaResumeAction } from './vea-resume-action'

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
const VEA_SKILL_ID = 'video-expert-analyzer'
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

function normalizeVeaAction(value: unknown): string | null {
  const raw = nonEmpty(value)
  if (!raw) return null
  if (isVeaAction(raw)) return raw
  if (raw.startsWith('skill_')) {
    const unprefixed = raw.slice('skill_'.length)
    if (isVeaAction(unprefixed)) return unprefixed
  }
  return null
}

function resolveContextAction(args: {
  skillId: string
  knownAction?: unknown
  progressStage?: unknown
  sceneScoresPath?: string | null
}): string | null {
  const known = nonEmpty(args.knownAction)
  if (args.skillId !== VEA_SKILL_ID) return known

  const manifestAction = normalizeVeaAction(known)
  if (manifestAction) return manifestAction

  return resolveVeaResumeAction(known, { sceneScoresPath: args.sceneScoresPath })
    || resolveVeaResumeAction(args.progressStage, { sceneScoresPath: args.sceneScoresPath })
}

function skillIdFromProjection(projection: TaskProjectionRecord): string | null {
  const continuation = projection.continuationRef
  if (continuation?.skillId) return continuation.skillId
  const artifactSkill = firstArtifactMetaString(projection, 'skillId')
  if (artifactSkill) return artifactSkill
  // Stage Q (Stage 11) — accept both legacy `skill:S:K` (2 colons) and
  // future runKind-partitioned `skill:S:K:R` (3 colons) keys. The skill
  // id is always group 1; an optional `:runKind` tail is allowed but
  // not captured. PR-3 ships the regex update; the writer-side key
  // change can land in any subsequent PR without breaking this lookup.
  //
  // Stage Q PR-3 also reserves `primitive-output:` and `primitive-run-state:`
  // as continuity-payload taskId prefixes (see `rememberSkillRun` primitive
  // path in `tools/skills-tools.ts`). They MUST NOT be parsed as a skillId
  // even though they contain colons, so the second-segment negative
  // lookahead is extended below.
  const taskMatch = projection.taskId.match(
    /^skill:(?!detached:|run_state:|output:)[^:]+:(?!(?:primitive-output|primitive-run-state):)([^:]+)(?::[^:]+)?$/,
  )
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
  const sceneScoresPath =
    artifactPathByOutputKey(projection, 'sceneScoresPath')
    || pathEnding(projection, 'scene_scores.json')
  const rawAction =
    continuation?.action
    || firstArtifactMetaString(projection, 'action')
    || projection.currentStepId
    || null
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
    sceneScoresPath,
    deliveryReportPath:
      artifactPathByOutputKey(projection, 'deliveryReportPath')
      || pathEnding(projection, 'delivery_report.json'),
    action: resolveContextAction({
      skillId,
      knownAction: rawAction,
      progressStage: projection.currentStepId,
      sceneScoresPath,
    }),
    source: 'projection',
    confidence: projection.module === 'skill' ? 84 : 78,
    status: projection.status,
    staleBlockerReason: projection.blockedReason || null,
    observedAt: projection.updatedAt,
  }
}

function contextFromSupervisor(snapshot: SkillTaskSupervisorSnapshot | null | undefined): ActiveSkillContext | null {
  if (!snapshot?.skillId) return null
  // Phase 7 — supervisor public status uses `completed` instead of `done`.
  if (snapshot.closeAllowed && snapshot.status === 'completed') return null
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
    action: resolveContextAction({
      skillId: snapshot.skillId,
      knownAction: snapshot.action,
      progressStage: snapshot.progress?.currentStage,
      sceneScoresPath: snapshot.sceneScoresPath,
    }),
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
    action: resolveContextAction({
      skillId: run.skillId,
      knownAction: run.action || run.toolName || null,
      progressStage: null,
      sceneScoresPath: run.sceneScoresPath || null,
    }),
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

// Stage 4 W1 — pure-read variant. Same logic as `rememberedContext` but does
// NOT delete expired entries. Used by the shadow `SkillTurnIdentity` resolver
// snapshot collector so shadow reads cannot mutate the legacy state under
// inspection. Treat expired-as-invisible exactly like `rememberedContext`
// would, just without the side-effect.
function peekRememberedContext(sessionId: string | null): ActiveSkillContext | null {
  if (!sessionId) return null
  const context = rememberedContexts.get(sessionId) || null
  if (!context) return null
  if (Date.now() - parseTime(context.observedAt) > ACTIVE_CONTEXT_TTL_MS) {
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

  const projection = newestContext((inputs.projections || []).map(contextFromProjection))
  if (projection) return projection

  const taskRun = newestContext((inputs.taskRuns || []).map(contextFromTaskRun))
  if (taskRun) return taskRun

  const remembered = rememberedContext(sessionId)
  if (remembered) return remembered

  return contextFromReferenceHint(inputs.referenceHint ?? null)
}

export function resolveActiveSkillContext(inputs: ResolveActiveSkillContextInputs = {}): ActiveSkillContext | null {
  const sessionId = sessionKey(inputs.sessionId)
  const explicitOrProvidedContext = resolveActiveSkillContextFromInputs({
    ...inputs,
    sessionId: null,
    referenceHint: null,
  })
  if (explicitOrProvidedContext) return explicitOrProvidedContext

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

  const remembered = rememberedContext(sessionId)
  if (remembered) return remembered

  return contextFromReferenceHint(inputs.referenceHint ?? (sessionId ? getLastReferenceSkill(sessionId) : null))
}

// Stage 4 W1 — pure-read variant of `resolveActiveSkillContext` for the
// shadow `SkillTurnIdentity` resolver snapshot. Same composite logic as
// `resolveActiveSkillContext` (supervisor → projection → taskRun → remembered
// → reference hint) but:
//   1. Uses `peekRememberedContext` instead of `rememberedContext` so expired
//      remembered entries are NOT deleted while the shadow inspects them.
//   2. Does NOT fall through to `getLastReferenceSkill(sessionId)` — caller
//      MUST pass `inputs.referenceHint` explicitly (collector reads it once
//      via the orchestrator's read API, accepting that single TTL bump).
//   3. Does NOT call `inspectLatestSkillTask` itself — caller MUST pass
//      `inputs.supervisorSnapshot` explicitly (already collected once).
//
// Sub-task of W1 per v6 plan §4 — guarantees the shadow resolver's read
// surface is bounded by the snapshot, not by extra orchestrator calls.
export function resolveActiveSkillContextReadOnly(
  inputs: ResolveActiveSkillContextInputs = {},
): ActiveSkillContext | null {
  const sessionId = sessionKey(inputs.sessionId)

  const explicitOrProvidedContext = resolveActiveSkillContextFromInputs({
    ...inputs,
    sessionId: null,
    referenceHint: null,
  })
  if (explicitOrProvidedContext) return explicitOrProvidedContext

  // Pure-read: NO `inspectLatestSkillTask` call here. Caller must supply
  // `supervisorSnapshot` if it has one (collected once at snapshot time).
  const supervisor = contextFromSupervisor(inputs.supervisorSnapshot)
  if (supervisor) return supervisor

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

  const remembered = peekRememberedContext(sessionId)
  if (remembered) return remembered

  // Pure-read: only use the reference hint the caller already collected.
  // Do NOT call getLastReferenceSkill (which would bump TTL).
  return contextFromReferenceHint(inputs.referenceHint ?? null)
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
