import type { RSSBehaviorInput } from '../../../shared/rss-sieve'

type BehaviorAction = Omit<RSSBehaviorInput, 'id' | 'at'>

/** W5 §2.4: what the person does with an article is recorded on this machine so the sieve can learn from it. */
export async function recordRSSBehavior(input: BehaviorAction): Promise<void> {
  const result = await window.electronAPI.rss.sieveRecordBehavior({ ...input, id: crypto.randomUUID(), at: Date.now() } as RSSBehaviorInput)
  if (!result.success) throw new Error(result.error)
}

/** For actions that already succeeded on their own: a failed record is logged and never blocks or undoes the action. */
export function noteRSSBehavior(input: BehaviorAction): void {
  void recordRSSBehavior(input).catch((error: unknown) => console.warn('[rss-sieve] behavior not recorded', input.action, error))
}
