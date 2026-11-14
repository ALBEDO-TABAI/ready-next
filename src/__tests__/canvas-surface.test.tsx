import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { CanvasSurface } from '../renderer/components/canvas/surface/CanvasSurface'
import { closeAllFloats, FloatHost } from '../renderer/components/ui'
import type { CanvasSurfaceProps, FrameWork } from '../renderer/components/canvas/surface/types'
import { mixedCanvas } from './fixtures/canvas-surface/mixed'
import { applyCanvasOperations } from '../shared/ready-canvas/operations'
import type { CanvasNode, ReadyCanvas } from '../shared/ready-canvas/schema'

async function mount(count = 12, extra: Partial<CanvasSurfaceProps> = {}, setup: { canvas?: ReadyCanvas; storage?: Record<string, string> } = {}) {
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
  // This machine's board preferences and cameras live in the window's localStorage (M4 §9.1).
  for (const [key, value] of Object.entries(setup.storage ?? {})) dom.window.localStorage.setItem(key, value)
  let canvas = setup.canvas ?? mixedCanvas(count), commits = 0
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
    const menu = ['矩形', '箭头', '连线'].includes(label) ? '图形' : ['画廊排版', '瀑布排版', '散开排版'].includes(label) ? '排版' : ['置顶', '上移一层', '下移一层', '置底'].includes(label) ? '层级' : null
    if (!button && menu) {
      const opener = [...surface.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === menu)
      assert.ok(opener, menu); await act(async () => opener.click()); button = find()
    }
    assert.ok(button, label); await act(async () => button.click())
  }
  return { dom, surface, card, pointer, flush, key, click, work, frames, root, get canvas() { return canvas }, get commits() { return commits },
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
    // One picked card carries the grips (a multi-selection has the hull's instead); a corner arc scales in proportion.
    await ui.pointer(ui.card(), 'pointerdown', 100, 120); await ui.pointer(ui.surface, 'pointerup', 100, 120)
    const handle = ui.card().querySelector('[data-resize="se"]')!
    await ui.pointer(handle, 'pointerdown', 240, 240)
    for (let i = 0; i < 10; i++) await ui.pointer(ui.surface, 'pointermove', 280, 270)
    await ui.flush(); assert.equal(ui.card().style.width, '240px'); assert.equal(ui.commits, 0)
    await ui.pointer(ui.surface, 'pointercancel', 280, 270); assert.equal(ui.card().style.width, '200px')
    await ui.pointer(handle, 'pointerdown', 240, 240); await ui.pointer(ui.surface, 'pointerup', 280, 270)
    assert.equal(ui.canvas.nodes[0].width, 240); assert.equal(ui.canvas.nodes[0].height, 192); assert.equal(ui.commits, 1)
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

const card = (id: string, x: number, y: number, width: number, height: number): CanvasNode => ({ id, type: 'text', text: id, x, y, width, height, ready: { kind: 'text' } })
const board = (nodes: CanvasNode[]): ReadyCanvas => ({ nodes, edges: [], ready: { id: 'align', schemaVersion: 1 } })
// The camera starts at (40, 80): a world point sits at that offset on screen.
const at = (x: number, y: number) => [x + 40, y + 80] as const

test('a card dropped beside a neighbour docks one gap away and scales to it, as one undoable step; ⇧ and 磁吸 off move it plainly', async () => {
  const start = board([card('a', 0, 0, 200, 200), card('b', 400, 300, 300, 100)])
  const ui = await mount(0, {}, { canvas: start })
  const drag = async (to: readonly [number, number], more = {}) => {
    const b = ui.canvas.nodes[1]
    // ⇧ is held once the drag is under way (a ⇧-press on a card adds or removes it from the selection).
    await ui.pointer(ui.card('b'), 'pointerdown', ...at(b.x + 10, b.y + 10))
    await ui.pointer(ui.surface, 'pointermove', ...at(to[0] + 10, to[1] + 10), more); await ui.flush()
  }
  try {
    // 8px short of "one gap to the right of a", overlapping it vertically: the dock mark shows, nothing is saved yet.
    await drag([220, 50])
    assert.ok(ui.surface.querySelector('.canvas-overlay .canvas-dock-mark')); assert.equal(ui.surface.getAttribute('data-gesture'), 'move'); assert.equal(ui.commits, 0)
    await ui.pointer(ui.surface, 'pointerup', ...at(230, 60))
    const b = ui.canvas.nodes[1]
    assert.deepEqual([b.x, b.y, b.width, b.height], [212, 0, 600, 200]); assert.equal(b.ready.appearance?.fontScale, 1.0833)
    assert.equal(ui.commits, 1); assert.equal(ui.surface.getAttribute('data-gesture'), null)
    assert.equal(ui.card('b').style.getPropertyValue('--canvas-font'), '25.9992px', 'the words scale with the card')
    await ui.key('z', { ctrlKey: true }); assert.deepEqual(ui.canvas, start)
    // ⇧ held: no snapping, no docking.
    await drag([220, 50], { shiftKey: true })
    assert.equal(ui.surface.querySelector('.canvas-overlay .canvas-dock-mark'), null)
    await ui.pointer(ui.surface, 'pointerup', ...at(230, 60), { shiftKey: true })
    assert.deepEqual([ui.canvas.nodes[1].x, ui.canvas.nodes[1].y, ui.canvas.nodes[1].width], [220, 50, 300])
    await ui.key('z', { ctrlKey: true })
    // 自适应缩放 off in 视图设置: the card snaps one gap away at its own size.
    await ui.click('视图设置')
    const toggle = (label: string) => act(async () => ui.dom.window.document.querySelector<HTMLElement>(`[role="switch"][aria-label="${label}"]`)!.click())
    await toggle('自适应缩放')
    await drag([220, 50]); await ui.pointer(ui.surface, 'pointerup', ...at(230, 60))
    assert.deepEqual([ui.canvas.nodes[1].x, ui.canvas.nodes[1].y, ui.canvas.nodes[1].width, ui.canvas.nodes[1].height], [212, 50, 300, 100])
    await ui.key('z', { ctrlKey: true })
    // 磁吸 off: it stays exactly where it was dropped.
    await ui.click('视图设置'); await toggle('磁吸')
    await drag([220, 50]); await ui.pointer(ui.surface, 'pointerup', ...at(230, 60))
    assert.deepEqual([ui.canvas.nodes[1].x, ui.canvas.nodes[1].y], [220, 50])
    // The preferences are this machine's: in localStorage, never in the board.
    assert.deepEqual(JSON.parse(ui.dom.window.localStorage.getItem('ready-next.canvas.view')!), { smartGuides: true, magneticSnap: false, gap: 12, adaptiveScale: false, roundedMedia: true })
    assert.ok(!JSON.stringify(ui.canvas).includes('magneticSnap'))
  } finally { await ui.close() }
})

test('a multi-selection has one hull whose arcs scale it in proportion; a hovered card shows its grips and its cluster', async () => {
  const start = board([card('a', 0, 0, 200, 100), card('b', 212, 0, 100, 100), card('far', 600, 400, 100, 100)])
  const ui = await mount(0, {}, { canvas: start })
  try {
    // Hover: grips on that card, and the outline of the cluster it sits in (a and b are one gap apart).
    assert.equal(ui.surface.querySelector('.canvas-clusters path[data-on]'), null); assert.equal(ui.surface.querySelector('[data-resize]'), null)
    await ui.pointer(ui.card('a'), 'pointermove', ...at(50, 50))
    assert.ok(ui.surface.querySelector('.canvas-clusters path[data-on]')); assert.equal(ui.card('a').querySelectorAll('[data-resize]').length, 8)
    await ui.pointer(ui.card('far'), 'pointermove', ...at(650, 450))
    assert.equal(ui.surface.querySelector('.canvas-clusters path[data-on]'), null, 'a lone card has no cluster')
    // Pick a and b (⌘-click adds): the hull replaces their own rings and grips.
    await ui.pointer(ui.card('a'), 'pointerdown', ...at(50, 50)); await ui.pointer(ui.surface, 'pointerup', ...at(50, 50))
    await ui.pointer(ui.card('b'), 'pointerdown', ...at(250, 50), { metaKey: true }); await ui.pointer(ui.surface, 'pointerup', ...at(250, 50), { metaKey: true })
    assert.ok(ui.surface.querySelector('.canvas-hull path')); assert.equal(ui.card('a').querySelector('[data-resize]'), null); assert.equal(ui.card('a').getAttribute('data-grouped'), 'true')
    const arc = ui.surface.querySelector('.canvas-hull-handles [data-resize="se"]')!
    await ui.pointer(arc, 'pointerdown', ...at(320, 108))
    await ui.pointer(ui.surface, 'pointermove', ...at(320 + 156, 108 + 20)); await ui.flush()
    assert.equal(ui.card('b').style.left, '318px'); assert.equal(ui.commits, 0)
    await ui.pointer(ui.surface, 'pointerup', ...at(320 + 156, 108 + 20))
    // The selection was 312 wide; 156 more is ×1.5 for both cards, about its top-left corner.
    assert.deepEqual(ui.canvas.nodes.slice(0, 2).map(n => [n.x, n.y, n.width, n.height]), [[0, 0, 300, 150], [318, 0, 150, 150]])
    assert.equal(ui.commits, 1); assert.deepEqual(ui.canvas.nodes[2], start.nodes[2])
    await ui.click('撤销'); assert.deepEqual(ui.canvas, start)
    // A plain click on one card of the selection narrows it to that card; its edge grip changes the width only.
    await ui.pointer(ui.card('a'), 'pointerdown', ...at(50, 50)); await ui.pointer(ui.surface, 'pointerup', ...at(50, 50))
    assert.equal(ui.surface.querySelector('.canvas-hull'), null)
    await ui.pointer(ui.card('a').querySelector('[data-resize="l"]')!, 'pointerdown', ...at(0, 50))
    await ui.pointer(ui.surface, 'pointermove', ...at(-40, 90)); await ui.flush(); await ui.pointer(ui.surface, 'pointerup', ...at(-40, 90))
    assert.deepEqual([ui.canvas.nodes[0].x, ui.canvas.nodes[0].width, ui.canvas.nodes[0].height], [-40, 240, 100]); assert.equal(ui.canvas.nodes[0].ready.appearance, undefined)
  } finally { await ui.close() }
})

test('keyboard and clipboard: ⌘D, arrows, Enter, layer steps, copy, cut and paste of cards, text styles', async () => {
  const opened: string[] = []
  const ui = await mount(4, { onOpenNode: node => opened.push(node.id) })
  const clip = async (type: 'copy' | 'cut' | 'paste', data: Map<string, string>) => {
    const event = new ui.dom.window.Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { files: [], getData: (key: string) => data.get(key) ?? '', setData: (key: string, value: string) => { data.set(key, value) } } })
    await act(async () => ui.surface.dispatchEvent(event)); return event.defaultPrevented
  }
  try {
    ui.surface.focus()
    // Arrows walk from card to card; Enter opens the picked one.
    await ui.key('ArrowRight'); const first = ui.surface.querySelector('.canvas-card[data-selected="true"]')!.getAttribute('data-node-id')!
    await ui.pointer(ui.card('n0'), 'pointerdown', 100, 120); await ui.pointer(ui.surface, 'pointerup', 100, 120)
    await ui.key('ArrowRight'); assert.equal(ui.surface.querySelector('.canvas-card[data-selected="true"]')?.getAttribute('data-node-id'), 'n1'); assert.ok(first)
    await ui.key('Enter'); assert.deepEqual(opened, ['n1'])
    // ⌥⌘] one layer up, ⌥⌘[ back down.
    await ui.key(']', { ctrlKey: true, altKey: true, code: 'BracketRight' }); assert.deepEqual(ui.canvas.nodes.map(n => n.id), ['n0', 'n2', 'n1', 'n3'])
    await ui.key('[', { ctrlKey: true, altKey: true, code: 'BracketLeft' }); assert.deepEqual(ui.canvas.nodes.map(n => n.id), ['n0', 'n1', 'n2', 'n3'])
    // ⌘D: a copy one step away, picked.
    await ui.key('d', { ctrlKey: true })
    assert.equal(ui.canvas.nodes.length, 5); assert.deepEqual([ui.canvas.nodes[4].x, ui.canvas.nodes[4].y], [284, 24])
    assert.equal(ui.surface.querySelector('.canvas-card[data-selected="true"]')?.getAttribute('data-node-id'), ui.canvas.nodes[4].id)
    await ui.key('z', { ctrlKey: true })
    // Copy n0 and n1 with their connector; each paste lands one more step away and is one undo step.
    await ui.pointer(ui.card('n0'), 'pointerdown', 100, 120); await ui.pointer(ui.surface, 'pointerup', 100, 120)
    await ui.pointer(ui.card('n1'), 'pointerdown', 350, 120, { shiftKey: true }); await ui.pointer(ui.surface, 'pointerup', 350, 120, { shiftKey: true })
    const data = new Map<string, string>()
    assert.equal(await clip('copy', data), true); assert.match(data.get('text/plain')!, /灵感 0[\s\S]*https:\/\/example\.com/); assert.equal(ui.commits, 4)
    await clip('paste', data); await clip('paste', data)
    assert.equal(ui.canvas.nodes.length, 8); assert.equal(ui.canvas.edges.length, 3)
    assert.deepEqual(ui.canvas.nodes.slice(4).map(n => n.x), [24, 284, 48, 308])
    await ui.key('z', { ctrlKey: true }); await ui.key('z', { ctrlKey: true }); assert.equal(ui.canvas.nodes.length, 4)
    // Plain text or a web address pastes as before; a clipboard with files is left to the media layer.
    assert.equal(await clip('paste', new Map([['text/plain', 'https://example.org/a']])), true)
    assert.ok(ui.canvas.nodes.at(-1)?.type === 'link')
    await ui.key('z', { ctrlKey: true })
    // Cut: the cards are copied and go to the bin.
    await ui.pointer(ui.card('n3'), 'pointerdown', 800, 120); await ui.pointer(ui.surface, 'pointerup', 800, 120)
    const cut = new Map<string, string>()
    await clip('cut', cut); assert.ok(cut.has('application/vnd.ready.canvas-cards+json')); assert.ok(ui.canvas.nodes[3].ready.trash)
    await ui.key('z', { ctrlKey: true })
    // 文字: size, weight and alignment of a text card are in the data; the selection bar now sets them.
    await ui.pointer(ui.card('n0'), 'pointerdown', 100, 120); await ui.pointer(ui.surface, 'pointerup', 100, 120)
    await ui.click('文字'); await ui.click('大标题'); await ui.click('文字'); await ui.click('居中')
    assert.deepEqual(ui.canvas.nodes[0].ready.appearance, { fontScale: 26 / 24, align: 'center' })
  } finally { await ui.close() }
})

