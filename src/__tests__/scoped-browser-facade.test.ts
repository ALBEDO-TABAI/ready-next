import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ScopedBrowserFacade } from '../main/modules/browser-engine/scoped-browser-facade'
import { AgentTabControlGate } from '../main/modules/browser-engine/agent-tab-control-gate'
import { BrowserWriteLeaseService } from '../main/modules/browser-engine/browser-write-lease'
import { isAgentBrowserError } from '../main/modules/browser-engine/agent-browser-errors'

function makeFacade(overrides?: { controlGate?: AgentTabControlGate }) {
  const calls: Array<{ tool: string; args: Record<string, unknown>; surface: string; leaseId: string }> = []
  const leaseService = new BrowserWriteLeaseService()
  const lease = leaseService.acquire({ surface: 'agent-view', taskId: 'collect', runId: 'r1' })
  if ('errorCode' in lease) throw new Error('expected lease')
  const controlGate = overrides?.controlGate ?? new AgentTabControlGate()
  const facade = new ScopedBrowserFacade({
    agentTabId: 'agent-tab-1',
    leaseService,
    leaseId: lease.leaseId,
    controlGate,
    execute: async (tool, args, surface, leaseId) => {
      calls.push({ tool, args, surface, leaseId })
      return JSON.stringify({ ok: true, tool })
    },
  })
  return { facade, calls, controlGate, leaseService, leaseId: lease.leaseId }
}

function parseErr(out: string) {
  try { const o = JSON.parse(out); return isAgentBrowserError(o) ? o : null } catch { return null }
}

describe('ScopedBrowserFacade (§3.4 dispatch keystone)', () => {
  it('forces tab_id = agentTabId on every call (never null/active)', async () => {
    const { facade, calls } = makeFacade()
    await facade.run('browser_navigate', { url: 'https://www.xiaohongshu.com/note/1' })
    assert.equal(calls[0].args.tab_id, 'agent-tab-1')
    assert.equal(calls[0].args.url, 'https://www.xiaohongshu.com/note/1', 'navigate keeps its url')
    assert.equal(calls[0].surface, 'agent-view')
  })

  it('rejects tools outside the collection subset', async () => {
    const { facade, calls } = makeFacade()
    const out = await facade.run('browser_execute_js', { code: 'x' })
    assert.equal(parseErr(out)?.errorCode, 'script_blocked')
    assert.equal(calls.length, 0, 'must not dispatch a non-subset tool')
  })

  it('rejects the url-form of collect/extract (would steal the foreground)', async () => {
    const { facade, calls } = makeFacade()
    const out = await facade.run('browser_visible_collect', { template: 'card_list', url: 'https://www.xiaohongshu.com/u/1' })
    assert.equal(parseErr(out)?.errorCode, 'script_blocked')
    assert.equal(calls.length, 0)
    // tabId form is allowed
    const ok = await facade.run('browser_visible_collect', { template: 'card_list' })
    assert.equal(parseErr(ok), null)
    assert.equal(calls[0].args.tab_id, 'agent-tab-1')
  })

  it('freezes writes when the control gate is interrupting (does not dispatch)', async () => {
    const gate = new AgentTabControlGate()
    const { facade, calls } = makeFacade({ controlGate: gate })
    gate.requestInterruption()
    const out = await facade.run('browser_navigate', { url: 'https://x' })
    assert.equal(parseErr(out)?.errorCode, 'lease_takeover')
    assert.equal(calls.length, 0, 'frozen write must not dispatch')
  })

  it('allows reads even while frozen (reads are not blocked by the gate)', async () => {
    const gate = new AgentTabControlGate()
    const { facade, calls } = makeFacade({ controlGate: gate })
    gate.requestInterruption()
    const out = await facade.run('browser_read_page', {})
    assert.equal(parseErr(out), null, 'reads pass even when writes are frozen')
    assert.equal(calls[0].args.tab_id, 'agent-tab-1')
  })

  it('dispatches under the agent-view lease', async () => {
    const { facade, calls, leaseId } = makeFacade()
    await facade.run('browser_collect_images', {})
    assert.equal(calls[0].surface, 'agent-view')
    assert.equal(calls[0].leaseId, leaseId)
  })
})
