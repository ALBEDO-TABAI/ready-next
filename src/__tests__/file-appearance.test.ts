import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FILE_APPEARANCE_COLORS,
  FILE_APPEARANCE_STORAGE_KEY,
  normalizeFileAppearanceIcon,
  normalizeFileAppearanceMap,
  remapFileAppearancePath,
  removeFileAppearancePath,
  withFileAppearanceColor,
  withFileAppearanceIcon,
} from '../renderer/stores/fileAppearance'

test('file appearance exposes the seven Finder-like color choices', () => {
  assert.deepEqual(
    FILE_APPEARANCE_COLORS.map((color) => color.key),
    ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'],
  )
})

test('file appearance normalizes colors and short custom icons', () => {
  const normalized = normalizeFileAppearanceMap({
    '/workspace/a.md': { color: 'red', icon: '  🎬  ' },
    '/workspace/b.md': { color: 'pink', icon: '' },
    '/workspace/c.md': { icon: 'ABCDZ' },
  })

  assert.deepEqual(normalized, {
    '/workspace/a.md': { color: 'red', icon: '🎬' },
    '/workspace/c.md': { icon: 'ABCD' },
  })
  assert.equal(normalizeFileAppearanceIcon('   '), null)
})

test('file appearance updates color and icon independently', () => {
  const withColor = withFileAppearanceColor({}, '/workspace/a.md', 'blue')
  const withIcon = withFileAppearanceIcon(withColor, '/workspace/a.md', '📁')
  const colorCleared = withFileAppearanceColor(withIcon, '/workspace/a.md', null)

  assert.deepEqual(withIcon, {
    '/workspace/a.md': { color: 'blue', icon: '📁' },
  })
  assert.deepEqual(colorCleared, {
    '/workspace/a.md': { icon: '📁' },
  })
})

test('file appearance follows folder moves and is removed with deleted folders', () => {
  const source = {
    '/workspace/folder': { color: 'green' as const },
    '/workspace/folder/child.md': { icon: '📝' },
    '/workspace/other.md': { color: 'gray' as const },
  }

  const moved = remapFileAppearancePath(source, '/workspace/folder', '/workspace/archive/folder')
  assert.deepEqual(moved, {
    '/workspace/archive/folder': { color: 'green' },
    '/workspace/archive/folder/child.md': { icon: '📝' },
    '/workspace/other.md': { color: 'gray' },
  })

  const removed = removeFileAppearancePath(moved, '/workspace/archive/folder')
  assert.deepEqual(removed, {
    '/workspace/other.md': { color: 'gray' },
  })
})

test('workspace store persists file appearance and remaps it on rename', async () => {
  const storage = new Map<string, string>()
  ;(globalThis as any).localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
    removeItem: (key: string) => { storage.delete(key) },
  }
  if (typeof (globalThis as any).window === 'undefined') {
    ;(globalThis as any).window = globalThis
  }
  ;(globalThis as any).window.electronAPI = undefined

  const { useWorkspace } = await import('../renderer/stores/useWorkspace')
  useWorkspace.setState({
    currentPath: '/workspace',
    files: [
      { name: 'a.md', path: '/workspace/a.md', isDirectory: false, size: 1, modified: new Date() },
    ],
    selectedFile: '/workspace/a.md',
    fileAppearances: {},
  })

  useWorkspace.getState().setFileColor('/workspace/a.md', 'red')
  useWorkspace.getState().setFileIcon('/workspace/a.md', '📝')

  assert.deepEqual(JSON.parse(storage.get(FILE_APPEARANCE_STORAGE_KEY) || '{}'), {
    '/workspace/a.md': { color: 'red', icon: '📝' },
  })

  await useWorkspace.getState().renameItem('/workspace/a.md', 'b.md')
  assert.deepEqual(useWorkspace.getState().fileAppearances, {
    '/workspace/b.md': { color: 'red', icon: '📝' },
  })
})
