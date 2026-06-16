import assert from 'node:assert/strict'
import test from 'node:test'

import type { ReadyBoardNode } from '../shared/ready-board'
import {
  buildReadyBoardSelectionTransfer,
  buildReadyBoardWorkspaceDragPayload,
  parseReadyBoardResourceDragPayload,
} from '../renderer/utils/boardTransfer'

const nodes: ReadyBoardNode[] = [
  { id: 'image-1', type: 'image', src: 'assets/photo.png', title: 'Photo', x: 0, y: 0, width: 100, height: 80 },
  { id: 'video-1', type: 'video', src: 'assets/clip.mp4', title: 'Clip', x: 120, y: 0, width: 100, height: 80 },
  { id: 'md-1', type: 'markdown', src: 'assets/note.md', title: 'Note', excerpt: 'Excerpt', x: 240, y: 0, width: 100, height: 80 },
  { id: 'text-1', type: 'text', text: 'hello board', fontSize: 24, color: '#111', x: 0, y: 120, width: 120, height: 60 },
  { id: 'note-1', type: 'note', text: 'sticky note', color: '#111', background: '#fff4b8', x: 0, y: 200, width: 120, height: 80 },
  { id: 'rect-1', type: 'rect', fill: '#fff', stroke: '#111', x: 0, y: 300, width: 120, height: 80 },
  { id: 'arrow-1', type: 'arrow', x2: 120, y2: 80, stroke: '#111', strokeWidth: 2, x: 0, y: 400, width: 120, height: 80 },
  { id: 'path-1', type: 'path', points: [{ x: 0, y: 0 }, { x: 12, y: 12 }], stroke: '#111', strokeWidth: 2, x: 0, y: 500, width: 120, height: 80 },
]

test('board transfer builds file and text resources while skipping unsupported shape nodes', () => {
  const payload = buildReadyBoardSelectionTransfer({
    boardPath: '/workspace/references/board.readyboard',
    boardTitle: 'Reference Board',
    nodes,
    selectedIds: nodes.map((node) => node.id),
  })

  assert.ok(payload)
  assert.equal(payload.resources.length, 5)
  assert.deepEqual(payload.paths, [
    '/workspace/references/assets/photo.png',
    '/workspace/references/assets/clip.mp4',
    '/workspace/references/assets/note.md',
  ])
  assert.match(payload.plainText, /hello board/)
  assert.match(payload.markdown, /!\[Photo\]\(file:\/\/\/workspace\/references\/assets\/photo\.png\)/)
  assert.equal(payload.resources.some((resource) => resource.nodeId === 'rect-1'), false)
  assert.equal(payload.resources.some((resource) => resource.nodeId === 'arrow-1'), false)
  assert.equal(payload.resources.some((resource) => resource.nodeId === 'path-1'), false)
})

test('board transfer exposes non-movable ready drag batch for multiple files', () => {
  const payload = buildReadyBoardSelectionTransfer({
    boardPath: '/workspace/references/board.readyboard',
    boardTitle: 'Reference Board',
    nodes,
    selectedIds: ['image-1', 'video-1'],
  })
  assert.ok(payload)

  const readyDrag = buildReadyBoardWorkspaceDragPayload(payload)
  assert.ok(readyDrag)
  assert.equal(readyDrag.type, 'batch')
  assert.equal(readyDrag.movable, false)
  assert.equal(readyDrag.items.length, 2)
  assert.equal(readyDrag.items[0].movable, false)
  assert.equal(readyDrag.items[0].source, 'readyboard')
})

test('board transfer does not create file drag payload for text-only selections', () => {
  const payload = buildReadyBoardSelectionTransfer({
    boardPath: '/workspace/references/board.readyboard',
    boardTitle: 'Reference Board',
    nodes,
    selectedIds: ['text-1', 'note-1'],
  })
  assert.ok(payload)
  assert.equal(buildReadyBoardWorkspaceDragPayload(payload), null)
})

test('board transfer parser rejects malformed payloads and normalizes valid payloads', () => {
  assert.equal(parseReadyBoardResourceDragPayload('{"type":"file"}'), null)
  const payload = buildReadyBoardSelectionTransfer({
    boardPath: '/workspace/references/board.readyboard',
    boardTitle: 'Reference Board',
    nodes,
    selectedIds: ['image-1'],
  })
  assert.ok(payload)

  const parsed = parseReadyBoardResourceDragPayload(JSON.stringify(payload))
  assert.ok(parsed)
  assert.equal(parsed.resources.length, 1)
  assert.equal(parsed.paths[0], '/workspace/references/assets/photo.png')
})
