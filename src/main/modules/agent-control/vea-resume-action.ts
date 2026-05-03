export type VeaStage =
  | 'prepare'
  | 'score_batches'
  | 'merge_validate'
  | 'finalize'
  | 'completed'

export type VeaAction =
  | 'video_expert_pipeline'
  | 'video_expert_ai_analyze'

const VEA_ACTIONS = new Set<string>([
  'video_expert_pipeline',
  'video_expert_ai_analyze',
])

const VEA_STAGES = new Set<string>([
  'prepare',
  'score_batches',
  'merge_validate',
  'finalize',
  'completed',
])

const POST_SCORE_STAGES = new Set<string>([
  'score_batches',
  'merge_validate',
  'finalize',
])

export interface VeaResumeArtifacts {
  sceneScoresPath?: string | null
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

export function isVeaAction(value: unknown): value is VeaAction {
  const action = nonEmpty(value)
  return Boolean(action && VEA_ACTIONS.has(action))
}

export function isVeaStage(value: unknown): value is VeaStage {
  const stage = nonEmpty(value)
  return Boolean(stage && VEA_STAGES.has(stage))
}

export function resolveVeaResumeAction(
  stage: unknown,
  artifacts: VeaResumeArtifacts = {},
): VeaAction | null {
  const currentStage = nonEmpty(stage)
  if (!currentStage) return null
  if (isVeaAction(currentStage)) return currentStage
  if (POST_SCORE_STAGES.has(currentStage) && nonEmpty(artifacts.sceneScoresPath)) {
    return 'video_expert_ai_analyze'
  }
  return null
}
