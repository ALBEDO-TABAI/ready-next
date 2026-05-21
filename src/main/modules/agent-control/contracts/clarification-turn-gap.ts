/**
 * Clarification turn-gap dispatcher (Stage S W6.3).
 *
 * Per roadmap §6.7: clarification triggers in the gap between agent turns,
 * NOT inside a middleware chain. This rejects deer-flow's `goto END` middleware
 * pattern which conflicts with §6.10 single-arbitration controller.
 *
 * Wire-up: turn-engine post-tool-batch hook calls `shouldTriggerClarification`
 * and if true, surfaces ClarificationRequest to ask-user-bridge for renderer
 * pickup. Does NOT swallow the turn — the agent reply still completes.
 *
 * TODO(stage-s-followup): wire into turn-engine post-batch processing.
 */

import type { ClarificationRequest } from './clarification-types'

export interface ClarificationGapContext {
  toolBatchHadAskUser: boolean
  pendingClarification: ClarificationRequest | null
}

export function shouldTriggerClarification(ctx: ClarificationGapContext): boolean {
  return ctx.toolBatchHadAskUser && ctx.pendingClarification != null
}
