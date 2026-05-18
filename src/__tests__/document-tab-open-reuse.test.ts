import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert'

const storage = new Map<string, string>()

;(globalThis as { localStorage?: Storage }).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
  removeItem: (key: string) => { storage.delete(key) },
  clear: () => { storage.clear() },
  get length() { return storage.size },
  key: (index: number) => [...storage.keys()][index] ?? null,
} as Storage

const { useDocTabs, normalizeDocTabPathKey } = await import('../renderer/stores/useDocTabs')

describe('document tab open reuse', () => {
  beforeEach(() => {
    storage.clear()
    useDocTabs.setState({
      tabs: [{ id: 'reset-tab', path: null, title: '新文档', content: '', isDirty: false }],
      activeTabId: 'reset-tab',
      splitTabId: null,
      documentSplitRatio: 50,
      pendingReveal: null,
    })
  })

  it('activates an existing tab when the same file is opened with alternate separators', () => {
    useDocTabs.getState().openTab('C:\\workspace\\readme.md')
    const tabId = useDocTabs.getState().tabs[1].id

    useDocTabs.getState().openTab('C:/workspace/other.md')
    assert.equal(useDocTabs.getState().tabs.length, 3)

    useDocTabs.getState().openTab('c:/workspace/readme.md')
    const state = useDocTabs.getState()
    assert.equal(state.tabs.length, 3)
    assert.equal(state.activeTabId, tabId)
  })

  it('compares document tab paths using normalized unicode', () => {
    assert.equal(
      normalizeDocTabPathKey('/workspace/Cafe\u0301.md'),
      normalizeDocTabPathKey('/workspace/Café.md'),
    )
  })
})
