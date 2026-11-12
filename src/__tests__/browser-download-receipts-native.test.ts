import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { fixture } from './utils/ready-object-fixture'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { browserDownloadDirectory, consumeBrowserDownload } from '../main/modules/browser-engine/download-receipt-consumer'
import type { BrowserDownloadReceipt } from '../shared/browser-download-receipt'

test('download receipt independently verifies bytes, registers ReadyRef and atomically persists once', t => {
  if (skipIfSqliteUnavailable(t, 'download receipts')) return
  const f = fixture()
  try {
    f.db.exec("CREATE TABLE receipt_test (payload TEXT NOT NULL); INSERT INTO receipt_test VALUES ('[]')")
    const path = join(f.root, 'report.csv')
    const bytes = Buffer.from('one,two\n1,2\n')
    writeFileSync(path, bytes)
    const file = { path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), url: 'https://example.test/report.csv' }
    const input = { file, directory: f.root, browserTaskId: 'task', ownerRunId: 'run', registry: f.registry,
      readReceipts: (): BrowserDownloadReceipt[] => JSON.parse(f.db.prepare('SELECT payload FROM receipt_test').get<{ payload: string }>()!.payload),
      saveReceipts: (receipts: BrowserDownloadReceipt[]) => { f.db.prepare('UPDATE receipt_test SET payload=?').run(JSON.stringify(receipts)) },
    }
    const receipt = consumeBrowserDownload(input)
    assert.equal(receipt.sha256, file.sha256)
    assert.equal((receipt.readyRef.kind === 'file' ? receipt.readyRef.id : null), f.registry.find(path)!.id)
    assert.match(receipt.readyUri, /^ready:\/\/doc\/file\//)
    assert.deepEqual(consumeBrowserDownload(input), receipt)
    assert.equal(input.readReceipts().length, 1)
    writeFileSync(path, 'tampered')
    assert.throws(() => consumeBrowserDownload(input), /content_mismatch/)
    assert.equal(input.readReceipts().length, 1)
  } finally { f.close() }
})

test('download destination rejects traversal and symlink escape; default is authorized folder or vault downloads', t => {
  if (skipIfSqliteUnavailable(t, 'download directory')) return
  const f = fixture()
  try {
    const allowed = join(f.root, 'allowed'); mkdirSync(allowed)
    symlinkSync(f.root, join(allowed, 'escape'))
    assert.equal(browserDownloadDirectory(undefined, [allowed], f.root), allowed)
    assert.equal(browserDownloadDirectory(undefined, [], f.root), join(f.root, '下载'))
    assert.throws(() => browserDownloadDirectory(join(allowed, '../bad'), [allowed], null), /not_authorized/)
    assert.throws(() => browserDownloadDirectory(join(allowed, 'escape/bad'), [allowed], null), /not_authorized/)
    assert.throws(() => browserDownloadDirectory(undefined, [], null), /not_authorized/)
  } finally { f.close() }
})
