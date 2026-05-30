import test from 'node:test'
import assert from 'node:assert/strict'

// useWorkspace touches localStorage/window at import; shim them for plain node.
const storage = new Map<string, string>()
;(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string): string | null => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
  removeItem: (key: string) => { storage.delete(key) },
  clear: () => { storage.clear() },
  get length() { return storage.size },
  key: (index: number): string | null => [...storage.keys()][index] ?? null,
}
if (typeof (globalThis as { window?: unknown }).window === 'undefined') {
  ;(globalThis as { window: typeof globalThis }).window = globalThis
}

const { getNextSidePanelVariant, SIDE_PANEL_CYCLE_ORDER } = await import('../renderer/stores/useWorkspace')

test('getNextSidePanelVariant advances the rail forward and wraps', () => {
  assert.deepEqual(SIDE_PANEL_CYCLE_ORDER, ['files', 'search', 'skills', 'backlinks', 'graph'])

  assert.equal(getNextSidePanelVariant('files'), 'search')
  assert.equal(getNextSidePanelVariant('search'), 'skills')
  assert.equal(getNextSidePanelVariant('skills'), 'backlinks')
  assert.equal(getNextSidePanelVariant('backlinks'), 'graph')
  assert.equal(getNextSidePanelVariant('graph'), 'files')
})

test('getNextSidePanelVariant starts a hidden/unknown rail at files', () => {
  assert.equal(getNextSidePanelVariant('hidden'), 'files')
})
