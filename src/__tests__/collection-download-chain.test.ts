/**
 * EP2 dogfood — the collection chain re-closed: discovery → download →
 * card progress → completion reconciliation → file-tree refresh.
 *
 * 1. with a completed image_gallery source task in scope, raw
 *    browser_download_urls redirects to browser_download_collected_media
 *    (escape hatch: unrelated_to_collection)
 * 2. discovered < page-claimed total → completion 'partial', never complete
 * 3. saved/failed/remaining flow back to the source task (card numbers move)
 * 4. successful downloads broadcast document:directoryChanged
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { executeBrowserTool } from '../main/modules/tools/browser-tools'
import { __setWebContentsProviderForTests, broadcastDirectoryChanged } from '../main/modules/document-engine/ipc/directory-change-broadcast'

function galleryTask(taskId: string) {
  return {
    taskId,
    kind: 'visible_collect',
    status: 'completed',
    createdAt: '2026-06-12T10:00:00.000Z',
    updatedAt: '2026-06-12T10:05:00.000Z',
    result: {
      template: 'image_gallery',
      discoveryStatus: 'complete',
      targetUrl: 'https://example.com/board',
      items: Array.from({ length: 3 }, (_, index) => ({
        image: `https://example.com/img-${index}.jpg`,
      })),
    },
  }
}

function makeController(over: Record<string, unknown> = {}) {
  const recorded: Array<Record<string, unknown>> = []
  return {
    recorded,
    listTasksByKind: async () => [galleryTask('task-gallery-1')],
    getTask: async (taskId: string) => (taskId === 'task-gallery-1' ? galleryTask(taskId) : null),
    getTaskPayload: () => ({ scopeId: 'scope-img', template: 'image_gallery', url: 'https://example.com/board' }),
    recordCollectedMediaDownload: async (taskId: string, summary: Record<string, unknown>) => {
      recorded.push({ taskId, ...summary })
      return null
    },
    // session-download fake: every URL succeeds without network
    downloadUrlToDirectory: async (params: { url: string; targetDir: string }) => ({
      success: true,
      savePath: join(params.targetDir, 'img.jpg'),
      filename: 'img.jpg',
    }),
    executeJS: async () => 'https://example.com/board',
    ...over,
  } as never
}

test('gap 1: raw browser_download_urls redirects to the chained tool when a gallery source task exists', async () => {
  const controller = makeController()
  const output = await executeBrowserTool('browser_download_urls', {
    urls: ['https://example.com/img-0.jpg'],
    directory: '~/Documents',
  }, controller, undefined, 'scope-img')
  const parsed = JSON.parse(output)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.errorCode, 'use_collected_media_download')
  assert.equal(parsed.sourceTaskId, 'task-gallery-1')
  assert.equal(parsed.suggestedNextTool, 'browser_download_collected_media')

  // explicitly unrelated downloads pass the guard (and fail later on the
  // unsupported protocol — proving we got PAST the redirect)
  const unrelated = await executeBrowserTool('browser_download_urls', {
    urls: ['ftp://example.com/file.bin'],
    directory: '~/Documents',
    unrelated_to_collection: true,
  }, controller, undefined, 'scope-img')
  const unrelatedParsed = JSON.parse(unrelated)
  assert.equal(unrelatedParsed.results[0].error, 'unsupported_protocol')

  // no gallery task in scope → no redirect either
  const bare = makeController({ listTasksByKind: async () => [] })
  const free = await executeBrowserTool('browser_download_urls', {
    urls: ['ftp://example.com/file.bin'],
    directory: '~/Documents',
  }, bare, undefined, 'scope-img')
  assert.equal(JSON.parse(free).results[0].error, 'unsupported_protocol')
})

test('gaps 2+3: collected-media download reconciles discovered/saved/remaining and writes back to the source task', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-dl-'))
  try {
    const controller = makeController()
    const output = await executeBrowserTool('browser_download_collected_media', {
      source_task_id: 'task-gallery-1',
      directory: dir,
      expected_total: 72,
    }, controller, undefined, 'scope-img')
    const parsed = JSON.parse(output)
    assert.equal(parsed.discovered, 3)
    assert.equal(parsed.saved, 3)
    assert.equal(parsed.failedCount, 0)
    assert.equal(parsed.remaining, 69, 'page claims 72, discovered 3 → 69 undiscovered remain')
    assert.equal(parsed.completion, 'partial', 'undiscovered images mean PARTIAL — never 完成')
    assert.match(parsed.guidance, /仍有 69 张未发现/)

    // write-back reached the source task ledger (card numbers move)
    const recorded = (controller as unknown as { recorded: Array<Record<string, unknown>> }).recorded
    assert.equal(recorded.length, 1)
    assert.equal(recorded[0].taskId, 'task-gallery-1')
    assert.equal(recorded[0].saved, 3)
    assert.equal(recorded[0].remaining, 69)

    // no claim ANYWHERE (no arg, no source-recorded total) and everything
    // saved → complete is legitimate
    const full = await executeBrowserTool('browser_download_collected_media', {
      source_task_id: 'task-gallery-1',
      directory: dir,
    }, controller, undefined, 'scope-img')
    const fullParsed = JSON.parse(full)
    assert.equal(fullParsed.completion, 'complete')
    assert.equal(fullParsed.remaining, 0)

    // the SOURCE TASK recorded the page claim (userExpectedTotal) — a model
    // that forgets expected_total can no longer silence the gap
    const claimedTask = galleryTask('task-gallery-1')
    ;(claimedTask.result as Record<string, unknown>).userExpectedTotal = 72
    const claimedController = makeController({
      getTask: async () => claimedTask,
    })
    const claimed = await executeBrowserTool('browser_download_collected_media', {
      source_task_id: 'task-gallery-1',
      directory: dir,
    }, claimedController, undefined, 'scope-img')
    const claimedParsed = JSON.parse(claimed)
    assert.equal(claimedParsed.completion, 'partial', 'source-recorded claim forces partial without the arg')
    assert.equal(claimedParsed.remaining, 69)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('gap 4: successful downloads broadcast document:directoryChanged to every live webContents', async () => {
  const sent: Array<{ channel: string; payload: { paths: string[] } }> = []
  __setWebContentsProviderForTests(() => [
    { isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload: payload as { paths: string[] } }) },
    { isDestroyed: () => true, send: () => { throw new Error('must not send to destroyed') } },
  ])
  try {
    const dir = mkdtempSync(join(tmpdir(), 'ready-dl-bc-'))
    try {
      const controller = makeController({ listTasksByKind: async () => [] })
      await executeBrowserTool('browser_download_urls', {
        urls: ['https://example.com/img-0.jpg'],
        directory: dir,
      }, controller, undefined, 'scope-img')
      assert.equal(sent.length, 1, 'one live webContents notified')
      assert.equal(sent[0].channel, 'document:directoryChanged')
      assert.deepEqual(sent[0].payload.paths, [dir])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }

    // outside Electron (no provider, no electron module) → graceful zero
    __setWebContentsProviderForTests(null)
    assert.equal(broadcastDirectoryChanged(['/tmp/x']), 0)
  } finally {
    __setWebContentsProviderForTests(null)
  }
})

test('projection truth: the card reads 52/72 with 剩余 19 — never 52/53 剩余 0', async () => {
  const { makeNoteCollectProjectionSink } = await import('../main/modules/claude-bridge/browser-collection-projection-sink')
  const rows = new Map<string, Record<string, unknown>>()
  const store = {
    get: (taskId: string) => (rows.get(taskId) ?? null) as never,
    create: (record: { taskId: string }) => { rows.set(record.taskId, record as never) },
    update: (taskId: string, patch: Record<string, unknown>) => {
      rows.set(taskId, { ...rows.get(taskId), ...patch })
    },
  }
  const sink = makeNoteCollectProjectionSink({ getTaskProjectionStore: () => store } as never)

  // discovery phase: 53 discovered of a page-claimed 72
  sink.upsert({
    taskId: 'src-1', scopeId: 'scope-img', title: '图片采集', summary: '发现中',
    state: 'running', total: 53, completed: 0, failed: 0,
    discovered: 53, userExpectedTotal: 72,
  } as never)

  // download write-back (refreshOnly): 52 saved, 1 failed
  sink.upsert({
    taskId: 'src-1#media-download', sourceTaskId: 'src-1', scopeId: 'scope-img',
    title: '图片采集', summary: '已保存 52 张 · 失败 1 · 剩余 19',
    state: 'completed', refreshOnly: true,
    total: 53, completed: 52, failed: 1,
    discovered: 53, saved: 52, userExpectedTotal: 72,
  } as never)

  const projection = rows.get('src-1') as { status: string; progress: { total: number; completed: number; detail: string } }
  assert.equal(projection.progress.total, 72, 'card total = page-claimed 72, not discovered 53')
  assert.equal(projection.progress.completed, 52)
  assert.match(projection.progress.detail, /发现 53\/72/)
  assert.match(projection.progress.detail, /剩余 19/, 'remaining includes the 19 undiscovered')
  assert.equal(projection.status, 'running', 'refreshOnly keeps the existing status — numbers move, lifecycle untouched')

  // refreshOnly with no existing projection is a no-op, never a create
  sink.upsert({
    taskId: 'ghost#media-download', sourceTaskId: 'ghost', scopeId: 'scope-img',
    title: 'x', summary: 'x', state: 'completed', refreshOnly: true,
    total: 1, completed: 1, failed: 0,
  } as never)
  assert.equal(rows.has('ghost'), false)
})
