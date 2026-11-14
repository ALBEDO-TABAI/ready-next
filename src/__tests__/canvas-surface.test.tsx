import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { CanvasSurface } from '../renderer/components/canvas/surface/CanvasSurface'
import { closeAllFloats, FloatHost } from '../renderer/components/ui'
import type { CanvasSurfaceProps, FrameWork } from '../renderer/components/canvas/surface/types'
import { mixedCanvas } from './fixtures/canvas-surface/mixed'
import { applyCanvasOperations } from '../shared/ready-canvas/operations'

async function mount(count = 12, extra: Partial<CanvasSurfaceProps> = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true,
    // The float host measures its frames; jsdom has no layout observer (the board itself checks for one).
    ResizeObserver: class { observe() {} disconnect() {} } }
  const saved = Object.fromEntries(Object.keys(globals).map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  let seq = 0
  const frames = new Map<number, FrameRequestCallback>()
  dom.window.requestAnimationFrame = cb => { frames.set(++seq, cb); return seq }
  dom.window.cancelAnimationFrame = id => { frames.delete(id) }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('root')!)
  let canvas = mixedCanvas(count), commits = 0
  const work: FrameWork[] = []
  const props: CanvasSurfaceProps = { canvas, onOperations: (ops) => { commits++; canvas = applyCanvasOperations(canvas, ops).canvas }, onFrameWork: value => work.push(value), ...extra }
  // The board's menus are the shared W1 menus, rendered by the app's one float host (as in the app).
  await act(async () => root.render(<><CanvasSurface {...props} /><FloatHost /></>))
  const surface = dom.window.document.querySelector<HTMLElement>('[data-canvas-surface]')!
  const card = (id = 'n0') => surface.querySelector<HTMLElement>(`[data-node-id="${id}"]`)!
  async function pointer(target: Element, type: string, x: number, y: number, more = {}) {
    await act(async () => target.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, ...more })))
  }
  async function flush() { await act(async () => { const batch = [...frames.values()]; frames.clear(); batch.forEach(cb => cb(0)) }) }
  async function key(key: string, more = {}, target: Element = surface) {
    await act(async () => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...more })))
  }
  // Chrome buttons are icons named by their label (W4 MS1); shapes and arrangements sit in the dock's 图形 and the
  // selection bar's 排版 menus, which (like the right-click menu) are shared W1 menus in the float host.
  async function click(label: string) {
    const menuItem = () => [...dom.window.document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find(item => item.querySelector('.rn-menu__label')?.textContent === label)
    const find = () => [...surface.querySelectorAll('button')].find(b => b.textContent === label || b.getAttribute('aria-label') === label) ?? menuItem()
    let button = find()
    const menu = ['矩形', '箭头', '连线'].includes(label) ? '图形' : ['画廊排版', '瀑布排版', '散开排版'].includes(label) ? '排版' : null
    if (!button && menu) {
      const opener = [...surface.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === menu)
      assert.ok(opener, menu); await act(async () => opener.click()); button = find()
    }
    assert.ok(button, label); await act(async () => button.click())
  }
  return { dom, surface, card, pointer, flush, key, click, work, frames, get canvas() { return canvas }, get commits() { return commits },
    async replace(next: typeof canvas) { canvas = next; await act(async () => root.render(<><CanvasSurface {...props} canvas={next} /><FloatHost /></>)) },
    menu: () => dom.window.document.querySelector('[role="menu"]'),
    async close() { await act(async () => { closeAllFloats(); root.unmount() }); dom.window.close(); for (const [key, descriptor] of Object.entries(saved)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) } } }
}

