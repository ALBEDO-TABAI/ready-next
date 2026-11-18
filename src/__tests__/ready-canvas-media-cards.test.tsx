import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { CanvasSurface } from '../renderer/components/canvas/surface/CanvasSurface'
import type { CanvasSurfaceProps } from '../renderer/components/canvas/surface/types'
import { AudioCard } from '../renderer/components/canvas/cards/AudioCard'
import { ImageCard } from '../renderer/components/canvas/cards/ImageCard'
import { VideoCard } from '../renderer/components/canvas/cards/VideoCard'
import { LinkCard } from '../renderer/components/canvas/cards/LinkCard'
import { RecordTool } from '../renderer/components/canvas/surface/RecordTool'
import { useBoardMedia, type CanvasSurfaceApi } from '../renderer/components/canvas/board-media'
import { closeAllFloats, FloatHost } from '../renderer/components/ui'
import { applyCanvasOperations, type CanvasCommand, type CanvasNode, type CanvasOperation, type ReadyCanvas } from '../shared/ready-canvas'
import type { CanvasOpen } from '../main/modules/board-engine/canvas-service'
import { png } from './utils/media-fixture'

async function mount() {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } }
  const saved = Object.fromEntries(Object.keys(globals).map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  dom.window.requestAnimationFrame = () => 1; dom.window.cancelAnimationFrame = () => {}
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(document.getElementById('root')!)
  const button = (label: string) => [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === label || b.textContent === label)
  return { dom, button,
    async render(node: React.ReactNode) { await act(async () => root.render(node)) },
    async click(label: string) { const target = button(label); assert.ok(target, label); await act(async () => target.click()) },
    async settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) },
    async close() { await act(async () => { closeAllFloats(); root.unmount() }); dom.window.close(); for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key)
    } } }
}
const sha = 'a'.repeat(64)
const audio = (id: string, media: object = {}, ready: object = {}): Extract<CanvasNode, { type: 'file' }> => ({ id, type: 'file', file: `X.assets/${id}.webm`, x: 0, y: 0, width: 300, height: 132,
  ready: { kind: 'audio', media: { mime: 'audio/webm', sha256: sha, ...media }, ...ready } })
const image = (id: string, x = 0, ready: object = {}): Extract<CanvasNode, { type: 'file' }> => ({ id, type: 'file', file: `X.assets/${id}.png`, x, y: 0, width: 200, height: 150, ready: { kind: 'image', preview: { title: id }, ...ready } })
const link = (id: string, ready: object = {}): Extract<CanvasNode, { type: 'link' }> => ({ id, type: 'link', url: 'https://example.com/post', x: 0, y: 300, width: 260, height: 195, ready: { kind: 'link', ...ready } })

test('the voice card shows its length and when it was taken; a transcript only when the card came with one', async () => {
  const ui = await mount()
  try {
    const stamp = '2026-11-14T06:36:00.000Z'
    await ui.render(<AudioCard node={audio('memo', { durationMs: 42400 }, { preview: { title: '录音', fetchedAt: stamp } })} src="local-file:///v/X.assets/memo.webm" peaks={async () => [0, .5, 1]} />)
    await ui.settle()
    const card = document.querySelector('.cv-audio')!
    assert.equal(card.querySelector('.cv-audio__title')?.textContent, '录音')
    assert.equal(card.querySelector('.cv-audio__time')?.textContent, '0:42')
    assert.equal(card.querySelector('time')?.getAttribute('datetime'), stamp)
    assert.ok(ui.button('播放'), 'a play button')
    assert.equal(card.querySelectorAll('.cv-audio__wave[data-shape="peaks"] i').length, 3, 'the real peaks are drawn')
    // The board only records (2026-11-14): a recording is whole without a transcript and says nothing about one.
    assert.doesNotMatch(card.textContent ?? '', /转写/)
    assert.deepEqual([...card.children].map(child => child.className), ['cv-audio__head', 'cv-audio__player'])
    await ui.render(<AudioCard node={audio('memo')} peaks={async () => null} />)
    await ui.settle()
    assert.doesNotMatch(document.querySelector('.cv-audio')?.textContent ?? '', /转写/)
    assert.equal(document.querySelector('.cv-audio__time')?.textContent, '--:--')
    assert.equal(document.querySelector('.cv-audio__wave')?.getAttribute('data-shape'), 'line')
    assert.equal(ui.button('播放')?.disabled, true, 'no file, nothing to play')
    await ui.render(<AudioCard node={audio('memo', { durationMs: 61000, transcript: '明天上午把封面第三稿发给印厂。' }, { sources: [{ uri: 'ready://fastcard/fc-1', capturedAt: stamp, method: 'fastcard' }] })} peaks={async () => null} />)
    assert.equal(document.querySelector('.cv-audio__transcript')?.textContent, '明天上午把封面第三稿发给印厂。')
    assert.equal(document.querySelector('.cv-audio__time')?.textContent, '1:01')
    assert.equal(document.querySelector('.cv-audio time')?.getAttribute('datetime'), stamp, 'a FastCard recording keeps its capture time')
  } finally { await ui.close() }
})

