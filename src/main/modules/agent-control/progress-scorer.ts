import type { ToolExecutionOutput } from './tool-result-types'
import type { SkillTaskSupervisorSnapshot } from './skill-task-supervisor'

export interface SkillProgressScore {
  score: number
  reasons: string[]
  fingerprint: string | null
  fingerprintChanged: boolean
  milestoneChanged: boolean
}
export interface SkillProgressScorerInput {
  previousFingerprint?: string | null
  previousSnapshot?: SkillTaskSupervisorSnapshot | null
  currentSnapshot?: SkillTaskSupervisorSnapshot | null
  executedTools?: Array<{
    name: string
    result?: ToolExecutionOutput | null
  }>
}

function numberValue(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function artifactPaths(tools: SkillProgressScorerInput['executedTools']): string[] {
  const paths: string[] = []
  for (const tool of tools || []) {
    const data = tool.result?.data
    if (!data || typeof data !== 'object') continue
    for (const key of ['absolutePath', 'outputDir', 'runStatePath', 'sceneScoresPath', 'deliveryReportPath']) {
      const value = stringValue((data as Record<string, unknown>)[key])
      if (value) paths.push(value)
    }
  }
  return Array.from(new Set(paths))
}

function milestoneFromToolResult(tools: SkillProgressScorerInput['executedTools']): string | null {
  for (const tool of tools || []) {
    const data = tool.result?.data
    if (!data || typeof data !== 'object') continue
    const rec = data as Record<string, unknown>
    const milestone = stringValue(rec.currentStage)
      || stringValue(rec.current_stage)
      || stringValue(rec.stage)
      || stringValue(rec.status)
    if (milestone) return `${tool.name}:${milestone}`
  }
  return null
}

export function scoreSkillProgress(input: SkillProgressScorerInput): SkillProgressScore {
  const reasons: string[] = []
  let score = 0
  const current = input.currentSnapshot || null
  const previous = input.previousSnapshot || null
  const fingerprint = current?.progressFingerprint || null
  const fingerprintChanged = Boolean(fingerprint && fingerprint !== (input.previousFingerprint || null))
  if (fingerprintChanged) {
    score += 2
    reasons.push('fingerprint_changed')
  }

  const currentCompletedScenes = numberValue(current?.progress.completedScenes)
  const previousCompletedScenes = numberValue(previous?.progress.completedScenes)
  if (
    currentCompletedScenes !== null
    && previousCompletedScenes !== null
    && currentCompletedScenes > previousCompletedScenes
  ) {
    score += 2
    reasons.push('completed_scenes_increased')
  }

  const currentCoverage = numberValue(current?.progress.coverageRatio)
  const previousCoverage = numberValue(previous?.progress.coverageRatio)
  if (currentCoverage !== null && previousCoverage !== null && currentCoverage > previousCoverage) {
    score += 2
    reasons.push('coverage_increased')
  }

  if (
    stringValue(current?.progress.currentStage)
    && stringValue(current?.progress.currentStage) !== stringValue(previous?.progress.currentStage)
  ) {
    score += 2
    reasons.push('stage_changed')
  }

  if (
    stringValue(current?.progress.updatedAt)
    && stringValue(current?.progress.updatedAt) !== stringValue(previous?.progress.updatedAt)
  ) {
    score += 1
    reasons.push('updated_at_changed')
  }

  const artifacts = artifactPaths(input.executedTools)
  if (artifacts.length > 0) {
    score += 2
    reasons.push('artifact_path_returned')
  }

  const typedMilestone = milestoneFromToolResult(input.executedTools)
  if (typedMilestone) {
    score += 2
    reasons.push('typed_action_milestone')
  }

  return {
    score,
    reasons,
    fingerprint,
    fingerprintChanged,
    milestoneChanged: fingerprintChanged || reasons.some((reason) =>
      reason === 'completed_scenes_increased'
        || reason === 'coverage_increased'
        || reason === 'stage_changed'
        || reason === 'artifact_path_returned'
        || reason === 'typed_action_milestone',
    ),
  }
}
