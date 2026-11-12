import { useCallback, useEffect, useRef, useSyncExternalStore, type KeyboardEvent, type RefObject } from 'react'
import { closeFloat, isFloatOpen, openFloat } from '../../components/ui'
import { AddressSuggestionList } from '../../components/browser/AddressSuggestions'
import type { BrowserSuggestions } from '../../../shared/browser-shell'

// Address-bar suggestions (W7 §4.10): what the list holds and when it asks Main. The list itself is AddressSuggestionList.

export const ADDRESS_SUGGESTIONS_FLOAT = 'browser-address-suggestions'

export type AddressSuggestion =
  | { kind: 'tab'; key: string; title: string; url: string; tabId: string; assistant: boolean }
  | { kind: 'bookmark' | 'history'; key: string; title: string; url: string }
  | { kind: 'search'; key: string; title: string }

/** One flat list in the order the groups are shown; each address appears once (Main already de-duplicates). */
export function flattenSuggestions(groups: BrowserSuggestions): AddressSuggestion[] {
  return [
    ...groups.tabs.map(item => ({ kind: 'tab' as const, key: `tab:${item.tabId}`, title: item.title || item.url, url: item.url, tabId: item.tabId, assistant: Boolean(item.browserTaskId) })),
    ...groups.bookmarks.map(item => ({ kind: 'bookmark' as const, key: `bookmark:${item.url}`, title: item.title || item.url, url: item.url })),
    ...groups.history.map(item => ({ kind: 'history' as const, key: `history:${item.url}`, title: item.title || item.url, url: item.url })),
    ...groups.search.map(term => ({ kind: 'search' as const, key: `search:${term}`, title: term })),
  ]
}

type State = { items: AddressSuggestion[]; selected: number }
function createStore() {
  let state: State = { items: [], selected: -1 }
  const listeners = new Set<() => void>()
  return {
    get: () => state,
    set: (next: State) => { state = next; listeners.forEach(listener => listener()) },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}
export type AddressSuggestionStore = ReturnType<typeof createStore>

/**
 * Suggestions for the address field: asks Main as the person types (newest request wins), shows the list under the
 * field, and owns ↑/↓/Enter while the list is open. `onKeyDown` returns true when it handled the key.
 */
export function useAddressSuggestions({ anchorRef, query, editing, onPick }: {
  anchorRef: RefObject<HTMLElement | null>
  query: string
  editing: boolean
  onPick: (item: AddressSuggestion) => void
}) {
  const storeRef = useRef<AddressSuggestionStore | null>(null)
  if (!storeRef.current) storeRef.current = createStore()
  const store = storeRef.current
  const pick = useRef(onPick)
  pick.current = onPick
  const sequence = useRef(0)
  const typed = useRef(false)

  const close = useCallback(() => {
    sequence.current += 1
    store.set({ items: [], selected: -1 })
    closeFloat(ADDRESS_SUGGESTIONS_FLOAT)
  }, [store])

  const choose = useCallback((item: AddressSuggestion) => {
    close()
    pick.current(item)
  }, [close])

  useEffect(() => {
    if (!editing) { typed.current = false; close(); return }
  }, [close, editing])

  useEffect(() => {
    // Only what the person types asks for suggestions; focusing the field (the address selected) does not.
    if (!editing || !typed.current) return
    const text = query.trim()
    if (!text) { close(); return }
    const seq = ++sequence.current
    const timer = window.setTimeout(() => {
      void window.electronAPI?.browser?.suggest?.({ query: text, limit: 5 }).then(groups => {
        if (seq !== sequence.current || !groups) return
        const items = flattenSuggestions(groups)
        if (items.length === 0) { closeFloat(ADDRESS_SUGGESTIONS_FLOAT); store.set({ items: [], selected: -1 }); return }
        store.set({ items, selected: -1 })
        if (isFloatOpen(ADDRESS_SUGGESTIONS_FLOAT)) return
        const anchor = () => anchorRef.current?.getBoundingClientRect() ?? { left: 0, top: 0, right: 0, bottom: 0 }
        openFloat({
          id: ADDRESS_SUGGESTIONS_FLOAT, anchor, placement: 'bottom-start', offset: 6, noFocus: true,
          style: { width: Math.max(320, Math.round(anchor().right - anchor().left)) },
          onClose: () => store.set({ items: [], selected: -1 }),
          render: () => <AddressSuggestionList store={store} onPick={choose} />,
        })
      }).catch(error => console.warn('[AddressSuggestions] suggestions unavailable:', error instanceof Error ? error.message : String(error)))
    }, 60)
    return () => window.clearTimeout(timer)
  }, [anchorRef, choose, close, editing, query, store])

  useEffect(() => () => closeFloat(ADDRESS_SUGGESTIONS_FLOAT), [])

  const shown = useSyncExternalStore(store.subscribe, store.get)

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>): boolean => {
    const { items, selected } = store.get()
    if (!isFloatOpen(ADDRESS_SUGGESTIONS_FLOAT) || items.length === 0) return false
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      // -1 is the typed text itself; ↑/↓ cycle through it and the rows.
      const next = selected + (event.key === 'ArrowDown' ? 1 : -1)
      store.set({ items, selected: next < -1 ? items.length - 1 : next > items.length - 1 ? -1 : next })
      return true
    }
    if (event.key === 'Enter' && selected >= 0) {
      event.preventDefault()
      choose(items[selected])
      return true
    }
    return false
  }, [choose, store])

  return {
    onKeyDown,
    /** The person typed: from now on, changes of the field ask for suggestions. */
    onTyped: () => { typed.current = true },
    close,
    /** For the field's combobox attributes: whether the list shows, and which row ↑/↓ is on. */
    expanded: shown.items.length > 0,
    activeDescendant: shown.selected >= 0 ? `browser-address-suggestion-${shown.selected}` : undefined,
  }
}
