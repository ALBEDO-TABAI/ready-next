import assert from 'node:assert/strict'
import test from 'node:test'

import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import { buildPageMap } from '../main/modules/browser-engine/agent-browser-page-map'
import { captureBrowserCdpPageMap } from '../main/modules/browser-engine/browser-cdp-page-map-capture'
import { browserSnapshotService } from '../main/modules/browser-engine/browser-snapshot-service'
import { callBrowserBackendTarget } from '../main/modules/tools/browser-probe'

test('CDP capture keeps delegated targets beyond an old fixed scan cap and resolves the backend node for action', async () => {
  browserSnapshotService.resetForTests()
  const delegatedIds = Array.from({ length: 250 }, (_, index) => 1_000 + index)
  const backendCalls: Array<{ id: number; operation: string }> = []
  const cdpCalls: Array<{ method: string; params: unknown }> = []
  const controller = {
    getActiveTab: () => ({ id: 'tab-a' }),
    getPhysicalTargetToken: () => 'physical-a',
    executeJS: async () => ({
      url: 'https://example.test/page',
      title: 'Page',
      timeOrigin: 10,
      mutationRevision: 0,
      frameDocumentToken: 'document-a',
    }),
    sendCdpCommand: async (_tabId: string | null, method: string, params?: unknown) => {
      cdpCalls.push({ method, params })
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'main-frame' } } }
      }
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            { nodeId: 'root', frameId: 'main-frame', role: { value: 'generic' }, name: { value: '' }, backendDOMNodeId: 10 },
            { nodeId: 'child-frame-button', frameId: 'child-frame', role: { value: 'button' }, name: { value: 'wrong-frame' }, backendDOMNodeId: 9_000 },
          ],
        }
      }
      if (method === 'DOMSnapshot.captureSnapshot') {
        return {
          documents: [
            {
              frameId: 'main-frame',
              nodes: {
                backendNodeId: [10, ...delegatedIds],
                isClickable: { index: delegatedIds.map((_, index) => index + 1) },
              },
            },
            {
              frameId: 'child-frame',
              nodes: {
                backendNodeId: [9_000, 9_001],
                isClickable: { index: [0, 1] },
              },
            },
          ],
        }
      }
      throw new Error(`unexpected CDP method ${method}`)
    },
    callFunctionOnBackendNode: async (
      _tabId: string | null,
      backendDOMNodeId: number,
      _functionDeclaration: string,
      args: unknown[],
    ) => {
      const operation = String(args[0] || '')
      backendCalls.push({ id: backendDOMNodeId, operation })
      return {
        matchCount: 1,
        disabled: false,
        target: {
          role: 'clickable',
          name: `delegated-${backendDOMNodeId - 1_000}`,
          box: { x: 10, y: 20, width: 40, height: 20 },
          visible: true,
          enabled: true,
          editable: false,
        },
      }
    },
  } as unknown as BrowserController

  const payload = await browserSnapshotService.capture(controller, 'tab-a', 8_192, async (generation) => {
    const captured = await captureBrowserCdpPageMap(controller, 'tab-a', async (backendDOMNodeId, roleHint) => {
      const result = await callBrowserBackendTarget(controller, 'tab-a', backendDOMNodeId, 'probe', { roleHint }) as { target?: Record<string, unknown> }
      return result.target || null
    })
    assert.ok(captured)
    const pageMap = buildPageMap(captured.rawRoots, {
      generation,
      viewport: { width: 1_000, height: 800 },
      maxBytes: 4_096,
    })
    return { pageMap }
  }, { force: true })

  assert.equal((payload.pageMap as { totalTargets?: number }).totalTargets, 250)
  assert.deepEqual(
    cdpCalls.find((call) => call.method === 'Accessibility.getFullAXTree')?.params,
    { frameId: 'main-frame' },
  )
  assert.equal(backendCalls.some((call) => call.id >= 9_000), false, 'subframe nodes must use the frame-bound probe path')
  const found = browserSnapshotService.find(controller, 'tab-a', {
    query: 'delegated-125',
    purpose: 'action',
    limit: 10,
  })
  assert.equal(found?.matches.length, 1)
  const target = found!.matches[0]
  assert.equal(target.backendDOMNodeId, 1_125)
  const resolved = await browserSnapshotService.resolveRef(controller, 'tab-a', target.targetId)
  assert.equal(resolved.ok, true)
  if (!resolved.ok) return
  assert.match(resolved.rawTargetId, /:b1125$/)

  await callBrowserBackendTarget(controller, 'tab-a', 1_125, 'probe', { roleHint: 'clickable' })
  assert.deepEqual(backendCalls.at(-1), { id: 1_125, operation: 'probe' })
})
