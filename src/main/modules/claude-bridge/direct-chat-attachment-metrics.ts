import { logAgentMetric } from '../agent-control/metrics'

/**
 * Stage 2.2 — throttle wrapper for the `attachment_load_failed` metric.
 *
 * `DirectChatEngine.getSessionAttachmentResources` is invoked on a polling
 * cadence by the renderer (every ~2s during active sessions, plus from
 * structured request-envelope assembly on every message). If the underlying
 * `chatRepository.listConversationAttachments` call starts erroring (DB
 * lock, disk full, etc.) and we emit a metric on every miss, the rotating
 * log fills up in seconds.
 *
 * This helper de-duplicates emissions per `(sessionId, reason)` within a
 * cooldown window (60s by default). First failure of a fresh key emits;
 * subsequent failures within the window are suppressed; after the window
 * the next failure emits again.
 *
 * Lives in its own module (no Electron deps) so it can be unit-tested
 * under plain Node, matching the 2.4a precedent of `direct-chat-ai-config.ts`.
 *
 * **Scope**: request-envelope assembly intentionally still consumes the legacy
 * `getSessionAttachmentResources(): []` shape, so on DB errors it sees
 * "0 attachments" — that's the known compromise documented in plan §5.3.
 * The metric is the only visibility this stage adds; full migration to a
 * detailed `AttachmentLoad` interface is deferred to Stage 3 once a real
 * `sendMessage`-path consumer exists.
 */
export class AttachmentLoadFailureThrottle {
  private last = new Map<string, number>()
  private readonly cooldownMs: number
  private readonly clock: () => number

  constructor(cooldownMs = 60_000, clock: () => number = Date.now) {
    this.cooldownMs = cooldownMs
    this.clock = clock
  }

  /**
   * Emit `attachment_load_failed` if not throttled by `(sessionId, reason)`.
   * Returns `true` if emitted, `false` if suppressed by cooldown.
   *
   * Empty / undefined `sessionId` collapses into a single throttle bucket
   * (`<no-session>`) — losing some granularity but bounded so a stuck path
   * cannot exhaust the throttle map's memory.
   */
  maybeEmit(
    sessionId: string | undefined,
    reason: 'db_error' | 'fs_error',
    extra: Record<string, unknown> = {},
  ): boolean {
    const key = `${sessionId || '<no-session>'}|${reason}`
    const now = this.clock()
    const last = this.last.get(key) ?? 0
    if (now - last < this.cooldownMs) return false
    this.last.set(key, now)
    logAgentMetric('attachment_load_failed', {
      sessionId: sessionId ?? null,
      reason,
      ...extra,
    })
    return true
  }
}
