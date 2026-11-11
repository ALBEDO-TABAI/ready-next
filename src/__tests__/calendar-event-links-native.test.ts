import { toReadyUri } from '../shared/ready-ref'
import { readDocumentSource } from '../shared/document-operations'
import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { readFileSync, mkdtempSync, realpathSync, rmSync, readdirSync, writeFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMigrations } from '../main/modules/migrations'
import { CalendarStore } from '../main/modules/database/calendar-store'
import { ObjectLinkRepository } from '../main/modules/search-engine/object-links'
import { SearchEngine } from '../main/modules/search-engine/indexer'
import { rebuildObjectIndex } from '../main/modules/search-engine/object-index-rebuild'
import { ObjectRegistry } from '../main/modules/object-service/registry'
import { DocumentDraftService } from '../main/modules/document-drafts/service'
import { CalendarMeetingNotes } from '../main/modules/calendar-engine/meeting-notes'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

const start = Date.parse('2026-10-29T09:00:00Z'), second = start + 86400000
const target = { kind: 'web', url: 'https://example.com/meeting' } as const
function fixture() {
  const db = new Database(':memory:'); runMigrations(db)
  const store = new CalendarStore(() => db)
  store.putCalendar({ id: 'local', accountId: 'local', name: 'Local', color: '#4488CC', visible: true })
  store.mutate({ type: 'create', event: { id: 'series', uid: 'series@test', calendarId: 'local', title: 'Meeting',
    allDay: false, start, end: start + 3600000, timeZone: 'UTC', rrule: 'FREQ=DAILY;COUNT=4',
    status: 'confirmed', transparency: 'opaque', createdAt: 1, updatedAt: 1 } }, {})
  const versions = () => Object.fromEntries(store.snapshot().events.map(e => [e.id, e.revision!]))
  const link = () => store.mutate({ type: 'link', key: `series|${second}`, target, purpose: 'related' }, versions())
  return { db, store, versions, link }
}

test('M6-A C1/C5 link/unlink check revisions; undo/redo restores edges and rejects intervening edits', t => {
  if (skipIfSqliteUnavailable(t, 'calendar links')) return
  const { db, store, versions, link } = fixture(); t.after(() => db.close())
  const added = link(), edge = added.snapshot.links![0]
  assert.equal(edge.originalStart, second)
  assert.throws(() => store.mutate({ type: 'unlink', key: `series|${second}`, linkId: edge.id }, { series: 1 }), /版本/)
  const removed = store.mutate({ type: 'unlink', key: `series|${second}`, linkId: edge.id }, versions())
  assert.deepEqual(removed.snapshot.links, [])
  const restored = store.restore(removed.undo, removed.versions)
  assert.deepEqual(restored.snapshot.links, [edge])
  const redone = store.restore(restored.undo, restored.versions)
  assert.deepEqual(redone.snapshot.links, [])
  store.mutate({ type: 'update', key: 'series', scope: 'all', patch: { title: 'Changed' } }, versions())
  assert.throws(() => store.restore(redone.undo, redone.versions), /版本/)
  assert.throws(() => store.mutate({ type: 'link', key: 'series', target }, { series: 1 }), /版本/)
})

test('M6-A repeated exception retains original identity; series move/split/delete and undo carry links', t => {
  if (skipIfSqliteUnavailable(t, 'calendar links recurrence')) return
  const { db, store, versions, link } = fixture(); t.after(() => db.close()); link()
  store.mutate({ type: 'update', key: `series|${second}`, scope: 'this', patch: { start: second + 3600000, end: second + 7200000 } }, versions())
  assert.equal(store.snapshot().links![0].originalStart, second)
  const moved = store.mutate({ type: 'update', key: `series|${second}`, scope: 'all', patch: { start: second + 7200000, end: second + 10800000 } }, versions())
  assert.equal(moved.snapshot.links![0].originalStart, second + 7200000)
  store.restore(moved.undo, moved.versions)
  const split = store.mutate({ type: 'update', key: `series|${second}`, scope: 'following', patch: { title: 'Later' } }, versions())
  const edge = split.snapshot.links![0]
  assert.notEqual(edge.eventId, 'series'); assert.equal(edge.originalStart, second)
  const deleted = store.mutate({ type: 'delete', keys: [`${edge.eventId}|${second}`], scope: 'this' }, versions())
  assert.deepEqual(deleted.snapshot.links, [])
  assert.deepEqual(store.restore(deleted.undo, deleted.versions).snapshot.links, [edge])
})