test('a board opens where it was left; a mouse wheel notch zooms while two fingers pan', async () => {
  const ui = await mount(3, {}, { storage: { 'ready-next.canvas.camera': JSON.stringify({ 'canvas-lab': { x: -120, y: 30, zoom: 0.5, at: 1 } }) } })
  const world = () => ui.surface.querySelector<HTMLElement>('.canvas-world')!.style.transform
  const wheel = async (init: WheelEventInit, legacy?: number) => {
    const event = new ui.dom.window.WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 400, clientY: 300, ...init })
    if (legacy !== undefined) Object.defineProperty(event, 'wheelDeltaY', { value: legacy })
    Object.defineProperty(event, 'timeStamp', { value: (clock += 400) })
    await act(async () => ui.surface.dispatchEvent(event)); await ui.flush()
  }
  let clock = 1000
  try {
    assert.equal(world(), 'translate(-120px, 30px) scale(0.5)')
    // Two fingers on a trackpad: small deltas, the legacy delta is not a whole notch → pan.
    await wheel({ deltaX: 0, deltaY: 10 }, -30); assert.equal(world(), 'translate(-120px, 20px) scale(0.5)')
    // One notch of a mouse wheel → zoom about the pointer.
    await wheel({ deltaX: 0, deltaY: -4 }, 120); assert.match(world(), /scale\(0\.55/)
    await new Promise(resolve => setTimeout(resolve, 350))
    assert.equal(JSON.parse(ui.dom.window.localStorage.getItem('ready-next.canvas.camera')!)['canvas-lab'].zoom.toFixed(2), '0.55')
  } finally { await ui.close() }
})
