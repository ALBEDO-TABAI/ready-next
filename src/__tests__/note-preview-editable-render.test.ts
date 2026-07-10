import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

/**
 * 行为合同（预览内编辑 UI 接线）：editable 态下正文块渲染可编辑外壳与
 * 铅笔入口，点击进入就地编辑器（种子为源码原文），提交后以完整下一版
 * 全文回调 onApplyContentEdit；独立图片块可拖拽；末尾提供「添加文字」。
 * 非 editable 态不渲染任何编辑面。
 *
 * 注意：DOM globals 必须先于 React/组件导入安装（编辑器挂载时会 focus()，
 * React DOM 的事件系统需要在正确的 window 下初始化），故全部走动态导入。
 */

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
})
const globalKeys = ['window', 'document', 'HTMLElement', 'HTMLTextAreaElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'Element', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'] as const
const previousGlobals = new Map<string, unknown>()
for (const key of globalKeys) previousGlobals.set(key, (globalThis as Record<string, unknown>)[key])
const setGlobal = (key: string, value: unknown) => {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
}
setGlobal('window', dom.window)
setGlobal('document', dom.window.document)
setGlobal('HTMLElement', dom.window.HTMLElement)
setGlobal('HTMLTextAreaElement', dom.window.HTMLTextAreaElement)
setGlobal('Node', dom.window.Node)
setGlobal('Event', dom.window.Event)
setGlobal('MouseEvent', dom.window.MouseEvent)
setGlobal('KeyboardEvent', dom.window.KeyboardEvent)
setGlobal('Element', dom.window.Element)
setGlobal('navigator', dom.window.navigator)
setGlobal('IS_REACT_ACT_ENVIRONMENT', true)

process.on('exit', () => {
  for (const key of globalKeys) {
    const previousValue = previousGlobals.get(key)
    if (previousValue === undefined) {
      delete (globalThis as unknown as Record<string, unknown>)[key]
    } else {
      Object.defineProperty(globalThis, key, { value: previousValue, configurable: true, writable: true })
    }
  }
  try { dom.window.close() } catch { /* silent-catch: jsdom close best-effort */ }
})

const { default: React, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { default: NotePreview } = await import('../renderer/components/document/NotePreview')
type NotePreviewRoot = ReturnType<typeof createRoot>

function renderPreview(props: Record<string, unknown>): { container: HTMLElement; root: NotePreviewRoot } {
  const host = dom.window.document.getElementById('root') as HTMLElement
  host.innerHTML = ''
  const container = dom.window.document.createElement('div')
  host.appendChild(container)
  let root: NotePreviewRoot | null = null
  act(() => {
    root = createRoot(container)
    root.render(React.createElement(NotePreview, props))
  })
  return { container, root: root as unknown as NotePreviewRoot }
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(textarea, value)
  textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
}

test('NotePreview editable mode: pencil edit commits the full next document', () => {
  let applied: string | null = null
  const content = '第一段。\n\n![图](a.png)\n'
  const { container, root } = renderPreview({
    content,
    notePath: '/tmp/note.md',
    editable: true,
    onApplyContentEdit: (next: string) => { applied = next },
  })
  try {
    // 可编辑外壳 + 图片块可拖拽 + 末尾添加文字入口
    const shells = container.querySelectorAll('.note-preview-edit-block')
    assert.ok(shells.length >= 2, `expected editable shells, got ${shells.length}`)
    const draggableShells = container.querySelectorAll('.note-preview-edit-block[draggable="true"]')
    assert.equal(draggableShells.length, 1, 'the standalone image block is draggable')
    assert.ok(container.querySelector('.note-preview-append-trigger'), 'append trigger renders')

    // 点击铅笔 → 就地编辑器（种子=源码原文）
    const pencil = container.querySelector('.note-preview-edit-block__edit') as HTMLButtonElement
    assert.ok(pencil, 'pencil button renders on the text block')
    act(() => {
      pencil.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    const textarea = container.querySelector('.note-preview-edit-editor textarea') as HTMLTextAreaElement
    assert.ok(textarea, 'in-place editor opens')
    assert.equal(textarea.value, '第一段。')

    // 改写并提交 → 完整下一版全文回调，编辑器关闭
    act(() => {
      setTextareaValue(textarea, '第一段改好了。')
    })
    const confirm = Array.from(container.querySelectorAll('.note-preview-edit-editor__button'))
      .find((node) => node.textContent?.includes('完成')) as HTMLButtonElement
    assert.ok(confirm, 'confirm button renders')
    act(() => {
      confirm.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    assert.equal(applied, '第一段改好了。\n\n![图](a.png)\n')
    assert.equal(container.querySelector('.note-preview-edit-editor textarea'), null, 'editor closes after commit')
  } finally {
    act(() => { root.unmount() })
  }
})

test('NotePreview stays read-only without the editable flag', () => {
  const { container, root } = renderPreview({
    content: '第一段。\n\n![图](a.png)\n',
    notePath: '/tmp/note.md',
  })
  try {
    assert.equal(container.querySelectorAll('.note-preview-edit-block').length, 0)
    assert.equal(container.querySelectorAll('.note-preview-append-trigger').length, 0)
    assert.equal(container.querySelectorAll('[draggable="true"]').length, 0)
  } finally {
    act(() => { root.unmount() })
  }
})
