import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { executeBrowserTool } from '../main/modules/tools/browser-tools'
import { BrowserWriteLeaseService } from '../main/modules/browser-engine/browser-write-lease'
import { isAgentBrowserError } from '../main/modules/browser-engine/agent-browser-errors'
import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import type { BrowserLeaseGate } from '../main/modules/browser-engine/agent-browser-lease-gate'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('agent-browser-lease-gate-integration declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'agent-browser-lease-gate-integration transitive sqlite load')
})

function createController(overrides?: Partial<BrowserController>): BrowserController {
  const mock: Partial<BrowserController> = {
    getTabList: () => [{ id: 'tab-1', title: 'T', url: 'https://example.com', active: true }],
    getActiveTab: () => ({ id: 'tab-1', title: 'T', url: 'https://example.com', active: true }) as never,
    getPageContent: async () => 'visible page text',
    normalizedToCss: async (_t, x, y) => ({ x: Number(x), y: Number(y), width: 1000, height: 800 }),
    dispatchMouse: async () => {},
    getViewportMetrics: async () => ({ width: 1000, height: 800, pageX: 0, pageY: 0, scale: 1 }),
    executeJS: async () => null,
    ...(overrides || {}),
  }
  return mock as BrowserController
}

function parseError(result: string) {
  try {
    const parsed = JSON.parse(result)
    return isAgentBrowserError(parsed) ? parsed : null
  } catch {
    return null
  }
}

describe('lease gate integration on executeBrowserTool', () => {
  it('without a gate, behavior is unchanged (legacy callers unaffected)', async () => {
    const controller = createController()
    const out = await executeBrowserTool('browser_read_page', {}, controller)
    assert.equal(out, 'visible page text')
  })

  it('denies a write tool with lease_required when no lease is held', async () => {
    const service = new BrowserWriteLeaseService()
    const gate: BrowserLeaseGate = { service, surface: 'user-view', leaseId: null }
    const controller = createController()
    const out = await executeBrowserTool('browser_click_at', { x: 1, y: 1 }, controller, undefined, undefined, gate)
    const err = parseError(out)
    assert.ok(err, `expected structured error, got: ${out}`)
    assert.equal(err?.errorCode, 'lease_required')
  })

  it('lets read tools through without a lease (reads are free)', async () => {
    const service = new BrowserWriteLeaseService()
    const gate: BrowserLeaseGate = { service, surface: 'user-view', leaseId: null }
    const controller = createController()
    const out = await executeBrowserTool('browser_read_page', {}, controller, undefined, undefined, gate)
    assert.equal(out, 'visible page text')
  })

  it('classifies extract_structured by call: read (no url) passes, write (url) is gated', async () => {
    const service = new BrowserWriteLeaseService()
    const gate: BrowserLeaseGate = { service, surface: 'user-view', leaseId: null }
    const controller = createController({
      extractStructured: async () => ({ template: 'article_list', items: [], sourceUrl: '' }),
      extractStructuredFromUrl: async () => ({ template: 'article_list', items: [], sourceUrl: '' }),
      openForCaptureTarget: async () => ({ success: true, tabId: 'tab-1' }),
    } as Partial<BrowserController>)

    const readOut = await executeBrowserTool('browser_extract_structured', { template: 'article_list' }, controller, undefined, undefined, gate)
    assert.equal(parseError(readOut), null, 'extract without url is a read and must pass')

    const writeOut = await executeBrowserTool('browser_extract_structured', { template: 'article_list', url: 'https://example.com/feed' }, controller, undefined, undefined, gate)
    const err = parseError(writeOut)
    assert.ok(err, 'extract with url is a write and must be gated')
    assert.equal(err?.errorCode, 'lease_required')
  })

  it('always gates browser_execute_js (undecidable => write), even read-looking code', async () => {
    const service = new BrowserWriteLeaseService()
    const gate: BrowserLeaseGate = { service, surface: 'user-view', leaseId: null }
    const controller = createController()
    const out = await executeBrowserTool('browser_execute_js', { code: 'document.title' }, controller, undefined, undefined, gate)
    const err = parseError(out)
    assert.ok(err)
    assert.equal(err?.errorCode, 'lease_required')
  })

  it('permits a write once a valid lease is held, then blocks it with lease_takeover after user takeover', async () => {
    const service = new BrowserWriteLeaseService()
    const lease = service.acquire({ surface: 'user-view', taskId: 't1', runId: 'r1' })
    if (isAgentBrowserError(lease)) throw new Error('expected lease')
    const gate: BrowserLeaseGate = { service, surface: 'user-view', leaseId: lease.leaseId }
    // browser_go_back is a lightweight write (no slow verification path).
    const controller = createController({ goBack: () => ({ success: true }) } as Partial<BrowserController>)

    const ok = await executeBrowserTool('browser_go_back', {}, controller, undefined, undefined, gate)
    assert.equal(parseError(ok), null, 'write with a valid lease must pass')

    service.recordUserSignal({ surface: 'user-view', source: 'keyboard' })
    const blocked = await executeBrowserTool('browser_go_back', {}, controller, undefined, undefined, gate)
    const err = parseError(blocked)
    assert.ok(err)
    assert.equal(err?.errorCode, 'lease_takeover')
  })
})
