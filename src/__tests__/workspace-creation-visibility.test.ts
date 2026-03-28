import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert'

const storage = new Map<string, string>()

const localStorageMock = {
  getItem: (key: string): string | null => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
  removeItem: (key: string) => { storage.delete(key) },
  clear: () => { storage.clear() },
  get length() { return storage.size },
  key: (index: number): string | null => [...storage.keys()][index] ?? null,
}

;(globalThis as { localStorage?: typeof localStorageMock }).localStorage = localStorageMock
if (typeof (globalThis as { window?: typeof globalThis }).window === 'undefined') {
  ;(globalThis as { window: typeof globalThis }).window = globalThis
}
;(globalThis as { window: typeof globalThis & { electronAPI?: undefined } }).window.electronAPI = undefined

const { useWorkspace } = await import('../renderer/stores/useWorkspace')

describe('useWorkspace startCreating visibility', () => {
  beforeEach(() => {
    storage.clear()
    useWorkspace.setState({
      workspaceRoot: null,
      currentPath: '/',
      files: [],
      selectedFile: null,
      expandedDirs: new Set<string>(),
      dirChildren: new Map(),
      pinnedFolders: [],
      sidebarVisible: true,
      sidePanelVariant: 'files',
      sidePanelWidths: { shared: 220 },
      skillsSplitRatio: 0.5,
      chatPanelVisible: true,
      chatPanelWidth: 380,
      renamingPath: null,
      creatingType: null,
      creatingPath: null,
    })
  })

  it('reveals the pinned root when creating from the toolbar', () => {
    useWorkspace.setState({
      pinnedFolders: ['/workspace-root'],
      currentPath: '/',
    })

    useWorkspace.getState().startCreating('file')

    const state = useWorkspace.getState()
    assert.strictEqual(state.creatingType, 'file')
    assert.strictEqual(state.creatingPath, '/workspace-root')
    assert.strictEqual(state.currentPath, '/workspace-root')
    assert.strictEqual(state.selectedFile, '/workspace-root')
    assert.ok(state.expandedDirs.has('/workspace-root'))
  })

  it('expands the ancestor chain for nested target directories', () => {
    useWorkspace.setState({
      pinnedFolders: ['/workspace-root'],
      currentPath: '/workspace-root/projects/demo',
      expandedDirs: new Set<string>(),
    })

    useWorkspace.getState().startCreating('folder')

    const state = useWorkspace.getState()
    assert.strictEqual(state.creatingType, 'folder')
    assert.strictEqual(state.creatingPath, '/workspace-root/projects/demo')
    assert.ok(state.expandedDirs.has('/workspace-root'))
    assert.ok(state.expandedDirs.has('/workspace-root/projects'))
    assert.ok(state.expandedDirs.has('/workspace-root/projects/demo'))
  })

  it('prefers the selected directory over the stale currentPath', () => {
    useWorkspace.setState({
      pinnedFolders: ['/workspace-root'],
      currentPath: '/workspace-root',
      selectedFile: '/workspace-root/docs',
      files: [
        {
          name: 'docs',
          path: '/workspace-root/docs',
          isDirectory: true,
          size: 0,
          modified: new Date(),
        },
      ],
    })

    useWorkspace.getState().startCreating('file')

    const state = useWorkspace.getState()
    assert.strictEqual(state.creatingPath, '/workspace-root/docs')
    assert.strictEqual(state.currentPath, '/workspace-root/docs')
    assert.ok(state.expandedDirs.has('/workspace-root'))
    assert.ok(state.expandedDirs.has('/workspace-root/docs'))
  })
})