test('a link card with a kept preview fetches nothing and shows its cover; a first read is offered to the host once', async () => {
  const ui = await mount()
  try {
    let reads = 0
    const source = { read: async () => { reads++; return { title: '新标题', image: 'X.assets/cover.png', fetchedAt: '2026-11-14T06:00:00.000Z' } } }
    const offered: string[] = []
    const kept = link('kept', { preview: { title: '存下的标题', description: '摘要', image: 'X.assets/kept.png', fetchedAt: '2026-11-01T00:00:00.000Z' } })
    await ui.render(<LinkCard node={kept} source={source} resolveAsset={path => `local-file:///v/${path}`} onPreview={node => offered.push(node.id)} />)
    await ui.settle()
    assert.equal(reads, 0); assert.deepEqual(offered, [])
    assert.equal(document.querySelector('.canvas-link-card strong')?.textContent, '存下的标题')
    assert.equal(document.querySelector<HTMLImageElement>('.canvas-link-cover')?.getAttribute('src'), 'local-file:///v/X.assets/kept.png')
    // A broken cover file falls back to the plain card.
    await act(async () => document.querySelector('.canvas-link-cover')!.dispatchEvent(new ui.dom.window.Event('error')))
    assert.equal(document.querySelector('.canvas-link-cover'), null)
    assert.equal(document.querySelector('.canvas-link-card')?.hasAttribute('data-cover'), false)
    await ui.render(<LinkCard node={link('fresh')} source={source} resolveAsset={path => `local-file:///v/${path}`} onPreview={node => offered.push(node.id)} />)
    await ui.settle()
    assert.equal(reads, 1); assert.deepEqual(offered, ['fresh'])
    assert.equal(document.querySelector('.canvas-link-card strong')?.textContent, '新标题')
    // The same card moved or restyled does not read again.
    await ui.render(<LinkCard node={{ ...link('fresh'), x: 40 }} source={source} resolveAsset={path => `local-file:///v/${path}`} onPreview={node => offered.push(node.id)} />)
    await ui.settle()
    assert.equal(reads, 1)
  } finally { await ui.close() }
})

test('the picture card covers its frame and honours a stored crop', async () => {
  const ui = await mount()
  try {
    await ui.render(<ImageCard node={image('pic', 0, { appearance: { crop: { mode: 'position', x: 10, y: 90 } } })} src="local-file:///v/X.assets/pic.png" />)
    const picture = document.querySelector<HTMLImageElement>('.cv-image img')!
    assert.equal(picture.getAttribute('src'), 'local-file:///v/X.assets/pic.png'); assert.equal(picture.style.objectPosition, '10% 90%')
    await ui.render(<ImageCard node={image('pic')} />)
    assert.ok(document.querySelector('.cv-image.is-missing'))
    // A rectangle crop: the picture sits in a box with the kept part's own shape (never stretched to the card's).
    // Before the picture has loaded the card's shape stands in; once its size is known the box takes the part's ratio.
    const cropped = image('pic', 0, { appearance: { crop: { mode: 'rect', x: .25, y: 0, w: .5, h: 1 } } })
    await ui.render(<ImageCard node={cropped} src="local-file:///v/X.assets/pic.png" />)
    const box = () => document.querySelector<HTMLElement>('.cv-image > .cv-image__crop')!
    assert.equal(Number(box().style.getPropertyValue('--cv-crop-ratio')), 200 / 150)
    const inner = box().querySelector('img')!
    assert.deepEqual([inner.style.width, inner.style.height, inner.style.left, inner.style.top], ['200%', '100%', '-50%', '0%'])
    for (const [key, value] of [['naturalWidth', 800], ['naturalHeight', 600], ['complete', true]] as const) Object.defineProperty(inner, key, { value, configurable: true })
    await act(async () => inner.dispatchEvent(new ui.dom.window.Event('load')))
    assert.equal(Number(box().style.getPropertyValue('--cv-crop-ratio')), 400 / 600, 'half the width of a 4:3 picture is 2:3')
  } finally { await ui.close() }
})

