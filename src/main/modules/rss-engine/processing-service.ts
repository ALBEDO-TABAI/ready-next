import { randomUUID } from 'node:crypto'
import { ProviderOutputIncompleteError } from '../agent-control/runtime-core/provider-output-status'
import type { RSSArticle } from '../../../shared/rss-workspace'
import type { RSSProcessingStore } from '../database/rss-processing-store'
import { ScheduleDispatchQueue } from '../scheduled-tasks/schedule-dispatch-queue'
import { buildRSSJudgmentInput, parseRSSJudgment, type RSSJudgmentInput } from './processing-judgment'

interface ProcessingDeps {
  store: RSSProcessingStore; getArticle(id: string): RSSArticle | null; hasModel(): boolean
  prepare(input: RSSJudgmentInput, jobId: string): (signal: AbortSignal) => Promise<string>
  now(): number; notify(): void
}

/** SQLite owns work and attempts. The shared dispatcher only coalesces wakeups; it never drops article jobs. */
export class RSSProcessingService {
  private readonly queue: ScheduleDispatchQueue
  private active: { id: string; controller: AbortController } | null = null
  private stopped = false
  private unsubscribe: (() => void) | null = null
  constructor(private readonly deps: ProcessingDeps) {
    this.queue = new ScheduleDispatchQueue({ isScopeBusy: () => this.stopped, dispatch: () => this.drain(),
      markSkippedCoalesced: () => { /* Only redundant wakeups are coalesced; article jobs stay in SQLite. */ },
      onDispatchError: (_item, error) => { console.error('[rss-processing] drain failed', error); deps.notify() },
    })
  }
  start(): Promise<void> {
    if (this.unsubscribe) return this.wake()
    const deps = this.deps
    deps.store.recover()
    this.unsubscribe = deps.store.onChanged(() => {
      // Store events can occur inside the surrounding intake transaction; defer claiming until it has committed.
      queueMicrotask(() => {
        if (this.stopped) return
        if (this.active) {
          const current = deps.store.get(this.active.id)
          if (!current || current.status !== 'running') this.active.controller.abort()
          else if (current.trigger === 'automatic' && !deps.store.settings().enabled) this.cancel(current.id)
        }
        void this.wake()
      })
    })
    return this.wake()
  }
  wake(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    return this.queue.enqueue({ occurrenceId: randomUUID(), scheduleId: 'rss-organization-wakeup', scopeId: 'rss-organization', scheduledFor: new Date(this.deps.now()).toISOString() })
  }
  cancel(id: string): void {
    this.deps.store.cancel(id, this.deps.now())
    if (this.active?.id === id) this.active.controller.abort()
    this.deps.notify()
  }
  async stop(): Promise<void> {
    this.stopped = true; this.unsubscribe?.(); this.unsubscribe = null
    if (this.active) this.cancel(this.active.id)
    await this.queue.drain('rss-organization')
  }
  private async drain(): Promise<void> {
    const { store, now } = this.deps
    while (!this.stopped) {
      const next = store.next()
      if (!next) break
      if (!this.deps.hasModel()) break
      const article = this.deps.getArticle(next.itemId)
      if (!article || !store.isCurrent(next)) { store.finish(next.id, 'stale', '文章或分类标准已变化，请选择是否重新整理。', now()); continue }
      const eventContext = store.eventContext(next, now())
      const input = buildRSSJudgmentInput(article, next.definitions, eventContext)
      let complete: (signal: AbortSignal) => Promise<string>
      try { complete = this.deps.prepare(input, next.id) }
      catch (error) { store.finish(next.id, 'failed', error instanceof Error ? error.message : String(error), now()); this.deps.notify(); continue }
      const current = store.claim(next.id, now(), this.deps.hasModel(), eventContext)
      if (!current) {
        if (store.get(next.id)?.status !== 'queued') continue
        break
      }
      const controller = new AbortController()
      this.active = { id: current.id, controller }; this.deps.notify()
      let responded = false
      try {
        const text = await complete(controller.signal)
        responded = true
        if (controller.signal.aborted || this.stopped) continue
        store.publish(current.id, parseRSSJudgment(text, input), now())
      } catch (error) {
        responded ||= error instanceof ProviderOutputIncompleteError
        store.finish(current.id, responded ? 'failed' : 'unknown', `${responded ? '结果未通过核对' : '请求结果未知，不会自动重试'}：${error instanceof Error ? error.message : String(error)}`, now())
      } finally { this.active = null; this.deps.notify() }
    }
    this.deps.notify()
  }
}
