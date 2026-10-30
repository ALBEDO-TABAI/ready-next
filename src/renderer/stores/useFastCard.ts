import { create } from 'zustand'
import { isFastCardTransferAPI, isFastCardQuickNoteAPI, type FastCardQuickNoteAPI } from '../../shared/fastcard'
import type { FastCardItem, FastCardIPCResult, FastCardStorageAPI, FastCardSyncState, FastCardTransferAPI, FastCardCanvasTarget, FastCardTransferReceipt, FastCardTransferRequest } from '../../shared/fastcard'

interface FastCardState {
  items: FastCardItem[]
  panelOpen: boolean
  collapsed: boolean
  syncState: FastCardSyncState
  transferReceipt: FastCardTransferReceipt | null
  saveToCanvas: (itemIds: string[], target?: FastCardCanvasTarget) => Promise<boolean>
  retryTransfer: (request: FastCardTransferRequest) => Promise<boolean>
  undoTransfer: () => Promise<boolean>
  dismissReceipt: () => void
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

export function getFastCardTransferAPI(): FastCardTransferAPI {
  const api = window.electronAPI
  if (!('fastCard' in api) || !isFastCardTransferAPI(api.fastCard)) throw new Error('画板转存服务尚未接通')
  return api.fastCard
}

export function createFastCardStore(getAPI: () => FastCardStorageAPI, getTransferAPI: () => FastCardTransferAPI = getFastCardTransferAPI) {
  // One writer in the workbench; the overlay receives confirmed snapshots only.
  let queue = Promise.resolve(true)
  let intent: { key: string; request: FastCardTransferRequest } | null = null
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
    const transfer = (request: FastCardTransferRequest) => run('saving', async () => {
      const result = await getTransferAPI().transfer(request)
      if (!result.success && result.errorCode === 'target_unavailable') intent = null
      const saved = receipt(result)
      if (!saved) throw new Error('未收到画板保存回执')
      set(state => ({ items: state.items.filter(item => !request.itemIds.includes(item.id)), transferReceipt: saved }))
      intent = null
    })
    return {
      transferReceipt: null,
      dismissReceipt: () => set({ transferReceipt: null }),
      saveToCanvas: (itemIds, target) => {
        const key = JSON.stringify([itemIds, target])
        if (intent && intent.key !== key) return run('saving', async () => { throw new Error('上次转存尚未确认，请先重试原操作') })
        intent ??= { key, request: { operationId: crypto.randomUUID(), itemIds: [...itemIds], ...(target ? { target } : {}) } }
        return transfer(intent.request)
      },
      retryTransfer: request => transfer(request),
      undoTransfer: () => run('saving', async () => {
        const saved = get().transferReceipt
        if (!saved) throw new Error('没有可撤销的保存')
        receipt(await getTransferAPI().undo(saved.operationId))
        const items = receipt(await getAPI().listFastCardItems())
        if (!items) throw new Error('未收到暂存恢复回执')
        set({ items, transferReceipt: null })
      }),
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

export function getFastCardQuickNoteAPI(): FastCardQuickNoteAPI {
  const api = window.electronAPI
  if (!('fastCard' in api) || !isFastCardQuickNoteAPI(api.fastCard)) throw new Error('快记服务尚未接通')
  return api.fastCard
}
