import { configureDocumentWriteService } from '../main/modules/document-engine/document-write-service'
import { ChatStore } from '../main/modules/database/chat-store'
import { executeFileManagementTool } from '../main/modules/tools/file-management-tools'
import { readDocumentEditableText, writeDocumentEditableText } from '../main/modules/document-engine/document-editable-text'
import { buildStructuredNotePreview } from '../renderer/components/document/note-preview-parser'
import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFileSync, readFileSync, statSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fixture } from './utils/ready-object-fixture'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { ObjectPresentationService, registerObjectIPC } from '../main/modules/object-service/presentation'
import { subscribeObjectMoves } from '../main/modules/object-service/events'
import { ObjectMutations } from '../main/modules/object-service/mutations'
import { ObjectEventWindow } from '../main/modules/object-service/event-window'
import { resolveCodexExplicitResources } from '../main/modules/agent-control/codex-runtime/codex-explicit-resources'

test('C2 object IPC is read-only on disk; migration preparation and acknowledgment survive retries', async t => {
  if (skipIfSqliteUnavailable(t, 'Object presentation')) return
  const f = fixture()
  try {
    const path = join(f.root, 'note.md'); writeFileSync(path, '# untouched')
    const before = statSync(path).mtimeMs
    const service = new ObjectPresentationService(f.registry)
    const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>()
    registerObjectIPC({ handle: (name, handler) => { handlers.set(name, handler) }, removeHandler: name => { handlers.delete(name) } }, () => service)
    const location = handlers.get('object:resolve-path')!({}, path)
    assert.deepEqual(location, service.locate(f.registry.find(path)!.id))
    assert.equal(readFileSync(path, 'utf8'), '# untouched'); assert.equal(statSync(path).mtimeMs, before)
    const request = { migrationId: 'renderer-test', paths: [path, join(f.root, 'missing.md')] }
    const report = service.prepareMigration(request)
    assert.equal(report.resolved.length, 1); assert.equal(report.unresolved.length, 1)
    renameSync(path, join(f.root, 'moved.md'))
    assert.deepEqual(new ObjectPresentationService(f.registry).prepareMigration(request), report)
    assert.equal(service.completeMigration(request.migrationId).state, 'completed')
    assert.equal(service.prepareMigration(request).state, 'completed')
    assert.throws(() => service.prepareMigration({ ...request, paths: [] }), /migration.*changed/)
  } finally { f.close() }
})

test('C2 move completion and Agent identity follow objects without rewriting a frozen authority or history', async t => {
  if (skipIfSqliteUnavailable(t, 'Object presentation')) return
  const f = fixture()
  const events: import('../shared/object-identity').ObjectMovedEvent[] = []
  const unsubscribe = subscribeObjectMoves(f.db, event => events.push(event))
  try {
    const a = join(f.root, 'a.md'), b = join(f.root, 'b.md'), c = join(f.root, 'c.md')
    writeFileSync(a, '# same')
    const resolve = (path: string) => resolveCodexExplicitResources({ selections: [{ kind: 'local_file', id: 'attachment', name: 'note', path }], resolveSkill: () => null, resolveLocalObject: path => new ObjectPresentationService(f.registry).resolve(path) })
    const first = await resolve(a); const frozen = JSON.stringify(first)
    const historical = { logicalResourceId: 'local-file:old-path-hash', path: a }
    const history = JSON.stringify(historical)
    const chat = new ChatStore(() => f.db)
    chat.createConversation('i2-history', 'ready', 'history')
    chat.addChatMessage('i2-receipt', 'i2-history', 'assistant', '', '2026-01-01', historical)
    const read = async (resources: typeof first, path: string) => JSON.parse(await executeFileManagementTool('file_read_excerpt', { path }, { searchEngine: f.engine, explicitReadableResources: resources.authorities }))
    assert.equal((await read(first, first.resourceRefs[0].logicalResourceId)).ok, true)
    await new ObjectMutations(f.registry).move(a, b)
    const second = await resolve(b)
    assert.equal(first.resourceRefs[0].logicalResourceId, second.resourceRefs[0].logicalResourceId)
    assert.equal(JSON.stringify(first), frozen); assert.equal(chat.getChatMessageById('i2-receipt')!.meta_json, history)
    assert.equal((await read(first, b)).ok, false)
    assert.equal((await read(first, first.resourceRefs[0].logicalResourceId)).ok, false)
    assert.equal((await read(second, second.resourceRefs[0].logicalResourceId)).content, '# same')
    assert.equal(second.requestResources[0].canWrite, false)
    assert.deepEqual(second.authorities[0].allowedToolNames, first.authorities[0].allowedToolNames)
    renameSync(b, c)
    const window = new ObjectEventWindow(f.registry, async () => {})
    const pending = [window.add(b), window.add(c)]; window.flush(); await Promise.all(pending)
    assert.deepEqual(events.map(e => [e.from, e.to]), [[a, b], [b, c]])
    assert.equal(events[0].objectId, events[1].objectId)
    assert.ok(events[1].revision > events[0].revision)
    assert.equal(readFileSync(c, 'utf8'), '# same')
    const directory = join(f.root, 'folder'), movedDirectory = join(f.root, 'renamed-folder')
    mkdirSync(directory)
    const directoryResources = (path: string) => resolveCodexExplicitResources({ selections: [{ kind: 'local_directory', id: 'folder', name: 'folder', path }], resolveSkill: () => null, resolveLocalObject: path => new ObjectPresentationService(f.registry).resolve(path) })
    const folderBefore = await directoryResources(directory)
    await new ObjectMutations(f.registry).move(directory, movedDirectory)
    const folderAfter = await directoryResources(movedDirectory)
    assert.equal(folderBefore.resourceRefs[0].logicalResourceId, folderAfter.resourceRefs[0].logicalResourceId)
    assert.deepEqual(folderAfter.authorities[0].allowedToolNames, ['file_inventory'])
    assert.equal(folderAfter.requestResources[0].canWrite, false)
  } finally { unsubscribe(); f.close() }
})

test('C2 page hides ready_id while source reading and saving retain it', async t => {
  if (skipIfSqliteUnavailable(t, 'Object presentation')) return
  const f = fixture()
  try {
    const path = join(f.root, 'portable.md')
    const source = '---\nready_id: portable-note\ntitle: Note\n---\nBody'
    writeFileSync(path, source)
    const read = await readDocumentEditableText(path)
    assert.equal(read.success, true); assert.equal(read.content, source)
    assert.doesNotMatch(JSON.stringify(buildStructuredNotePreview(read.content)), /portable-note|ready_id/)
    configureDocumentWriteService({ index: async path => { const result = await f.engine.indexDocument(f.root,path); assert.ok(result.ok,result.error) } })
    const written = read.content.replace('Body', 'Edited body')
    assert.equal((await writeDocumentEditableText(path, written)).success, true)
    assert.equal(readFileSync(path, 'utf8'), written)
    assert.match(written, /ready_id: portable-note/)
  } finally { configureDocumentWriteService(null); f.close() }
})