test('crop mode on a picture card: menu, selection bar and K enter it; Enter or a press outside applies one undoable step; Esc cancels', async () => {
  const ui = await mount()
  try {
    // The card's picture is "loaded": 800 × 600, shown in a 200 × 150 card.
    for (const [key, value] of [['naturalWidth', 800], ['naturalHeight', 600], ['complete', true]] as const) Object.defineProperty(ui.dom.window.HTMLImageElement.prototype, key, { get: () => value, configurable: true })
    let canvas: ReadyCanvas = { ready: { schemaVersion: 1, id: 'board' }, edges: [], nodes: [audio('memo'), image('pic', 400, { media: { mime: 'image/png', sha256: sha, originalName: '田野.png' } })] }
    const batches: CanvasOperation[][] = [], downloads: string[][] = []
    let handle: Parameters<NonNullable<CanvasSurfaceProps['surfaceApi']>>[0] = null
    const resolveAsset = (path: string) => `local-file:///v/${path}`
    const props: CanvasSurfaceProps = { canvas, onOperations: ops => { batches.push(ops); canvas = applyCanvasOperations(canvas, ops).canvas }, resolveAsset,
      renderCard: node => node.type === 'file' && node.ready.kind === 'image' ? <ImageCard node={node} src={resolveAsset(node.file)} /> : undefined,
      onDownload: async ids => { downloads.push(ids) }, surfaceApi: api => { handle = api } }
    await ui.render(<><CanvasSurface {...props} /><FloatHost /></>)
    const surface = document.querySelector<HTMLElement>('[data-canvas-surface]')!
    surface.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 700, width: 1000, height: 700, x: 0, y: 0, toJSON() {} })
    const pic = () => canvas.nodes.find(node => node.id === 'pic')!
    const fire = async (target: Element, type: string, x = 0, y = 0) => { await act(async () => target.dispatchEvent(new ui.dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }))) }
    const key = async (name: string, more: object = {}) => { await act(async () => surface.dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: name, ...more }))); await ui.settle() }
    const menuFor = async (id: string) => { await fire(surface.querySelector(`[data-node-id="${id}"]`)!, 'contextmenu', 10, 20)
      return [...document.querySelectorAll<HTMLElement>('[role="menu"] [role^="menuitem"]')] }
    const labels = (items: HTMLElement[]) => items.map(item => item.querySelector('.rn-menu__label')?.textContent)
    const drag = async (grip: string, dx: number, dy: number) => {
      const overlay = surface.querySelector('.cv-crop')!
      await fire(overlay.querySelector(`[data-crop-grip="${grip}"]`)!, 'pointerdown', 500, 300); await fire(overlay, 'pointermove', 500 + dx, 300 + dy); await fire(overlay, 'pointerup', 500 + dx, 300 + dy)
    }
    const frame = () => { const style = surface.querySelector<HTMLElement>('.cv-crop__frame')!.style; return [style.left, style.top, style.width, style.height] }

    // Only a picture card offers 裁剪; every card offers 下载为 ZIP.
    assert.deepEqual(labels(await menuFor('memo')).filter(label => label === '裁剪' || label === '下载为 ZIP'), ['下载为 ZIP'])
    await act(async () => closeAllFloats())
    const items = await menuFor('pic')
    assert.deepEqual(labels(items).filter(label => label === '裁剪' || label === '下载为 ZIP'), ['裁剪', '下载为 ZIP'])
    await act(async () => items.find(item => item.querySelector('.rn-menu__label')?.textContent === '裁剪')!.click()); await ui.settle()
    // Crop mode: the card steps aside for the overlay, the bar shows the kept part in the picture's own pixels.
    assert.ok(surface.querySelector('.cv-crop'), 'the crop overlay is up')
    assert.equal(surface.querySelector('[data-node-id="pic"]')?.getAttribute('data-cropping'), 'true')
    assert.equal(surface.querySelector('[role="toolbar"][aria-label="选区操作"]'), null, 'the selection bar gives way to the crop bar')
    const bar = () => surface.querySelector('[role="toolbar"][aria-label="裁剪"]')
    assert.match(bar()?.textContent ?? '', /800 × 600/); assert.equal(ui.button('还原整张图片')?.disabled, true)
    assert.deepEqual(frame(), ['0px', '0px', '200px', '150px'])
    await drag('se', -100, -50)
    assert.deepEqual(frame(), ['0px', '0px', '100px', '100px']); assert.match(bar()?.textContent ?? '', /400 × 400/)
    assert.equal(batches.length, 0, 'nothing is written while cropping')
    // Other keys do not reach the board (Delete would bin the card).
    await key('Delete'); assert.equal(pic().ready.trash, undefined); assert.ok(surface.querySelector('.cv-crop'))
    await key('Enter')
    assert.equal(surface.querySelector('.cv-crop'), null)
    assert.deepEqual(batches, [[
      { type: 'appearance', id: 'pic', appearance: { crop: { mode: 'rect', x: 0, y: 0, w: .5, h: .666667 } } },
      { type: 'geometry', id: 'pic', geometry: { x: 400, y: 0, width: 100, height: 100 } },
    ]], 'one batch: the crop and the card\'s new frame')
    assert.deepEqual({ file: (pic() as { file: string }).file, media: pic().ready.media }, { file: 'X.assets/pic.png', media: { mime: 'image/png', sha256: sha, originalName: '田野.png' } }, 'the attachment is not touched')
    assert.ok(Math.abs(Number(surface.querySelector<HTMLElement>('[data-node-id="pic"] .cv-image__crop')!.style.getPropertyValue('--cv-crop-ratio')) - 1) < 1e-3, 'the card shows the square part unstretched')
    // One undo restores the frame and removes the crop.
    surface.focus(); await key('z', { metaKey: true })
    assert.deepEqual({ width: pic().width, height: pic().height, appearance: pic().ready.appearance }, { width: 200, height: 150, appearance: undefined })

    // K on the one picked picture; Esc leaves everything as it was.
    await act(async () => handle!.select(['pic'])); surface.focus()
    await key('k'); assert.ok(surface.querySelector('.cv-crop'), 'K enters crop mode')
    await drag('l', 60, 0); await key('Escape')
    assert.equal(surface.querySelector('.cv-crop'), null); assert.equal(batches.length, 2, 'only the crop and its undo were written')
    assert.equal(surface.querySelector('[data-node-id="pic"]')?.getAttribute('data-selected'), 'true', 'the card stays picked')
    // K does nothing for a card that is not a picture.
    await act(async () => handle!.select(['memo'])); await key('k'); assert.equal(surface.querySelector('.cv-crop'), null)

    // The selection bar's 裁剪; slide the picture under a smaller frame; a press outside applies.
    await act(async () => handle!.select(['pic'])); await ui.click('裁剪'); await ui.settle()
    await drag('r', -100, 0); await drag('image', -40, 0); await drag('image', -999, 0)
    await fire(surface, 'pointerdown', 900, 600); await ui.settle()
    assert.equal(surface.querySelector('.cv-crop'), null)
    assert.deepEqual(pic().ready.appearance, { crop: { mode: 'rect', x: .5, y: 0, w: .5, h: 1 } }, 'the right half: the picture was slid as far as it goes')
    assert.deepEqual({ x: pic().x, width: pic().width, height: pic().height }, { x: 400, width: 100, height: 150 })
    // Cropping again shows the whole picture around the frame; 还原整张图片 and 完成裁剪 give the whole picture back.
    await ui.click('裁剪'); await ui.settle()
    const ghost = surface.querySelector<HTMLElement>('.cv-crop__ghost')!.style
    assert.deepEqual([ghost.left, ghost.top, ghost.width, ghost.height], ['-100px', '0px', '200px', '150px'])
    await ui.click('还原整张图片'); await ui.click('完成裁剪'); await ui.settle()
    assert.deepEqual({ x: pic().x, width: pic().width, height: pic().height, appearance: pic().ready.appearance }, { x: 300, width: 200, height: 150, appearance: undefined })

    // 更多 keeps the two kinds of export apart, and downloads the chosen cards (or the whole board).
    await ui.click('更多')
    assert.deepEqual([...document.querySelectorAll('[role="menu"] > *')].map(item => item.querySelector('.rn-menu__label')?.textContent ?? item.textContent).filter(Boolean), ['下载 · 各自的原文件', '把选中的卡片下载为 ZIP'])
    await act(async () => [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find(item => item.querySelector('.rn-menu__label')?.textContent === '把选中的卡片下载为 ZIP')!.click()); await ui.settle()
    await act(async () => handle!.select([])); await ui.click('更多')
    await act(async () => [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find(item => item.querySelector('.rn-menu__label')?.textContent === '下载为 ZIP')!.click()); await ui.settle()
    assert.deepEqual(downloads, [['pic'], []])
  } finally { await ui.close() }
})

