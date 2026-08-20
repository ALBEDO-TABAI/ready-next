/**
 * Reserved belief/site card `source` prefixes — single source of truth.
 *
 * These prefixes carry historical lifecycle semantics. Ready no longer
 * produces them, but the read-only emergence feed still recognizes staged
 * cards that were written by older versions.
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

/** True when `source` is a legacy dedup marker.
 * Type guard: a match implies `source` is a (non-null) string. */
export function isPossibleDuplicateOfSource(source: string | null | undefined): source is string {
  return normalize(source)?.startsWith(POSSIBLE_DUPLICATE_OF_PREFIX) ?? false
}

/** True when `source` is a legacy risk-suggestion update marker.
 * Type guard: a match implies `source` is a (non-null) string. */
export function isPossibleRiskUpdateOfSource(source: string | null | undefined): source is string {
  return normalize(source)?.startsWith(POSSIBLE_RISK_UPDATE_OF_PREFIX) ?? false
}
