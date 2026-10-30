import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { canvasFixture, textNode } from './utils/canvas-fixture'
import { CanvasService } from '../main/modules/board-engine/canvas-service'

test('C3 canvas versions, operation identity and restart receipts', async t => {
  if (skipIfSqliteUnavailable(t, 'canvas writes')) return
  const f = canvasFixture()
  try {
    const h = await f.service.create({ path: 'A.canvas', operationId: 'create' })
    const request = { ...h, operationId: 'add', expectedVersion: h.version, commands: [{ type: 'addNode' as const, node: textNode('a') }] }
    const receipt = await f.service.write(request)
    assert.equal(receipt.state, 'completed')
    assert.deepEqual(await f.service.write(request), receipt)
    const restarted = new CanvasService(f.registry, f.root)
    await restarted.recover()
    assert.deepEqual(await restarted.write(request), receipt)
    await assert.rejects(restarted.write({ ...request, commands: [] }), /operation_id_reused/)
    assert.equal((await f.service.write({ ...request, operationId: 'stale' })).state, 'conflict')
    f.service.release(h.handleId)
    assert.equal((await restarted.open(h.objectId)).canvas.nodes.length, 1)
  } finally { f.close() }
})

test('C3 dirty buffer merges disjoint fields, rejects overlaps and preserves both versions', async t => {
  if (skipIfSqliteUnavailable(t, 'canvas buffers')) return
  const f = canvasFixture()
  try {
    const h = await f.service.create({ path: 'A.canvas', operationId: 'create', canvas: { nodes: [textNode('a')], edges: [], ready: { schemaVersion: 1, id: 'board' } } })
    const dirty = structuredClone(h.canvas); dirty.nodes[0].x = 20
    f.service.updateBuffer({ objectId: h.objectId, tabId: 'tab', openGeneration: 1, bufferVersion: 1, baseVersion: h.version, canvas: dirty })
    const result = await f.service.write({ ...h, expectedVersion: h.version, operationId: 'merge', commands: [{ type: 'geometry', id: 'a', geometry: { y: 40 } }] })
    assert.equal(result.state, 'merged_dirty')
    assert.equal(f.service.buffer(h.objectId)?.canvas.nodes[0].y, 40)
    assert.equal(f.service.buffer(h.objectId)?.canvas.nodes[0].x, 20)
    assert.equal(JSON.parse(readFileSync(join(f.root, 'A.canvas'), 'utf8')).nodes[0].y, 0)
    const conflict = await f.service.write({ ...h, expectedVersion: h.version, operationId: 'overlap', commands: [{ type: 'geometry', id: 'a', geometry: { x: 99 } }] })
    assert.equal(conflict.state, 'conflict')
    assert.equal(f.service.buffer(h.objectId)?.canvas.nodes[0].x, 20)
    assert.throws(() => f.service.updateBuffer({ objectId: h.objectId, tabId: 'new-tab', openGeneration: 2, bufferVersion: 1, baseVersion: h.version, canvas: h.canvas }), /recover or save/)
    const restarted = new CanvasService(f.registry, f.root)
    assert.equal(restarted.buffer(h.objectId)?.canvas.nodes[0].y, 40)
    const reopened = await restarted.open(h.objectId)
    assert.equal((await restarted.saveBuffer({ ...reopened, operationId: 'save', expectedVersion: h.version })).state, 'completed')
    assert.equal((await restarted.read(reopened.handleId)).canvas.nodes[0].x, 20)
  } finally { f.close() }
})

