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

const { isImagePreviewPath, useDocTabs, normalizeDocTabPathKey } = await import('../renderer/stores/useDocTabs')

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

  it('reuses one image preview tab for images in the same folder', () => {
    const firstId = useDocTabs.getState().openImageTab('/workspace/shots/001.png')
    assert.ok(firstId)
    assert.equal(useDocTabs.getState().tabs.length, 2)
    assert.equal(useDocTabs.getState().activeTabId, firstId)

    const secondId = useDocTabs.getState().openImageTab('/workspace/shots/002.jpg')
    const state = useDocTabs.getState()
    assert.equal(secondId, firstId)
    assert.equal(state.tabs.length, 2)
    assert.equal(state.activeTabId, firstId)
    assert.equal(state.tabs.find((tab) => tab.id === firstId)?.path, '/workspace/shots/002.jpg')
    assert.equal(state.tabs.find((tab) => tab.id === firstId)?.title, '002.jpg')
  })

  it('can update an image preview tab without stealing the active board tab', () => {
    useDocTabs.setState({
      tabs: [
        { id: 'board-tab', path: '/workspace/references.readyboard', title: 'references.readyboard', content: '', isDirty: false },
      ],
      activeTabId: 'board-tab',
      splitTabId: null,
      documentSplitRatio: 50,
      pendingReveal: null,
    })

    const imageId = useDocTabs.getState().openImageTab('/workspace/shots/001.png', { activate: false })
    const state = useDocTabs.getState()
    assert.ok(imageId)
    assert.equal(state.activeTabId, 'board-tab')
    assert.equal(state.tabs.length, 2)
    assert.equal(state.tabs.find((tab) => tab.id === imageId)?.path, '/workspace/shots/001.png')
  })

  it('recognizes supported image preview paths only', () => {
    assert.equal(isImagePreviewPath('/workspace/shots/001.PNG'), true)
    assert.equal(isImagePreviewPath('/workspace/shots/movie.mp4'), false)
  })
})
