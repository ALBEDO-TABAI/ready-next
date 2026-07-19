import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ScopedBrowserFacade } from '../main/modules/browser-engine/scoped-browser-facade'
import { BrowserWriteLeaseService } from '../main/modules/browser-engine/browser-write-lease'
import { isAgentBrowserError } from '../main/modules/browser-engine/agent-browser-errors'

function makeFacade(overrides?: { surface?: 'agent-view' | 'user-view' }) {
  const calls: Array<{ tool: string; args: Record<string, unknown>; surface: string; leaseId: string }> = []
  const leaseService = new BrowserWriteLeaseService()
  const surface = overrides?.surface ?? 'agent-view'
  const lease = leaseService.acquire({ surface, taskId: 'collect', runId: 'r1' })
  if ('errorCode' in lease) throw new Error('expected lease')
  const facade = new ScopedBrowserFacade({
    agentTabId: 'agent-tab-1',
    leaseService,
    leaseId: lease.leaseId,
    surface,
    execute: async (tool, args, surface, leaseId) => {
      calls.push({ tool, args, surface, leaseId })
      return JSON.stringify({ ok: true, tool })
    },
  })
  return { facade, calls, leaseService, leaseId: lease.leaseId }
}

function makeFacadeWithAgentTabId(agentTabId: string) {
  const calls: Array<{ tool: string; args: Record<string, unknown>; surface: string; leaseId: string }> = []
  const leaseService = new BrowserWriteLeaseService()
  const lease = leaseService.acquire({ surface: 'agent-view', taskId: 'collect', runId: 'r1' })
  if ('errorCode' in lease) throw new Error('expected lease')
  const facade = new ScopedBrowserFacade({
    agentTabId,
    leaseService,
    leaseId: lease.leaseId,
    surface: 'agent-view',
    execute: async (tool, args, surface, leaseId) => {
      calls.push({ tool, args, surface, leaseId })
      return JSON.stringify({ ok: true, tool })
    },
  })
  return { facade, calls }
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
    const out = await facade.run('browser_eval', { code: 'x', purpose: 'test' })
    assert.equal(parseErr(out)?.errorCode, 'script_blocked')
    assert.equal(calls.length, 0, 'must not dispatch a non-subset tool')
  })

  it('rejects the url-form of collect/extract (would steal the foreground)', async () => {
    const { facade, calls } = makeFacade()
    const out = await facade.run('browser_collect', { mode: 'visible', template: 'card_list', url: 'https://www.xiaohongshu.com/u/1' })
    assert.equal(parseErr(out)?.errorCode, 'script_blocked')
    assert.equal(calls.length, 0)
    // tabId form is allowed
    const ok = await facade.run('browser_collect', { mode: 'visible', template: 'card_list' })
    assert.equal(parseErr(ok), null)
    assert.equal(calls[0].args.tab_id, 'agent-tab-1')
  })

  it('keeps user-view collection scoped to its independent lease', async () => {
    const { facade, calls } = makeFacade({ surface: 'user-view' })
    const out = await facade.run('browser_click', { text: '笔记一' })
    assert.equal(parseErr(out), null)
    assert.equal(calls.length, 1, 'user-view writes are governed by the user-view lease, not the agent-view freeze gate')
    assert.equal(calls[0].surface, 'user-view')
    assert.equal(calls[0].args.collection_surface, 'user-view')
  })

  it('allows reads through the scoped facade', async () => {
    const { facade, calls } = makeFacade()
    const out = await facade.run('browser_read', {})
    assert.equal(parseErr(out), null)
    assert.equal(calls[0].args.tab_id, 'agent-tab-1')
  })

  it('dispatches under the agent-view lease', async () => {
    const { facade, calls, leaseId } = makeFacade()
    await facade.run('browser_collect', { mode: 'images' })
    assert.equal(calls[0].surface, 'agent-view')
    assert.equal(calls[0].leaseId, leaseId)
  })

  it('refuses agent-view writes when the scoped tab binding is missing', async () => {
    const { facade, calls } = makeFacadeWithAgentTabId('')
    const out = await facade.run('browser_navigate', { url: 'https://x' })
    assert.equal(parseErr(out)?.errorCode, 'browser_surface_binding_violation')
    assert.equal(calls.length, 0)
  })
})
