import { emptyNavigation, NavigationStateSchema, type NavigationHistoryAPI } from '../../shared/navigation-history'
/** Isolated IPC storage substitute for renderer tests; native durability is tested against ready.db separately. */
export function memoryNavigationAPI(): NavigationHistoryAPI {
  let state = emptyNavigation()
  return { browserPosition: async () => null, restoreBrowserPosition: async () => {}, read: async () => structuredClone(state), save: async input => {
    const parsed = NavigationStateSchema.parse(input)
    if (parsed.revision !== state.revision) throw new Error('Stale navigation write')
    state = { ...parsed, revision: state.revision + 1 }; return structuredClone(state)
  } }
}
