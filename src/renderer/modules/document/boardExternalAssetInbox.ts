import type {
  ReadyBoardAsset,
  ReadyBoardExternalAssetReceipt,
} from '../../../shared/ready-board'

interface BoardExternalImageEventData {
  boardId: string
  path: string
  receiptId: string
  asset: ReadyBoardAsset
}

interface BoardExternalImageResponse {
  success: boolean
  data?: BoardExternalImageEventData
  error?: string
}

interface BoardExternalImageAPI {
  onActiveBoardExternalImageAdded(
    callback: (result: BoardExternalImageResponse) => void,
  ): () => void
}

interface BoardExternalAssetOwner {
  boardId: string
  path: string
  onAsset(receipt: ReadyBoardExternalAssetReceipt): Promise<void> | void
  reportError(error: string): void
}

const ownersByBoardId = new Map<string, BoardExternalAssetOwner>()
const ownersByPath = new Map<string, BoardExternalAssetOwner>()
const pendingByPath = new Map<string, ReadyBoardExternalAssetReceipt[]>()
const deliveriesByPath = new Map<string, Promise<void>>()

function enqueueReceipt(path: string, receipt: ReadyBoardExternalAssetReceipt): void {
  const pending = pendingByPath.get(path) ?? []
  if (!pending.some((candidate) => candidate.id === receipt.id)) pending.push(receipt)
  pendingByPath.set(path, pending)
}

function deliverPending(path: string): Promise<void> {
  const existing = deliveriesByPath.get(path)
  if (existing) return existing
  if (!ownersByPath.has(path) || !(pendingByPath.get(path)?.length)) return Promise.resolve()
  let deliveryFailed = false
  const delivery = (async () => {
    while (true) {
      const owner = ownersByPath.get(path)
      const receipt = pendingByPath.get(path)?.[0]
      if (!owner || !receipt) return
      try {
        await owner.onAsset(receipt)
      } catch (error) {
        deliveryFailed = true
        owner.reportError(error instanceof Error ? error.message : String(error))
        return
      }
      const pending = pendingByPath.get(path)
      if (!pending) continue
      const next = pending.filter((candidate) => candidate.id !== receipt.id)
      if (next.length > 0) pendingByPath.set(path, next)
      else pendingByPath.delete(path)
    }
  })()
  deliveriesByPath.set(path, delivery)
  void delivery.finally(() => {
    if (deliveriesByPath.get(path) !== delivery) return
    deliveriesByPath.delete(path)
    if (!deliveryFailed && ownersByPath.has(path) && pendingByPath.get(path)?.length) {
      void deliverPending(path)
    }
  }).catch(() => undefined)
  return delivery
}

export function enqueueBoardExternalAssetReceipts(
  path: string,
  receipts: readonly ReadyBoardExternalAssetReceipt[],
): void {
  for (const receipt of receipts) enqueueReceipt(path, receipt)
  void deliverPending(path)
}

export function installBoardExternalAssetBridge(api: BoardExternalImageAPI | undefined): () => void {
  if (!api) return () => undefined
  return api.onActiveBoardExternalImageAdded((result) => {
    if (!result.success || !result.data) {
      if (result.error) for (const owner of ownersByBoardId.values()) owner.reportError(result.error)
      return
    }
    const receiptId = String(result.data.receiptId || '').trim()
    if (!receiptId) {
      ownersByBoardId.get(result.data.boardId)?.reportError('画板外部素材缺少持久回执')
      return
    }
    enqueueReceipt(result.data.path, { id: receiptId, asset: result.data.asset })
    void deliverPending(result.data.path)
  })
}

export function registerBoardExternalAssetOwner(owner: BoardExternalAssetOwner): () => void {
  ownersByBoardId.set(owner.boardId, owner)
  ownersByPath.set(owner.path, owner)
  void deliverPending(owner.path)
  return () => {
    if (ownersByBoardId.get(owner.boardId) === owner) ownersByBoardId.delete(owner.boardId)
    if (ownersByPath.get(owner.path) === owner) ownersByPath.delete(owner.path)
  }
}

export async function flushBoardExternalAssetInboxForTests(): Promise<void> {
  while (deliveriesByPath.size > 0) {
    await Promise.allSettled([...deliveriesByPath.values()])
  }
}

export function resetBoardExternalAssetInboxForTests(): void {
  ownersByBoardId.clear()
  ownersByPath.clear()
  pendingByPath.clear()
  deliveriesByPath.clear()
}
