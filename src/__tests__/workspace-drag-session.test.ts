import assert from 'node:assert/strict'
import test from 'node:test'

import {
  beginWorkspaceDragSession,
  endWorkspaceDragSession,
  getActiveWorkspaceDragPayloads,
} from '../renderer/components/layout/workspaceDragSession'
import type { WorkspaceDragPayload } from '../renderer/components/layout/fileTreeDragPayload'

function payload(path: string): WorkspaceDragPayload {
  return { type: 'file', path, name: path.split('/').pop() || path, isDirectory: false, movable: true }
}

test('a begun session is readable while dragging and cleared on end', () => {
  endWorkspaceDragSession()
  assert.deepEqual(getActiveWorkspaceDragPayloads(), [])

  beginWorkspaceDragSession([payload('/ws/a.md'), payload('/ws/b.md')])
  // The whole point: readable repeatedly (mirrors many `dragover` ticks) without a
  // DataTransfer, since getData() is empty during dragover.
  assert.deepEqual(getActiveWorkspaceDragPayloads().map((p) => p.path), ['/ws/a.md', '/ws/b.md'])
  assert.deepEqual(getActiveWorkspaceDragPayloads().map((p) => p.path), ['/ws/a.md', '/ws/b.md'])

  endWorkspaceDragSession()
  assert.deepEqual(getActiveWorkspaceDragPayloads(), [])
})

test('reads return isolated copies so callers cannot mutate the live session', () => {
  beginWorkspaceDragSession([payload('/ws/a.md')])
  const first = getActiveWorkspaceDragPayloads()
  first[0].path = '/hacked'
  assert.equal(getActiveWorkspaceDragPayloads()[0].path, '/ws/a.md')
  endWorkspaceDragSession()
})

test('beginning with an empty selection clears any prior session', () => {
  beginWorkspaceDragSession([payload('/ws/a.md')])
  beginWorkspaceDragSession([])
  assert.deepEqual(getActiveWorkspaceDragPayloads(), [])
})
