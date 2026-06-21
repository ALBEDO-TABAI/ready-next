import type {
  SpecialistFoundationSemanticReviewDeps,
} from './specialist-foundation-semantic-judge'

export const SPECIALIST_FOUNDATION_SEMANTIC_JUDGE_UNAVAILABLE_REASONS = [
  'production_judge_not_configured',
  'production_judge_disabled',
] as const

export type SpecialistFoundationSemanticJudgeUnavailableReason =
  (typeof SPECIALIST_FOUNDATION_SEMANTIC_JUDGE_UNAVAILABLE_REASONS)[number]

export interface ResolvedSpecialistFoundationSemanticJudge {
  judge?: SpecialistFoundationSemanticReviewDeps['judge']
  unavailableReason?: SpecialistFoundationSemanticJudgeUnavailableReason
}

export function resolveSpecialistFoundationSemanticJudge(params: {
  judge?: SpecialistFoundationSemanticReviewDeps['judge']
  disabled?: boolean
} = {}): ResolvedSpecialistFoundationSemanticJudge {
  if (params.judge) return { judge: params.judge }
  return {
    unavailableReason: params.disabled
      ? 'production_judge_disabled'
      : 'production_judge_not_configured',
  }
}
