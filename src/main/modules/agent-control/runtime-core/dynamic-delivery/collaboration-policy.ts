import type {
  CollaborationDecision,
  DeliveryPreflightFacts,
} from '../../../../../shared/dynamic-delivery'

const NEVER_COLLABORATE = new Set(['direct_answer', 'short_task', 'continuation', 'browser_transaction'])
const SUPPORT_ELIGIBLE = new Set(['multi_step_task', 'research', 'media_task'])

export function decideDynamicDelivery(facts: DeliveryPreflightFacts): CollaborationDecision {
  if (facts.mode === 'standard') return 'single_path'
  if (facts.hasUnknownRequiredFact) return 'single_path'
  if (facts.risk !== 'ordinary') return 'single_path'
  if (NEVER_COLLABORATE.has(facts.taskType)) return 'single_path'
  if (facts.budget.remainingTokens < facts.budget.ownerReservedTokens) return 'single_path'
  if (facts.budget.remainingWallClockMs <= 0) return 'single_path'

  const hasReadyParticipant = facts.profiles.some((profile) => profile.collaborationReady)
  if (
    hasReadyParticipant
    && SUPPORT_ELIGIBLE.has(facts.taskType)
    && facts.structuredTargetCount >= 2
  ) {
    return 'support_and_verify'
  }

  if (facts.taskType === 'multi_step_task' || facts.taskType === 'research' || facts.taskType === 'media_task') {
    return 'verify_only'
  }
  return 'single_path'
}
