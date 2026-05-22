import type { SkillState } from '../../skills-runtime/runtime-manager'
import type { SkillRunRecord } from '../session/session-continuity'
import type { TaskProjectionRecord } from '../contracts/run-contracts'

function normalizeLooseToken(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, '')
    .trim()
}

function parseUpdatedAt(value: string | null | undefined): number {
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function projectionSearchText(projection: TaskProjectionRecord): string {
  return [
    projection.taskTitle,
    projection.taskSummary,
    projection.blockedReason,
    ...(projection.steps || []).flatMap((step) => [step.title, step.description, step.detail]),
    ...(projection.recentArtifacts || []).flatMap((artifact) => [artifact.label, artifact.path, artifact.kind]),
  ].filter((item): item is string => typeof item === 'string' && item.trim().length > 0).join('\n')
}

function projectionStatusPriority(projection: TaskProjectionRecord): number {
  if (projection.status === 'failed' || projection.status === 'blocked') return 0
  if (projection.status === 'running' || projection.interactionState === 'resuming') return 1
  if (projection.status === 'completed') return 2
  return 3
}

function summarizeArtifacts(projection: TaskProjectionRecord): string {
  return (projection.recentArtifacts || [])
    .map((artifact) => [artifact.label, artifact.path, artifact.kind].filter(Boolean).join(' '))
    .filter(Boolean)
    .slice(0, 3)
    .join('；')
}

function isSkillProjection(projection: TaskProjectionRecord): boolean {
  if (projection.module === 'skill') return true
  const text = projectionSearchText(projection)
  return /技能执行|skill execution/i.test(text)
}

function findSkillForProjection(
  projection: TaskProjectionRecord,
  skills: SkillState[],
): SkillState | null {
  const normalizedText = normalizeLooseToken(projectionSearchText(projection))
  if (!normalizedText) return null
  for (const skill of skills) {
    const candidates = [skill.id, skill.name]
      .map(normalizeLooseToken)
      .filter((candidate) => candidate.length >= 6)
    if (candidates.some((candidate) => normalizedText.includes(candidate))) {
      return skill
    }
  }
  return null
}

function pickActionName(skill: SkillState): string {
  if (skill.defaultAction) return skill.defaultAction
  const runnable = skill.actions.find((action) => action.runtime !== 'reference')
  return runnable?.name || skill.actions[0]?.name || ''
}

export function recoverLatestSkillRunFromTaskProjections(params: {
  projections: TaskProjectionRecord[]
  skills: SkillState[]
  resolveSkillToolByAction?: (skillId: string, actionName: string) => { name?: string | null } | null
}): SkillRunRecord | null {
  if (!params.projections.length || !params.skills.length) return null

  const sorted = params.projections
    .filter(isSkillProjection)
    .slice()
    .sort((left, right) => {
      const priorityDelta = projectionStatusPriority(left) - projectionStatusPriority(right)
      if (priorityDelta !== 0) return priorityDelta
      return parseUpdatedAt(right.updatedAt) - parseUpdatedAt(left.updatedAt)
    })

  for (const projection of sorted) {
    const skill = findSkillForProjection(projection, params.skills)
    if (!skill) continue
    const continuationRef = projection.continuationRef || null
    const action = continuationRef?.action || pickActionName(skill)
    const toolName = action
      ? (params.resolveSkillToolByAction?.(skill.id, action)?.name || '')
      : ''
    return {
      toolName,
      skillId: skill.id,
      action,
      success: projection.status === 'completed',
      status: projection.status,
      runKind: 'task_projection',
      taskRunId: continuationRef?.taskRunId || undefined,
      detachedTaskId: continuationRef?.detachedTaskId || undefined,
      jobId: continuationRef?.jobId || undefined,
      outputDir: continuationRef?.outputDir || undefined,
      runStatePath: continuationRef?.runStatePath || undefined,
      pauseReason: continuationRef?.pauseReason || undefined,
      resumePayload: continuationRef ? { ...continuationRef } : undefined,
      summary: [
        `技能：${skill.name || skill.id}`,
        projection.taskTitle,
        projection.taskSummary ? `上次摘要/目标：${projection.taskSummary}` : '',
        projection.blockedReason ? `失败原因：${projection.blockedReason}` : '',
        summarizeArtifacts(projection) ? `输出目录或 artifact：${summarizeArtifacts(projection)}` : '',
      ].filter((item): item is string => typeof item === 'string' && item.trim().length > 0).join('；'),
      updatedAt: parseUpdatedAt(projection.updatedAt) || Date.now(),
    }
  }

  return null
}