test('C10 publish failure preserves readable file and recovery completes same operation', async t => {
  if (skipIfSqliteUnavailable(t, 'canvas recovery')) return
  const f = canvasFixture()
  try {
    const h = await f.service.create({ path: 'A.canvas', operationId: 'create' })
    const failing = new CanvasService(f.registry, f.root, { checkpoint: phase => { if (phase === 'published') throw new Error('injected interruption') } })
    const opened = await failing.open(h.objectId)
    const request = { ...opened, expectedVersion: h.version, operationId: 'interrupted', commands: [{ type: 'addNode' as const, node: textNode('a') }] }
    assert.equal((await failing.write(request)).state, 'recovery-required')
    assert.equal(JSON.parse(readFileSync(join(f.root, 'A.canvas'), 'utf8')).nodes.length, 1)
    const restarted = new CanvasService(f.registry, f.root)
    await restarted.recover()
    assert.equal((await restarted.write(request)).state, 'completed')
    assert.equal((await restarted.open(h.objectId)).canvas.nodes.length, 1)
  } finally { f.close() }
})

test('C3 text ranges merge nonoverlap; overlapping text, delete/edit and group changes conflict', async t => {
  if (skipIfSqliteUnavailable(t, 'canvas conflict boundaries')) return
  const { fragmentHash } = await import('../shared/document-blocks/positions')
  const f = canvasFixture()
  try {
    const h = await f.service.create({ path: 'A.canvas', operationId: 'create', canvas: { nodes: [textNode('a'), { id: 'g1', type: 'group', x: 0, y: 0, width: 200, height: 100, ready: { kind: 'group' } }, { id: 'g2', type: 'group', x: 0, y: 0, width: 200, height: 100, ready: { kind: 'group' } }], edges: [], ready: { schemaVersion: 1, id: 'text-board' } } })
    const local = structuredClone(h.canvas); if (local.nodes[0].type !== 'text') throw new Error('fixture')
    local.nodes[0].text = 'HELLO world'; local.nodes[0].ready.groupId = 'g1'
    f.service.updateBuffer({ objectId: h.objectId, tabId: 'text', openGeneration: 1, bufferVersion: 1, baseVersion: h.version, canvas: local })
    const write = (operationId: string, commands: import('../shared/ready-canvas').CanvasCommand[]) => f.service.write({ ...h, operationId, expectedVersion: h.version, commands })
    assert.equal((await write('text-merge', [{ type: 'textRanges', id: 'a', expectedTextVersion: fragmentHash('hello world'), ranges: [{ start: 6, end: 11, expectedText: 'world', replacement: 'WORLD' }] }])).state, 'merged_dirty')
    assert.equal(f.service.buffer(h.objectId)?.canvas.nodes[0].text, 'HELLO WORLD')
    for (const [operationId, commands, code] of [
      ['text-overlap', [{ type: 'textRanges', id: 'a', expectedTextVersion: fragmentHash('hello world'), ranges: [{ start: 0, end: 5, expectedText: 'hello', replacement: 'other' }] }], 'text_conflict'],
      ['delete', [{ type: 'deleteNode', id: 'a' }], 'delete_edit_conflict'],
      ['group', [{ type: 'group', ids: ['a'], groupId: 'g2' }], 'group_conflict'],
    ] satisfies Array<[string, import('../shared/ready-canvas').CanvasCommand[], string]>) {
      const result = await write(operationId, commands)
      assert.equal(result.state, 'conflict'); if (result.state === 'conflict') assert.equal(result.conflict.code, code)
    }
    assert.equal(f.service.buffer(h.objectId)?.canvas.nodes[0].text, 'HELLO WORLD')
  } finally { f.close() }
})