test('selection context menu adds the actual selected nodes, closes after a pick and keeps failed work retryable', async () => {
  const attempts: string[][] = []
  const ui = await mount(3, { onAddToDocument: async ids => {
    attempts.push(ids); if (attempts.length === 1) throw new Error('请重试')
  } })
  const rightClick = () => act(async () => ui.card().dispatchEvent(new ui.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 20 })))
  // jsdom has no layout: give the board a box, so the menu is placed against it (it stays inside the board).
  ui.surface.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 700, width: 1000, height: 700, x: 0, y: 0, toJSON() {} })
  try {
    ui.surface.focus(); await ui.key('a', { ctrlKey: true })
    await rightClick()
    // The menu opens at the pointer in the float host and is named for the selection.
    assert.equal(ui.menu()?.getAttribute('aria-label'), '选区菜单')
    assert.equal(ui.dom.window.document.querySelector<HTMLElement>('[data-float-id="canvas-context-menu"]')?.style.left, '10px')
    await ui.click('添加到文档')
    assert.equal(ui.menu(), null, 'a pick closes the menu')
    assert.match(ui.surface.querySelector('[role="alert"]')?.textContent ?? '', /请重试/)
    await rightClick()
    assert.equal(ui.surface.querySelector('[role="alert"]'), null, 'reopening the menu clears the old failure')
    await ui.click('添加到文档')
    assert.deepEqual(attempts, [['n0', 'n1', 'n2'], ['n0', 'n1', 'n2']])
    assert.equal(ui.menu(), null)
    assert.equal(ui.commits, 0)
  } finally { await ui.close() }
})

test('real surface coalesces drag frames, commits once, restores cancel and supports undo/redo', async () => {
  const ui = await mount()
  try {
    await ui.pointer(ui.card(), 'pointerdown', 10, 10)
    for (let i = 1; i <= 100; i++) await ui.pointer(ui.surface, 'pointermove', 10 + i, 90)
    assert.equal(ui.frames.size, 1); assert.equal(ui.commits, 0)
    await ui.flush(); assert.equal(ui.work.length, 1); assert.notEqual(ui.card().style.translate, '')
    await ui.pointer(ui.surface, 'pointerup', 110, 90)
    assert.equal(ui.commits, 1); assert.equal(ui.canvas.nodes[0].x, 100)
    const committed = structuredClone(ui.canvas)
    await ui.pointer(ui.card(), 'pointerdown', 110, 90)
    await ui.pointer(ui.surface, 'pointermove', 210, 180); await ui.flush()
    await ui.pointer(ui.surface, 'pointercancel', 210, 180)
    assert.equal(ui.commits, 1); assert.equal(ui.card().style.translate, '')
    assert.deepEqual(ui.canvas, committed)
    await ui.key('z', { ctrlKey: true }); assert.equal(ui.canvas.nodes[0].x, 0)
    await ui.key('z', { ctrlKey: true, shiftKey: true }); assert.deepEqual(ui.canvas, committed)
  } finally { await ui.close() }
})
test('real surface groups, lays out, redoes exact R positions, recycles and restores', async () => {
  const ui = await mount()
  try {
    ui.surface.focus(); await ui.key('a', { ctrlKey: true }); await ui.click('分组')
    assert.equal(ui.canvas.nodes.filter(n => n.ready.groupId).length, 12)
    await ui.click('散开排版'); const scattered = structuredClone(ui.canvas)
    await ui.click('撤销'); await ui.click('重做'); assert.deepEqual(ui.canvas, scattered)
    await ui.key('Delete'); assert.equal(ui.canvas.nodes.filter(n => n.ready.trash).length, 12)
    await ui.click('回收站'); await ui.click('全部恢复')
    assert.equal(ui.canvas.nodes.filter(n => n.ready.trash).length, 0)
  } finally { await ui.close() }
})
test('only the editing text card mounts an editor, typing and unfocused shortcuts do not act', async () => {
  const ui = await mount(1000, { renderTextEditor: ({ node }) => <textarea defaultValue={node.type === 'text' ? node.text : ''} /> })
  try {
    await ui.key('a', { ctrlKey: true }); await ui.key('Delete'); assert.equal(ui.commits, 0)
    await act(async () => ui.card().dispatchEvent(new ui.dom.window.MouseEvent('dblclick', { bubbles: true })))
    const editor = ui.surface.querySelector('textarea')!
    assert.ok(editor); assert.equal(ui.surface.querySelectorAll('textarea').length, 1)
    editor.focus(); await ui.key('Delete', {}, editor); await ui.key('p', {}, editor); assert.equal(ui.commits, 0)
    assert.ok(ui.surface.querySelectorAll('[data-node-detail]').length < 100)
  } finally { await ui.close() }
})
test('1000 mixed nodes: measured work stays local and 240 moves produce one submission', async () => {
  let previews = 0
  const ui = await mount(1000, { renderCard: n => { previews++; return <span>{n.id}</span> } })
  try {
    await ui.pointer(ui.card(), 'pointerdown', 10, 10)
    const beforeFrames = previews
    for (let frame = 0; frame < 30; frame++) {
      for (let event = 0; event < 8; event++) await ui.pointer(ui.surface, 'pointermove', 30 + frame, 70 + frame)
      await ui.flush()
    }
    assert.equal(ui.commits, 0); assert.equal(previews, beforeFrames, 'drag frames never render the React cards')
    await ui.pointer(ui.surface, 'pointerup', 60, 100)
    assert.equal(ui.commits, 1)
    assert.ok(ui.work.every(w => w.candidates < 100 && w.domWrites < 20))
    console.log('CANVAS_1000', JSON.stringify({ nodes: 1000, moves: 240, commits: ui.commits, frames: ui.work.length, maxCandidates: Math.max(...ui.work.map(w => w.candidates)), maxVisited: Math.max(...ui.work.map(w => w.visited)), maxDomWrites: Math.max(...ui.work.map(w => w.domWrites)) }))
  } finally { await ui.close() }
})

