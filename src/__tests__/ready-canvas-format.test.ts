import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ReadyCanvasSchema, StandardCanvasSchema, type CanvasCommand } from '../shared/ready-canvas'
import { hashBytes } from '../main/modules/document-drafts/files'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { canvasFixture } from './utils/canvas-fixture'

test('C10 real writer roundtrip preserves every node kind, edges, child canvas, trash and attachments', async t => {
  if (skipIfSqliteUnavailable(t, 'canvas roundtrip')) return
  const f = canvasFixture()
  try {
    const canvas = ReadyCanvasSchema.parse(JSON.parse(readFileSync(new URL('./fixtures/ready-canvas/valid/all-types.canvas', import.meta.url), 'utf8')))
    writeFileSync(join(f.root, 'Page.md'), '---\nready_id: page_1\n---\n# Section'); f.registry.register(join(f.root, 'Page.md'))
    mkdirSync(join(f.root, 'Board.assets')); writeFileSync(join(f.root, 'Board.assets', 'preview.png'), 'preview')
    const h = await f.service.create({ path: 'Board.canvas', operationId: 'create', canvas: { ...canvas, nodes: [], edges: [] } })
    const commands: CanvasCommand[] = []
    for (const node of canvas.nodes) {
      if (node.ready.kind === 'subcanvas') {
        commands.push({ type: 'createSubcanvas', path: 'Board/child.canvas', canvas: { nodes: [], edges: [], ready: { schemaVersion: 1, id: 'cv_child' } }, node })
      } else if (node.ready.media) {
        const bytes = Buffer.from(node.id); node.ready.media.sha256 = hashBytes(bytes)
        const path = join(f.root, node.id + '.bin'); writeFileSync(path, bytes)
        commands.push({ type: 'importAttachment', sourceToken: await f.service.prepareAttachment(path), node })
      } else commands.push({ type: 'addNode', node })
    }
    for (const edge of canvas.edges) commands.push({ type: 'addEdge', edge })
    const result = await f.service.write({ ...h, expectedVersion: h.version, operationId: 'all', commands })
    assert.equal(result.state, 'completed', JSON.stringify(result))
    f.service.release(h.handleId)
    const reopened = await f.service.open(h.objectId)
    const raw = JSON.parse(readFileSync(join(f.root, reopened.path), 'utf8'))
    StandardCanvasSchema.parse(raw); ReadyCanvasSchema.parse(raw)
    assert.deepEqual(reopened.canvas.nodes.map(n => n.ready.kind), canvas.nodes.map(n => n.ready.kind))
    assert.deepEqual(reopened.canvas.edges, canvas.edges)
    for (const node of reopened.canvas.nodes) if (node.type === 'file') assert.ok(readFileSync(join(f.root, node.file)).length)
    assert.equal(reopened.canvas.nodes.find(n => n.id === 'trashed')?.ready.trash?.operationId, 'del_1')
  } finally { f.close() }
})