test('C10 attachment staging and readback failures do not return success and retry safely', async t => {
  if (skipIfSqliteUnavailable(t, 'canvas failure injection')) return
  const { writeFileSync } = await import('node:fs')
  const f = canvasFixture()
  try {
    for (const phase of ['staged', 'readback'] as const) {
      const h = await f.service.create({ path: `${phase}.canvas`, operationId: `create-${phase}` })
      const before = readFileSync(join(f.root, `${phase}.canvas`), 'utf8')
      const source = join(f.root, `${phase}.txt`); writeFileSync(source, 'attachment')
      const failing = new CanvasService(f.registry, f.root, { checkpoint: point => { if (point === phase) throw new Error(`injected ${phase}`) } })
      const opened = await failing.open(h.objectId), token = await failing.prepareAttachment(source)
      const result = await failing.write({ ...opened, operationId: phase, expectedVersion: opened.version, commands: [{ type: 'importAttachment', sourceToken: token, node: { id: 'asset', type: 'file', x: 0, y: 0, width: 100, height: 100, file: `${phase}.assets/pending.txt`, ready: { kind: 'document' } } }] })
      assert.equal(result.state, 'recovery-required')
      assert.doesNotThrow(() => JSON.parse(readFileSync(join(f.root, `${phase}.canvas`), 'utf8')))
      if (phase === 'staged') assert.equal(readFileSync(join(f.root, `${phase}.canvas`), 'utf8'), before)
      const restarted = new CanvasService(f.registry, f.root); await restarted.recover()
      const final = await restarted.open(h.objectId)
      assert.equal(final.canvas.nodes.length, 1)
      assert.equal(readFileSync(join(f.root, String(final.canvas.nodes[0].file)), 'utf8'), 'attachment')
    }
  } finally { f.close() }
})

test('C10 actual process death after publication recovers exactly one saved node', async t => {
  if (skipIfSqliteUnavailable(t, 'canvas process recovery')) return
  const { spawnSync } = await import('node:child_process')
  const f = canvasFixture()
  try {
    const h = await f.service.create({ path: 'Crash.canvas', operationId: 'create-crash' })
    const script = `import Database from 'better-sqlite3'; import { ObjectRegistry } from './src/main/modules/object-service/registry.ts'; import { CanvasService } from './src/main/modules/board-engine/canvas-service.ts'; const db=new Database(${JSON.stringify(join(f.root, 'test.db'))}); const service=new CanvasService(new ObjectRegistry(db),${JSON.stringify(f.root)},{checkpoint:phase=>{if(phase==='published')process.exit(23)}}); const h=await service.open(${JSON.stringify(h.objectId)}); await service.write({...h,operationId:'process-crash',expectedVersion:h.version,commands:[{type:'addNode',node:${JSON.stringify(textNode('one'))}}]});`
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' })
    assert.equal(child.status, 23, child.stderr)
    await new CanvasService(f.registry, f.root).recover()
    assert.equal((await f.service.open(h.objectId)).canvas.nodes.length, 1)
    assert.equal(f.db.prepare('SELECT state FROM canvas_operations WHERE id=?').get<{ state: string }>('process-crash')?.state, 'completed')
  } finally { f.close() }
})

test('C10 attachment write failure, atomic publisher failure and mismatched readback retain readable originals', async t => {
  if (skipIfSqliteUnavailable(t, 'canvas IO failures')) return
  const { writeFileSync } = await import('node:fs')
  const f = canvasFixture()
  try {
    for (const failure of ['attachment', 'publish', 'readback'] as const) {
      const h = await f.service.create({ path: `${failure}.canvas`, operationId: `create-${failure}` }), before = readFileSync(join(f.root, h.path), 'utf8')
      const dependencies = failure === 'attachment' ? { stage: async () => { throw new Error('attachment write failed') } } : failure === 'publish' ? { publish: async () => { throw new Error('atomic publish failed') } } : { readback: async () => Buffer.from('incorrect readback') }
      const writer = new CanvasService(f.registry, f.root, dependencies), opened = await writer.open(h.objectId)
      const source = join(f.root, 'source.txt'); writeFileSync(source, 'source')
      const commands: import('../shared/ready-canvas').CanvasCommand[] = failure === 'attachment' ? [{ type: 'importAttachment', sourceToken: await writer.prepareAttachment(source), node: { id: 'asset', type: 'file', x: 0, y: 0, width: 10, height: 10, file: 'pending.assets/a', ready: { kind: 'document' } } }] : [{ type: 'addNode', node: textNode('a') }]
      const result = await writer.write({ ...opened, expectedVersion: h.version, operationId: `fail-${failure}`, commands })
      assert.equal(result.state, 'recovery-required')
      assert.doesNotThrow(() => JSON.parse(readFileSync(join(f.root, h.path), 'utf8')))
      if (failure !== 'readback') assert.equal(readFileSync(join(f.root, h.path), 'utf8'), before)
      else if (result.state === 'recovery-required') assert.match(result.message, /readback_mismatch/)
      await new CanvasService(f.registry, f.root).recover()
      assert.equal((await f.service.open(h.objectId)).canvas.nodes.length, 1)
    }
  } finally { f.close() }
})

