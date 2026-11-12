import { memoryNavigationAPI } from './utils/navigation-memory'
import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

test('a calendar day ReadyRef opens that day in the calendar and offers the way back', async () => {
  const dom = new JSDOM('<div data-workbench-mode-panel="document"></div>', { url: 'http://localhost' })
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, CustomEvent: dom.window.CustomEvent, localStorage: dom.window.localStorage })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true })
  }
  try {
    const revealed: string[] = []
    Object.defineProperty(dom.window, 'electronAPI', { value: { navigationHistory: memoryNavigationAPI(), calendar: { revealDay: async (date: string) => { revealed.push(date); return { success: true, data: true } } } } })
    const { openReadyRef } = await import('../renderer/modules/workbench/open-ready-ref')
    const { useMode } = await import('../renderer/stores/useMode')
    const { navigationHistory } = await import('../renderer/modules/workbench/navigation-history')
    dom.window.addEventListener('ready:workbench-mode-change-request', (event) => useMode.getState().setWorkbenchMode((event as CustomEvent).detail.mode))
    useMode.setState({ workbenchMode: 'document', splitMode: null })
    await openReadyRef('ready://calendar/day/2026-11-03')
    assert.deepEqual(revealed, ['2026-11-03'])
    assert.equal(useMode.getState().workbenchMode, 'calendar')
    assert.equal(navigationHistory.getSnapshot().entries.at(-1)?.mode, 'calendar')
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
  }
})