test('the record tool shows a running recording with a stop control, then hands the sound over; a failed save can be retried', async () => {
  const ui = await mount()
  try {
    const saved: Array<{ name: string; durationMs: number }> = [], errors: string[] = []
    let cancelled = 0, fail = true
    const start = async () => ({ stop: async () => ({ file: new File(['sound'], '录音.webm', { type: 'audio/webm' }), durationMs: 3200 }), cancel: () => { cancelled++ } })
    const onRecorded = async (file: File, durationMs: number) => { if (fail) { fail = false; throw new Error('画板正在处理另一项修改') } saved.push({ name: file.name, durationMs }) }
    await ui.render(<RecordTool start={start} onRecorded={onRecorded} report={cause => errors.push(String(cause))} />)
    await ui.click('录音')
    const stop = ui.button('停止录音')!
    assert.ok(stop.hasAttribute('data-recording')); assert.match(stop.querySelector('[role="timer"]')!.textContent!, /^0:0\d$/)
    await ui.click('停止录音'); await ui.settle()
    assert.deepEqual(saved, []); assert.match(errors[0], /另一项修改/)
    await ui.click('重试保存录音'); await ui.settle()
    assert.deepEqual(saved, [{ name: '录音.webm', durationMs: 3200 }])
    assert.ok(ui.button('录音'), 'back to idle')
    // A denied microphone is reported and leaves the tool idle.
    await ui.render(<RecordTool key="denied" start={async () => { throw new Error('没有麦克风权限') }} onRecorded={onRecorded} report={cause => errors.push(String(cause))} />)
    await ui.click('录音'); await ui.settle()
    assert.match(errors.at(-1)!, /没有麦克风权限/); assert.ok(ui.button('录音'))
    // Leaving the board mid-recording discards it.
    await ui.render(<RecordTool key="leave" start={start} onRecorded={onRecorded} report={() => {}} />)
    await ui.click('录音'); await ui.render(<div />)
    assert.equal(cancelled, 1)
  } finally { await ui.close() }
})

