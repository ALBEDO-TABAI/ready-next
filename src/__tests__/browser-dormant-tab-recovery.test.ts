import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserTabLifecycleService, type BrowserLifecycleTabRecord } from '../main/modules/browser-engine/tab-lifecycle-service'
import { selectAcceptedDormantTabs } from '../renderer/modules/browser/browserDormantTabRecovery'

test('dormant registration accepts up to 200 valid unique tabs without leaving rejected renderer ghosts', () => {
  const tabs = new Map<string, BrowserLifecycleTabRecord>()
  let activeTabId: string | null = null
  let splitTabId: string | null = null
  const service = new BrowserTabLifecycleService({
    tabs,
    getActiveTabId: () => activeTabId,
    setActiveTabId: (tabId: string | null) => { activeTabId = tabId },
    setSplitTabId: (tabId: string | null) => { splitTabId = tabId },
    observeRestoredTabId: () => undefined,
    isAllowedUrl: (url: string) => url.startsWith('https://'),
    extractDomain: (url: string) => new URL(url).hostname,
    useMock: true,
  } as ConstructorParameters<typeof BrowserTabLifecycleService>[0])
  const persisted = [
    { id: '', url: 'https://invalid.example', title: 'invalid' },
    ...Array.from({ length: 201 }, (_, index) => ({
      id: `tab-${index + 1}`,
      url: `https://${index + 1}.example`,
      title: `Tab ${index + 1}`,
    })),
    { id: 'tab-1', url: 'https://duplicate.example', title: 'duplicate' },
  ]

  const result = service.registerDormantTabs({ tabs: persisted, activeTabId: 'tab-1', splitTabId: 'tab-2' })
  const recovered = selectAcceptedDormantTabs(persisted, result)

  assert.equal(result.success, true)
  assert.equal(tabs.size, 200)
  assert.equal(activeTabId, 'tab-1')
  assert.equal(splitTabId, 'tab-2')
  assert.equal(recovered.length, 200)
  assert.equal(new Set(recovered.map((tab) => tab.id)).size, 200)
  assert.equal(recovered.some((tab) => tab.id === 'tab-201'), false)
  assert.deepEqual(recovered.map((tab) => tab.id), [...tabs.keys()])
})