test('M6-A all-day identities stay dates and subscription links are rejected atomically', t => {
  if (skipIfSqliteUnavailable(t, 'calendar links read-only')) return
  const { db, store, versions } = fixture(); t.after(() => db.close())
  store.mutate({ type: 'update', key: 'series', scope: 'all', patch: { allDay: true, start: '2026-10-29', end: '2026-10-30' } }, versions())
  const result = store.mutate({ type: 'link', key: 'series|2026-10-30', target }, versions())
  assert.equal(result.snapshot.links![0].originalStart, '2026-10-30')
  store.upsertCalendarSource({ id: 'local', name: 'Subscription', syncUrl: 'https://example.com/cal.ics' })
  assert.throws(() => store.mutate({ type: 'link', key: 'series|2026-10-31', target }, versions()), /只读/)
  assert.throws(() => store.restore(result.undo, result.versions), /只读/)
  assert.deepEqual(store.snapshot().links, result.snapshot.links)
})

test('M6-A C5 real index rebuild restores outgoing/backlinks and export contains exact instance references', async t => {
  if (skipIfSqliteUnavailable(t, 'calendar links rebuild')) return
  const { db, store, link, versions } = fixture(); t.after(() => db.close()); link()
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ready-m6-index-'))); t.after(() => rmSync(root, { recursive: true, force: true }))
  const engine = new SearchEngine(db, { fts5Available: true }); t.after(() => engine.cancelPendingWorkspaceResolves())
  engine.getRepository().ensureWorkspace(root)
  const relations = new ObjectLinkRepository(db), source = { ref: { kind: 'event', id: 'series', occurrence: String(second) } } as const
  const before = relations.outgoing(source)
  assert.equal(before.length, 1); assert.equal(relations.incoming({ ref: target }).length, 1)
  await rebuildObjectIndex(engine, [root]); assert.deepEqual(relations.outgoing(source), before)
  await rebuildObjectIndex(engine, [root]); assert.deepEqual(relations.outgoing(source), before)
  const exported = store.exportCalendar().replace(/\r?\n /g, '')
  const property = exported.split(/\r?\n/).find(line => line.startsWith('X-READY-LINK:'))!
  const value = JSON.parse(decodeURIComponent(property.slice('X-READY-LINK:'.length)))
  assert.equal(value.source, `ready://calendar/event/series#occurrence=${second}`)
  assert.equal(value.target, `ready://web?url=${encodeURIComponent(target.url)}`)
  const from=join(root,'before.md'),to=join(root,'after.md'),registry=new ObjectRegistry(db)
  writeFileSync(from,'# Related page\n');const object=registry.register(from)
  assert.equal((await engine.indexDocument(root,from)).ok,true)
  store.mutate({type:'link',key:`series|${second}`,target:{kind:'page',id:object.id}},versions())
  renameSync(from,to);registry.reconcile([from,to])
  await rebuildObjectIndex(engine,[root])
  assert.equal(registry.get(object.id)?.current_path,to)
  assert.deepEqual(relations.incoming({objectId:object.id}).map(edge=>edge.source),[source])
  assert.ok(store.snapshot().links!.some(link=>link.target.kind==='page'&&link.target.id===object.id))
})

