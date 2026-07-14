import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyGraphWheelGesture,
  buildGraphDocumentPreview,
  type GraphViewport,
} from '../renderer/components/graph/graph-interactions'

test('ordinary two-finger movement pans the graph without changing zoom', () => {
  const initial: GraphViewport = { x: 24, y: -18, zoom: 1.4 }
  const next = applyGraphWheelGesture(initial, {
    deltaX: 32,
    deltaY: -20,
    ctrlKey: false,
    pointerX: 180,
    pointerY: 120,
  })

  assert.deepEqual(next, { x: -8, y: 2, zoom: 1.4 })
})

test('trackpad pinch zoom keeps the graph point under the gesture center stationary', () => {
  const initial: GraphViewport = { x: 40, y: 25, zoom: 1.2 }
  const pointer = { x: 240, y: 160 }
  const graphPointBefore = {
    x: (pointer.x - initial.x) / initial.zoom,
    y: (pointer.y - initial.y) / initial.zoom,
  }

  const next = applyGraphWheelGesture(initial, {
    deltaX: 0,
    deltaY: -12,
    ctrlKey: true,
    pointerX: pointer.x,
    pointerY: pointer.y,
  })

  assert.ok(next.zoom > initial.zoom)
  assert.ok(Math.abs((pointer.x - next.x) / next.zoom - graphPointBefore.x) < 1e-9)
  assert.ok(Math.abs((pointer.y - next.y) / next.zoom - graphPointBefore.y) < 1e-9)
})

test('document preview uses the first heading as title and returns readable body text', () => {
  const preview = buildGraphDocumentPreview(`---\ntags: [reading]\n---\n# 《白痴》第四部第十一章\n\n第四部第十一章是最后一章，讲述婚礼被破坏后的悲剧结局。\n\n- 公爵四处寻找娜斯塔霞。`, 'note.md')

  assert.equal(preview.title, '《白痴》第四部第十一章')
  assert.equal(preview.body, '第四部第十一章是最后一章，讲述婚礼被破坏后的悲剧结局。 公爵四处寻找娜斯塔霞。')
})