test('C3 prepare/commit/release bind confirmation, and a move only prepares then rolls back', async t => {
  if (skipIfSqliteUnavailable(t, 'canvas buffer protocol')) return
  const f = canvasFixture()
  try {
    const h = await f.service.create({ path: 'Protocol.canvas', operationId: 'create-protocol' })
    const phases: string[] = []
    const service = new CanvasService(f.registry, f.root, { sync: async request => { phases.push(request.phase); return { confirmation: request.confirmation, canvas: request.canvas } } })
    service.updateBuffer({ objectId: h.objectId, tabId: 'protocol', openGeneration: 4, bufferVersion: 8, baseVersion: h.version, canvas: h.canvas })
    const open = await service.open(h.objectId)
    assert.equal((await service.write({ ...open, expectedVersion: h.version, operationId: 'protocol', commands: [{ type: 'addNode', node: textNode('a') }] })).state, 'completed')
    assert.deepEqual(phases, ['prepare', 'commit', 'release'])
    phases.length = 0
    await service.withPageMove([h.objectId], 'lock-only', async () => {})
    assert.deepEqual(phases, ['prepare', 'rollback'])
    const stale = new CanvasService(f.registry, f.root, { sync: async request => ({ confirmation: request.confirmation ? { ...request.confirmation, openGeneration: 99 } : undefined }) })
    const current = await stale.open(h.objectId)
    assert.equal((await stale.write({ ...current, expectedVersion: current.version, operationId: 'stale-confirmation', commands: [{ type: 'addNode', node: textNode('b') }] })).state, 'conflict')
    assert.equal((await service.open(h.objectId)).canvas.nodes.length, 1)
  } finally { f.close() }
})

test('M4 IPC uses real handles, validates payloads and awaits startup recovery', async t => {
  if (skipIfSqliteUnavailable(t, 'canvas IPC')) return
  const { registerCanvasIPC } = await import('../main/modules/board-engine/ipc')
  const { CanvasImportService } = await import('../main/modules/canvas-import/service')
  const { z } = await import('zod')
  const f = canvasFixture()
  try {
    const handlers = new Map<string, Parameters<import('electron').IpcMain['handle']>[1]>()
    const authorized: string[] = []
    registerCanvasIPC({ handle: (channel, handler) => { handlers.set(channel, handler) } }, f.service, new CanvasImportService(f.service), Promise.resolve(), (_event, path) => { authorized.push(path) })
    const call = (channel: string, input: unknown) => Reflect.apply(handlers.get(channel)!, undefined, [{}, input])
    const created = z.object({ ok: z.literal(true), value: z.object({ objectId: z.string(), handleId: z.string(), version: z.string() }) }).parse(await call('canvas:create', { operationId: 'ipc-create', path: 'IPC.canvas' }))
    assert.equal((await call('canvas:read', created.value.handleId)).ok, true)
    assert.equal((await call('canvas:write', { ...created.value, expectedVersion: created.value.version, operationId: 'invalid', commands: [{ type: 'arbitrary-file-write' }] })).ok, false)
    await call('canvas:release', created.value.handleId)
    assert.equal((await call('canvas:read', created.value.handleId)).ok, false)
    assert.ok(authorized.every(path => path === f.root))
  } finally { f.close() }
})

