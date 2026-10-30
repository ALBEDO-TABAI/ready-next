import { create } from 'zustand'
import type { VaultState } from '../../shared/vault'
import { useWorkspace } from './useWorkspace'

type VaultView =
  | { phase: 'idle' | 'loading'; data: null }
  | { phase: 'loaded'; data: VaultState }
  | { phase: 'saving'; data: VaultState | null }
  | { phase: 'error'; data: VaultState | null; message: string }

interface VaultStore {
  view: VaultView
  load(): Promise<void>
  createDefault(): Promise<void>
  chooseFolder(): Promise<void>
}

export const useVault = create<VaultStore>((set, get) => {
  let pending: Promise<void> | null = null
  let subscribed = false
  let revision = 0
  const accept = (data: VaultState) => {
    if (data.status === 'ready') {
      const workspace = useWorkspace.getState()
      if (!workspace.pinnedFolders.includes(data.root)) workspace.addPinnedFolder(data.root)
    }
    set({ view: { phase: 'loaded', data } })
  }
  // One subscription for the lifetime of this renderer store, including while UI is unmounted.
  const run = (phase: 'loading' | 'saving', action: () => Promise<VaultState | null>): Promise<void> => {
    if (!subscribed) {
      window.electronAPI.vault.onChanged(data => { revision++; accept(data) })
      subscribed = true
    }
    if (pending) return pending
    const startedAt = revision
    const previousView = get().view
    const previous = previousView.data
    set({ view: phase === 'loading' ? { phase, data: null } : { phase, data: previous } })
    pending = Promise.resolve().then(action).then(data => {
      if (revision !== startedAt) return
      if (!data) {
        set({ view: previousView })
        return
      }
      accept(data)
    }).catch((error: unknown) => {
      if (phase === 'loading' && revision !== startedAt) return
      set({ view: { phase: 'error', data: revision === startedAt ? previous : get().view.data, message: error instanceof Error ? error.message : String(error) } })
    }).finally(() => { pending = null })
    return pending
  }
  return {
    view: { phase: 'idle', data: null },
    load: () => run('loading', () => window.electronAPI.vault.get()),
    createDefault: () => run('saving', () => window.electronAPI.vault.createDefault()),
    chooseFolder: () => run('saving', async () => {
      const result = await window.electronAPI.document.openFolder({ validateAsWorkspace: true })
      if (!result.success) {
        if (result.error === 'cancelled') return null
        throw new Error(result.error || '无法选择文件夹。')
      }
      if (!result.path) throw new Error('未返回文件夹路径。')
      return window.electronAPI.vault.set(result.path)
    }),
  }
})
