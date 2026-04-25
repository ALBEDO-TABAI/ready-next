import type {
  ScopeRunResumableAction,
  ScopeRunTaskStep,
  ScopeRunWaitingFor,
} from './types'

export type SkillTaskEventStatus = 'running' | 'done' | 'blocked' | 'error'

export interface SkillTaskEvent {
  sessionId?: string
  skillId?: string
  skillName?: string
  toolName: string
  status: SkillTaskEventStatus
  message?: string
  artifactPath?: string | null
  artifactLabel?: string | null
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
    executionId: string
    stepId?: string | null
    blockerType?: string | null
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

export function recordSkillTaskEvent(event: SkillTaskEvent): void {
  const projection = getOrCreateProjection(event)
  const updatedAt = new Date().toISOString()
  const stepId = event.toolName
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
  projection.blockedReason = event.status === 'blocked' ? event.message || '等待用户补充信息' : null
  projection.waitingFor = event.status === 'blocked' ? 'input' : 'none'
  projection.resumableActions = event.status === 'blocked'
    ? ['continue', 'cancel']
    : event.artifactPath
      ? ['open_artifact']
      : ['none']
  projection.taskContinuation = event.status === 'blocked'
    ? {
      executionId: projection.taskId,
      stepId,
      blockerType: 'need_input',
    }
    : null

  if (event.artifactPath) {
    const label = event.artifactLabel || event.artifactPath.split(/[\\/]/).pop() || '技能产物'
    projection.recentArtifacts = [
      ...projection.recentArtifacts,
      {
        id: `${stepId}:${updatedAt}`,
        module: 'skill',
        kind: event.toolName === 'skill_read_artifact' ? 'read_artifact' : 'artifact',
        label,
        path: event.artifactPath,
        createdAt: updatedAt,
        meta: {
          skillId: event.skillId || null,
          toolName: event.toolName,
        },
      },
    ].slice(-6)
  }
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

export function clearSkillTaskProjection(sessionId?: string): void {
  if (sessionId) {
    projectionsBySession.delete(sessionKey(sessionId))
    return
  }
  projectionsBySession.clear()
}
