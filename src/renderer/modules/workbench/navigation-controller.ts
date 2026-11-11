import { emptyNavigation, navigationObjectKey, type NavigationEntry, type NavigationHistoryAPI, type NavigationState } from '../../../shared/navigation-history'

/** Serialize open/restore/save, so rapid shortcuts never race the durable cursor or record replay as an open. */
export class NavigationController {
  private state = emptyNavigation()
  private loaded = false
  private tail: Promise<unknown> = Promise.resolve()
  private listeners = new Set<() => void>()
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
    return this.enqueue(async () => {
      await perform()
      const entries = this.state.entries.slice(0, this.state.cursor + 1)
      if (origin) {
        if (!entries.length && navigationObjectKey(origin.ref) !== navigationObjectKey(entry.ref)) entries.push(origin)
        else if (entries.length && navigationObjectKey(entries[entries.length - 1].ref) === navigationObjectKey(origin.ref)) entries[entries.length - 1] = origin
      }
      entries.push(entry)
      const kept = entries.slice(-50)
      this.publish(await this.api().save({ ...this.state, entries: kept, cursor: kept.length - 1 }))
    })
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
    })
  }
}