test('marquee, pan, wheel and resize coalesce; cancelled marquee and pan restore the start', async () => {
  const ui = await mount()
  try {
    await ui.pointer(ui.surface, 'pointerdown', 30, 70)
    for (let i = 0; i < 20; i++) await ui.pointer(ui.surface, 'pointermove', 505, 245)
    assert.equal(ui.frames.size, 1); await ui.flush()
    assert.equal(ui.surface.querySelectorAll('.canvas-card[data-selected="true"]').length, 2)
    assert.equal(ui.surface.querySelectorAll('[data-edge-id][data-selected]').length, 1, 'the connector the marquee crosses is picked with the cards')
    await ui.pointer(ui.surface, 'pointercancel', 505, 245)
    assert.equal(ui.surface.querySelectorAll('[data-selected="true"]').length, 0)
    await ui.pointer(ui.surface, 'pointerdown', 30, 70)
    await ui.pointer(ui.surface, 'pointerup', 505, 245)
    assert.equal(ui.surface.querySelectorAll('.canvas-card[data-selected="true"]').length, 2)
    const handle = ui.card().querySelector('[data-resize]')!
    await ui.pointer(handle, 'pointerdown', 240, 240)
    for (let i = 0; i < 10; i++) await ui.pointer(ui.surface, 'pointermove', 280, 270)
    await ui.flush(); assert.equal(ui.card().style.width, '240px'); assert.equal(ui.commits, 0)
    await ui.pointer(ui.surface, 'pointercancel', 280, 270); assert.equal(ui.card().style.width, '200px')
    await ui.pointer(handle, 'pointerdown', 240, 240); await ui.pointer(ui.surface, 'pointerup', 280, 270)
    assert.equal(ui.canvas.nodes[0].width, 240); assert.equal(ui.commits, 1)
    const world = ui.surface.querySelector<HTMLElement>('.canvas-world')!, start = world.style.transform
    await ui.click('平移'); await ui.pointer(ui.surface, 'pointerdown', 700, 400)
    await ui.pointer(ui.surface, 'pointermove', 800, 500); await ui.flush(); assert.notEqual(world.style.transform, start)
    await ui.pointer(ui.surface, 'pointercancel', 800, 500); assert.equal(world.style.transform, start)
    for (let i = 0; i < 30; i++) await act(async () => ui.surface.dispatchEvent(new ui.dom.window.WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 400, clientY: 300, deltaY: -10, ctrlKey: true })))
    assert.equal(ui.frames.size, 1); await ui.flush()
    assert.notEqual(ui.surface.querySelector('output')?.textContent, '100%'); assert.equal(ui.commits, 1)
  } finally { await ui.close() }
})

