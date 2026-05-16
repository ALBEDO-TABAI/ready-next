import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clampDropMenuPositionToBoundary,
  parseBrowserTabDragPayload,
  resolveFileTreeDropTarget,
} from '../renderer/components/layout/fileTreeExternalDrop'

test('parseBrowserTabDragPayload accepts browser tab drags and rejects other payloads', () => {
  const validPayload = JSON.stringify({
    type: 'browser-tab',
    tabId: 'tab-1',
    title: 'Ready',
    name: 'Ready',
    url: 'https://ready.local',
  })
  const rssPayload = JSON.stringify({
    type: 'rss-item',
    id: 'rss-1',
    name: 'Feed item',
    link: 'https://example.com/rss',
  })

  assert.deepStrictEqual(parseBrowserTabDragPayload(validPayload), {
    type: 'browser-tab',
    tabId: 'tab-1',
    title: 'Ready',
    name: 'Ready',
    url: 'https://ready.local',
  })
  assert.strictEqual(parseBrowserTabDragPayload(rssPayload), null)
  assert.strictEqual(parseBrowserTabDragPayload('not-json'), null)
})

test('resolveFileTreeDropTarget highlights directory bodies as inside drops', () => {
  const target = resolveFileTreeDropTarget({
    itemPath: '/workspace/archive',
    isDirectory: true,
    containerPath: '/workspace',
    pointerY: 38,
    rectTop: 10,
    rectHeight: 48,
  })

  assert.deepStrictEqual(target, {
    kind: 'inside-directory',
    dirPath: '/workspace/archive',
    itemPath: '/workspace/archive',
    containerPath: '/workspace',
  })
})

test('resolveFileTreeDropTarget uses separator targets near row edges', () => {
  const beforeTarget = resolveFileTreeDropTarget({
    itemPath: '/workspace/archive',
    isDirectory: true,
    containerPath: '/workspace',
    pointerY: 12,
    rectTop: 10,
    rectHeight: 48,
  })
  const afterTarget = resolveFileTreeDropTarget({
    itemPath: '/workspace/brief.md',
    isDirectory: false,
    containerPath: '/workspace',
    pointerY: 57,
    rectTop: 10,
    rectHeight: 48,
  })

  assert.deepStrictEqual(beforeTarget, {
    kind: 'insert-before',
    anchorPath: '/workspace/archive',
    containerPath: '/workspace',
  })
  assert.deepStrictEqual(afterTarget, {
    kind: 'insert-after',
    anchorPath: '/workspace/brief.md',
    containerPath: '/workspace',
  })
})

test('clampDropMenuPositionToBoundary keeps floating menus inside the file panel bounds', () => {
  const position = clampDropMenuPositionToBoundary({
    x: 214,
    y: 460,
    menuWidth: 208,
    menuHeight: 192,
    boundaryLeft: 0,
    boundaryTop: 80,
    boundaryRight: 236,
    boundaryBottom: 540,
    viewportWidth: 1200,
    viewportHeight: 900,
    padding: 8,
  })

  assert.deepStrictEqual(position, {
    x: 20,
    y: 340,
  })
})
