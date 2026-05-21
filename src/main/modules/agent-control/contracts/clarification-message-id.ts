/**
 * Stage S W6.2 — Stable clarification message ID.
 *
 * The renderer dedupes clarification capsules by message ID. Using the
 * agent's `toolCallId` as the stable anchor keeps the same clarification
 * collapsed across re-renders. When no toolCallId is available, fall back
 * to a content-derived sha256 prefix so identical questions still dedupe.
 */

import { createHash } from 'node:crypto'

export function buildClarificationMessageId(
  toolCallId: string | null | undefined,
  fallbackText?: string,
): string {
  if (toolCallId) return `clarification:${toolCallId}`
  const digest = createHash('sha256')
    .update(fallbackText || '')
    .digest('hex')
    .slice(0, 16)
  return `clarification:${digest}`
}
