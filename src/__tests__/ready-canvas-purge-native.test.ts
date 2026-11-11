import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { CanvasService } from '../main/modules/board-engine/canvas-service'
import { ReadyCanvasSchema, type CanvasCommand } from '../shared/ready-canvas'
import { canvasFixture, textNode } from './utils/canvas-fixture'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

const trash = { operationId: 'recycle', deletedAt: '2026-11-11T00:00:00Z' }
async function setup(f: ReturnType<typeof canvasFixture>) {
  mkdirSync(join(f.root, 'A.assets'))
  writeFileSync(join(f.root, 'A.assets/file.txt'), 'shared asset')
  return f.service.create({ path: 'A.canvas', operationId: 'create', canvas: {
    nodes: [textNode('a'), textNode('b'), textNode('c'),
      { id: 'g', type: 'group', x: 0, y: 0, width: 100, height: 100, ready: { kind: 'group' } },
      { id: 'asset', type: 'file', file: 'A.assets/file.txt', x: 0, y: 0, width: 100, height: 100, ready: { kind: 'document' } }],
    edges: [{ id: 'ab', fromNode: 'a', toNode: 'b' }, { id: 'bc', fromNode: 'b', toNode: 'c' }],
    ready: { schemaVersion: 1, id: 'purge-board' },
  } })
}
async function write(f: ReturnType<typeof canvasFixture>, operationId: string, commands: CanvasCommand[]) {
  const h = await f.service.open('purge-board')
  const result = await f.service.write({ ...h, expectedVersion: h.version, operationId, commands })
  assert.equal(result.state, 'completed', JSON.stringify(result))
  f.service.release(h.handleId)
  return result
}
function read(f: ReturnType<typeof canvasFixture>) {
  return ReadyCanvasSchema.parse(JSON.parse(readFileSync(join(f.root, 'A.canvas'), 'utf8')))
}

test('purge removes recycled cards and incident edges, detaches surviving cards and retains assets', async t => {
  if (skipIfSqliteUnavailable(t, 'canvas purge')) return
  const f = canvasFixture()
  try {
    await setup(f)
    await write(f, 'prepare', [{ type: 'group', ids: ['b'], groupId: 'g' },
      { type: 'replaceNode', node: { ...textNode('c'), ready: { kind: 'text', dock: { left: 'a' } } } },
      { type: 'trash', ids: ['a', 'g', 'asset'], trash }])
    await write(f, 'purge', [{ type: 'purge', ids: ['a', 'g', 'asset'] }])
    const canvas = read(f)
    assert.deepEqual(canvas.nodes.map(n => n.id), ['b', 'c'])
    assert.deepEqual(canvas.edges.map(e => e.id), ['bc'])
    assert.equal(canvas.nodes[0].ready.groupId, undefined)
    assert.equal(canvas.nodes[1].ready.dock?.left, undefined)
    assert.equal(readFileSync(join(f.root, 'A.assets/file.txt'), 'utf8'), 'shared asset')
  } finally { f.close() }
})

test('purging a live card or live explicit edge rejects the whole write without changing bytes', async t => {
  if (skipIfSqliteUnavailable(t, 'canvas purge boundary')) return
  const f = canvasFixture()
  try {
    await setup(f); await write(f, 'trash', [{ type: 'trash', ids: ['a'], trash }])
    const before = readFileSync(join(f.root, 'A.canvas'))
    await assert.rejects(write(f, 'live-node', [{ type: 'purge', ids: ['a', 'b'] }]), /只能永久删除已回收的卡片/)
    await assert.rejects(write(f, 'live-edge', [{ type: 'purge', ids: ['a'], edgeIds: ['bc'] }]), /只能永久删除已回收的连线/)
    assert.deepEqual(readFileSync(join(f.root, 'A.canvas')), before)
  } finally { f.close() }
})

test('empty trash purges all recycled cards and independently recycled edges, retaining live content', async t => {
  if (skipIfSqliteUnavailable(t, 'canvas empty trash')) return
  const f = canvasFixture()
  try {
    await setup(f); await write(f, 'trash', [{ type: 'trash', ids: ['a', 'asset'], edgeIds: ['bc'], trash }])
    const before = read(f)
    await write(f, 'empty', [{ type: 'purge', ids: before.nodes.filter(n => n.ready.trash).map(n => n.id), edgeIds: before.edges.filter(e => e.ready?.trash).map(e => e.id) }])
    assert.deepEqual(read(f).nodes.map(n => n.id), ['b', 'c', 'g'])
    assert.deepEqual(read(f).edges, [])
    await write(f, 'empty-again', [{ type: 'purge', ids: [] }])
  } finally { f.close() }
})

test('purge interruption before or after publication recovers and replay does not delete twice', async t => {
  if (skipIfSqliteUnavailable(t, 'canvas purge recovery')) return
  for (const phase of ['staged', 'published'] as const) {
    const f = canvasFixture()
    try {
      await setup(f); await write(f, 'trash', [{ type: 'trash', ids: ['a'], trash }])
      const failing = new CanvasService(f.registry, f.root, { checkpoint: point => { if (point === phase) throw new Error('interrupted') } })
      const h = await failing.open('purge-board')
      const request = { ...h, expectedVersion: h.version, operationId: 'purge', commands: [{ type: 'purge' as const, ids: ['a'] }] }
      assert.equal((await failing.write(request)).state, 'recovery-required')
      assert.equal(read(f).nodes.some(n => n.id === 'a'), phase === 'staged')
      const restarted = new CanvasService(f.registry, f.root)
      await restarted.recover()
      assert.equal((await restarted.write(request)).state, 'completed')
      assert.equal(read(f).nodes.some(n => n.id === 'a'), false)
      assert.deepEqual(read(f).edges.map(e => e.id), ['bc'])
    } finally { f.close() }
  }
})
