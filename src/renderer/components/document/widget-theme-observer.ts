type ThemeListener = () => void

const listeners = new Set<ThemeListener>()
let observer: MutationObserver | null = null

function ensureObserver(): void {
  if (observer || listeners.size === 0 || typeof MutationObserver !== 'function') return
  observer = new MutationObserver(() => {
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        // silent-catch: one disposed widget must not block theme refreshes for the rest.
      }
    }
  })
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'data-theme', 'data-skin'],
  })
}

export function subscribeWidgetThemeChanges(listener: ThemeListener): () => void {
  listeners.add(listener)
  ensureObserver()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      observer?.disconnect()
      observer = null
    }
  }
}

export function __getWidgetThemeObserverStatsForTests(): { listeners: number; observing: boolean } {
  return { listeners: listeners.size, observing: observer !== null }
}

export function __resetWidgetThemeObserverForTests(): void {
  listeners.clear()
  observer?.disconnect()
  observer = null
}
