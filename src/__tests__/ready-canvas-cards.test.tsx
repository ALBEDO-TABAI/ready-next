import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { CanvasSurface } from '../renderer/components/canvas/surface/CanvasSurface'
import { TextCard } from '../renderer/components/canvas/cards/TextCard'
import { DocumentCard, type DocumentPreviewSource } from '../renderer/components/canvas/cards/DocumentCard'
import { LinkCard } from '../renderer/components/canvas/cards/LinkCard'
import { applyCanvasOperations, type ReadyCanvas } from '../shared/ready-canvas'
import { createRangeEdit } from '../shared/document-blocks'
import { cardTextEdit } from '../renderer/components/canvas/cards/text-adapter'
import { CanvasCompositionSurface } from '../renderer/modules/canvas/composition/CanvasCompositionSurface'
import { DocumentDraftSchema, type DraftFinalizeInput } from '../shared/document-drafts'

async function mount() {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true }
  const saved = Object.fromEntries(Object.keys(globals).map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  dom.window.requestAnimationFrame = () => 1; dom.window.cancelAnimationFrame = () => {}
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(document.getElementById('root')!)
  return { dom, async render(node: React.ReactNode) { await act(async () => root.render(node)) },
    // Board chrome buttons are icons named by their label (W4 MS1).
    async click(label: string) { const button = [...document.querySelectorAll('button')].find(b => b.textContent === label || b.getAttribute('aria-label') === label); assert.ok(button, label); await act(async () => button.click()) },
    async close() { await act(async () => root.unmount()); dom.window.close(); for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key)
    } } }
}

const text = (id: string) => ({ id, type: 'text' as const, text: '原文😀', x: 0, y: 0, width: 200, height: 100, ready: { kind: 'text' as const } })

test('card adapter submits M3 range commands to the surface; one card changes and surface undo restores it', async () => {
  const ui = await mount()
  let canvas: ReadyCanvas = { ready: { schemaVersion: 1, id: 'board' }, nodes: [text('one'), { ...text('two'), x: 300 }], edges: [] }
  try {
    await ui.render(<CanvasSurface canvas={canvas} onOperations={operations => { canvas = applyCanvasOperations(canvas, operations).canvas }}
      renderTextEditor={({ node, commit }) => node.type === 'text' && <TextCard node={node} commit={commit}
        renderEditor={host => <button onClick={() => void host.buffer.apply(createRangeEdit(host.buffer.snapshot,
          [{ start: 0, end: 2, expectedText: '原文', replacement: '修改' }], { anchor: 0, focus: 0 }, { anchor: 2, focus: 2 }))}>提交区间</button>} />} />)
    await act(async () => document.querySelector('[data-node-id="one"]')!.dispatchEvent(new ui.dom.window.MouseEvent('dblclick', { bubbles: true })))
    await ui.click('提交区间')
    assert.equal(canvas.nodes[0].type === 'text' && canvas.nodes[0].text, '修改😀')
    assert.deepEqual(canvas.nodes[1], { ...text('two'), x: 300 })
    await ui.click('撤销')
    assert.deepEqual(canvas.nodes[0], text('one'))
    assert.deepEqual(canvas.nodes[1], { ...text('two'), x: 300 })
    await ui.click('重做')
    assert.equal(canvas.nodes[0].type === 'text' && canvas.nodes[0].text, '修改😀')
    const stale = createRangeEdit({ content: '原文😀', version: 0 }, [{ start: 0, end: 2, expectedText: '原文', replacement: '旧输入' }], { anchor: 0, focus: 0 })
    assert.throws(() => cardTextEdit(canvas.nodes[0], 1, stale), { code: 'version_conflict' })
  } finally { await ui.close() }
})

test('document card refreshes on object change, ignores an old read and renders passive content', async () => {
  const ui = await mount()
  let refresh: () => void = () => {}, resolveOld: (value: Awaited<ReturnType<DocumentPreviewSource['read']>>) => void = () => {}
  let reads = 0, opened = ''
  const source: DocumentPreviewSource = {
    subscribe(listener) { refresh = listener; return () => { refresh = () => {} } },
    read: async () => ++reads === 1 ? new Promise(resolve => { resolveOld = resolve })
      : { ref: { kind: 'page', id: 'page' }, title: '最新原文', markdown: '# 第二版\n<script>window.bad=1</script>\n![远程图](https://example.com/x.png)', version: 'v2', truncated: false },
  }
  try {
    await ui.render(<DocumentCard node={{ id: 'doc', type: 'file', file: 'A.md', x: 0, y: 0, width: 200, height: 200,
      ready: { kind: 'document', ref: { kind: 'page', id: 'page' } } }} source={source} open={async ref => { if ('id' in ref) opened = ref.id }} />)
    await act(async () => refresh())
    assert.match(document.body.textContent!, /最新原文/)
    await act(async () => resolveOld({ ref: { kind: 'page', id: 'page' }, title: '迟到旧版', markdown: 'old', version: 'v1', truncated: false }))
    assert.doesNotMatch(document.body.textContent!, /迟到旧版/)
    assert.equal(document.querySelectorAll('script,img,iframe,[contenteditable]').length, 0)
    await ui.click('打开'); assert.equal(opened, 'page')
  } finally { await ui.close() }
})

