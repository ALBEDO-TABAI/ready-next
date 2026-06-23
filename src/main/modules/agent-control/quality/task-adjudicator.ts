/**
 * EP2-Q4a — task adjudicator (02 §4), PURE judging function. Input: terminal
 * candidate + criteria + proofs; output: verdict + CheckIn. No I/O here —
 * the finalizer channel calls this and records the results.
 *
 * Hard rule (zero-proof): a `done` candidate with zero proofs is never
 * accepted — "模型说完成了" is not evidence. assistant_response digest IS a
 * legal proof (direct_answer's deliverable is the reply itself), so the rule
 * stays uniform across task types with no exemptions.
 *
 * Lifecycle policy belongs to the caller. Shadow callers observe only;
 * finalizer callers may enforce the verdict at the terminal funnel.
 */

import type { ProofRef } from './proof-collector'
import { isValidProofRef } from './proof-collector'
import type { CriteriaItem, CriteriaKind } from './criteria-templates'

export interface CheckInRecord {
  kind: 'shadow' | 'enforce'
  verdict: 'accept' | 'reject' | 'degraded'
  terminalStatus: string
  terminalReason: string
  satisfiedCount: number
  totalCount: number
  proofCount: number
  blockers: string[]
  ts: string
}

export const CHECKINS_LIMIT = 50

/** Which proof kinds can satisfy which criteria kinds (deterministic v1). */
const CRITERIA_PROOF_MAP: Record<CriteriaKind, ReadonlyArray<ProofRef['kind']>> = {
  response_digest: ['assistant_response'],
  tool_call: ['tool_result'],
  steps_complete: ['run_state', 'task_event'],
  artifact: ['artifact'],
  // A research report's sources are the search/fetch tool results themselves —
  // a synthesized inline answer (no written report file) must still be provable.
  report_sources: ['artifact', 'tool_result'],
  media_file: ['artifact'],
  collection_verdict: ['task_event', 'artifact'],
  result_parseable: ['artifact', 'tool_result'],
  skill_run_state: ['run_state'],
  document_diff: ['artifact', 'tool_result'],
  scope_compliance: ['tool_result', 'artifact'],
}

export interface AdjudicationInput {
  /** Terminal candidate from the finalizer (RunOutcome.kind-derived status). */
  terminalStatus: string
  terminalReason: string
  criteria: ReadonlyArray<CriteriaItem>
  proofs: ReadonlyArray<unknown>
  mode?: CheckInRecord['kind']
  /** Q4b admission: learning refs must exist on disk BEFORE bookkeeping. */
  learningRefsValid?: boolean
  now: Date
}

export interface AdjudicationResult {
  verdict: CheckInRecord['verdict']
  checkIn: CheckInRecord
}

export function adjudicateTerminalOutcome(input: AdjudicationInput): AdjudicationResult {
  const proofs = input.proofs.filter(isValidProofRef)
  const presentKinds = new Set(proofs.map((proof) => proof.kind))
  const applicable = input.criteria.filter((item) => !item.notApplicable)
  const satisfied = applicable.filter((item) =>
    (CRITERIA_PROOF_MAP[item.kind] ?? []).some((kind) => presentKinds.has(kind)))

  const blockers: string[] = []
  let verdict: CheckInRecord['verdict'] = 'accept'

  if (input.learningRefsValid === false) {
    verdict = 'degraded'
    blockers.push('learning_refs_missing')
  }
  if (input.terminalStatus === 'done') {
    if (proofs.length === 0) {
      verdict = 'reject'
      blockers.push('zero_proof_done')
    } else if (satisfied.length < applicable.length) {
      // unsatisfied criteria on a done candidate: degraded (shadow surfaces
      // it; enforce-mode policy belongs to Q4b)
      if (verdict === 'accept') verdict = 'degraded'
      blockers.push(...applicable
        .filter((item) => !satisfied.includes(item))
        .map((item) => `criteria_unsatisfied:${item.id}`))
    }
  }

  return {
    verdict,
    checkIn: {
      kind: input.mode ?? 'shadow',
      verdict,
      terminalStatus: input.terminalStatus,
      terminalReason: input.terminalReason,
      satisfiedCount: satisfied.length,
      totalCount: applicable.length,
      proofCount: proofs.length,
      blockers,
      ts: input.now.toISOString(),
    },
  }
}

/** Rolling append, same governance shape as proof refs (limit 50 + archive). */
export function appendCheckIns(
  existing: unknown,
  addition: CheckInRecord,
  opts: { limit?: number; archive?: (rows: unknown[]) => void } = {},
): unknown[] {
  const limit = opts.limit ?? CHECKINS_LIMIT
  const base = Array.isArray(existing) ? existing : []
  const merged = [...base, addition]
  if (merged.length <= limit) return merged
  const overflow = merged.slice(0, merged.length - limit)
  if (opts.archive) {
    try { opts.archive(overflow) } catch { /* archive failure must not lose the write */ }
  }
  return merged.slice(merged.length - limit)
}
