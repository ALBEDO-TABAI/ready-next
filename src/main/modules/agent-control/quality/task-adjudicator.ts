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

import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, parse } from 'node:path'
import type { ProofRef } from './proof-collector'
import {
  isValidProofRef,
  RESEARCH_SOURCE_BUNDLED_TOOL_NAMES,
  RESEARCH_SOURCE_CONTENT_TOOL_NAMES,
  RESEARCH_SOURCE_DISCOVERY_TOOL_NAMES,
} from './proof-collector'
import type { CriteriaItem, CriteriaKind } from './criteria-templates'
import { normalizeDeliveryTarget } from './criteria-templates'

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
  /** P2-5 (2026-07-03) — observable learning decision for this terminal run:
   *  did it produce durable, learnable evidence (learningRefs) that the
   *  specialist task-evolution pipeline can draft a proposal from? `learned`
   *  false = nothing to crystallize (direct answers, pure lookups). */
  learningDecision?: { learned: boolean; refCount: number }
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
  report_sources: [],
  media_file: ['artifact'],
  collection_verdict: ['task_event', 'artifact'],
  result_parseable: ['artifact', 'tool_result'],
  skill_run_state: ['run_state'],
  document_diff: ['artifact', 'tool_result'],
  scope_compliance: ['tool_result', 'artifact'],
  transaction_confirmed: ['transaction_confirmed'],
  // R-CRIT (方案 b) — artifact is the proof SOURCE, but delivery_coverage is NOT
  // satisfied by bare presence: it is counted one-to-one against declared
  // targets (see resolveDeliveryCoverage). This map entry only documents the
  // source kind; the counting path bypasses the presentKinds membership test.
  delivery_coverage: ['artifact'],
}

function reportSourceToolName(proof: ProofRef): string | null {
  if (proof.kind !== 'tool_result' || !proof.sourceReceipt?.urls.length) return null
  return proof.sourceReceipt.acquisitionTool || proof.ref.split(':', 1)[0] || null
}

function hasReportSourceCoverage(proofs: ReadonlyArray<ProofRef>): boolean {
  if (proofs.some((proof) => proof.sourceReceipt?.acquisitionKind === 'answer')) return true
  const sourceTools = proofs
    .map(reportSourceToolName)
    .filter((toolName): toolName is string => Boolean(toolName))
  if (sourceTools.some((toolName) => RESEARCH_SOURCE_BUNDLED_TOOL_NAMES.has(toolName))) return true
  return sourceTools.some((toolName) => RESEARCH_SOURCE_DISCOVERY_TOOL_NAMES.has(toolName))
    && sourceTools.some((toolName) => RESEARCH_SOURCE_CONTENT_TOOL_NAMES.has(toolName))
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
  /** P2-5: durable learning evidence derived from the run (finalizer supplies
   *  a subset of proofRefs). Drives checkIn.learningDecision; empty = no
   *  crystallizable learning this run (not a failure). */
  learningRefs?: ReadonlyArray<unknown>
  now: Date
}

export interface CriteriaResolution {
  id: string
  kind: CriteriaKind
  satisfied: boolean
  /** Only on delivery_coverage items — how many declared targets were backed
   *  by a delivered artifact (one-to-one), and how many were declared. */
  coverage?: { delivered: number; expected: number }
}

export interface AdjudicationResult {
  verdict: CheckInRecord['verdict']
  checkIn: CheckInRecord
  /** R-CRIT — per-criterion resolution detail for observability (the finalizer
   *  logs delivery_coverage/na as `adjudicator_criteria_resolved`). Not persisted. */
  criteriaResolutions: CriteriaResolution[]
}

// Coverage tokens are normalized by the SHARED normalizeDeliveryTarget (defined
// in criteria-templates) so the producer-filter and this counter agree exactly
// on which targets are real (review finding: filter mismatch).
function canonicalizeCoveragePath(pathToken: string): string {
  if (!isAbsolute(pathToken)) return pathToken
  let current = pathToken
  const missingSegments: string[] = []
  const root = parse(pathToken).root
  while (current !== root && !existsSync(current)) {
    missingSegments.unshift(current.slice(dirname(current).length).replace(/^[/\\]+/, ''))
    current = dirname(current)
  }
  try {
    return join(realpathSync.native(current), ...missingSegments).replace(/\\/g, '/')
  } catch {
    // silent-catch: canonicalization is best-effort; retain the normalized path when realpath is unavailable.
    return pathToken
  }
}

