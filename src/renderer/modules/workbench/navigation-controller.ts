import { emptyNavigation, navigationObjectKey, type NavigationEntry, type NavigationHistoryAPI, type NavigationState } from '../../../shared/navigation-history'

/** Serialize open/restore/save, so rapid shortcuts never race the durable cursor or record replay as an open. */
export class NavigationController {
  private state = emptyNavigation()
  private loaded = false
  private tail: Promise<unknown> = Promise.resolve()
  private listeners = new Set<() => void>()
  /** Opens and steps requested but not finished: the person is about to be somewhere else. */
  private moving = 0
  constructor(private readonly api: () => Pick<NavigationHistoryAPI, 'read' | 'save'>) {}
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(state: NavigationState) { this.state = state; this.listeners.forEach(listener => listener()) }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(async () => { if (!this.loaded) { this.publish(await this.api().read()); this.loaded = true }; return work() })
    this.tail = next.catch(error => { console.error('[navigation] operation failed', error) })
    return next
  }
  load = () => this.enqueue(async () => this.state)
  open(entry: NavigationEntry, perform: () => Promise<void>, origin?: NavigationEntry): Promise<void> {
    // The origin is where the person is now. It is stale only if another navigation was still on its way when it was
    // taken (rapid opens); revisions alone do not say that — loading, saving and Main's own updates move them too.
    const stale = this.moving > 0
    this.moving++
    return this.enqueue(async () => {
      await perform()
      const entries = this.state.entries.slice(0, this.state.cursor + 1)
      if (origin) {
        const last = entries[entries.length - 1], key = navigationObjectKey(origin.ref)
        if (last && navigationObjectKey(last.ref) === key) entries[entries.length - 1] = origin
        // The person reached the place they jump from without an open being recorded (a new tab, a draft being
        // written): it becomes an entry of its own, so going back returns there rather than to the entry before it.
        else if (key !== navigationObjectKey(entry.ref) && (!last || !stale)) entries.push(origin)
      }
      entries.push(entry)
      const kept = entries.slice(-50)
      this.publish(await this.api().save({ ...this.state, entries: kept, cursor: kept.length - 1 }))
    }).finally(() => { this.moving-- })
  }
  /** 今日 sits over the current entry without being one: going back from it returns to that entry, cursor unchanged. */
  reopen(restore: (entry: NavigationEntry) => Promise<void>): Promise<void> {
    return this.enqueue(async () => {
      const entry = this.state.entries[this.state.cursor]
      if (entry) await restore(entry)
    })
  }
  step(direction: -1 | 1, restore: (entry: NavigationEntry) => Promise<void>, current: () => Promise<NavigationEntry | undefined> = async () => undefined,
    tabStep?: () => { matches(entry: NavigationEntry): Promise<boolean>; perform(): void | Promise<void> } | undefined): Promise<void> {
    this.moving++
    return this.enqueue(async () => {
      // Select the local target inside the queue, after the preceding shortcut has finished.
      const local = tabStep?.(), position = await current()
      let cursor = this.state.cursor + direction
      if (local) while (this.state.entries[cursor] && !await local.matches(this.state.entries[cursor])) cursor += direction
      const entry = this.state.entries[cursor]
      if (local) await local.perform()
      else if (entry) await restore(entry)
      if (!entry) return
      const entries = [...this.state.entries]
      if (position) entries[this.state.cursor] = position
      this.publish(await this.api().save({ ...this.state, entries, cursor }))
    }).finally(() => { this.moving-- })
  }
}
