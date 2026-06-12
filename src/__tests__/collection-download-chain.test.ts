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

    // without expected_total and everything saved → complete
    const full = await executeBrowserTool('browser_download_collected_media', {
      source_task_id: 'task-gallery-1',
      directory: dir,
    }, controller, undefined, 'scope-img')
    const fullParsed = JSON.parse(full)
    assert.equal(fullParsed.completion, 'complete')
    assert.equal(fullParsed.remaining, 0)
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
