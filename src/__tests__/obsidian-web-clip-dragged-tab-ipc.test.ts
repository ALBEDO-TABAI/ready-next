/**
 * Contract tests for `browser:clipDraggedTab` host-IPC.
 *
 * The IPC binding itself is registered against `ipcMain`, which is hard to
 * exercise without Electron. These tests exercise:
 *
 *   1. `runClipDraggedTabBackground` — the pure runner that the IPC handler
 *      defers to. We verify it: (a) emits `running` then `completed`, with
 *      a stable `taskId`; (b) maps `ClipFetchError(login_required)` to
 *      `clip_login_required`; (c) maps `ClipPipelineError` correctly with
 *      `recoverable` flag preserved; (d) maps unknown errors to `unexpected`.
 *
 *   2. The host-IPC channel is NOT registered as a model-facing tool —
 *      i.e. `browser:clipDraggedTab` does NOT appear in
 *      `GENERAL_RESEARCH_TOOL_NAMES`, must not be a tool name, and the
 *      preload bridge does not expose a typed/schema entry.
 *
 *   3. Renderer-facing payload shapes (running/completed/failed unions)
 *      are stable — taskId, url, status are always present.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert'

import {
  runClipDraggedTabBackground,
  validateClipDraggedTabArgs,
  type ClipDraggedTabRunnerDeps,
  type ClipBackgroundUpdate,
} from '../main/modules/clipping/clip-dragged-tab-runner'
import { ClipFetchError } from '../main/modules/clipping/clip-fetch'
import { ClipPipelineError } from '../main/modules/clipping/clip-pipeline'
import { GENERAL_RESEARCH_TOOL_NAMES } from '../main/modules/tools/general-research-tool-defs'

function makeRecorder(): {
  events: ClipBackgroundUpdate[]
  controller: { sendToRenderer: (channel: string, data: unknown) => void }
} {
  const events: ClipBackgroundUpdate[] = []
  return {
    events,
    controller: {
      sendToRenderer: (channel: string, data: unknown) => {
        assert.equal(channel, 'clip:backgroundUpdate', `unexpected channel ${channel}`)
        events.push(data as ClipBackgroundUpdate)
      },
    },
  }
}

function makeDeps(overrides: Partial<ClipDraggedTabRunnerDeps>): ClipDraggedTabRunnerDeps {
  return {
    getRuntimeInfo: () => ({ skillsRoot: '/tmp/skills', outputsRoot: '/tmp/outputs' }),
    fetchHtml: async () => ({
      html: '<html><head><title>T</title></head><body><article>body</article></body></html>',
      finalUrl: 'https://example.com/foo',
      titleFromHead: 'T',
    }),
    fetchJina: async () => undefined,
    runPipeline: async () => ({
      savedPath: '/tmp/outputs/obsidian-web-clip/foo.md',
      savedPathRelative: 'obsidian-web-clip/foo.md',
      suggestedVaultRelativePath: 'foo.md',
      preset: { id: 'article-clipper', name: 'Article' },
      frontmatter: { title: 'T', url: 'https://example.com/foo' },
      title: 'T',
      url: 'https://example.com/foo',
      warnings: [],
    }),
    generateTaskId: () => 'clip-test-001',
    materializeToTargetDir: async (_savedPath, _targetDir) => ({
      ok: false,
      error: { kind: 'invalid_target', message: 'default fake — no target_dir test' },
    }),
    ...overrides,
  }
}

describe('runClipDraggedTabBackground · happy path', () => {
  it('emits running then completed with stable taskId', async () => {
    const { events, controller } = makeRecorder()
    await runClipDraggedTabBackground(
      'clip-test-001',
      { url: 'https://example.com/foo', title: 'A page', target_hint: '/vault/Notes' },
      controller,
      makeDeps({}),
    )
    assert.equal(events.length, 2, `expected 2 events, got ${events.length}`)
    assert.equal(events[0].status, 'running')
    assert.equal(events[0].taskId, 'clip-test-001')
    assert.equal(events[0].url, 'https://example.com/foo')
    assert.equal(events[0].targetHint, '/vault/Notes')
    assert.equal(events[1].status, 'completed')
    if (events[1].status === 'completed') {
      assert.equal(events[1].savedPath, '/tmp/outputs/obsidian-web-clip/foo.md')
      assert.equal(events[1].preset.id, 'article-clipper')
    }
  })

  it('runs with no Jina markdown (fetchJina returns undefined)', async () => {
    const { events, controller } = makeRecorder()
    let jinaCalled = false
    await runClipDraggedTabBackground(
      'clip-test-002',
      { url: 'https://example.com/bar' },
      controller,
      makeDeps({
        fetchJina: async () => {
          jinaCalled = true
          return undefined
        },
      }),
    )
    assert.equal(jinaCalled, true, 'fetchJina should be attempted')
    assert.equal(events[events.length - 1].status, 'completed')
  })

  it('swallows fetchJina throws as non-fatal', async () => {
    const { events, controller } = makeRecorder()
    await runClipDraggedTabBackground(
      'clip-test-003',
      { url: 'https://example.com/baz' },
      controller,
      makeDeps({
        fetchJina: async () => { throw new Error('jina-down') },
      }),
    )
    assert.equal(events[events.length - 1].status, 'completed')
  })

  it('recovers a raw 403 when Jina returns readable markdown', async () => {
    const { events, controller } = makeRecorder()
    let pipelineInput: { html: string; jinaMarkdown?: string } | null = null
    await runClipDraggedTabBackground(
      'clip-test-004',
      { url: 'https://example.com/cloudflare' },
      controller,
      makeDeps({
        fetchHtml: async () => { throw new ClipFetchError('login_required', 'HTTP 403') },
        fetchJina: async () => 'Title: Cloudflare page\n\nMarkdown Content:\n# Article\n\nBody',
        runPipeline: async (input) => {
          pipelineInput = { html: input.html, jinaMarkdown: input.jinaMarkdown }
          return {
            savedPath: '/tmp/outputs/obsidian-web-clip/cloudflare.md',
            savedPathRelative: 'obsidian-web-clip/cloudflare.md',
            suggestedVaultRelativePath: 'cloudflare.md',
            preset: { id: 'article-clipper', name: 'Article' },
            frontmatter: { title: 'Cloudflare page', url: 'https://example.com/cloudflare' },
            title: 'Cloudflare page',
            url: 'https://example.com/cloudflare',
            warnings: ['raw_html_unavailable_jina_fallback'],
          }
        },
      }),
    )
    const last = events[events.length - 1]
    assert.equal(last.status, 'completed')
    assert.deepEqual(pipelineInput, {
      html: '',
      jinaMarkdown: 'Title: Cloudflare page\n\nMarkdown Content:\n# Article\n\nBody',
    })
  })
})

describe('runClipDraggedTabBackground · error mapping', () => {
  it('maps ClipFetchError(fetch_failed) → clip_fetch_failed recoverable=true', async () => {
    const { events, controller } = makeRecorder()
    await runClipDraggedTabBackground(
      't-fetch-1',
      { url: 'https://example.com/x' },
      controller,
      makeDeps({
        fetchHtml: async () => { throw new ClipFetchError('fetch_failed', 'ECONNRESET') },
      }),
    )
    const last = events[events.length - 1]
    assert.equal(last.status, 'failed')
    if (last.status === 'failed') {
      assert.equal(last.errorKind, 'clip_fetch_failed')
      assert.equal(last.recoverable, true)
      assert.equal((last.errorDetail as { message: string }).message, 'ECONNRESET')
    }
  })

  it('maps ClipFetchError(login_required) → clip_login_required recoverable=false', async () => {
    const { events, controller } = makeRecorder()
    await runClipDraggedTabBackground(
      't-login-1',
      { url: 'https://example.com/x' },
      controller,
      makeDeps({
        fetchHtml: async () => { throw new ClipFetchError('login_required', 'HTTP 403') },
      }),
    )
    const last = events[events.length - 1]
    assert.equal(last.status, 'failed')
    if (last.status === 'failed') {
      assert.equal(last.errorKind, 'clip_login_required')
      assert.equal(last.recoverable, false)
    }
  })

  it('forwards ClipPipelineError errorKind + recoverable + detail', async () => {
    const { events, controller } = makeRecorder()
    await runClipDraggedTabBackground(
      't-pipe-1',
      { url: 'https://example.com/x' },
      controller,
      makeDeps({
        runPipeline: async () => {
          throw new ClipPipelineError(
            'clip_preset_render_failed',
            false,
            { reason: 'requires_interpreter', preset: 'youtube-clipper' },
            'Preset requires interpreter',
          )
        },
      }),
    )
    const last = events[events.length - 1]
    assert.equal(last.status, 'failed')
    if (last.status === 'failed') {
      assert.equal(last.errorKind, 'clip_preset_render_failed')
      assert.equal(last.recoverable, false)
      const detail = last.errorDetail as { reason: string; preset: string }
      assert.equal(detail.reason, 'requires_interpreter')
      assert.equal(detail.preset, 'youtube-clipper')
    }
  })

  it('maps unknown error → errorKind=unexpected recoverable=false', async () => {
    const { events, controller } = makeRecorder()
    await runClipDraggedTabBackground(
      't-unexp-1',
      { url: 'https://example.com/x' },
      controller,
      makeDeps({
        fetchHtml: async () => { throw new Error('something else') },
      }),
    )
    const last = events[events.length - 1]
    assert.equal(last.status, 'failed')
    if (last.status === 'failed') {
      assert.equal(last.errorKind, 'unexpected')
      assert.equal(last.recoverable, false)
      assert.equal((last.errorDetail as { message: string }).message, 'something else')
    }
  })
})

describe('runClipDraggedTabBackground · materialize to target_dir', () => {
  it('skips materialize when target_dir is absent (sandbox remains authoritative)', async () => {
    const { events, controller } = makeRecorder()
    let called = false
    await runClipDraggedTabBackground(
      'cp-skip-1',
      { url: 'https://example.com/x' },
      controller,
      makeDeps({
        materializeToTargetDir: async () => {
          called = true
          return { ok: false, error: { kind: 'invalid_target', message: 'unexpected' } }
        },
      }),
    )
    assert.equal(called, false)
    const last = events[events.length - 1]
    if (last.status === 'completed') {
      assert.equal(last.copiedPath, undefined)
      assert.equal(last.assetPaths, undefined)
      assert.equal(last.copyError, undefined)
      // sandbox remains authoritative — savedPath preserved
      assert.equal(last.savedPath, '/tmp/outputs/obsidian-web-clip/foo.md')
    } else {
      assert.fail('expected completed')
    }
  })

  it('forwards finalMdPath + assetPaths on successful materialize; clears sandbox savedPath', async () => {
    const { events, controller } = makeRecorder()
    await runClipDraggedTabBackground(
      'cp-ok-1',
      { url: 'https://example.com/x', target_dir: '/Users/me/Notes' },
      controller,
      makeDeps({
        materializeToTargetDir: async (savedPath, targetDir, options) => {
          assert.equal(savedPath, '/tmp/outputs/obsidian-web-clip/foo.md')
          assert.equal(targetDir, '/Users/me/Notes')
          assert.equal(options?.sourcePageUrl, 'https://example.com/foo')
          return {
            ok: true,
            result: {
              finalMdPath: '/Users/me/Notes/foo/foo.md',
              assetPaths: ['/Users/me/Notes/foo/foo.assets/abc1.jpg', '/Users/me/Notes/foo/foo.assets/def2.png'],
              imageDownloadFailures: 0,
              failureMessages: [],
            },
          }
        },
      }),
    )
    const last = events[events.length - 1]
    if (last.status === 'completed') {
      assert.equal(last.copiedPath, '/Users/me/Notes/foo/foo.md')
      assert.deepEqual(last.assetPaths, [
        '/Users/me/Notes/foo/foo.assets/abc1.jpg',
        '/Users/me/Notes/foo/foo.assets/def2.png',
      ])
      assert.equal(last.imageDownloadFailures, 0)
      assert.equal(last.copyError, undefined)
      // Sandbox file moved → savedPath cleared so renderer knows canonical
      // location is the vault, not the sandbox.
      assert.equal(last.savedPath, '')
    } else {
      assert.fail('expected completed')
    }
  })

  it('forwards copyError without failing the overall clip; sandbox stays authoritative', async () => {
    const { events, controller } = makeRecorder()
    await runClipDraggedTabBackground(
      'cp-fail-1',
      { url: 'https://example.com/x', target_dir: '/nonexistent/path' },
      controller,
      makeDeps({
        materializeToTargetDir: async () => ({
          ok: false,
          error: { kind: 'not_a_directory', message: 'target_dir is not a directory' },
        }),
      }),
    )
    const last = events[events.length - 1]
    assert.equal(last.status, 'completed', 'clip must still be completed; materialize is best-effort')
    if (last.status === 'completed') {
      assert.equal(last.copiedPath, undefined)
      assert.equal(last.copyError?.kind, 'not_a_directory')
      assert.equal(last.savedPath, '/tmp/outputs/obsidian-web-clip/foo.md')
    }
  })

  it('reports imageDownloadFailures when some assets fail', async () => {
    const { events, controller } = makeRecorder()
    await runClipDraggedTabBackground(
      'cp-partial-1',
      { url: 'https://example.com/x', target_dir: '/Users/me/Notes' },
      controller,
      makeDeps({
        materializeToTargetDir: async () => ({
          ok: true,
          result: {
            finalMdPath: '/Users/me/Notes/foo/foo.md',
            assetPaths: ['/Users/me/Notes/foo/foo.assets/aaa.jpg'],
            imageDownloadFailures: 3,
            failureMessages: ['timeout', 'http 403', 'too large'],
          },
        }),
      }),
    )
    const last = events[events.length - 1]
    if (last.status === 'completed') {
      assert.equal(last.imageDownloadFailures, 3)
      assert.equal(last.assetPaths?.length, 1)
    } else {
      assert.fail('expected completed')
    }
  })
})

describe('validateClipDraggedTabArgs · input gating', () => {
  it('rejects null / non-object', () => {
    assert.equal(validateClipDraggedTabArgs(null).ok, false)
    assert.equal(validateClipDraggedTabArgs(null).errorKind, 'invalid_args')
    assert.equal(validateClipDraggedTabArgs(undefined).ok, false)
    assert.equal(validateClipDraggedTabArgs('').ok, false)
    assert.equal(validateClipDraggedTabArgs(42).ok, false)
  })

  it('rejects missing or non-string url', () => {
    assert.equal(validateClipDraggedTabArgs({}).errorKind, 'invalid_args')
    assert.equal(validateClipDraggedTabArgs({ url: '' }).errorKind, 'invalid_args')
    assert.equal(validateClipDraggedTabArgs({ url: 42 }).errorKind, 'invalid_args')
  })

  it('rejects non-http(s) url', () => {
    assert.equal(validateClipDraggedTabArgs({ url: 'file:///etc/passwd' }).errorKind, 'invalid_url')
    assert.equal(validateClipDraggedTabArgs({ url: 'chrome://settings' }).errorKind, 'invalid_url')
    assert.equal(validateClipDraggedTabArgs({ url: 'javascript:alert(1)' }).errorKind, 'invalid_url')
    assert.equal(validateClipDraggedTabArgs({ url: 'data:text/html,foo' }).errorKind, 'invalid_url')
  })

  it('accepts well-formed http(s) urls', () => {
    assert.equal(validateClipDraggedTabArgs({ url: 'https://example.com/foo' }).ok, true)
    assert.equal(validateClipDraggedTabArgs({ url: 'http://localhost:8080/x' }).ok, true)
  })
})

describe('clipDraggedTab IPC · host-IPC-only invariant', () => {
  it('browser:clipDraggedTab is NOT exposed as a model-facing tool name', () => {
    // The drop-tab IPC must never become a model-callable tool — it bypasses
    // §6.20 frame state + §6.23 authorization by being host-IPC-only.
    assert.equal(GENERAL_RESEARCH_TOOL_NAMES.includes('browser:clipDraggedTab' as never), false)
    assert.equal(GENERAL_RESEARCH_TOOL_NAMES.includes('clip_dragged_tab' as never), false)
    assert.equal(GENERAL_RESEARCH_TOOL_NAMES.includes('clipDraggedTab' as never), false)
  })
})

describe('clipDraggedTab · payload shape stability', () => {
  it('every emitted update carries taskId, url, status', async () => {
    const { events, controller } = makeRecorder()
    await runClipDraggedTabBackground(
      'shape-test-1',
      { url: 'https://example.com/foo' },
      controller,
      makeDeps({}),
    )
    for (const e of events) {
      assert.ok(e.taskId, `event missing taskId: ${JSON.stringify(e)}`)
      assert.ok(e.url, `event missing url: ${JSON.stringify(e)}`)
      assert.ok(e.status, `event missing status: ${JSON.stringify(e)}`)
    }
  })

  it('failed update carries errorKind + recoverable flag', async () => {
    const { events, controller } = makeRecorder()
    await runClipDraggedTabBackground(
      'shape-test-2',
      { url: 'https://example.com/foo' },
      controller,
      makeDeps({
        fetchHtml: async () => { throw new ClipFetchError('fetch_failed', 'x') },
      }),
    )
    const last = events[events.length - 1]
    assert.equal(last.status, 'failed')
    if (last.status === 'failed') {
      assert.ok(last.errorKind, 'errorKind required')
      assert.equal(typeof last.recoverable, 'boolean')
    }
  })
})
