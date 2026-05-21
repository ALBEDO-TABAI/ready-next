/**
 * Stage S W6.1 — Clarification request type union.
 *
 * Frozen 5-type union per Stage S roadmap §6.7. The set is deliberately
 * closed: any future addition must update the gate
 * `scripts/check-clarification-type-enum-frozen.cjs` together with the
 * roadmap and consumer code.
 */

export const CLARIFICATION_TYPES = [
  'missing_info',
  'ambiguous_requirement',
  'approach_choice',
  'risk_confirmation',
  'suggestion',
] as const

export type ClarificationType = (typeof CLARIFICATION_TYPES)[number]

export interface ClarificationRequest {
  type: ClarificationType
  question: string
  options?: string[] | null
  toolCallId?: string
}