test('the surface hosts media: dock tools, transcript search, card menu items, paste and its handle', async () => {
  const ui = await mount()
  try {
    let canvas: ReadyCanvas = { ready: { schemaVersion: 1, id: 'board' }, edges: [], nodes: [
      audio('memo', { durationMs: 1000, transcript: '把封面第三稿发给印厂' }), image('pic', 400), link('page') ] }
    const pasted: Array<{ at: { x: number; y: number }; files: number | null }> = []
    let handle: Parameters<NonNullable<CanvasSurfaceProps['surfaceApi']>>[0] = null
    const props: CanvasSurfaceProps = { canvas, onOperations: (ops: CanvasOperation[]) => { canvas = applyCanvasOperations(canvas, ops).canvas },
      dockTools: <button type="button" aria-label="录音">mic</button>,
      extraCardItems: nodes => nodes.length === 1 && nodes[0].type === 'link' ? [{ id: 'refresh-preview', label: '刷新预览', onSelect: () => {} }] : [],
      onPasteMedia: async (at, data) => { pasted.push({ at, files: data ? data.files.length : null }); return true },
      surfaceApi: api => { handle = api } }
    await ui.render(<><CanvasSurface {...props} /><FloatHost /></>)
    const surface = document.querySelector<HTMLElement>('[data-canvas-surface]')!
    surface.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 700, width: 1000, height: 700, x: 0, y: 0, toJSON() {} })
    assert.ok(surface.querySelector('.canvas-dock [aria-label="录音"]'), 'the host tool sits in the dock')
    // Search reads transcripts.
    await ui.click('在画板中搜索')
    const input = surface.querySelector<HTMLInputElement>('input[aria-label="搜索卡片"]')!
    await act(async () => { Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, '印厂'); input.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true })) })
    assert.deepEqual([...surface.querySelectorAll('[data-matched="true"]')].map(card => card.getAttribute('data-node-id')), ['memo'])
    await ui.click('关闭搜索')
    // The host's items join a card's menu, for the cards it names.
    const menuFor = async (id: string) => { await act(async () => surface.querySelector(`[data-node-id="${id}"]`)!.dispatchEvent(new ui.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 20 })))
      return [...document.querySelectorAll('[role="menu"] .rn-menu__label')].map(item => item.textContent) }
    assert.ok((await menuFor('page')).includes('刷新预览'))
    assert.equal((await menuFor('pic')).includes('刷新预览'), false)
    await act(async () => closeAllFloats())
    // ⌘V with files on the clipboard goes to the host with the view centre; text alone is left to others.
    const paste = async (files: unknown[]) => { const event = new ui.dom.window.Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'clipboardData', { value: { files, types: files.length ? ['Files'] : ['text/plain'], getData: () => 'hello' } })
      await act(async () => surface.dispatchEvent(event)); return event.defaultPrevented }
    assert.equal(await paste([{}]), true)
    // Plain text on the clipboard is the board's own paste (a text card), not the media layer's: handled, but not passed on.
    assert.equal(await paste([]), true)
    assert.equal(pasted.length, 1); assert.equal(pasted[0].files, 1)
    assert.deepEqual(pasted[0].at, handle!.centre(), 'placed where the person is looking')
    // 粘贴 from the right-click menu asks the host first (system clipboard).
    await act(async () => surface.dispatchEvent(new ui.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 600, clientY: 500 })))
    const pasteItem = [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find(item => item.querySelector('.rn-menu__label')?.textContent === '粘贴')!
    await act(async () => pasteItem.click()); await ui.settle()
    assert.equal(pasted.length, 2); assert.equal(pasted[1].files, null)
    // The handle commits through the surface's own undoable path and moves the selection.
    assert.equal(await act(async () => handle!.commit([{ type: 'geometry', id: 'pic', geometry: { x: 420 } }])), true)
    assert.equal(canvas.nodes.find(node => node.id === 'pic')!.x, 420)
    await act(async () => handle!.select(['pic']))
    assert.equal(surface.querySelector('[data-node-id="pic"]')?.getAttribute('data-selected'), 'true')
    assert.equal(handle!.element(), surface)
  } finally { await ui.close() }
})