test('link failure retains its original address and text cards use the shared editor', async () => {
  const ui = await mount()
  try {
    const opened: string[] = []
    await ui.render(<><LinkCard node={{ id: 'link', type: 'link', url: 'https://example.com/original', x: 0, y: 0, width: 200, height: 100, ready: { kind: 'link' } }}
      source={{ read: async () => { throw new Error('离线') } }} open={() => opened.push('link')} /><TextCard node={text('one')} commit={async () => true} /></>)
    assert.match(document.body.textContent!, /https:\/\/example.com\/original/)
    assert.match(document.body.textContent!, /离线/)
    await ui.click('在浏览器中打开'); assert.deepEqual(opened, ['link'], 'a failed preview still opens the page')
    assert.ok(document.querySelector('[data-ready-block-editor] [contenteditable="true"]'))
    // Main's private-network refusal reads as a plain reason (W4 §2.2 O16).
    await ui.render(<LinkCard node={{ id: 'lan', type: 'link', url: 'https://intranet.example/', x: 0, y: 0, width: 200, height: 100, ready: { kind: 'link' } }}
      source={{ read: async () => { throw new Error('Private network address rejected') } }} />)
    assert.match(document.body.textContent!, /这个地址是内网地址，没有抓取预览/)
  } finally { await ui.close() }
})

test('canvas save uses the real SaveToPicker, maps the not-yet-created X folder to its parent, and forwards keep-card choice', async () => {
  const ui = await mount(), requests: DraftFinalizeInput[] = []
  let refreshed = 0
  const unused = async (): Promise<never> => { throw new Error('unexpected API call') }
  const draft = DocumentDraftSchema.parse({ draftId: 'draft', tabId: 'tab', vaultRoot: '/vault', revision: 1, content: 'body', contentHash: 'a'.repeat(64),
    origin: 'canvas', objectId: null, baseVersion: null, suggestedParent: 'board', sourceCanvas: { objectId: 'board', nodeId: 'card' },
    attachments: [], title: '成文', state: 'editing', finalize: null, createdAt: 0, updatedAt: 0 })
  try {
    await ui.render(<CanvasCompositionSurface canvas={{ ready: { schemaVersion: 1, id: 'board' }, edges: [], nodes: [{ ...text('card'), ready: { kind: 'draft', draftId: 'draft', draftLibraryId: 'library' } }] }}
      version={'a'.repeat(64)} path="/vault/X.canvas" tabId="tab" trees={[]} onOperations={() => {}}
      composition={{ compose: unused, recover: unused, preview: unused }} documentPreview={{ read: unused, subscribe: () => () => {} }}
      refreshCanvas={async () => { refreshed++ }} openDraft={unused}
      drafts={{ create: unused, save: unused, list: unused, discard: unused, importLegacy: unused, read: async () => ({ ok: true, value: draft }),
        finalize: async (draftId, revision, input) => { requests.push(input); return { ok: true, value: {
          draftId, revision, operationId: input.operationId, objectId: 'page', path: '/vault/X/成文.md', contentHash: 'b'.repeat(64), parentObjectId: 'board',
        } } } }} />)
    await ui.click('保存到…')
    assert.match(document.querySelector('[aria-label="最终路径"]')!.textContent!, /\/vault\/X\/成文.md/)
    await act(async () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    await ui.click('确认')
    assert.equal(requests.length, 1)
    assert.equal(requests[0].parentObjectId, 'board'); assert.equal(requests[0].parentPath, undefined)
    assert.equal(requests[0].keepDocumentCard, false); assert.equal(requests[0].title, '成文')
    assert.equal(refreshed, 1); assert.equal(document.querySelector('[role="dialog"]'), null)
  } finally { await ui.close() }
})
