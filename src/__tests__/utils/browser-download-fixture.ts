import assert from 'node:assert/strict'
import { z } from 'zod'
import type { BrowserController } from '../../main/modules/browser-engine/ipc-handler'
import { browserDownloadDirectory } from '../../main/modules/browser-engine/download-receipt-consumer'
import type { BrowserDownloadReceipt } from '../../shared/browser-download-receipt'
import { toReadyUri } from '../../shared/ready-ref'

// Stub the receipt boundary; disk/DB readback is covered by browser-download-receipts-native.
// Directory authorization still uses the real policy.
export function createBrowserDownloadFixture() {
  const receipts: BrowserDownloadReceipt[] = []
  const methods: Pick<BrowserController, 'resolveTaskDownloadDirectory' | 'consumeTaskDownload'> = {
    resolveTaskDownloadDirectory: (requested, roots) => browserDownloadDirectory(requested, roots, null),
    consumeTaskDownload: (file, directory, browserTaskId, ownerRunId) => {
      assert.ok(browserTaskId)
      assert.ok(ownerRunId)
      const downloaded = z.object({ path: z.string(), size: z.number().positive(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/), url: z.string() }).parse(file)
      assert.equal(browserDownloadDirectory(downloaded.path, [directory], null), downloaded.path)
      const readyRef = { kind: 'file' as const, id: `download-${receipts.length + 1}` }
      const receipt: BrowserDownloadReceipt = {
        receiptId: readyRef.id, browserTaskId, ownerRunId, path: downloaded.path,
        size: downloaded.size, sha256: downloaded.sha256, sourceUrl: downloaded.url,
        readyRef, readyUri: toReadyUri(readyRef),
      }
      receipts.push(receipt)
      return receipt
    },
  }
  return { methods, receipts }
}