test('the board document places dropped and pasted files, opens the slideshow and refreshes a link preview', async () => {
  const ui = await mount()
  try {
    const board: ReadyCanvas = { ready: { schemaVersion: 1, id: 'board', title: 'X' }, edges: [], nodes: [image('b', 400), image('a', 0), link('page')] }
    const opened: CanvasOpen = { objectId: 'board', handleId: 'h', path: 'X.canvas', version: sha, canvas: board }
    const staged: string[] = [], written: CanvasCommand[][] = [], commits: CanvasOperation[][] = [], selected: string[][] = [], errors: string[] = [], previewRequests: unknown[] = []
    Object.assign(ui.dom.window, { electronAPI: { canvasMedia: {
      stage: async (input: { name: string }) => { staged.push(input.name); return input.name.endsWith('.exe') ? { ok: false, error: '不支持的文件类型' } : { ok: true, value: { token: `t${staged.length}`, kind: 'image', mime: 'image/png', sha256: sha, size: 10 } } },
      linkPreview: async (input: unknown) => { previewRequests.push(input); return { ok: true, value: { title: '新标题', image: 'X.assets/cover.png', fetchedAt: '2026-11-14T06:00:00.000Z' } } },
    } } })
    const surfaceElement = document.createElement('div'); document.body.append(surfaceElement)
    const api: CanvasSurfaceApi = { commit: async ops => { commits.push(ops); return true }, centre: () => ({ x: 500, y: 300 }), select: ids => { selected.push(ids) }, element: () => surfaceElement }
    let media!: ReturnType<typeof useBoardMedia>
    function Host() {
      media = useBoardMedia({ opened, root: '/vault', write: async commands => { written.push(commands) }, report: cause => errors.push(String(cause)), pick: async () => [new File([png() as BlobPart], '选的.png', { type: 'image/png' })] })
      return <>{media.dockTools}{media.renderCard(audio('memo'))}</>
    }
    await ui.render(<><Host /><FloatHost /></>); await ui.settle()
    media.surfaceApi(api)
    assert.doesNotMatch(document.querySelector('.cv-audio')?.textContent ?? '', /转写/, 'a recording without a transcript says nothing about transcription')
    assert.ok(ui.button('录音'))
    // Drop: only a transfer with files is taken; the cards are written with their attachments and selected.
    assert.equal(media.acceptsDrop(['Files']), true); assert.equal(media.acceptsDrop(['text/plain']), false)
    assert.equal(media.dropFiles({ files: [] } as unknown as DataTransfer, { x: 0, y: 0 }), false)
    assert.equal(media.dropFiles({ files: [new File([png() as BlobPart], '拖的.png', { type: 'image/png' })] } as unknown as DataTransfer, { x: 40, y: 60 }), true)
    await ui.settle(); await ui.settle()
    assert.deepEqual(staged, ['拖的.png']); assert.equal(written.length, 1)
    const dropped = written[0][0]
    assert.equal(dropped.type === 'importAttachment' && dropped.sourceToken, 't1')
    assert.deepEqual(dropped.type === 'importAttachment' && [dropped.node.x, dropped.node.y, dropped.node.ready.kind], [40, 60, 'image'])
    assert.equal(selected.at(-1)?.length, 1)
    // Paste: the event's files, centred on the view; a clipboard without files is not handled.
    assert.equal(await media.pasteMedia({ x: 500, y: 300 }, { files: [new File([png() as BlobPart], '贴的.png', { type: 'image/png' })] } as unknown as DataTransfer), true)
    assert.equal(written.length, 2)
    assert.equal(await media.pasteMedia({ x: 500, y: 300 }, { files: [] } as unknown as DataTransfer), false)
    assert.equal(await media.pasteMedia({ x: 500, y: 300 }, null), false)
    // 文件…: what the picker returned.
    const item = media.newItems({ x: 200, y: 200 })[0]
    assert.equal(item.label, '文件…')
    await act(async () => { item.onSelect?.() }); await ui.settle(); await ui.settle()
    assert.deepEqual(staged, ['拖的.png', '贴的.png', '选的.png']); assert.equal(written.length, 3)
    // Main's refusal reaches the person and nothing is written.
    media.dropFiles({ files: [new File(['MZ'], '坏的.exe', { type: 'image/png' })] } as unknown as DataTransfer, { x: 0, y: 0 })
    await ui.settle(); await ui.settle()
    assert.match(errors.at(-1) ?? '', /不支持的文件类型/); assert.equal(written.length, 3)
    // Double-click on a picture: the slideshow over the board, in reading order; arrows step, Esc closes.
    assert.equal(media.openNode(link('page')), false)
    await act(async () => { assert.equal(media.openNode(board.nodes[0]), true) })
    const show = () => document.querySelector('[data-float-id="canvas-slideshow"]')
    assert.equal(show()?.getAttribute('role'), 'dialog')
    assert.equal(show()?.querySelector('.cv-slideshow__picture')?.getAttribute('alt'), 'b'); assert.equal(show()?.querySelector('.cv-slideshow__count')?.textContent, '2 / 2')
    const press = (key: string) => act(async () => { window.dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
    await press('ArrowRight')
    assert.equal(show()?.querySelector('.cv-slideshow__picture')?.getAttribute('alt'), 'a'); assert.equal(show()?.querySelector('.cv-slideshow__count')?.textContent, '1 / 2')
    await press('ArrowLeft')
    assert.equal(show()?.querySelector('.cv-slideshow__picture')?.getAttribute('src'), 'local-file:///vault/X.assets/b.png')
    await press('Escape')
    assert.equal(show(), null)
    // 刷新预览 asks Main for this board's link and stores the answer on the card through the surface.
    assert.deepEqual(media.cardItems([board.nodes[0]]), []); assert.deepEqual(media.cardItems([board.nodes[2], board.nodes[0]]), [])
    const refresh = media.cardItems([board.nodes[2]])[0]
    assert.equal(refresh.label, '刷新预览')
    await act(async () => { refresh.onSelect?.() }); await ui.settle(); await ui.settle()
    assert.deepEqual(previewRequests, [{ objectId: 'board', url: 'https://example.com/post' }])
    assert.deepEqual(commits, [[{ type: 'replaceNode', node: { ...board.nodes[2], ready: { kind: 'link', preview: { title: '新标题', image: 'X.assets/cover.png', fetchedAt: '2026-11-14T06:00:00.000Z' } } } }]])
  } finally { await ui.close() }
})

// jsdom plays nothing: a play, a pause and a position are kept on the element and announced the way a browser does.
function fakePlayback(window: JSDOM['window'], length = 35) {
  const proto = window.HTMLMediaElement.prototype, paused = new WeakMap<object, boolean>(), time = new WeakMap<object, number>()
  Object.defineProperty(proto, 'paused', { configurable: true, get() { return paused.get(this) ?? true } })
  Object.defineProperty(proto, 'duration', { configurable: true, get() { return length } })
  Object.defineProperty(proto, 'currentTime', { configurable: true, get() { return time.get(this) ?? 0 }, set(value: number) { time.set(this, value) } })
  proto.play = async function (this: HTMLMediaElement) { paused.set(this, false); this.dispatchEvent(new window.Event('play')) }
  proto.pause = function (this: HTMLMediaElement) { if (paused.get(this) === false) { paused.set(this, true); this.dispatchEvent(new window.Event('pause')) } }
}
const film = (id = 'film', x = 0): Extract<CanvasNode, { type: 'file' }> => ({ id, type: 'file', file: `X.assets/${id}.mp4`, x, y: 0, width: 320, height: 208, ready: { kind: 'video', preview: { title: '样片' } } })

test('a video card is picked and moved by its picture; its mark and its bar play it; the bar never moves the card', async () => {
  const ui = await mount()
  try {
    fakePlayback(ui.dom.window)
    let canvas: ReadyCanvas = { ready: { schemaVersion: 1, id: 'board' }, edges: [], nodes: [film(), image('pic', 900)] }
    let commits = 0, enlarged = 0
    const props: CanvasSurfaceProps = { canvas, onOperations: (ops: CanvasOperation[]) => { commits++; canvas = applyCanvasOperations(canvas, ops).canvas },
      renderCard: node => node.type === 'file' && node.ready.kind === 'video' ? <VideoCard node={node} src="local-file:///vault/X.assets/film.mp4" onEnlarge={() => { enlarged++ }} /> : undefined }
    const show = () => ui.render(<><CanvasSurface {...props} canvas={canvas} /><FloatHost /></>)
    await show()
    const surface = document.querySelector<HTMLElement>('[data-canvas-surface]')!
    const card = () => surface.querySelector<HTMLElement>('[data-node-id="film"]')!
    const pointer = (target: Element, type: string, x: number, y: number) => act(async () => { target.dispatchEvent(new ui.dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1 })) })
    const picture = card().querySelector('video')!
    assert.equal(picture.hasAttribute('controls'), false, 'the board does not use the browser controls: they would take every press on the picture')
    assert.equal(picture.getAttribute('src'), 'local-file:///vault/X.assets/film.mp4#t=0.1')
    await act(async () => { picture.dispatchEvent(new ui.dom.window.Event('durationchange')) })
    assert.equal(card().querySelector('.cv-video__length')?.textContent, '0:35')

    // A press on the picture picks the card; a drag from it moves the card, once.
    await pointer(picture, 'pointerdown', 100, 100)
    assert.equal(card().dataset.selected, 'true')
    await pointer(surface, 'pointermove', 60, 160); await pointer(surface, 'pointerup', 40, 180)
    assert.equal(commits, 1); assert.deepEqual([canvas.nodes[0].x, canvas.nodes[0].y], [-60, 80])
    await show()
    assert.equal(card().querySelector('.cv-video')?.hasAttribute('data-playing'), false, 'moving a video does not start it')

    // The mark in the middle: a press that does not move plays or pauses; a drag from it moves the card instead.
    const mark = () => card().querySelector<HTMLElement>('.cv-video__mark')!
    await pointer(mark(), 'pointerdown', 100, 100); await pointer(surface, 'pointerup', 100, 100)
    assert.equal(card().querySelector('.cv-video')?.hasAttribute('data-playing'), true)
    assert.equal(card().querySelector('.cv-video__length'), null, 'a started video shows its time in the bar')
    await pointer(mark(), 'pointerdown', 100, 100); await pointer(surface, 'pointerup', 101, 100)
    assert.equal(card().querySelector('.cv-video')?.hasAttribute('data-playing'), false)
    await pointer(mark(), 'pointerdown', 100, 100); await pointer(surface, 'pointermove', 130, 100); await pointer(surface, 'pointerup', 130, 100)
    assert.equal(commits, 2); assert.equal(canvas.nodes[0].x, -30)
    await show()
    assert.equal(card().querySelector('.cv-video')?.hasAttribute('data-playing'), false, 'a drag from the mark is a move, not a press')

    // The bar: real controls. They keep their presses, so using them never moves the card.
    await ui.click('播放')
    assert.ok(ui.button('暂停')); assert.equal(card().querySelector('video')!.paused, false)
    const track = card().querySelector<HTMLElement>('.cv-video__track')!
    track.getBoundingClientRect = () => ({ left: 200, top: 0, right: 300, bottom: 20, width: 100, height: 20, x: 200, y: 0, toJSON() {} })
    await pointer(track, 'pointerdown', 250, 10); await pointer(track, 'pointermove', 280, 10); await pointer(surface, 'pointerup', 280, 10)
    assert.equal(card().querySelector('video')!.currentTime, 28); assert.equal(track.getAttribute('aria-valuenow'), '80')
    assert.equal(card().querySelector('.cv-video__time')?.textContent, '0:28 / 0:35')
    await act(async () => { track.dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })) })
    assert.equal(card().querySelector('video')!.currentTime, 23)
    assert.equal(commits, 2, 'the position slider and its keys never move the card'); assert.equal(canvas.nodes[0].x, -30)
    await ui.click('静音')
    assert.equal(card().querySelector('video')!.muted, true); assert.equal(ui.button('打开声音')?.getAttribute('aria-pressed'), 'true')
    await ui.click('暂停'); assert.ok(ui.button('播放'))
    await ui.click('放大'); assert.equal(enlarged, 1)
    // The end puts the still picture back.
    await act(async () => { card().querySelector('video')!.dispatchEvent(new ui.dom.window.Event('ended')) })
    assert.equal(card().querySelector('.cv-video__length')?.textContent, '0:35'); assert.equal(card().querySelector('video')!.currentTime, .1)
  } finally { await ui.close() }
})