test('M6-A C12 interrupted note finalize retries the same draft/file and checks revision again before linking', async t => {
  if (skipIfSqliteUnavailable(t, 'calendar meeting retry')) return
  const { db, store, versions } = fixture(); t.after(() => db.close())
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ready-m6-notes-'))); t.after(() => rmSync(root, { recursive: true, force: true }))
  const registry = new ObjectRegistry(db), engine = new SearchEngine(db, { fts5Available: true })
  t.after(() => engine.cancelPendingWorkspaceResolves()); engine.getRepository().ensureWorkspace(root)
  let interrupt = true
  const drafts = new DocumentDraftService(db, { registry, index: async (vault, path) => {
    const indexed = await engine.indexDocument(vault, path); assert.equal(indexed.ok, true)
    if (interrupt) { interrupt = false; throw new Error('interrupted after publish') }
  } })
  let notes = new CalendarMeetingNotes(db, store, drafts)
  const input = { key: `series|${second}`, expected: versions(), destination: { parentPath: root, title: 'Notes', operationId: 'meeting-one' } }
  await assert.rejects(notes.create(root, input), /interrupted/)
  notes = new CalendarMeetingNotes(db, store, drafts)
  const [a, b] = await Promise.all([notes.create(root, input), notes.create(root, input)])
  assert.equal(a.ref.kind, 'page'); assert.deepEqual(a.ref, b.ref)
  assert.equal(readdirSync(root).filter(name => name.endsWith('.md')).length, 1)
  assert.equal(readDocumentSource(readFileSync(join(root, 'Notes.md'), 'utf8')).body, `[日程](${toReadyUri({ kind: 'event', id: 'series', occurrence: String(second) })})\n\n`)
  assert.equal(db.prepare('SELECT count(*) n FROM document_drafts').get<{n:number}>()!.n, 1)
  assert.equal(store.snapshot().links!.filter(l => l.purpose === 'meeting-note').length, 1)
  await assert.rejects(notes.create(root, { ...input, destination: { ...input.destination, operationId: 'meeting-two', title: 'Another' } }), /已有|关联|意图/)
})

test('M6-A C3/C12 a concurrent event edit rejects the link; reopening SQLite resumes the published note once', async t => {
  if (skipIfSqliteUnavailable(t, 'calendar meeting restart')) return
  const directory = realpathSync(mkdtempSync(join(tmpdir(),'ready-m6-restart-')))
  t.after(()=>rmSync(directory,{recursive:true,force:true}))
  const initial=fixture(), path=join(directory,'ready.db')
  initial.db.prepare('VACUUM INTO ?').run(path);initial.db.close()
  const open=()=>{
    const db=new Database(path);runMigrations(db)
    const calendar=new CalendarStore(()=>db), registry=new ObjectRegistry(db), engine=new SearchEngine(db,{fts5Available:true})
    engine.getRepository().ensureWorkspace(directory)
    let edit=false
    const drafts=new DocumentDraftService(db,{registry,index:async(root,file)=>{
      assert.equal((await engine.indexDocument(root,file)).ok,true)
      if(edit){edit=false;calendar.mutate({type:'update',key:'series',scope:'all',patch:{title:'Concurrent edit'}},{series:1})}
    }})
    return {db,calendar,notes:new CalendarMeetingNotes(db,calendar,drafts),interrupt:()=>{edit=true},close:()=>{engine.cancelPendingWorkspaceResolves();db.close()}}
  }
  let session=open()
  try {
    const input={key:`series|${second}`,expected:{series:1},destination:{parentPath:directory,title:'Durable note',operationId:'restart-note'}}
    session.interrupt()
    await assert.rejects(session.notes.create(directory,input),/版本/)
    assert.equal(session.calendar.snapshot().links!.length,0)
    assert.equal(readdirSync(directory).filter(name=>name.endsWith('.md')).length,1)
    session.close();session=open()
    const destination=session.notes.pendingDestination(directory,input.key)
    assert.deepEqual(destination,input.destination)
    const receipt=await session.notes.create(directory,{...input,destination:destination!,expected:{series:2}})
    session.close();session=open()
    assert.deepEqual(session.calendar.snapshot().links!.map(link=>link.target),[receipt.ref])
    assert.deepEqual((await session.notes.create(directory,{...input,expected:{series:2}})).ref,receipt.ref)
    assert.equal(readdirSync(directory).filter(name=>name.endsWith('.md')).length,1)
    session.calendar.restore(receipt.mutation.undo,receipt.mutation.versions)
    await assert.rejects(session.notes.create(directory,input),/撤销/)
  } finally {session.close()}
})