test('whiteboard tools prepare graphics, preserve negative arrows, create standard edges and layers', async () => {
  const drafts: import('../renderer/components/canvas/surface/types').GraphicDraft[] = []
  const ui = await mount(12, { prepareGraphic: async draft => { drafts.push(draft); return `Lab.assets/${draft.id}.svg` } })
  try {
    for (const label of ['矩形', '箭头', '手绘']) {
      await ui.click(label)
      await ui.pointer(ui.surface, 'pointerdown', 800, 600)
      for (let i = 0; i < 5; i++) await ui.pointer(ui.surface, 'pointermove', 700 - i, 500 - i)
      assert.equal(ui.frames.size, 1); await ui.flush()
      await ui.pointer(ui.surface, 'pointerup', 690, 490)
    }
    assert.equal(ui.commits, 3); assert.equal(drafts.length, 3)
    assert.equal(ui.canvas.nodes.filter(n => n.ready.kind === 'graphic').length, 4)
    assert.deepEqual(drafts[1].graphic, { type: 'arrow', stroke: '#ff5a1f', strokeWidth: 2, x2: -110, y2: -110 })
    assert.ok(drafts[2].graphic.type === 'path' && drafts[2].graphic.points.length >= 2)
    await ui.click('连线'); await ui.pointer(ui.card(), 'pointerdown', 100, 120); await ui.pointer(ui.surface, 'pointerup', 350, 150)
    assert.equal(ui.canvas.edges.length, 2); assert.equal(ui.canvas.edges[1].fromNode, 'n0'); assert.equal(ui.canvas.edges[1].toNode, 'n1')
    await ui.click('选择'); await ui.pointer(ui.card(), 'pointerdown', 100, 120); await ui.pointer(ui.surface, 'pointerup', 100, 120)
    await ui.click('置顶'); assert.equal(ui.canvas.nodes.at(-1)?.id, 'n0')
    await ui.click('置底'); assert.equal(ui.canvas.nodes[0].id, 'n0')
  } finally { await ui.close() }
})

