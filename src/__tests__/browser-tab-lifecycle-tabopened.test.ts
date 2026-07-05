import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

import {
  BrowserTabLifecycleService,
  type BrowserLifecycleTabRecord,
} from '../main/modules/browser-engine/tab-lifecycle-service'

function makeMockHost() {
  const sent: Array<{ channel: string; data: Record<string, unknown> }> = []
  const tabs = new Map<string, BrowserLifecycleTabRecord>()
  let activeTabId: string | null = null
  let counter = 0
  const host = {
    tabs,
    getActiveTabId: () => activeTabId,
    setActiveTabId: (tabId: string | null) => { activeTabId = tabId },
    getNextTabId: () => `tab-${++counter}`,
    getViewBounds: () => ({ x: 0, y: 0, width: 0, height: 0 }),
    shouldPresentHosts: () => false,
    isAllowedUrl: () => true,
    extractDomain: (url: string) => url,
    createHost: (): never => { throw new Error('mock mode must not create native hosts') },
    resetPageBackground: () => {},
    syncPageBackground: () => {},
    applyBounds: () => {},
    detachHost: () => {},
    showHost: () => {},
    sendToRenderer: (channel: string, data: unknown) => {
      sent.push({ channel, data: data as Record<string, unknown> })
    },
    buildTabPayload: (tab: BrowserLifecycleTabRecord) => ({
      id: tab.id,
      url: tab.url,
      title: tab.title,
      domain: tab.domain,
      favicon: tab.favicon,
      owner: tab.owner,
      required: tab.required,
      activity: tab.activity,
      lastAuditedAt: tab.lastAuditedAt,
      active: tab.id === activeTabId,
      loading: tab.loading,
      canGoBack: tab.canGoBack,
      canGoForward: tab.canGoForward,
      error: tab.error,
    }),
    emitTabMeta: () => {},
    logBrowserDiag: () => {},
    bindPopup: () => {},
    bindAppShortcutBridge: () => {},
    installContextMenu: () => {},
    handleWindowOpen: () => ({ action: 'deny' as const }),
    ensureDownloadSession: () => {},
    addHistoryEntry: () => {},
    updateHistoryEntryTitle: () => {},
    handleLocalMediaDropNavigation: () => false,
    browserUserAgent: 'test-agent',
    useMock: true,
  }
  return { host, sent, getActive: () => activeTabId }
}

describe('D1 (P1-b): createTab announces background tabs to the renderer tab strip', () => {
  it('background create emits browser:tabOpened with activate:false and never grabs active', async () => {
    const { host, sent, getActive } = makeMockHost()
    const service = new BrowserTabLifecycleService(host)

    const result = await service.createTab('https://example.com', { background: true })
    assert.equal(result.success, true)

    const opened = sent.filter((event) => event.channel === 'browser:tabOpened')
    assert.equal(opened.length, 1, 'background create must announce the tab exactly once')
    assert.equal(opened[0].data.id, result.tabId)
    assert.equal(opened[0].data.activate, false, 'payload must carry the no-preempt flag')
    assert.equal(opened[0].data.active, false, 'a background tab is never the active tab')
    assert.equal(getActive(), null, 'background create must not preempt the active tab')
  })

  it('foreground create keeps legacy semantics: no tabOpened emission, active switches', async () => {
    const { host, sent, getActive } = makeMockHost()
    const service = new BrowserTabLifecycleService(host)

    const result = await service.createTab('https://example.com')
    assert.equal(result.success, true)
    assert.equal(getActive(), result.tabId, 'foreground create activates the tab (unchanged)')

    const opened = sent.filter((event) => event.channel === 'browser:tabOpened')
    assert.equal(opened.length, 0, 'foreground path is renderer-driven today; no duplicate announcement')
  })
})

describe('D1 renderer contract: activate:false must not steal focus', () => {
  // Structure contract (justified): the renderer hook wires zustand + RAF +
  // window listeners that have no headless behavior harness in this repo; the
  // ordering below is the load-bearing property (list the tab, bail before any
  // activation side effect). Real focus behavior is verified on-machine (回测清单).
  it('useBrowserRuntimeEffects lists the tab, then returns before activation side effects', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/renderer/modules/browser/useBrowserRuntimeEffects.ts'),
      'utf8',
    )
    const block = source.slice(source.indexOf('onTabOpened('))
    const addTab = block.indexOf('store.addTab(openedTab)')
    const gate = block.indexOf('if (tab.activate === false) return')
    const activate = block.indexOf('store.setActiveTabId(openedTab.id)')
    assert.ok(addTab > -1, 'tab must still be added to the strip store')
    assert.ok(gate > -1, 'the activate:false early return must exist')
    assert.ok(activate > -1, 'legacy activation path must remain for popup-opened tabs')
    assert.ok(addTab < gate && gate < activate, 'gate must sit after listing and before activation')
  })
})
