import { stepCollectionIntentTtl } from '../../../../shared/browser-collection-intent'

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
  private readonly collectionIntentTtl = new Map<string, number>()
  private readonly batchCollectionIntentTtl = new Map<string, number>()
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

  trackCollectionIntent(sessionId: string | undefined, currentMessageHasIntent: boolean): boolean {
    return this.trackIntentTtl(this.collectionIntentTtl, sessionId, currentMessageHasIntent)
  }

  trackBatchCollectionIntent(sessionId: string | undefined, currentMessageHasIntent: boolean): boolean {
    return this.trackIntentTtl(this.batchCollectionIntentTtl, sessionId, currentMessageHasIntent)
  }

  trackLocalSendImIntent(sessionId: string | undefined, currentMessageHasIntent: boolean): boolean {
    return this.trackIntentTtl(this.localSendImIntentTtl, sessionId, currentMessageHasIntent)
  }

  /**
   * On a local-send-im turn, clear collection + batch-collection intent so the
   * send turn does not inherit a stale browser-collection surface.
   */
  resetCollectionIntents(sessionId: string): void {
    this.collectionIntentTtl.delete(sessionId)
    this.batchCollectionIntentTtl.delete(sessionId)
  }
}
