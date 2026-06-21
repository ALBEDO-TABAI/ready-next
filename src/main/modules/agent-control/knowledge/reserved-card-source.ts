/**
 * Reserved belief/site card `source` prefixes — single source of truth.
 *
 * These prefixes carry special lifecycle semantics and are produced ONLY by
 * Ready's own learning paths:
 *  - `possible-update-of:`      site-card-learning, suggested update of an existing card
 *  - `possible-risk-update-of:` site-card-learning, risk-suggestion variant
 *  - `possible-duplicate-of`    crystallize-gate, dedup marker (note: space, not colon)
 *  - `failure-learning:`        site-card-learning, new card from a failure signal
 *
 * A model-authored card MUST NOT be able to forge any of them: forging
 * `possible-(risk-)update-of:` lets the model drive a confused-deputy merge into
 * an ACTIVE card on a single user confirm (N-MWR-01). The generators below and
 * the model-write guard read this one list, so the guard can never again block a
 * subset and miss a sibling (the B4 regression).
 */
export const POSSIBLE_UPDATE_OF_PREFIX = 'possible-update-of:'
export const POSSIBLE_RISK_UPDATE_OF_PREFIX = 'possible-risk-update-of:'
export const POSSIBLE_DUPLICATE_OF_PREFIX = 'possible-duplicate-of'
export const FAILURE_LEARNING_PREFIX = 'failure-learning:'

export const RESERVED_CARD_SOURCE_PREFIXES: readonly string[] = [
  POSSIBLE_UPDATE_OF_PREFIX,
  POSSIBLE_RISK_UPDATE_OF_PREFIX,
  POSSIBLE_DUPLICATE_OF_PREFIX,
  FAILURE_LEARNING_PREFIX,
]

function normalize(source: string | null | undefined): string | null {
  if (typeof source !== 'string') return null
  return source.trim().toLowerCase()
}

/** True when `source` begins with ANY reserved system-generated prefix. */
export function isReservedCardSourceValue(source: string | null | undefined): boolean {
  const normalized = normalize(source)
  if (normalized === null) return false
  return RESERVED_CARD_SOURCE_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

/** True when `source` is the dedup marker produced by crystallize-gate.
 * Type guard: a match implies `source` is a (non-null) string. */
export function isPossibleDuplicateOfSource(source: string | null | undefined): source is string {
  return normalize(source)?.startsWith(POSSIBLE_DUPLICATE_OF_PREFIX) ?? false
}

/** True when `source` is the risk-suggestion update marker from site-card-learning.
 * Type guard: a match implies `source` is a (non-null) string. */
export function isPossibleRiskUpdateOfSource(source: string | null | undefined): source is string {
  return normalize(source)?.startsWith(POSSIBLE_RISK_UPDATE_OF_PREFIX) ?? false
}
