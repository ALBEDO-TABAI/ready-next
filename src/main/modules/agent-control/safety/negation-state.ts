/**
 * EP2-I2 — standing negation state, session-lineage lifetime (05 §2.2).
 *
 * Layer 1 (exposure suppression) already exists in S4-1; this module powers
 * layer 2: the dispatch-time interception. A negation recorded here stays
 * active for the scope until an EXPLICIT release signal ("现在可以采集了")
 * clears it — not merely the next turn. In-memory only: a restart clears
 * standing negations (conservative default — the user re-states intent).
 *
 * Tool → family mapping is conservative by name: only unambiguous matches
 * intercept. `retry` is loop behavior, not a dispatchable tool family.
 */

import type { FollowupNegationFamily } from '../../../../shared/agent-followup-intent'

const scopeNegations = new Map<string, Set<FollowupNegationFamily>>()

export function recordNegations(scopeId: string, families: ReadonlyArray<FollowupNegationFamily>): void {
  if (!scopeId || families.length === 0) return
  const set = scopeNegations.get(scopeId) ?? new Set<FollowupNegationFamily>()
  for (const family of families) set.add(family)
  scopeNegations.set(scopeId, set)
}

export function releaseNegations(scopeId: string, families: ReadonlyArray<FollowupNegationFamily>): void {
  const set = scopeNegations.get(scopeId)
  if (!set) return
  for (const family of families) set.delete(family)
  if (set.size === 0) scopeNegations.delete(scopeId)
}

export function activeNegations(scopeId: string | null | undefined): FollowupNegationFamily[] {
  if (!scopeId) return []
  return [...(scopeNegations.get(scopeId) ?? [])]
}

export function __clearNegationStateForTests(): void {
  scopeNegations.clear()
}

const FAMILY_TOOL_PATTERNS: ReadonlyArray<{ family: FollowupNegationFamily; pattern: RegExp }> = [
  { family: 'collection', pattern: /^browser_(visible_collect|collect|run_workflow|download_collected_media|batch)/ },
  { family: 'browser', pattern: /^browser_/ },
  { family: 'deletion', pattern: /(?:_delete|_remove|delete_|remove_)/ },
  { family: 'external_send', pattern: /(?:message_send|send_message|send_email|feishu_send)/ },
  { family: 'overwrite', pattern: /overwrite/ },
]

/** First negated family the tool name unambiguously belongs to, else null. */
export function matchToolNegationFamily(
  toolName: string,
  families: ReadonlyArray<FollowupNegationFamily>,
): FollowupNegationFamily | null {
  for (const { family, pattern } of FAMILY_TOOL_PATTERNS) {
    if (families.includes(family) && pattern.test(toolName)) return family
  }
  return null
}
