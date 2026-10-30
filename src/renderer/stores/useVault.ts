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
  const run = (phase: 'loading' | 'saving', action: () => Promise<VaultState | null>): Promise<void> => {
    if (pending) return pending
    const previousView = get().view
    const previous = previousView.data
    set({ view: phase === 'loading' ? { phase, data: null } : { phase, data: previous } })
    pending = Promise.resolve().then(action).then(data => {
      if (!data) {
        set({ view: previousView })
        return
      }
      if (data.status === 'ready') {
        const workspace = useWorkspace.getState()
        if (!workspace.pinnedFolders.includes(data.root)) workspace.addPinnedFolder(data.root)
      }
      set({ view: { phase: 'loaded', data } })
    }).catch((error: unknown) => {
      set({ view: { phase: 'error', data: previous, message: error instanceof Error ? error.message : String(error) } })
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
