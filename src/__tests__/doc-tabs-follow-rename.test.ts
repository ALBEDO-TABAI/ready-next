import assert from 'node:assert/strict'
import test from 'node:test'
import type { ObjectPresentationAPI, ObjectMovedEvent } from '../shared/object-identity'

// A page rename moves the file and rewrites its frontmatter title. The open tab must follow the move and take the
// renamed file's text; otherwise the next edit carries the old title back (found by verify:ready-next-m3).
const values = new Map<string, string>()
const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
let moved: (event: ObjectMovedEvent) => void = () => {}
let path = '/vault/父页.md', revision = 1
const files = new Map<string, string>()
const reads: string[] = []
let holdRead: { path: string; release: () => void } | null = null
const objects: ObjectPresentationAPI = {
  resolvePath: async () => ({ objectId: 'page-a', path, revision }),
  locate: async () => ({ objectId: 'page-a', path, revision }),
  onMoved: callback => { moved = callback; return () => {} },
  prepareMigration: async request => ({ migrationId: request.migrationId, state: 'prepared', resolved: [], unresolved: [] }),
  completeMigration: async migrationId => ({ migrationId, state: 'completed', resolved: [], unresolved: [] }),
}
const document = {
  readFile: async (file: string) => {
    reads.push(file)
    if (holdRead?.path === file) await new Promise<void>(resolve => { holdRead!.release = resolve })
    const content = files.get(file)
    return content === undefined ? { success: false, error: 'missing' } : { success: true, content }
  },
}
Object.defineProperty(globalThis, 'window', { value: { electronAPI: { objects, document }, addEventListener: () => {} }, configurable: true })
const presentation = await import('../renderer/stores/objectPresentationState')
const { useDocTabs, settleDocTabObjects } = await import('../renderer/stores/useDocTabs')

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const tabFor = (id: string) => useDocTabs.getState().tabs.find(tab => tab.id === id)!

test('a clean tab follows a page rename and takes the renamed file text', async () => {
  await presentation.initializeObjectPresentation()
  useDocTabs.getState().openTab(path)
  await settleDocTabObjects()
  const id = useDocTabs.getState().tabs.find(tab => tab.objectId === 'page-a')!.id
  useDocTabs.getState().hydrateTabContentFromDisk(id, '---\ntitle: 父页\nicon: 🌱\n---\n')

  path = '/vault/验收页.md'; revision++
  files.set(path, '---\ntitle: 验收页\nicon: 🌱\n---\n')
  moved({ objectId: 'page-a', from: '/vault/父页.md', to: path, revision })
  await settle()
  assert.equal(tabFor(id).path, path)
  assert.equal(tabFor(id).content, '---\ntitle: 验收页\nicon: 🌱\n---\n')
  assert.equal(tabFor(id).isDirty, false)

  // A board or other non-Markdown move never rereads.
  const before = reads.length
  revision++
  moved({ objectId: 'page-a', from: path, to: '/vault/灵感.canvas', revision })
  await settle()
  assert.equal(reads.length, before)
})

test('a read that returns after the tab moved again is not applied', async () => {
  const id = useDocTabs.getState().tabs.find(tab => tab.objectId === 'page-a')!.id
  path = '/vault/终稿.md'; revision++
  files.set(path, '---\ntitle: 终稿\n---\n')
  holdRead = { path, release: () => {} }
  moved({ objectId: 'page-a', from: '/vault/灵感.canvas', to: path, revision })
  await settle()
  path = '/vault/定稿.md'; revision++
  files.set(path, '---\ntitle: 定稿\n---\n')
  moved({ objectId: 'page-a', from: '/vault/终稿.md', to: path, revision })
  await settle()
  holdRead.release(); holdRead = null
  await settle()
  assert.equal(tabFor(id).path, '/vault/定稿.md')
  assert.equal(tabFor(id).content, '---\ntitle: 定稿\n---\n')
})
