import { create } from 'zustand'
import type { FastCardItem, FastCardIPCResult, FastCardStorageAPI, FastCardSyncState } from '../../shared/fastcard'

interface FastCardState {
  items: FastCardItem[]
  panelOpen: boolean
  collapsed: boolean
  syncState: FastCardSyncState
  load: () => Promise<boolean>
  addItem: (item: FastCardItem) => Promise<boolean>
  removeItem: (id: string) => Promise<boolean>
  clear: () => Promise<boolean>
  open: () => Promise<boolean>
  collapse: () => void
}

function receipt<T>(result: FastCardIPCResult<T>): T | undefined {
  if (!result.success) throw new Error(result.error || 'FastCard 操作失败')
  return result.data
}

export function createFastCardStore(getAPI: () => FastCardStorageAPI) {
  // One writer in the workbench; the overlay receives confirmed snapshots only.
  let queue = Promise.resolve(true)
  return create<FastCardState>((set, get) => {
    const run = (kind: 'loading' | 'saving', operation: () => Promise<void>): Promise<boolean> => {
      queue = queue.then(async () => {
        set({ syncState: { kind } })
        try {
          await operation()
          set({ syncState: { kind: 'ready' } })
          return true
        } catch (error) {
          set({ syncState: { kind: 'error', message: error instanceof Error ? error.message : String(error) },
            panelOpen: true, collapsed: false })
          return false
        }
      })
      return queue
    }
    return {
      items: [], panelOpen: false, collapsed: true, syncState: { kind: 'idle' },
      load: () => run('loading', async () => {
        const items = receipt(await getAPI().listFastCardItems())
        if (!items) throw new Error('FastCard 未收到列表回执')
        set({ items })
      }),
      addItem: (item) => run('saving', async () => {
        const saved = receipt(await getAPI().addFastCardItem(item))
        if (!saved) throw new Error('FastCard 未收到保存回执')
        set(state => ({ items: [saved, ...state.items.filter(value => value.id !== saved.id)],
          panelOpen: true, collapsed: false }))
      }),
      removeItem: (id) => run('saving', async () => {
        receipt(await getAPI().removeFastCardItem(id))
        set(state => ({ items: state.items.filter(item => item.id !== id) }))
      }),
      clear: () => run('saving', async () => {
        receipt(await getAPI().clearFastCardItems())
        set({ items: [] })
      }),
      open: () => {
        set({ panelOpen: true, collapsed: false })
        return get().load()
      },
      collapse: () => set({ panelOpen: false, collapsed: true }),
    }
  })
}

export const useFastCard = createFastCardStore(() => window.electronAPI.browser)