test('a connector is picked by click, ⇧-click and right-click; Delete removes it and undo brings it back', async () => {
  const ui = await mount(3)
  const pressed = (label: string) => [...ui.surface.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === label)
  ui.surface.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 700, width: 1000, height: 700, x: 0, y: 0, toJSON() {} })
  try {
    const hit = () => ui.surface.querySelector('[data-edge-id="edge0"] .canvas-edge-hit')!
    const picked = () => [...ui.surface.querySelectorAll('[data-edge-id][data-selected], .canvas-card[data-selected="true"]')].map(el => el.getAttribute('data-edge-id') ?? el.getAttribute('data-node-id'))
    await ui.pointer(hit(), 'pointerdown', 270, 160); await ui.pointer(ui.surface, 'pointerup', 270, 160)
    assert.deepEqual(picked(), ['edge0']); assert.equal(ui.commits, 0)
    assert.ok(pressed('删除连线'), 'a picked connector shows its own bar')
    // ⇧-click adds a card to the connector, and takes the connector out again.
    await ui.pointer(ui.card('n2'), 'pointerdown', 600, 100, { shiftKey: true }); await ui.pointer(ui.surface, 'pointerup', 600, 100, { shiftKey: true })
    assert.deepEqual(picked().sort(), ['edge0', 'n2'])
    await ui.pointer(hit(), 'pointerdown', 270, 160, { shiftKey: true }); await ui.pointer(ui.surface, 'pointerup', 270, 160, { shiftKey: true })
    assert.deepEqual(picked(), ['n2'])
    // Right-click the connector: it becomes the selection and its menu deletes it.
    await act(async () => hit().dispatchEvent(new ui.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 270, clientY: 160 })))
    assert.equal(ui.menu()?.getAttribute('aria-label'), '连线菜单'); assert.deepEqual(picked(), ['edge0'])
    await ui.click('删除连线')
    assert.equal(ui.canvas.edges.length, 0); assert.equal(ui.commits, 1); assert.equal(ui.canvas.nodes.filter(n => n.ready.trash).length, 0)
    await ui.click('撤销'); assert.deepEqual(ui.canvas.edges.map(e => e.id), ['edge0'])
    await ui.key('z', { ctrlKey: true, shiftKey: true }); assert.equal(ui.canvas.edges.length, 0)
    await ui.key('z', { ctrlKey: true }); assert.equal(ui.canvas.edges.length, 1)
    // Delete on the keyboard; a connector between two cards binned together stays in the file and returns with them.
    await ui.pointer(hit(), 'pointerdown', 270, 160); await ui.pointer(ui.surface, 'pointerup', 270, 160)
    await ui.key('Delete'); assert.equal(ui.canvas.edges.length, 0)
    await ui.key('z', { ctrlKey: true })
    ui.surface.focus(); await ui.key('a', { ctrlKey: true }); await ui.key('Backspace')
    assert.equal(ui.canvas.nodes.filter(n => n.ready.trash).length, 3); assert.equal(ui.canvas.edges.length, 1)
    assert.equal(ui.surface.querySelector('[data-edge-id]'), null, 'hidden with its cards')
    await ui.click('回收站'); await ui.click('全部恢复'); await ui.click('回收站')
    assert.ok(ui.surface.querySelector('[data-edge-id="edge0"]'))
  } finally { await ui.close() }
})

test('one connector or shape, then the select tool with it picked; each is one undo step and earlier steps survive', async () => {
  const ui = await mount(3, { prepareGraphic: async draft => `Lab.assets/${draft.id}.svg` })
  const tool = (label: string) => [...ui.surface.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === label)?.getAttribute('aria-pressed')
  try {
    await ui.click('连线'); await ui.pointer(ui.card('n1'), 'pointerdown', 350, 150); await ui.pointer(ui.surface, 'pointerup', 620, 150)
    assert.equal(ui.canvas.edges.length, 2); assert.equal(tool('选择'), 'true')
    const drawn = ui.canvas.edges[1].id
    assert.ok(ui.surface.querySelector(`[data-edge-id="${drawn}"][data-selected]`), 'the new connector is picked')
    await ui.click('矩形'); await ui.pointer(ui.surface, 'pointerdown', 600, 400); await ui.pointer(ui.surface, 'pointermove', 700, 500); await ui.flush(); await ui.pointer(ui.surface, 'pointerup', 800, 600)
    assert.equal(ui.canvas.nodes.length, 4); assert.equal(tool('选择'), 'true')
    assert.equal(ui.surface.querySelector('.canvas-card[data-selected="true"]')?.getAttribute('data-kind'), 'graphic')
    // Freehand keeps the pen: strokes come in runs.
    await ui.click('手绘')
    for (const y of [300, 340]) { await ui.pointer(ui.surface, 'pointerdown', 500, y); await ui.pointer(ui.surface, 'pointermove', 560, y + 20); await ui.flush(); await ui.pointer(ui.surface, 'pointerup', 600, y) }
    assert.equal(ui.canvas.nodes.length, 6); assert.equal(tool('手绘'), 'true')
    // Undo walks back through every step: two strokes, the rectangle, then the connector drawn before them.
    for (const expected of [5, 4, 3]) { await ui.click('撤销'); assert.equal(ui.canvas.nodes.length, expected) }
    assert.equal(ui.canvas.edges.length, 2)
    await ui.click('撤销'); assert.equal(ui.canvas.edges.length, 1)
    await ui.click('重做'); assert.deepEqual(ui.canvas.edges.map(e => e.id), ['edge0', drawn])
  } finally { await ui.close() }
})

