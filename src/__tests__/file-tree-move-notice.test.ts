import assert from 'node:assert/strict'
import test from 'node:test'

import { buildMoveBlockedNotice } from '../renderer/components/layout/fileTreeMoveNotice'

test('a successful move (no collisions, no failures) surfaces nothing', () => {
  assert.equal(buildMoveBlockedNotice({ dirName: 'pin', collided: [], failed: [] }), null)
})

test('a single name collision names the folder and the file', () => {
  assert.equal(
    buildMoveBlockedNotice({ dirName: 'pin', collided: ['画板.readyboard'], failed: [] }),
    '「pin」中已存在同名文件「画板.readyboard」，未移动',
  )
})

test('multiple collisions are summarized with a count', () => {
  assert.equal(
    buildMoveBlockedNotice({ dirName: 'pin', collided: ['a.jpg', 'b.jpg'], failed: [] }),
    '「pin」中已存在 2 个同名文件，未移动',
  )
})

test('collisions take priority over other failures in the message', () => {
  assert.equal(
    buildMoveBlockedNotice({ dirName: 'pin', collided: ['a.jpg'], failed: ['c.jpg'] }),
    '「pin」中已存在同名文件「a.jpg」，未移动',
  )
})

test('a non-collision failure is surfaced instead of failing silently', () => {
  assert.equal(buildMoveBlockedNotice({ dirName: 'pin', collided: [], failed: ['c.jpg'] }), '移动「c.jpg」失败')
  assert.equal(buildMoveBlockedNotice({ dirName: 'pin', collided: [], failed: ['c.jpg', 'd.jpg'] }), '移动 2 个文件失败')
})
