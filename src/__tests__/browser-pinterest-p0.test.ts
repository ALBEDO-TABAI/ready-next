import assert from 'node:assert/strict'
import test from 'node:test'

import {
  executeBrowserTool,
  normalizeDownloadTargets,
  pinimgOriginalsUrl,
} from '../main/modules/tools/browser-tools'
import { resolveAuthorizedBrowserDownloadDirectory } from '../main/modules/tools/browser-media-download'
import type { ToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'

function parseBrowserJson(output: string | ToolExecutionOutput): any {
  return JSON.parse(typeof output === 'string' ? output : output.text)
}

// ── P0.2 — Pinterest /originals/ upgrade + size-variant dedupe ──────────────

test('pinimgOriginalsUrl upgrades a thumbnail path segment to /originals/', () => {
  assert.equal(
    pinimgOriginalsUrl('https://i.pinimg.com/474x/ab/cd/ef/hash.jpg'),
    'https://i.pinimg.com/originals/ab/cd/ef/hash.jpg',
  )
  // already-originals and non-pinimg URLs are not upgradeable
  assert.equal(pinimgOriginalsUrl('https://i.pinimg.com/originals/ab/cd/ef/hash.jpg'), null)
  assert.equal(pinimgOriginalsUrl('https://example.com/474x/img.jpg'), null)
})

test('normalizeDownloadTargets collapses pinimg size variants of one pin and prefers originals', () => {
  const targets = normalizeDownloadTargets([
    'https://i.pinimg.com/474x/ab/cd/ef/pinA.jpg',
    'https://i.pinimg.com/originals/ab/cd/ef/pinA.jpg', // same pin, different size
    'https://i.pinimg.com/236x/11/22/33/pinB.jpg',
    'https://example.com/photo.jpg', // non-pinimg, kept as-is
    'https://example.com/photo.jpg', // exact dup, dropped
  ])
  // pinA collapses to ONE entry, pinB one, example one → 3 distinct
  assert.equal(targets.length, 3)
  const pinA = targets[0]
  assert.equal(pinA.url, 'https://i.pinimg.com/originals/ab/cd/ef/pinA.jpg')
  // the pre-upgrade variant is kept as the fetch fallback
  assert.equal(pinA.fallbackUrl, 'https://i.pinimg.com/474x/ab/cd/ef/pinA.jpg')
  const pinB = targets[1]
  assert.equal(pinB.url, 'https://i.pinimg.com/originals/11/22/33/pinB.jpg')
  const plain = targets[2]
  assert.equal(plain.url, 'https://example.com/photo.jpg')
  assert.equal(plain.fallbackUrl, null)
})

test('normalizeDownloadTargets keeps a thumbnail fallback even when /originals/ appears FIRST', () => {
  const targets = normalizeDownloadTargets([
    'https://i.pinimg.com/originals/ab/cd/ef/pinA.jpg', // originals first
    'https://i.pinimg.com/474x/ab/cd/ef/pinA.jpg',      // same pin, thumbnail later
  ])
  assert.equal(targets.length, 1)
  assert.equal(targets[0].url, 'https://i.pinimg.com/originals/ab/cd/ef/pinA.jpg')
  // the later thumbnail is adopted as the 403/404 fallback (order-independent)
  assert.equal(targets[0].fallbackUrl, 'https://i.pinimg.com/474x/ab/cd/ef/pinA.jpg')
})

test('download upgrades pinimg to originals and falls back to the thumbnail when originals 404s', async (t) => {
  const requested: string[] = []

  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'ready-pin-p0-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const output = await executeBrowserTool('browser_download', {
    urls: ['https://i.pinimg.com/474x/ab/cd/ef/pinA.jpg'],
    directory: dir,
    unrelated_to_collection: true,
  }, {
    executeJS: async () => 'https://i.pinimg.com/',
    downloadUrlToDirectory: async (params: { url: string; targetDir: string; suggestedName?: string | null }) => {
      requested.push(params.url)
      if (params.url.includes('/originals/')) return { success: false, error: 'HTTP 404' }
      return {
        success: true,
        savePath: join(params.targetDir, `${params.suggestedName || 'pin'}.jpg`),
        filename: `${params.suggestedName || 'pin'}.jpg`,
        size: 3,
        mimeType: 'image/jpeg',
      }
    },
  } as never, undefined, undefined, undefined, undefined, undefined, { workspaceRoots: [dir] })
  const parsed = parseBrowserJson(output)
  assert.equal(parsed.success, 1, 'pin saved via fallback')
  // originals attempted FIRST, then the 474x fallback
  assert.ok(requested.some((u) => u.includes('/originals/')), 'originals attempted')
  assert.ok(requested.some((u) => u.includes('/474x/')), 'thumbnail fallback attempted')
})

// ── P0.3 — explicit target folder required (no silent ~/Documents) ──────────

test('browser_download uses the Ready-owned default when no directory is supplied', () => {
  const resolved = resolveAuthorizedBrowserDownloadDirectory(undefined)
  assert.equal(resolved.ok, true)
  if (resolved.ok) assert.equal(resolved.authority, 'ready_default')
})

// ── P0.1 — a recent FAILED image_gallery must not be salvaged by manual URLs ─

function failedGalleryTask(taskId: string) {
  return {
    taskId,
    kind: 'visible_collect',
    status: 'failed',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    result: { template: 'image_gallery', stopReason: 'script_failed_to_execute', targetUrl: 'https://jp.pinterest.com/u/board' },
  }
}