test('failed batches and failed graphic preparation leave board and undo history unchanged', async () => {
  let attempts = 0
  const ui = await mount(12, { onOperations: async () => { attempts++; throw new Error('接收失败') }, prepareGraphic: async () => { throw new Error('附件准备失败') } })
  try {
    await ui.pointer(ui.card(), 'pointerdown', 10, 10); await ui.pointer(ui.surface, 'pointerup', 100, 100)
    assert.equal(attempts, 1); assert.equal(ui.card().style.left, '0px'); assert.match(ui.surface.textContent || '', /接收失败/)
    const undo = [...ui.surface.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '撤销')!
    assert.equal(undo.disabled, true)
    await ui.click('矩形'); await ui.pointer(ui.surface, 'pointerdown', 600, 400); await ui.pointer(ui.surface, 'pointerup', 800, 600)
    assert.match(ui.surface.textContent || '', /附件准备失败/); assert.equal(attempts, 1); assert.equal(ui.canvas.nodes.length, 12)
  } finally { await ui.close() }
})

test('subcanvas navigation and ancestor actions are explicit caller callbacks', async () => {
  const opened: string[] = []
  const ui = await mount(12, { onNavigateSubcanvas: n => opened.push(n.id), breadcrumbs: [{ id: 'parent', title: '父画板' }], onNavigateAncestor: id => opened.push(id) })
  try {
    await act(async () => ui.card('n6').dispatchEvent(new ui.dom.window.MouseEvent('dblclick', { bubbles: true })))
    await ui.click('父画板'); assert.deepEqual(opened, ['n6', 'parent']); assert.equal(ui.commits, 0)
  } finally { await ui.close() }
})

test('authoritative replacement cancels dragging and pending graphics cannot leak to another board', async () => {
  let finish!: (path: string) => void
  const ui = await mount(12, { prepareGraphic: () => new Promise(resolve => { finish = resolve }) })
  try {
    await ui.pointer(ui.card(), 'pointerdown', 10, 10); await ui.pointer(ui.surface, 'pointermove', 110, 110); await ui.flush()
    const external = mixedCanvas(); external.nodes[0].x = 777
    await ui.replace(external); await ui.pointer(ui.surface, 'pointerup', 110, 110)
    assert.equal(ui.commits, 0); assert.equal(ui.card().style.translate, ''); assert.equal(ui.card().style.left, '777px')
    await ui.click('矩形'); await ui.pointer(ui.surface, 'pointerdown', 600, 400); await ui.pointer(ui.surface, 'pointerup', 800, 600)
    const other = mixedCanvas(); other.ready.id = 'other'
    await ui.replace(other); await act(async () => finish('Lab.assets/prepared.svg'))
    assert.equal(ui.commits, 0); assert.equal(ui.canvas.ready.id, 'other'); assert.equal(ui.canvas.nodes.length, 12)
  } finally { await ui.close() }
})

