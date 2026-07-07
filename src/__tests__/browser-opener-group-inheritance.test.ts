import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

import { type BrowserTab, useBrowserTabs } from '../renderer/stores/useBrowserTabs'
import { BrowserTabMetaService, type BrowserTabMetaRecord } from '../main/modules/browser-engine/tab-meta-service'

function btab(id: string, groupId?: string | null): BrowserTab {
  return {
    id,
    url: `https://example.com/${id}`,
    title: id.toUpperCase(),
    loading: false,
    canGoBack: false,
    canGoForward: false,
    ...(groupId !== undefined ? { groupId } : {}),
  }
}

function order(): string[] {
  return useBrowserTabs.getState().tabs.map((t) => t.id)
}
function groupIdOf(id: string): string | null {
  return useBrowserTabs.getState().tabs.find((t) => t.id === id)?.groupId ?? null
}

// P4: a link opened in the background from an existing tab is listed right after its
// opener and inherits the opener's group. addTabAfterOpener is the behavioral core the
// renderer onTabOpened handler calls.
describe('useBrowserTabs.addTabAfterOpener (P4 opener→group inheritance)', () => {
  beforeEach(() => {
    const store = useBrowserTabs.getState()
    store.setTabs([btab('a'), btab('b'), btab('c')])
    store.setActiveTabId('a')
  })

  it('inserts the new tab right after an ungrouped opener', () => {
    useBrowserTabs.getState().addTabAfterOpener(btab('x'), 'b')
    assert.deepEqual(order(), ['a', 'b', 'x', 'c'])
    assert.equal(groupIdOf('x'), null)
  })

  it('inherits the opener group and stays contiguous with it', () => {
    // Group {a,b}: drag b onto a → both grouped, order [a,b,c].
    useBrowserTabs.getState().createTabGroupFromDrop('b', 'a')
    const g = useBrowserTabs.getState().tabGroups[0].id
    useBrowserTabs.getState().addTabAfterOpener(btab('x'), 'a')
    // x inherits group g and lands adjacent to its opener a; the group run stays contiguous.
    assert.equal(groupIdOf('x'), g)
    assert.deepEqual(order(), ['a', 'x', 'b', 'c'])
    // I1: a, x, b are one contiguous run; c is outside.
    assert.equal(groupIdOf('a'), g)
    assert.equal(groupIdOf('b'), g)
    assert.equal(groupIdOf('c'), null)
  })

  it('appends at the end when there is no opener', () => {
    useBrowserTabs.getState().addTabAfterOpener(btab('x'), null)
    assert.deepEqual(order(), ['a', 'b', 'c', 'x'])
    assert.equal(groupIdOf('x'), null)
  })

  it('appends at the end when the opener is not listed', () => {
    useBrowserTabs.getState().addTabAfterOpener(btab('x'), 'ghost')
    assert.deepEqual(order(), ['a', 'b', 'c', 'x'])
  })
})

// The opener id must survive the main→renderer hop: buildTabPayload carries it so the
// browser:tabOpened event can drive the insert-after-opener placement.
describe('BrowserTabMetaService.buildTabPayload (P4 openerTabId passthrough)', () => {
  function svcWith(tab: BrowserTabMetaRecord): BrowserTabMetaService<BrowserTabMetaRecord> {
    const tabs = new Map<string, BrowserTabMetaRecord>([[tab.id, tab]])
    return new BrowserTabMetaService({ tabs, getActiveTabId: () => null, sendToRenderer: () => undefined })
  }
  const base: BrowserTabMetaRecord = {
    id: 't1', url: 'https://x/', title: 'X', domain: 'x', favicon: null, owner: 'manual',
    required: false, activity: 'idle', lastAuditedAt: null, loading: false, canGoBack: false,
    canGoForward: false, error: null,
  }

  it('carries a set openerTabId into the payload', () => {
    const payload = svcWith({ ...base, openerTabId: 'opener-1' }).buildTabPayload({ ...base, openerTabId: 'opener-1' })
    assert.equal(payload.openerTabId, 'opener-1')
  })

  it('defaults an absent openerTabId to null', () => {
    const payload = svcWith(base).buildTabPayload(base)
    assert.equal(payload.openerTabId, null)
  })
})
