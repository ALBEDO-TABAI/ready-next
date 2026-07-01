import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getTargetDirFromDropTarget,
  resolveInternalMoveDir,
} from '../renderer/components/layout/fileTreeExternalDrop'
import type { WorkspaceDragPayload } from '../renderer/components/layout/fileTreeDragPayload'

function filePayload(path: string, overrides: Partial<WorkspaceDragPayload> = {}): WorkspaceDragPayload {
  return {
    type: overrides.isDirectory ? 'folder' : 'file',
    path,
    name: path.split('/').pop() || path,
    isDirectory: false,
    movable: true,
    ...overrides,
  }
}

const ROW = { rectTop: 10, rectHeight: 48 }

test('getTargetDirFromDropTarget maps each indicator to the folder the drop lands in', () => {
  assert.equal(
    getTargetDirFromDropTarget({ kind: 'inside-directory', dirPath: '/ws/a', itemPath: '/ws/a', containerPath: '/ws' }),
    '/ws/a',
  )
  assert.equal(
    getTargetDirFromDropTarget({ kind: 'insert-before', anchorPath: '/ws/a/x.md', containerPath: '/ws/a' }),
    '/ws/a',
  )
  assert.equal(
    getTargetDirFromDropTarget({ kind: 'insert-after', anchorPath: '/ws/a/x.md', containerPath: '/ws/a' }),
    '/ws/a',
  )
})

test('internal move over a directory body lands inside that directory', () => {
  const dest = resolveInternalMoveDir(
    [filePayload('/ws/note.md')],
    { itemPath: '/ws/archive', isDirectory: true, containerPath: '/ws', pointerY: 34, ...ROW },
  )
  assert.equal(dest, '/ws/archive')
})

test('internal move near a row edge lands in that row\'s containing folder, not into it', () => {
  const before = resolveInternalMoveDir(
    [filePayload('/ws/note.md')],
    { itemPath: '/ws/sub/photos', isDirectory: true, containerPath: '/ws/sub', pointerY: 12, ...ROW },
  )
  assert.equal(before, '/ws/sub')

  const after = resolveInternalMoveDir(
    [filePayload('/ws/note.md')],
    { itemPath: '/ws/sub/brief.md', isDirectory: false, containerPath: '/ws/sub', pointerY: 57, ...ROW },
  )
  assert.equal(after, '/ws/sub')
})

test('internal move rejects a no-op back into the item\'s own current folder', () => {
  // Dragging /ws/note.md onto a sibling row in the same folder would be a no-op move.
  const dest = resolveInternalMoveDir(
    [filePayload('/ws/note.md')],
    { itemPath: '/ws/other.md', isDirectory: false, containerPath: '/ws', pointerY: 34, ...ROW },
  )
  assert.equal(dest, null)
})

test('internal move rejects dropping a folder into itself or a descendant', () => {
  const intoSelf = resolveInternalMoveDir(
    [filePayload('/ws/docs', { isDirectory: true })],
    { itemPath: '/ws/docs', isDirectory: true, containerPath: '/ws', pointerY: 34, ...ROW },
  )
  assert.equal(intoSelf, null)

  const intoDescendant = resolveInternalMoveDir(
    [filePayload('/ws/docs', { isDirectory: true })],
    { itemPath: '/ws/docs/nested', isDirectory: true, containerPath: '/ws/docs', pointerY: 34, ...ROW },
  )
  assert.equal(intoDescendant, null)
})

test('internal move rejects immovable sources and empty selections', () => {
  assert.equal(
    resolveInternalMoveDir(
      [filePayload('/ws/pinned', { isDirectory: true, movable: false })],
      { itemPath: '/ws/archive', isDirectory: true, containerPath: '/ws', pointerY: 34, ...ROW },
    ),
    null,
  )
  assert.equal(
    resolveInternalMoveDir([], { itemPath: '/ws/archive', isDirectory: true, containerPath: '/ws', pointerY: 34, ...ROW }),
    null,
  )
})
