import type { ReadyRef } from './ready-ref'

export interface BrowserDownloadReceipt {
  receiptId: string
  browserTaskId: string
  ownerRunId: string
  path: string
  size: number
  sha256: string
  sourceUrl: string
  readyRef: ReadyRef
  readyUri: string
}
