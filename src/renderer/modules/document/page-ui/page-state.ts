import { createStore } from 'zustand/vanilla'
import type { DocumentPagesAPI, PageNode, PageRoot, PageUserState } from '../../../../shared/document-pages'
import type { VaultState } from '../../../../shared/vault'

export function pageRoots(vault: VaultState | null, workspaceRoot: string | null, pinned: string[]): PageRoot[] {
  const paths = new Set([...(vault?.status === 'ready' ? [vault.root] : []), ...(workspaceRoot ? [workspaceRoot] : []), ...pinned])
  if (vault?.status === 'missing') paths.delete(vault.root)
  return [...paths].filter(Boolean).map(path => ({ path, kind: vault?.status === 'ready' && path === vault.root ? 'vault' : 'external' }))
}

export function flattenPages(nodes: PageNode[]): PageNode[] {
  return nodes.flatMap(node => [node, ...flattenPages(node.children)])
}

export const parentDirectory = (node: PageNode): string => node.kind === 'page' ? node.path.slice(0, -3) : node.path
export const joinPagePath = (parent: string, name: string): string => `${parent.replace(/[\\/]$/, '')}${parent.includes('\\') ? '\\' : '/'}${name}`
export const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

export function createPageTreeStore(api: DocumentPagesAPI) {
  let epoch = 0
  return createStore<{
    trees: PageNode[]; states: PageUserState[]; loading: boolean; error: string | null
    load(roots: PageRoot[]): Promise<void>
    loadStates(): Promise<void>
    invalidate(): void
  }>((set) => ({
    trees: [], states: [], loading: false, error: null,
    invalidate: () => { epoch++ },
    loadStates: async () => {
      const request = epoch
      const result = await api.states()
      if (request !== epoch) return
      if (!result.ok) { set({ error: result.message }); return }
      set({ states: result.value })
    },
    load: async roots => {
      const request = ++epoch
      if (!roots.length) { set({ trees: [], states: [], loading: false, error: null }); return }
      set({ loading: true, error: null })
      try {
        const [trees, states] = await Promise.all([Promise.all(roots.map(root => api.tree(root))), api.states()])
        if (!states.ok) throw new Error(states.message)
        const nodes = trees.map(result => { if (!result.ok) throw new Error(result.message); return result.value })
        if (request === epoch) set({ trees: nodes, states: states.value, loading: false })
      } catch (error) {
        if (request === epoch) set({ trees: [], states: [], loading: false, error: errorMessage(error) })
      }
    },
  }))
}