const normalizeCoverageToken = (value: unknown): string =>
  canonicalizeCoveragePath(normalizeDeliveryTarget(value))

function coverageBasename(pathToken: string): string {
  const index = pathToken.lastIndexOf('/')
  return index >= 0 ? pathToken.slice(index + 1) : pathToken
}

/** Does a delivered artifact path satisfy an expected delivery target? Matching
 *  is PATH-ANCHORED: exact, a directory the artifact sits under, or a path
 *  suffix. A bare basename match is allowed ONLY when the declared target has
 *  no directory part (the user named just a file) — otherwise an intermediate
 *  write elsewhere with a colliding basename would wrongly satisfy a full-path
 *  target (review finding: loose basename matching). */
function deliveredSatisfiesTarget(deliveredPath: string, expectedTarget: string): boolean {
  const delivered = normalizeCoverageToken(deliveredPath)
  const expected = normalizeCoverageToken(expectedTarget)
  if (!delivered || !expected) return false
  if (delivered === expected) return true
  if (delivered.startsWith(`${expected}/`)) return true          // expected = directory containing delivered
  if (delivered.endsWith(`/${expected}`)) return true            // expected = path suffix (anchored; incl bare filename)
  if (!expected.includes('/') && coverageBasename(delivered) === expected) return true // expected = bare filename
  return false
}

/**
 * R-CRIT (方案 b) — count, ONE-TO-ONE over DISTINCT real deliveries, how many
 * declared delivery targets are backed by a delivered artifact. A single real
 * file (even if proof-collected multiple times) can cover at most one target,
 * so N declared outputs genuinely need N distinct deliveries — that is what
 * makes "delivered 1 of 2" fail while the old proof-kind test (single artifact
 * satisfies) could not.
 *
 * Two correctness guards from the P1 adversarial review:
 *   • DEDUP delivered paths first — N proof copies of one path must NOT cover N
 *     targets (the proof collector mints duplicate artifact proofs for a path
 *     re-mentioned across a multi-step run).
 *   • MAXIMUM bipartite matching (Kuhn) rather than greedy first-match — a
 *     permissive target must not consume the only artifact a restrictive target
 *     needs and starve it (which would false-reject a COMPLETE delivery). N is
 *     tiny (declared outputs), so the O(V·E) augmenting-path search is trivial.
 *
 * Caveat (tracked with the deferred producer): the delivered set is every
 * artifact proof, which includes auxiliary paths (run_state/report) the
 * collector harvests; the producer should emit specific file/path targets
 * (not bare directories) so an auxiliary write in the target dir can't satisfy
 * a directory target. Directory targets remain supported but carry this caveat.
 */