test('cancelling replacement marquee restores the previous selection; grouped drag moves members together', async () => {
  const ui = await mount()
  try {
    await ui.pointer(ui.card(), 'pointerdown', 100, 120); await ui.pointer(ui.surface, 'pointerup', 100, 120)
    await ui.pointer(ui.surface, 'pointerdown', 600, 400); await ui.pointer(ui.surface, 'pointermove', 800, 600); await ui.flush()
    await ui.pointer(ui.surface, 'pointercancel', 800, 600)
    assert.equal(ui.card().dataset.selected, 'true')
    await ui.pointer(ui.card('n1'), 'pointerdown', 350, 120, { shiftKey: true }); await ui.pointer(ui.surface, 'pointerup', 350, 120)
    await ui.click('分组')
    const group = ui.canvas.nodes.find(n => n.type === 'group')!
    await ui.pointer(ui.card(group.id), 'pointerdown', 20, 60); await ui.pointer(ui.surface, 'pointerup', 120, 160)
    assert.equal(ui.canvas.nodes.find(n => n.id === 'n0')?.x, 100)
    assert.equal(ui.canvas.nodes.find(n => n.id === 'n1')?.x, 360)
    assert.equal(ui.canvas.nodes.find(n => n.id === group.id)?.x, 76)
    await ui.click('解组'); assert.equal(ui.canvas.nodes.some(n => n.id === group.id), false)
    assert.equal(ui.canvas.nodes.some(n => n.ready.groupId === group.id), false)
    await ui.click('撤销'); assert.ok(ui.canvas.nodes.some(n => n.id === group.id))
  } finally { await ui.close() }
})

test('rotated-card dragging still submits integer coordinates at a zoomed scale', async () => {
  const ui = await mount(12, { initialCamera: { x: 40, y: 80, zoom: 2 } })
  try {
    const canvas = mixedCanvas(); canvas.nodes[0].ready.appearance = { rotation: 30 }
    await ui.replace(canvas)
    await ui.pointer(ui.card(), 'pointerdown', 100, 120)
    await ui.pointer(ui.surface, 'pointerup', 300, 320)
    assert.equal(ui.commits, 1)
    assert.equal(ui.canvas.nodes[0].x, 100); assert.equal(ui.canvas.nodes[0].y, 100)
    assert.equal(ui.canvas.nodes[0].ready.appearance?.rotation, 30)
  } finally { await ui.close() }
})

test('a canvas node navigation request selects and centers the requested node', async () => {
  const ui = await mount(3, { revealNode: { nodeId: 'n1', requestId: 'navigation-1' } })
  try {
    assert.equal(ui.card('n1').dataset.selected, 'true')
    const node = ui.canvas.nodes.find(node => node.id === 'n1')!
    const world = ui.surface.querySelector<HTMLElement>('.canvas-world')!
    assert.equal(world.style.transform, `translate(${1000 / 2 - node.x - node.width / 2}px, ${700 / 2 - node.y - node.height / 2}px) scale(1)`)
    assert.equal(ui.commits, 0, 'navigation does not change the file')
  } finally { await ui.close() }
})

test('M6-D event drop commits one reference card; context schedule selects the actual card', async () => {
  const { writeEventTransfer } = await import('../renderer/modules/calendar/linkage/transfer')
  const scheduled: string[] = []
  const ui = await mount(3, { onScheduleNode: node => { scheduled.push(node.id) } })
  try {
    const values = new Map<string, string>()
    writeEventTransfer({ setData: (key, value) => { values.set(key, value) } }, { kind: 'event', id: 'series', occurrence: '2026-11-01' }, '全天日程', true)
    assert.deepEqual(JSON.parse(values.get('application/x-ready-ref')!), { kind: 'event', id: 'series', occurrence: '2026-11-01' })
    assert.equal(values.has('application/x-ready-drag'), false)
    const drop = new ui.dom.window.MouseEvent('drop', { bubbles: true, cancelable: true, clientX: 400, clientY: 300 })
    Object.defineProperty(drop, 'dataTransfer', { value: { getData: (key: string) => values.get(key) || '', types: [...values.keys()] } })
    await act(async () => ui.surface.dispatchEvent(drop))
    assert.equal(ui.commits, 1)
    assert.deepEqual(ui.canvas.nodes.at(-1)?.ready.ref, { kind: 'event', id: 'series', occurrence: '2026-11-01' })
    await act(async () => ui.card('n0').dispatchEvent(new ui.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 20 })))
    await ui.click('安排日程…'); assert.deepEqual(scheduled, ['n0'])
    await ui.click('撤销'); assert.equal(ui.canvas.nodes.length, 3)
  } finally { await ui.close() }
})
