import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { fixture } from './utils/ready-object-fixture'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { browserDownloadDirectory, consumeBrowserDownload } from '../main/modules/browser-engine/download-receipt-consumer'
import type { BrowserDownloadReceipt } from '../shared/browser-download-receipt'
import { BrowserDownloadService } from '../main/modules/browser-engine/download-service'
import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import type { BrowserDataService } from '../main/modules/browser-engine/data-service'
import { ObjectPresentationService } from '../main/modules/object-service/presentation'
import { executeBrowserTool } from '../main/modules/tools/browser-tools'
import { attachBrowserWorkflowFixture } from './utils/browser-workflow-fixture'
import { importWithoutAssets } from './utils/import-without-styles'

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

test('download result, durable ReadyRef and capsule use the same preserved name after collisions', async t => {
  if (skipIfSqliteUnavailable(t, 'download names and ReadyRef')) return
  const f = fixture()
  try {
    const directory = join(f.root, '下载'); mkdirSync(directory)
    writeFileSync(join(directory, 'report-2026-q3.csv'), 'existing')
    f.db.exec("CREATE TABLE receipt_names (payload TEXT NOT NULL); INSERT INTO receipt_names VALUES ('[]')")
    const readReceipts = (): BrowserDownloadReceipt[] => JSON.parse(f.db.prepare('SELECT payload FROM receipt_names').get<{ payload: string }>()!.payload)
    const service = new BrowserDownloadService({
      dataService: { addDownload() {}, updateDownloadProgress() {}, updateDownloadState() {} } as unknown as BrowserDataService,
      sendToRenderer() {},
    })
    const session = new EventEmitter()
    const transport = Object.assign(session, { downloadURL(url: string) {
      queueMicrotask(() => {
        const item = Object.assign(new EventEmitter(), {
          getURL: () => url, getURLChain: () => [url], getFilename: () => 'download.csv', getContentDisposition: () => '',
          getSavePath: () => '', getMimeType: () => 'text/csv', getTotalBytes: () => 4, getReceivedBytes: () => 4,
          canResume: () => false, cancel: () => { throw new Error('unexpected cancellation') },
          setSavePath: (path: string) => writeFileSync(path, 'a,b\n'),
        })
        session.emit('will-download', {}, item)
        item.emit('done', {}, 'completed')
      })
    } })
    const workflow = attachBrowserWorkflowFixture({
      getActiveTab: () => ({ id: 'tab-1', url: 'http://127.0.0.1/downloads', title: 'Downloads', active: true }),
      executeJS: async () => 'http://127.0.0.1/downloads',
      resolveTaskDownloadDirectory: () => directory,
      downloadUrlToDirectory: (payload: Parameters<BrowserController['downloadUrlToDirectory']>[0]) => service.downloadUrlToDirectory(transport as never, payload),
      consumeTaskDownload: (file: unknown, dir: string, browserTaskId: string, ownerRunId: string) => consumeBrowserDownload({
        file, directory: dir, browserTaskId, ownerRunId, registry: f.registry, readReceipts,
        saveReceipts: receipts => { f.db.prepare('UPDATE receipt_names SET payload=?').run(JSON.stringify(receipts)) },
      }),
    } as unknown as BrowserController)
    const output = await executeBrowserTool('browser_download', {
      mode: 'urls', urls: ['http://127.0.0.1/downloads/files/report-2026-q3.csv', 'http://127.0.0.1/downloads/files/report-2026-q3.csv?copy=2'],
      directory,
    }, workflow.controller, undefined, undefined, undefined, undefined, undefined, { ...workflow.context, workspaceRoots: [directory] })
    assert.equal(typeof output, 'object')
    if (typeof output === 'string') throw new Error(output)
    const data = output.data as { success: number; results: Array<{ filename: string; path: string }>; downloadReceipts: BrowserDownloadReceipt[] }
    assert.equal(data.success, 2, output.text)
    assert.deepEqual(data.downloadReceipts, readReceipts())
    const { BrowserTaskCardView } = await importWithoutAssets(() => import('../renderer/components/agent/chat-panel/task/BrowserTaskCard'))
    for (const [index, receipt] of data.downloadReceipts.entries()) {
      const name = `report-2026-q3 (${index + 2}).csv`
      assert.equal(data.results[index].filename, name)
      assert.equal(receipt.path, data.results[index].path)
      assert.equal(receipt.path, join(directory, name))
      assert.equal(receipt.readyRef.kind, 'file')
      if (receipt.readyRef.kind !== 'file') throw new Error('expected file ReadyRef')
      assert.equal(new ObjectPresentationService(f.registry).locate(receipt.readyRef.id)?.path, receipt.path)
      const html = renderToStaticMarkup(createElement(BrowserTaskCardView, {
        task: { browserTaskId: receipt.browserTaskId, ownerRunId: receipt.ownerRunId, parentTaskId: null,
          seenAt: 1, scopeId: null, title: null, tabIds: [], heldTabIds: [], attention: null, receipts: [receipt] },
        onContinue() {},
      }))
      assert.ok(html.includes(`href="${receipt.readyUri}"`), html)
      assert.ok(html.includes(`class="rn-ref__title">${name.slice(0, -4)}</span>`), html)
    }
  } finally { f.close() }
})
