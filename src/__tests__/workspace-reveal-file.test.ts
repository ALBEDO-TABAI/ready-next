import assert from 'node:assert/strict'
import test from 'node:test'

const storage = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
  removeItem: (key: string) => { storage.delete(key) },
}

if (typeof (globalThis as any).window === 'undefined') {
  ;(globalThis as any).window = globalThis
}

;(globalThis as any).window.electronAPI = {
  document: {
    listFiles: async (path: string) => {
      const modified = new Date().toISOString()
      if (path === '/workspace/books') {
        return {
          success: true,
          items: [
            { name: 'Book', path: '/workspace/books/Book', isDirectory: true, size: 0, modified },
          ],
        }
      }
      if (path === '/workspace/books/Book') {
        return {
          success: true,
          items: [
            { name: 'Book.md', path: '/workspace/books/Book/Book.md', isDirectory: false, size: 16, modified },
          ],
        }
      }
      return {
        success: true,
        items: [
          { name: 'books', path: '/workspace/books', isDirectory: true, size: 0, modified },
        ],
      }
    },
  },
}

const { useWorkspace } = await import('../renderer/stores/useWorkspace')

test('workspace revealFile selects imported ebook markdown and refreshes parent directories', async () => {
  useWorkspace.setState({
    workspaceRoot: '/workspace',
    currentPath: '/workspace',
    files: [],
    selectedFile: null,
    expandedDirs: new Set(),
    dirChildren: new Map(),
    pinnedFolders: ['/workspace'],
  })

  await useWorkspace.getState().revealFile('/workspace/books/Book/Book.md')

  const state = useWorkspace.getState()
  assert.equal(state.selectedFile, '/workspace/books/Book/Book.md')
  assert.equal(state.expandedDirs.has('/workspace/books'), true)
  assert.equal(state.expandedDirs.has('/workspace/books/Book'), true)
  assert.equal(state.dirChildren.get('/workspace/books')?.[0]?.path, '/workspace/books/Book')
  assert.equal(state.dirChildren.get('/workspace/books/Book')?.[0]?.path, '/workspace/books/Book/Book.md')
})
