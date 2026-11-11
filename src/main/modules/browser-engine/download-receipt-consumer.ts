import { createHash } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { ObjectRegistry, fullHash, isInside, canonicalObjectPath, objectTransaction } from '../object-service/registry'
import { toReadyUri } from '../../../shared/ready-ref'
import type { BrowserDownloadReceipt } from '../../../shared/browser-download-receipt'

const downloadedFile = z.object({
  path: z.string().min(1), size: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), url: z.string().min(1),
})

export function browserDownloadDirectory(requested: unknown, roots: readonly string[], vaultRoot: string | null): string {
  const allowed = [...roots, ...(vaultRoot ? [join(vaultRoot, '下载')] : [])].filter(isAbsolute)
  const path = typeof requested === 'string' && requested.trim() ? requested.trim() : allowed[0]
  if (!path || !isAbsolute(path) || !allowed.some(root => isInside(canonicalObjectPath(root), canonicalObjectPath(path)))) {
    throw new Error('download_directory_not_authorized')
  }
  return canonicalObjectPath(path)
}

/** Independent disk readback; registration and durable receipt publish together. */
export function consumeBrowserDownload(input: {
  file: unknown; directory: string; browserTaskId: string; ownerRunId: string
  registry: ObjectRegistry
  readReceipts: () => BrowserDownloadReceipt[]
  saveReceipts: (receipts: BrowserDownloadReceipt[]) => void
}): BrowserDownloadReceipt {
  const file = downloadedFile.parse(input.file)
  const path = realpathSync(file.path)
  if (!isAbsolute(input.directory) || canonicalObjectPath(input.directory) !== input.directory || !isInside(input.directory, path)) throw new Error('download_receipt_path_outside_directory')
  const stat = statSync(path)
  if (!stat.isFile() || stat.size !== file.size || fullHash(path) !== file.sha256) throw new Error('download_receipt_content_mismatch')
  return objectTransaction(input.registry.db, () => {
    const object = input.registry.register(path)
    if (object.content_hash !== file.sha256 || object.size !== file.size) throw new Error('download_receipt_object_mismatch')
    const readyRef = { kind: 'file' as const, id: object.id }
    const receipt: BrowserDownloadReceipt = {
      receiptId: createHash('sha256').update(JSON.stringify([input.browserTaskId, input.ownerRunId, path, file.sha256])).digest('hex'),
      browserTaskId: input.browserTaskId, ownerRunId: input.ownerRunId,
      path, size: file.size, sha256: file.sha256, sourceUrl: file.url,
      readyRef, readyUri: toReadyUri(readyRef),
    }
    const previous = input.readReceipts()
    const existing = previous.find(item => item.receiptId === receipt.receiptId)
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(receipt)) throw new Error('download_receipt_identity_conflict')
      return existing
    }
    input.saveReceipts([...previous, receipt])
    const saved = input.readReceipts().find(item => item.receiptId === receipt.receiptId)
    if (!saved || JSON.stringify(saved) !== JSON.stringify(receipt)) throw new Error('download_receipt_readback_failed')
    return saved
  })
}
