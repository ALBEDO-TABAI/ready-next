const LOCAL_SEND_IM_INTENT_TTL_TURNS = 6

/** Per-session continuity for non-Browser local channel delivery only. */
export class AgentSdkIntentTracker {
  private readonly localSendImIntentTtl = new Map<string, number>()

  trackLocalSendImIntent(sessionId: string | undefined, currentMessageHasIntent: boolean): boolean {
    const sid = sessionId || ''
    if (!sid) return currentMessageHasIntent
    const prior = this.localSendImIntentTtl.get(sid) ?? 0
    const recent = currentMessageHasIntent || prior > 0
    const nextTtl = currentMessageHasIntent
      ? LOCAL_SEND_IM_INTENT_TTL_TURNS
      : Math.max(0, prior - 1)
    if (nextTtl > 0) this.localSendImIntentTtl.set(sid, nextTtl)
    else this.localSendImIntentTtl.delete(sid)
    return recent
  }
}
