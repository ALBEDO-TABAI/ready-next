import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { ConversationScope, ScopeRunSummary } from '../main/modules/agent-control/contracts/types'
import { RunProjection } from '../main/modules/agent-control/task-projection/run-projection'
import { executeBrowserTool } from '../main/modules/tools/browser-tools'
import { executeSendImFileTool } from '../main/modules/tools/send-im-skill-tool'

function createScope(): ConversationScope {
  return {
    id: 'scope-browser-send-im',
    agent: 'butler',
    title: '测试会话',
    sourceKind: 'local',
    sourceId: 'app',
    threadKey: 'scope-browser-send-im',
    meta: {},
    createdAt: '2026-06-18T00:00:00.000Z',
    updatedAt: '2026-06-18T00:00:00.000Z',
    lastMessageAt: '2026-06-18T00:00:00.000Z',
  }
}

function createDownloadController() {
  return {
    executeJS: async () => 'https://example.test/page',
    getActiveTab: () => ({ id: 'tab-1' }),
    downloadUrlToDirectory: async (payload: {
      url: string
      targetDir: string
      suggestedName?: string | null
    }) => {
      const bytes = Buffer.from([1, 2, 3])
      const filename = `${payload.suggestedName || 'image'}.jpg`
      const savePath = join(payload.targetDir, filename)
      writeFileSync(savePath, bytes)
      return {
        success: true,
        savePath,
        filename,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        mimeType: 'image/jpeg',
        urlChain: [payload.url],
      }
    },
  }
}

test('browser_download registers downloaded images as recent artifacts', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-browser-download-artifacts-'))
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = (async () => { throw new Error('Node fetch must not be used for browser downloads') }) as typeof fetch

    const output = await executeBrowserTool(
      'browser_download',
      {
        urls: [
          'https://example.test/one.jpg',
          'https://example.test/two.jpg',
          'https://example.test/three.jpg',
          'https://example.test/four.jpg',
        ],
        directory: dir,
        filename_prefix: 'image',
        unrelated_to_collection: true,
      },
      createDownloadController() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { workspaceRoots: [dir] },
    )

    assert.equal(typeof output, 'object')
    if (typeof output === 'string') return
    const artifacts = output.projectionPatch?.recentArtifacts as Array<{ path?: string; kind?: string }> | undefined
    assert.equal(artifacts?.length, 4)
    assert.deepEqual(artifacts?.map((artifact) => artifact.kind), ['image', 'image', 'image', 'image'])
    assert.equal(output.contextModifier?.activeFrame?.discoveredHandles?.length, 4)
    for (const artifact of artifacts || []) {
      assert.equal(typeof artifact.path, 'string')
      assert.equal(existsSync(artifact.path || ''), true)
    }
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

test('downloaded media flows through projection recentArtifacts into send-im attachments', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-browser-download-send-im-'))
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = (async () => { throw new Error('Node fetch must not be used for browser downloads') }) as typeof fetch

    const downloadOutput = await executeBrowserTool(
      'browser_download',
      {
        urls: [
          'https://example.test/one.jpg',
          'https://example.test/two.jpg',
          'https://example.test/three.jpg',
          'https://example.test/four.jpg',
        ],
        directory: dir,
        filename_prefix: 'image',
        unrelated_to_collection: true,
      },
      createDownloadController() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { workspaceRoots: [dir] },
    )
    assert.equal(typeof downloadOutput, 'object')
    if (typeof downloadOutput === 'string') return

    const store = new Map<string, ScopeRunSummary>()
    const projection = new RunProjection({
      getScope: () => createScope(),
      getPrevious: (scopeId) => store.get(scopeId),
      setSummary: (scopeId, summary) => {
        store.set(scopeId, summary)
      },
      toChannelKey: () => 'local:app',
    })
    const summary = projection.recordEvent({
      type: 'updated',
      scopeId: 'scope-browser-send-im',
      agent: 'butler',
      phase: 'tool_running',
      recentArtifacts: downloadOutput.projectionPatch?.recentArtifacts as ScopeRunSummary['recentArtifacts'],
      timestamp: '2026-06-18T00:00:00.000Z',
    })

    const sentPayloads: Array<{ attachments?: Array<Record<string, unknown>> }> = []
    const sendOutput = await executeSendImFileTool(
      { target: 'wechat' },
      {
        runtime: {
          listChannels: () => [{
            id: 'channel-wechat-openclaw-default',
            type: 'wechat-openclaw',
            name: '微信',
            enabled: true,
            config: {},
          }],
        },
        sidecarManager: {
          isRunning: () => true,
          sendChannel: async (payload) => {
            sentPayloads.push(payload)
            return { success: true }
          },
        },
        currentUserText: '把这四张图发到我微信',
        requestEnvelope: {
          recentArtifacts: summary?.recentArtifacts,
        },
      },
    )

    assert.equal(sendOutput.data?.status, 'done')
    assert.equal(sentPayloads.length, 1)
    assert.equal(sentPayloads[0]?.attachments?.length, 4)
    assert.deepEqual(
      sentPayloads[0]?.attachments?.map((attachment) => attachment.path),
      summary?.recentArtifacts?.map((artifact) => artifact.path),
    )
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})
