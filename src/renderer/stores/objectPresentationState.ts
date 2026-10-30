import type { ObjectLocation, ObjectMovedEvent, ObjectPresentationAPI, ObjectStateMigrationReport } from '../../shared/object-identity'
import type { DocumentReadingPositionRecord } from '../modules/document/documentScrollAnchor'
import { normalizeFileAppearanceMap, type FileAppearanceMap } from './fileAppearance'

export const OBJECT_READING_POSITIONS_KEY = 'ready-object-reading-positions-v1'
export const OBJECT_APPEARANCES_KEY = 'ready-object-appearances-v1'
export const OBJECT_MIGRATION_KEY = 'ready-object-presentation-migration-v1'
const OLD_READING_KEY = 'ready-document-reading-positions-v1'
const OLD_APPEARANCES_KEY = 'ready-file-appearances-v1'
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>
interface Migration {
  migrationId: string
  positions: DocumentReadingPositionRecord[]
  appearances: FileAppearanceMap
  applied: boolean
  report?: ObjectStateMigrationReport
}
const locations = new Map<string, ObjectLocation>()
const listeners = new Set<() => void>()
const moveListeners = new Set<(event: ObjectMovedEvent) => void>()
let initialization: Promise<void> | undefined

export function objectPresentationAPI(): ObjectPresentationAPI {
  if (!window.electronAPI?.objects) throw new Error('Object service unavailable')
  return window.electronAPI.objects
}
export function rememberObjectLocation(location: ObjectLocation): ObjectLocation {
  const current = locations.get(location.objectId)
  if (current && current.revision > location.revision) return current
  for (const [id, previous] of locations) {
    if (id !== location.objectId && previous.path === location.path) locations.delete(id)
  }
  locations.set(location.objectId, location)
  for (const listener of listeners) listener()
  return location
}
export function objectLocationForId(id: string): ObjectLocation | undefined { return locations.get(id) }
export function objectLocationForPath(path: string): ObjectLocation | undefined {
  return [...locations.values()].find(location => location.path === path)
}
function isPathKey(key: string): boolean { return /^(?:[\\/]|[a-z]:[\\/])/i.test(key) }
export function readingPositionKey(key: string): string | null {
  if (locations.has(key)) return key
  if (isPathKey(key)) return objectLocationForPath(key)?.objectId ?? null
  return key.startsWith('doc-') ? `draft:${key}` : key
}
export function projectObjectAppearances(appearances: FileAppearanceMap): FileAppearanceMap {
  return Object.fromEntries([...locations.values()].flatMap(location => appearances[location.objectId] ? [[location.path, appearances[location.objectId]]] : []))
}
export function subscribeObjectPresentation(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener) }
}
export function onObjectMoved(listener: (event: ObjectMovedEvent) => void): () => void {
  moveListeners.add(listener); return () => { moveListeners.delete(listener) }
}
export async function resolvePresentationObject(path: string): Promise<ObjectLocation> {
  await initializeObjectPresentation()
  return rememberObjectLocation(await objectPresentationAPI().resolvePath(path))
}

/** Each new store is written before the applied marker; retries only fill absent keys. */
export async function migrateObjectPresentation(api: ObjectPresentationAPI, storage: Storage): Promise<void> {
  const saved = storage.getItem(OBJECT_MIGRATION_KEY)
  const migration: Migration = saved ? JSON.parse(saved) : {
    migrationId: crypto.randomUUID(),
    positions: JSON.parse(storage.getItem(OLD_READING_KEY) ?? '[]'),
    appearances: normalizeFileAppearanceMap(JSON.parse(storage.getItem(OLD_APPEARANCES_KEY) ?? '{}')),
    applied: false,
  }
  if (migration.report?.state === 'completed') {
    storage.removeItem(OLD_READING_KEY); storage.removeItem(OLD_APPEARANCES_KEY)
    return
  }
  storage.setItem(OBJECT_MIGRATION_KEY, JSON.stringify(migration))
  const paths = [...new Set([...migration.positions.map(record => record.key), ...Object.keys(migration.appearances)])].filter(isPathKey)
  const report = await api.prepareMigration({ migrationId: migration.migrationId, paths })
  if (!migration.applied) {
    const ids = new Map(report.resolved.map(location => [location.sourcePath, location.objectId]))
    const positions: DocumentReadingPositionRecord[] = JSON.parse(storage.getItem(OBJECT_READING_POSITIONS_KEY) ?? '[]')
    const present = new Set(positions.map(record => record.key))
    for (const record of [...migration.positions].sort((a, b) => b.updatedAt - a.updatedAt)) {
      const key = ids.get(record.key) ?? (record.key.startsWith('doc-') ? `draft:${record.key}` : null)
      if (key && !present.has(key)) { positions.push({ ...record, key }); present.add(key) }
    }
    const appearances = normalizeFileAppearanceMap(JSON.parse(storage.getItem(OBJECT_APPEARANCES_KEY) ?? '{}'))
    for (const [path, appearance] of Object.entries(migration.appearances)) {
      const id = ids.get(path)
      if (id && !appearances[id]) appearances[id] = appearance
    }
    storage.setItem(OBJECT_READING_POSITIONS_KEY, JSON.stringify(positions))
    storage.setItem(OBJECT_APPEARANCES_KEY, JSON.stringify(appearances))
    migration.applied = true
  }
  // Keep original values with failures, including after old keys are removed.
  migration.report = report
  storage.setItem(OBJECT_MIGRATION_KEY, JSON.stringify(migration))
  const completed = await api.completeMigration(migration.migrationId)
  if (completed.state !== 'completed') throw new Error('Object migration completion was not confirmed')
  migration.report = { ...report, state: 'completed' }
  storage.setItem(OBJECT_MIGRATION_KEY, JSON.stringify(migration))
  storage.removeItem(OLD_READING_KEY); storage.removeItem(OLD_APPEARANCES_KEY)
}

export function acceptObjectMove(event: ObjectMovedEvent): void {
  const previous = locations.get(event.objectId)
  if (previous && previous.revision >= event.revision) return
  rememberObjectLocation({ objectId: event.objectId, path: event.to, revision: event.revision })
  for (const listener of moveListeners) listener(event)
}
let subscribed = false
export function initializeObjectPresentation(): Promise<void> {
  if (initialization) return initialization
  const api = objectPresentationAPI()
  if (!subscribed) { api.onMoved(acceptObjectMove); subscribed = true }
  initialization = (async () => {
    await migrateObjectPresentation(api, localStorage)
    const appearances = normalizeFileAppearanceMap(JSON.parse(localStorage.getItem(OBJECT_APPEARANCES_KEY) ?? '{}'))
    const positions: DocumentReadingPositionRecord[] = JSON.parse(localStorage.getItem(OBJECT_READING_POSITIONS_KEY) ?? '[]')
    const ids = new Set([...Object.keys(appearances), ...positions.map(record => record.key).filter(key => !key.startsWith('draft:'))])
    for (const id of ids) {
      const location = await api.locate(id)
      if (location) rememberObjectLocation(location)
    }
    for (const listener of listeners) listener()
  })().catch(error => { initialization = undefined; throw error })
  return initialization
}
