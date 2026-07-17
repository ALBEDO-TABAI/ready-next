import { stepCollectionIntentTtl } from '../../../../shared/browser-collection-intent'
import type { BrowserWorkIntent } from '../../../../shared/browser-work-intent'

const COLLECTION_INTENT_TTL_TURNS = 6

/**
 * Per-session browser-collection-intent TTL (continuity). Synchronous — never
 * adds an `await` to the run() hot path. Awaiting session history here used to
 * create a window where a preempting run could abort the controller before
 * runAgent attached its abort listener (missed abort → hang); a sync TTL map
 * avoids that ordering hazard entirely.
 *
 * When a turn's message expresses collection intent, the surface stays exposed
 * for the next few turns so a bare follow-up ("再试一次") keeps the browser
 * tools available, then decays.
 *
 * Extracted from AgentSdkRuntime (V3 Phase 2). Pure in-memory state — no
 * dependency on the runtime instance.
 */
export class AgentSdkIntentTracker {
  private readonly browserWorkIntents = new Map<string, BrowserWorkIntent>()
  private readonly localSendImIntentTtl = new Map<string, number>()

  /** Update the TTL for THIS turn and return whether a recent turn (incl. now) had intent. */
  private trackIntentTtl(
    ttlMap: Map<string, number>,
    sessionId: string | undefined,
    currentMessageHasIntent: boolean,
  ): boolean {
    const sid = sessionId || ''
    if (!sid) return currentMessageHasIntent
    const prior = ttlMap.get(sid) ?? 0
    const { recent, nextTtl } = stepCollectionIntentTtl(
      prior,
      currentMessageHasIntent,
      COLLECTION_INTENT_TTL_TURNS,
    )
    if (nextTtl > 0) ttlMap.set(sid, nextTtl)
    else ttlMap.delete(sid)
    return recent
  }

  trackBrowserWorkIntent(
    sessionId: string | undefined,
    current: BrowserWorkIntent,
    followupKind: 'continue_task' | 'status_query' | 'correction' | 'new_task',
  ): BrowserWorkIntent {
    const sid = sessionId || ''
    if (!sid) return current
    if (current.kind !== 'observe') {
      this.browserWorkIntents.set(sid, current)
      return current
    }
    if (followupKind === 'continue_task' || followupKind === 'correction') {
      return this.browserWorkIntents.get(sid) || current
    }
    if (followupKind === 'new_task') this.browserWorkIntents.delete(sid)
    return current
  }

  trackLocalSendImIntent(sessionId: string | undefined, currentMessageHasIntent: boolean): boolean {
    return this.trackIntentTtl(this.localSendImIntentTtl, sessionId, currentMessageHasIntent)
  }

  /**
   * On a local-send-im turn, clear collection + batch-collection intent so the
   * send turn does not inherit a stale browser-collection surface.
   */
  resetCollectionIntents(sessionId: string): void {
    this.browserWorkIntents.delete(sessionId)
  }
}
