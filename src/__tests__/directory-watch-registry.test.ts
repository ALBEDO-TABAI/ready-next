import assert from 'node:assert/strict'
import test from 'node:test'

// Main keeps one watched set per window; the registry sends it the union of every owner's folders (B7, W3-T6).
test('directory watch registry: owners share the window set, releasing one keeps the others', async t => {
  const sent: string[][] = []
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { document: { watchDirectories: async (paths: string[]) => { sent.push(paths); return { success: true } } } } } })
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window') })
  const { watchDirectoriesFor, releaseDirectoryWatch, resetDirectoryWatchRegistryForTests } = await import('../renderer/modules/document/directoryWatchRegistry')
  resetDirectoryWatchRegistryForTests()
  const files = Symbol('files'), database = Symbol('database')
  watchDirectoriesFor(files, ['/vault', '/vault/A'])
  watchDirectoriesFor(database, ['/vault/库'])
  assert.deepEqual(sent.at(-1), ['/vault', '/vault/A', '/vault/库'])
  watchDirectoriesFor(files, [])
  assert.deepEqual(sent.at(-1), ['/vault/库'], 'hiding the file view keeps the database row folder watched')
  const count = sent.length
  watchDirectoriesFor(database, ['/vault/库'])
  assert.equal(sent.length, count, 'an unchanged union is not re-sent')
  releaseDirectoryWatch(database)
  assert.deepEqual(sent.at(-1), [])
})