test('a video enlarges with the pictures: the browser controls there, space plays or pauses, the cards fall silent', async () => {
  const ui = await mount()
  try {
    fakePlayback(ui.dom.window)
    const clip = film('clip', 0)
    const board: ReadyCanvas = { ready: { schemaVersion: 1, id: 'board', title: 'X' }, edges: [], nodes: [image('b', 400), clip] }
    const opened: CanvasOpen = { objectId: 'board', handleId: 'h', path: 'X.canvas', version: sha, canvas: board }
    let media!: ReturnType<typeof useBoardMedia>
    function Host() {
      media = useBoardMedia({ opened, root: '/vault', write: async () => {}, report: () => {} })
      return <div data-node-id="clip">{media.renderCard(clip)}</div>
    }
    await ui.render(<><Host /><FloatHost /></>); await ui.settle()
    const surfaceElement = document.querySelector<HTMLElement>('[data-node-id="clip"]')!.parentElement!
    media.surfaceApi({ commit: async () => true, centre: () => ({ x: 0, y: 0 }), select: () => {}, element: () => surfaceElement })
    const inline = surfaceElement.querySelector('video')!
    await ui.click('播放'); inline.currentTime = 12
    assert.equal(inline.paused, false)
    await ui.click('放大')
    const show = () => document.querySelector('[data-float-id="canvas-slideshow"]')
    const large = () => show()?.querySelector<HTMLVideoElement>('video.cv-slideshow__picture')
    assert.equal(inline.paused, true, 'the card stops when its video is shown large')
    assert.equal(large()?.hasAttribute('controls'), true); assert.equal(large()?.getAttribute('src'), 'local-file:///vault/X.assets/clip.mp4#t=12.00')
    assert.equal(large()?.autoplay, true); assert.equal(show()?.querySelector('.cv-slideshow__count')?.textContent, '1 / 2')
    const press = (key: string) => act(async () => { window.dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
    await press(' '); assert.equal(large()?.paused, false, 'space plays the video instead of stepping on')
    await press(' '); assert.equal(large()?.paused, true)
    await press('ArrowRight')
    assert.equal(show()?.querySelector('img.cv-slideshow__picture')?.getAttribute('alt'), 'b')
    await press(' ')
    assert.equal(large()?.getAttribute('src'), 'local-file:///vault/X.assets/clip.mp4#t=12.00', 'space on a picture steps on, back round to the video')
    await press('ArrowLeft'); await press('ArrowRight')
    assert.equal(large()?.autoplay, true)
    await press('Escape'); assert.equal(show(), null)
    // Double-click reaches the same view.
    await act(async () => { assert.equal(media.openNode(clip), true) })
    assert.ok(large()); await press('Escape')
  } finally { await ui.close() }
})
