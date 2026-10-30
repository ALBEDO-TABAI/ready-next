import assert from 'node:assert/strict'
import test from 'node:test'
import type { ObjectPresentationAPI, ObjectMovedEvent } from '../shared/object-identity'

const values = new Map<string, string>()
const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
let moved: (event: ObjectMovedEvent) => void = () => {}
let path = '/notes/a.md', revision = 1
const api: ObjectPresentationAPI = {
  resolvePath: async () => ({ objectId: 'object-a', path, revision }),
  locate: async () => ({ objectId: 'object-a', path, revision }),
  onMoved: callback => { moved = callback; return () => {} },
  prepareMigration: async request => ({ migrationId: request.migrationId, state: 'prepared', resolved: request.paths.filter(p => p !== '/missing.md').map(sourcePath => ({ objectId: 'object-a', path, revision, sourcePath })), unresolved: request.paths.includes('/missing.md') ? [{ path: '/missing.md', reason: 'not present' }] : [] }),
  completeMigration: async migrationId => ({ migrationId, state: 'completed', resolved: [], unresolved: [] }),
}
Object.defineProperty(globalThis, 'window', { value: { electronAPI: { objects: api }, addEventListener: () => {} }, configurable: true })
const presentation = await import('../renderer/stores/objectPresentationState')
const { useDocTabs, settleDocTabObjects } = await import('../renderer/stores/useDocTabs')
const { saveDocumentReadingPosition, loadDocumentReadingPosition } = await import('../renderer/modules/document/documentScrollAnchor')
const { useWorkspace } = await import('../renderer/stores/useWorkspace')
const snapshot = { top: 40, ratio: 0.4, maxScroll: 100, anchorTitle: null, anchorOrdinal: null, anchorProgress: null }

test('C2 Renderer resolves objects, deduplicates aliases, follows completed moves and preserves presentation', async () => {
  await presentation.initializeObjectPresentation()
  useDocTabs.getState().openTab(path)
  await settleDocTabObjects()
  const tab = useDocTabs.getState().tabs.find(t => t.objectId === 'object-a')!
  assert.ok(tab); assert.equal(tab.path, path)
  assert.equal(useDocTabs.getState().ensureTabForPath(path), tab.id)
  saveDocumentReadingPosition(path, snapshot)
  await useWorkspace.getState().setFileColor(path, 'red')
  useDocTabs.getState().openTab('/alias/a.md')
  await settleDocTabObjects()
  assert.equal(useDocTabs.getState().tabs.filter(t => t.objectId === 'object-a').length, 1)
  path = '/notes/b.md'; revision++
  moved({ objectId: 'object-a', from: '/notes/a.md', to: path, revision })
  assert.equal(useDocTabs.getState().tabs.find(t => t.id === tab.id)?.path, path)
  assert.equal(loadDocumentReadingPosition(path)?.top, 40)
  assert.equal(useWorkspace.getState().fileAppearances[path]?.color, 'red')
  moved({ objectId: 'object-a', from: path, to: '/stale.md', revision: 1 })
  assert.equal(useDocTabs.getState().tabs.find(t => t.id === tab.id)?.path, path)
  assert.equal(values.has('ready-document-reading-positions-v1'), false)
  assert.equal(values.has('ready-file-appearances-v1'), false)
  assert.ok(values.get(presentation.OBJECT_APPEARANCES_KEY)?.includes('object-a'))
})

test('C2 migration retries after lost acknowledgment without overwriting new state; unresolved values remain in report', async () => {
  const data = new Map<string, string>([
    ['ready-document-reading-positions-v1', JSON.stringify([{ key: '/notes/a.md', updatedAt: 1, ...snapshot }])],
    ['ready-file-appearances-v1', JSON.stringify({ '/notes/a.md': { color: 'blue' }, '/missing.md': { icon: '!' } })],
  ])
  const store = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } }
  let acknowledgments = 0
  const retryAPI = { ...api, completeMigration: async (id: string) => { if (++acknowledgments === 1) throw new Error('lost acknowledgment'); return api.completeMigration(id) } }
  await assert.rejects(presentation.migrateObjectPresentation(retryAPI, store), /lost acknowledgment/)
  assert.ok(data.has('ready-file-appearances-v1'))
  const pending = data.get(presentation.OBJECT_MIGRATION_KEY)!
  data.set(presentation.OBJECT_APPEARANCES_KEY, JSON.stringify({ 'object-a': { color: 'red' } }))
  await presentation.migrateObjectPresentation(retryAPI, store)
  assert.equal(data.has('ready-file-appearances-v1'), false)
  assert.equal(JSON.parse(data.get(presentation.OBJECT_APPEARANCES_KEY)!)['object-a'].color, 'red')
  const report = JSON.parse(data.get(presentation.OBJECT_MIGRATION_KEY)!)
  assert.equal(report.migrationId, JSON.parse(pending).migrationId)
  assert.equal(report.report.unresolved[0].path, '/missing.md')
  assert.equal(report.appearances['/missing.md'].icon, '!')
})