export function resolveDeliveryCoverage(
  expectedTargets: ReadonlyArray<string>,
  deliveredArtifactPaths: ReadonlyArray<string>,
): { delivered: number; expected: number } {
  // ASYMMETRY (deliberate): delivered paths ARE deduped (N proof copies of one
  // real file must cover ≤1 target); expected targets are NOT — the incident is
  // "2 docs to the SAME directory V/", i.e. expected=[V, V], and deduping that to
  // [V] would collapse expected to 1 → a single delivered doc would falsely count
  // as complete (2/2), silently accepting the under-delivery. So N declared
  // outputs stay N even when identical. Producer contract (deferred): emit one
  // DISTINCT target per deliverable; duplicate identical FULL-FILE targets are a
  // producer bug and fail-closed here (a complete delivery under-counts), which
  // is the safe direction — never a silent false-accept.
  const expected = expectedTargets.map(normalizeCoverageToken).filter(Boolean)
  const delivered = [...new Set(deliveredArtifactPaths.map(normalizeCoverageToken).filter(Boolean))]
  // adjacency: for each declared target, the distinct delivered paths that satisfy it
  const candidates = expected.map((target) => {
    const indices: number[] = []
    delivered.forEach((path, index) => { if (deliveredSatisfiesTarget(path, target)) indices.push(index) })
    return indices
  })
  // Kuhn's augmenting-path maximum bipartite matching (targets ← deliveries).
  const matchedDeliveryToTarget = new Array<number>(delivered.length).fill(-1)
  const augment = (targetIndex: number, visited: boolean[]): boolean => {
    for (const deliveryIndex of candidates[targetIndex]) {
      if (visited[deliveryIndex]) continue
      visited[deliveryIndex] = true
      if (matchedDeliveryToTarget[deliveryIndex] === -1
        || augment(matchedDeliveryToTarget[deliveryIndex], visited)) {
        matchedDeliveryToTarget[deliveryIndex] = targetIndex
        return true
      }
    }
    return false
  }
  let deliveredCount = 0
  for (let targetIndex = 0; targetIndex < expected.length; targetIndex += 1) {
    if (augment(targetIndex, new Array<boolean>(delivered.length).fill(false))) deliveredCount += 1
  }
  return { delivered: deliveredCount, expected: expected.length }
}

export function adjudicateTerminalOutcome(input: AdjudicationInput): AdjudicationResult {
  const proofs = input.proofs.filter(isValidProofRef)
  const presentKinds = new Set(proofs.map((proof) => proof.kind))
  const deliveredArtifactPaths = proofs
    .filter((proof) => proof.kind === 'artifact')
    .map((proof) => proof.ref)
  const applicable = input.criteria.filter((item) => !item.notApplicable)
  const resolutions: CriteriaResolution[] = applicable.map((item) => {
    if (item.kind === 'delivery_coverage') {
      // R-CRIT (方案 b) — counted, NOT proof-kind membership. resolveCriteria
      // only emits this kind with ≥1 declared target; if every declared target
      // normalizes to empty (a producer contract violation, e.g. all separators/
      // quotes) expected===0 — do NOT vacuously pass (review finding), treat the
      // unresolvable declaration as UNSATISFIED so the problem surfaces.
      const expectedTargets = Array.isArray(item.expected) ? item.expected : []
      const coverage = resolveDeliveryCoverage(expectedTargets, deliveredArtifactPaths)
      const isSatisfied = coverage.expected > 0 && coverage.delivered >= coverage.expected
      return { id: item.id, kind: item.kind, satisfied: isSatisfied, coverage }
    }
    if (item.kind === 'report_sources') {
      return {
        id: item.id,
        kind: item.kind,
        satisfied: hasReportSourceCoverage(proofs),
      }
    }
    const isSatisfied = (CRITERIA_PROOF_MAP[item.kind] ?? []).some((kind) => presentKinds.has(kind))
    return { id: item.id, kind: item.kind, satisfied: isSatisfied }
  })
  const satisfied = applicable.filter((item, index) => resolutions[index].satisfied)

  const blockers: string[] = []
  let verdict: CheckInRecord['verdict'] = 'accept'

  if (input.terminalStatus !== 'done') {
    verdict = input.terminalStatus === 'checkpoint' ? 'degraded' : 'reject'
    blockers.push(`terminal_not_done:${input.terminalStatus}`)
  }
  if (input.learningRefsValid === false) {
    if (verdict === 'accept') verdict = 'degraded'
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

  const learningRefCount = Array.isArray(input.learningRefs)
    ? input.learningRefs.filter((ref) => ref != null).length
    : 0

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
      // P2-5 — only accepted runs that produced durable evidence carry a
      // positive learning decision; the specialist pipeline gates on this.
      learningDecision: { learned: verdict === 'accept' && learningRefCount > 0, refCount: learningRefCount },
    },
    criteriaResolutions: resolutions,
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
    try { opts.archive(overflow) } catch { /* silent-catch: archive failure must not lose the write */ }
  }
  return merged.slice(merged.length - limit)
}