function controllerWithFailedGallery() {
  return {
    listTasksByKind: async (kind: string) => (kind === 'visible_collect' ? [failedGalleryTask('task-failed-1')] : []),
    getTask: async (taskId: string) => (taskId === 'task-failed-1' ? failedGalleryTask(taskId) : null),
    getTaskPayload: () => ({ scopeId: 'scope-pin', template: 'image_gallery', url: 'https://jp.pinterest.com/u/board' }),
    executeJS: async () => 'https://jp.pinterest.com/u/board',
  } as never
}

test('browser_download is blocked after a recent failed image_gallery and steers back to the structured collection', async () => {
  const output = await executeBrowserTool('browser_download', {
    urls: ['https://i.pinimg.com/474x/ab/cd/ef/pinA.jpg'],
    directory: '/tmp/pin',
  }, controllerWithFailedGallery(), undefined, 'scope-pin')
  const parsed = parseBrowserJson(output)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.errorCode, 'image_gallery_collection_failed_retry_required')
  assert.equal(parsed.failedTaskId, 'task-failed-1')
  assert.equal(parsed.suggestedNextTool, 'browser_collect')
})

test('a pinimg batch with NO prior collection task is steered to the structured image_gallery chain', async () => {
  const controller = {
    listTasksByKind: async () => [], // no prior collection task in scope
    getTask: async () => null,
    getTaskPayload: () => null,
    executeJS: async () => 'https://jp.pinterest.com/u/board',
  } as never
  const output = await executeBrowserTool('browser_download', {
    urls: [
      'https://i.pinimg.com/474x/a/a/a/p1.jpg',
      'https://i.pinimg.com/474x/b/b/b/p2.jpg',
      'https://i.pinimg.com/236x/c/c/c/p3.jpg',
    ],
    directory: '/tmp/pin',
  }, controller, undefined, 'scope-pin')
  const parsed = parseBrowserJson(output)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.errorCode, 'use_structured_image_gallery_collection')
  assert.equal(parsed.suggestedNextTool, 'browser_collect')
})

test('a USABLE gallery source wins over a failed one (redirect to collected-media, not retry)', async () => {
  const usable = {
    taskId: 'task-usable-1',
    kind: 'visible_collect',
    status: 'completed',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    result: {
      template: 'image_gallery',
      discoveryStatus: 'complete',
      items: [{ image: 'https://i.pinimg.com/originals/aa/bb/cc/pin.jpg' }],
    },
  }
  const controller = {
    listTasksByKind: async (kind: string) => (kind === 'visible_collect' ? [usable, failedGalleryTask('task-failed-1')] : []),
    getTask: async (taskId: string) => (taskId === 'task-usable-1' ? usable : (taskId === 'task-failed-1' ? failedGalleryTask(taskId) : null)),
    getTaskPayload: (taskId: string) => ({ scopeId: 'scope-pin', template: 'image_gallery', url: 'https://jp.pinterest.com/u/board', taskId }),
    executeJS: async () => 'https://jp.pinterest.com/u/board',
  } as never
  const output = await executeBrowserTool('browser_download', {
    urls: ['https://i.pinimg.com/474x/ab/cd/ef/pinA.jpg'],
    directory: '/tmp/pin',
  }, controller, undefined, 'scope-pin')
  const parsed = parseBrowserJson(output)
  assert.equal(parsed.errorCode, 'use_collected_media_download')
  assert.equal(parsed.sourceTaskId, 'task-usable-1')
})

test('browser_collect(visible_collect) routes through startVisibleCollection with tab_id→tabId + scope', async () => {
  const captured: { payload?: Record<string, unknown>; scope?: string } = {}
  let rawStartCalled = false
  const controller = {
    // present → collection starts must use this path (it resolves the tab URL)
    startVisibleCollection: async (payload: Record<string, unknown>, scopeId?: string) => {
      captured.payload = payload
      captured.scope = scopeId
      return { taskId: 'task-x', status: 'queued' }
    },
    startTask: async () => { rawStartCalled = true; return { taskId: 'task-x', status: 'queued' } },
  } as never
  await executeBrowserTool('browser_collect', {
    mode: 'start',
    kind: 'visible_collect',
    payload: { tab_id: 'tab-7', template: 'image_gallery' }, // tab_id only, NO url
  }, controller, undefined, 'scope-pin')
  assert.equal(rawStartCalled, false, 'collection kind must not use raw startTask')
  assert.equal(captured.payload?.tabId, 'tab-7', 'external tab_id mapped to internal tabId')
  assert.equal(captured.scope, 'scope-pin', 'scope passed to startVisibleCollection')
})

test('browser_collect(non-collection) still uses raw startTask with mapped tab_id + scope', async () => {
  let captured: { kind?: string; payload?: Record<string, unknown> } = {}
  const controller = {
    startTask: async (req: { kind: string; payload: Record<string, unknown> }) => {
      captured = req
      return { taskId: 'task-y', status: 'queued' }
    },
  } as never
  await executeBrowserTool('browser_collect', {
    mode: 'start',
    kind: 'scroll_collect',
    payload: { tab_id: 'tab-3' },
  }, controller, undefined, 'scope-pin')
  assert.equal(captured.payload?.tabId, 'tab-3')
  assert.equal(captured.payload?.scopeId, 'scope-pin')
})

test('an explicitly unrelated download passes the failed-gallery guard', async () => {
  const output = await executeBrowserTool('browser_download', {
    urls: ['ftp://example.com/file.bin'], // unsupported protocol → proves we got PAST the guard
    directory: '/tmp/pin',
    unrelated_to_collection: true,
  }, controllerWithFailedGallery(), undefined, 'scope-pin')
  const parsed = parseBrowserJson(output)
  // not the guard error — we reached the download path
  assert.notEqual(parsed.errorCode, 'image_gallery_collection_failed_retry_required')
})