test('C10 identical attachment bytes are reused and symlink escape fails before replacing the canvas', async t => {
  if (skipIfSqliteUnavailable(t, 'canvas attachments boundary')) return
  const { writeFileSync, symlinkSync, mkdirSync } = await import('node:fs')
  const f = canvasFixture()
  try {
    let h = await f.service.create({ path: 'Assets.canvas', operationId: 'create-assets' })
    const source = join(f.root, 'source.txt'); writeFileSync(source, 'same bytes')
    const sourceToken = await f.service.prepareAttachment(source)
    for (const id of ['a', 'b']) {
      const result = await f.service.write({ ...h, operationId: `asset-${id}`, expectedVersion: h.version, commands: [{ type: 'importAttachment', sourceToken, node: { id, type: 'file', file: 'Assets.assets/pending', x: 0, y: 0, width: 100, height: 100, ready: { kind: 'document' } } }] })
      assert.equal(result.state, 'completed', JSON.stringify(result)); h = await f.service.read(h.handleId)
    }
    assert.equal(h.canvas.nodes[0].file, h.canvas.nodes[1].file)
    const before = readFileSync(join(f.root, h.path))
    mkdirSync(join(f.root, 'Escape.assets')); symlinkSync('/private/tmp', join(f.root, 'Escape.assets', 'link'))
    const rejected = await f.service.write({ ...h, operationId: 'symlink', expectedVersion: h.version, commands: [{ type: 'addNode', node: { id: 'escape', type: 'file', file: 'Escape.assets/link/outside', x: 0, y: 0, width: 100, height: 100, ready: { kind: 'document' } } }] })
    assert.equal(rejected.state, 'recovery-required'); if (rejected.state === 'recovery-required') assert.match(rejected.message, /symbolic links/)
    assert.deepEqual(readFileSync(join(f.root, h.path)), before)
  } finally { f.close() }
})

test('C3 adding an attachment to a dirty canvas retains both contents and later saves once', async t => {
  if (skipIfSqliteUnavailable(t, 'dirty canvas attachments')) return
  const { writeFileSync } = await import('node:fs')
  const f = canvasFixture()
  try {
    const h = await f.service.create({ path: 'Dirty.canvas', operationId: 'create-dirty', canvas: { nodes: [textNode('a')], edges: [], ready: { schemaVersion: 1, id: 'dirty-board' } } })
    const dirty = structuredClone(h.canvas); dirty.nodes[0].x = 99
    f.service.updateBuffer({ objectId: h.objectId, tabId: 'dirty-tab', openGeneration: 1, bufferVersion: 1, baseVersion: h.version, canvas: dirty })
    const source = join(f.root, 'image.txt'); writeFileSync(source, 'cached attachment')
    const request = { ...h, expectedVersion: h.version, operationId: 'dirty-attachment', commands: [{ type: 'importAttachment' as const, sourceToken: await f.service.prepareAttachment(source), node: { id: 'media', type: 'file' as const, file: 'Dirty.assets/pending', x: 0, y: 0, width: 100, height: 100, ready: { kind: 'document' as const } } }] }
    assert.equal((await f.service.write(request)).state, 'merged_dirty')
    assert.equal(JSON.parse(readFileSync(join(f.root, h.path), 'utf8')).nodes.length, 1)
    const save = { ...h, expectedVersion: h.version, operationId: 'save-dirty' }
    const result = await f.service.saveBuffer(save); assert.equal(result.state, 'completed')
    assert.deepEqual(await f.service.saveBuffer(save), result)
    const final = await f.service.read(h.handleId)
    assert.equal(final.canvas.nodes.length, 2); assert.equal(final.canvas.nodes[0].x, 99)
    assert.equal(readFileSync(join(f.root, String(final.canvas.nodes[1].file)), 'utf8'), 'cached attachment')
  } finally { f.close() }
})
