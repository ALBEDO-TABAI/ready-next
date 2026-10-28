type ChangeListener = (ids: readonly string[]) => void
const listeners = new Set<ChangeListener>()
export function onCalendarChanged(listener: ChangeListener): () => void { listeners.add(listener); return () => { listeners.delete(listener) } }
export function publishCalendarChanged(ids: readonly string[]): void {
  for (const listener of listeners) {
    try { listener(ids) } catch (error) { console.error('[calendar] change consumer failed', error) }
  }
}
