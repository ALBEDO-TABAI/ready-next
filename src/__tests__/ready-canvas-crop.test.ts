import assert from 'node:assert/strict'
import test from 'node:test'
import { cropOperations, cropRatio, dragCrop, MIN_CROP, pictureRect, sessionCrop, startCrop, wholePicture } from '../renderer/modules/canvas/interaction/crop'
import { applyCanvasInverse, applyCanvasOperations } from '../shared/ready-canvas/operations'
import type { CanvasNode, ReadyCanvas } from '../shared/ready-canvas/schema'

const natural = { width: 800, height: 600 }
const picture = (ready: object = {}, frame: Partial<CanvasNode> = {}): Extract<CanvasNode, { type: 'file' }> => ({ id: 'pic', type: 'file', file: 'X.assets/pic.png', x: 100, y: 50, width: 400, height: 300, ...frame, ready: { kind: 'image', ...ready } } as Extract<CanvasNode, { type: 'file' }>)
const board = (node: CanvasNode): ReadyCanvas => ({ ready: { schemaVersion: 1, id: 'board', title: 'X' }, edges: [], nodes: [node] })
const close = (actual: number, expected: number, message?: string) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message ?? ''} ${actual} ≠ ${expected}`)

test('the picture is laid out as its card shows it: covering, moved by a position crop, scaled to a rectangle crop', () => {
  // No crop: a 4:3 picture covers a square card from its middle.
  assert.deepEqual(pictureRect({ width: 300, height: 300 }, natural), { x: -50, y: 0, width: 400, height: 300 })
  // Stillroom's position crop slides it: 0% keeps the left edge, 100% the right.
  assert.equal(pictureRect({ width: 300, height: 300 }, natural, { mode: 'position', x: 0, y: 50 }).x, 0)
  assert.equal(pictureRect({ width: 300, height: 300 }, natural, { mode: 'position', x: 100, y: 50 }).x, -100)
  // A rectangle crop on a card of the same shape: exactly that part fills the card.
  const crop = { mode: 'rect' as const, x: .25, y: .5, w: .5, h: .5 }
  assert.deepEqual(pictureRect({ width: 400, height: 300 }, natural, crop), { x: -200, y: -300, width: 800, height: 600 })
  // A card of another shape: the part covers it from the middle, at one scale on both axes (never stretched).
  const wide = pictureRect({ width: 800, height: 300 }, natural, crop)
  close(wide.width / wide.height, 800 / 600, 'the picture keeps its own shape')
  assert.deepEqual(wide, { x: -400, y: -750, width: 1600, height: 1200 })
  close(cropRatio(crop, natural), 4 / 3); close(cropRatio(undefined, natural), 4 / 3); close(cropRatio({ mode: 'rect', x: 0, y: 0, w: .5, h: 1 }, natural), 2 / 3)
})

test('grips move the frame inside the picture and no smaller than the minimum; a drag inside slides the picture under the frame', () => {
  const start = startCrop(picture(), natural)
  assert.deepEqual(start, { image: { x: 0, y: 0, width: 400, height: 300 }, frame: { x: 0, y: 0, width: 400, height: 300 } })
  assert.deepEqual(dragCrop(start, 'se', -100, -60).frame, { x: 0, y: 0, width: 300, height: 240 })
  assert.deepEqual(dragCrop(start, 'nw', 40, 30).frame, { x: 40, y: 30, width: 360, height: 270 })
  assert.deepEqual(dragCrop(start, 'r', -150, 999).frame, { x: 0, y: 0, width: 250, height: 300 }, 'an edge grip moves one side only')
  assert.deepEqual(dragCrop(start, 'se', 500, 500).frame, start.frame, 'the frame cannot leave the picture')
  assert.deepEqual(dragCrop(start, 'l', 9999, 0).frame, { x: 400 - MIN_CROP, y: 0, width: MIN_CROP, height: 300 })
  assert.deepEqual(dragCrop(start, 'b', 0, -9999).frame.height, MIN_CROP)
  // Sliding: only as far as the frame stays covered.
  const smaller = dragCrop(start, 'se', -100, -100)
  assert.deepEqual(dragCrop(smaller, 'image', 60, 40).image, { x: 0, y: 0, width: 400, height: 300 }, 'no gap on the left or top')
  assert.deepEqual(dragCrop(smaller, 'image', -60, -40).image, { x: -60, y: -40, width: 400, height: 300 })
  assert.deepEqual(dragCrop(smaller, 'image', -999, -999).image, { x: -100, y: -100, width: 400, height: 300 })
  assert.equal(dragCrop(smaller, 'image', -60, -40).frame, smaller.frame)
})

test('applying a crop is one undoable step: the card takes the frame and the crop\'s aspect ratio, the file is not named', () => {
  const node = picture({ media: { mime: 'image/png', sha256: 'a'.repeat(64) }, appearance: { radius: 8 } }), start = startCrop(node, natural)
  const session = dragCrop(dragCrop(start, 'nw', 100, 30), 'se', -100, -120)
  const operations = cropOperations(node, start, session)
  assert.deepEqual(operations, [
    { type: 'appearance', id: 'pic', appearance: { radius: 8, crop: { mode: 'rect', x: .25, y: .1, w: .5, h: .5 } } },
    { type: 'geometry', id: 'pic', geometry: { x: 200, y: 80, width: 200, height: 150 } },
  ])
  const before = board(node), { canvas, inverse } = applyCanvasOperations(before, operations), after = canvas.nodes[0] as typeof node
  close(after.width / after.height, cropRatio(after.ready.appearance!.crop, natural), 'the card has the crop\'s aspect ratio')
  assert.equal(after.file, node.file); assert.deepEqual(after.ready.media, node.ready.media)
  // The cropped card shows exactly the kept part; a later proportional resize keeps showing exactly it.
  assert.deepEqual(pictureRect(after, natural, after.ready.appearance!.crop), { x: -100, y: -30, width: 400, height: 300 })
  assert.deepEqual(pictureRect({ width: 400, height: 300 }, natural, after.ready.appearance!.crop), { x: -200, y: -60, width: 800, height: 600 })
  assert.deepEqual(applyCanvasInverse(canvas, inverse), before, 'one undo restores the card and its appearance')
  // Cropping again starts from what the card shows, and can widen back out to the whole picture.
  const again = startCrop(after, natural)
  assert.deepEqual(again, { image: { x: -100, y: -30, width: 400, height: 300 }, frame: { x: 0, y: 0, width: 200, height: 150 } })
  const whole = wholePicture(again)
  assert.equal(sessionCrop(whole), undefined)
  assert.deepEqual(cropOperations(after, again, whole), [
    { type: 'appearance', id: 'pic', appearance: { radius: 8 } },
    { type: 'geometry', id: 'pic', geometry: { x: 100, y: 50, width: 400, height: 300 } },
  ], '还原 gives the whole picture back where it was, at the same scale')
})

test('an untouched frame changes nothing; the last appearance field leaving clears it; a rotated card keeps the frame in place', () => {
  const plain = picture(), start = startCrop(plain, natural)
  assert.deepEqual(cropOperations(plain, start, start), [])
  assert.deepEqual(cropOperations(plain, start, dragCrop(dragCrop(start, 'r', -80, 0), 'r', 80, 0)), [], 'dragged out and back')
  // A Stillroom position crop left alone stays a position crop.
  const positioned = picture({ appearance: { crop: { mode: 'position', x: 0, y: 50 } } }, { width: 300, height: 300 }), slid = startCrop(positioned, natural)
  assert.deepEqual(cropOperations(positioned, slid, slid), [])
  // Only a crop on the card, widened to the whole picture: no empty appearance is left behind.
  const cropped = picture({ appearance: { crop: { mode: 'rect', x: 0, y: 0, w: .5, h: 1 } } }, { width: 200, height: 300 }), session = startCrop(cropped, natural)
  assert.deepEqual(cropOperations(cropped, session, wholePicture(session))[0], { type: 'appearance', id: 'pic', appearance: null })
  // Turned a quarter: the card's own x axis points down the board, so a frame 100 left of the middle sits 100 up.
  const turned = picture({ appearance: { rotation: 90 } }), turnedStart = startCrop(turned, natural)
  const [, geometry] = cropOperations(turned, turnedStart, dragCrop(turnedStart, 'r', -200, 0))
  assert.deepEqual(geometry, { type: 'geometry', id: 'pic', geometry: { x: 200, y: -50, width: 200, height: 300 } })
})
