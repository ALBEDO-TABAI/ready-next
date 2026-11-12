import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { editorFixture } from './helpers/ready-block-editor-fixture'
import { importWithoutStyles } from './utils/import-without-styles'
import type { FastCardItem, FastCardTransferRequest } from '../shared/fastcard'
import type { ReadyRef } from '../shared/ready-ref'

// W6 §3.2: one bar for the four reading scenes. The real bar, capture wiring, stores, toast and page buffer run;
// only the process boundary (window.electronAPI) is an observable stand-in.
const selected: { ref: ReadyRef; title: string; text: string; pageUrl: string } = {
  ref: { kind: 'web', url: 'https://example.com/article' }, title: '网页标题', text: '选中的文字', pageUrl: 'https://example.com/article',
}

async function mountBar(t: test.TestContext) {
  // Registered before the editor fixture, so it runs while the fixture's DOM still exists.
  let cleanup = async () => {}
  t.after(() => cleanup())
  const f = await editorFixture(t, '正文')
  const customEvent = Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent')
  Object.assign(globalThis, { ResizeObserver: class { observe() {} disconnect() {} } })
  Object.defineProperty(globalThis, 'CustomEvent', { value: f.dom.window.CustomEvent, configurable: true, writable: true })
  const added: FastCardItem[] = [], removed: string[] = [], transfers: FastCardTransferRequest[] = [], undone: string[] = []
  let cards: FastCardItem[] = []
  Object.assign(f.dom.window, { electronAPI: {
    browser: {
      addFastCardItem: async (item: FastCardItem) => { added.push(item); cards = [item, ...cards]; return { success: true, data: item } },
      removeFastCardItem: async (id: string) => { removed.push(id); cards = cards.filter(card => card.id !== id); return { success: true } },
      listFastCardItems: async () => ({ success: true, data: cards }),
      getTabs: async () => [{ id: 'tab', url: 'https://example.com/article' }],
    },
    fastCard: {
      transfer: async (request: FastCardTransferRequest) => { transfers.push(request); cards = cards.filter(card => !request.itemIds.includes(card.id))
        return { success: true, data: { state: 'completed', operationId: request.operationId, objectId: 'board', title: '灵感', nodeIds: ['node'] } } },
      undo: async (operationId: string) => { undone.push(operationId); cards = [...added.filter(item => transfers.some(request => request.operationId === operationId && request.itemIds.includes(item.id))), ...cards]; return { success: true, data: { state: 'undone' } } },
      targets: async () => ({ success: true, data: [] }), pending: async () => ({ success: true, data: [] }),
    },
  } })
  const { ui, bar } = await importWithoutStyles(async () => ({
    ui: await import('../renderer/components/ui'),
    bar: await import('../renderer/modules/workbench/selection-bar/SelectionBar'),
  }))
  const { useAgent } = await import('../renderer/stores/useAgent')
  const { useFastCard } = await import('../renderer/stores/useFastCard')
  const agentBefore = useAgent.getState(), cardsBefore = useFastCard.getState()
  const host = document.createElement('div'); document.body.append(host)
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(host)
  const toastStore = await import('../renderer/components/ui/toast-store')
  const clearToasts = () => toastStore.getToasts().forEach(item => toastStore.dismissToast(item.id))
  clearToasts()
  cleanup = async () => {
    await act(async () => { clearToasts(); root.unmount() }); host.remove()
    useAgent.setState(agentBefore, true); useFastCard.setState(cardsBefore, true)
    Reflect.deleteProperty(globalThis, 'ResizeObserver')
    if (customEvent) Object.defineProperty(globalThis, 'CustomEvent', customEvent)
  }
  const settle = () => act(async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 5)) })
  const toast = () => [...document.querySelectorAll('.rn-toast')].at(-1)
  const toastAction = async (label: string) => {
    const button = [...toast()!.querySelectorAll('button')].find(item => item.textContent === label)
    assert.ok(button, label)
    await act(async () => button.click()); await settle()
  }
  return { f, ui, bar, root, added, removed, transfers, undone, useAgent, settle, toast, toastAction, buttons: () => [...host.querySelectorAll<HTMLButtonElement>('[data-ready-selection-bar] button')] }
}

test('the shared selection bar: fixed order and names, then 保存到画板 and the scene’s extras', async t => {
  const h = await mountBar(t)
  const ran: string[] = []
  await act(async () => h.root.render(<h.bar.SelectionBar read={() => selected} highlight={async () => { ran.push('划线') }}
    extras={[{ id: 'translate', label: '翻译', icon: null, run: () => { ran.push('翻译') } }]} />))
  assert.deepEqual(h.buttons().map(button => button.textContent), ['划线', '存入 FastCard', '引用到文档', '问 AI', '保存到画板', '翻译'])
  assert.equal(document.querySelector('[data-ready-selection-bar] [role="toolbar"]')?.getAttribute('aria-label'), '选中的文字')
  // A press keeps the reader's selection: the bar never takes focus away from the selected words.
  const down = new h.f.dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true })
  h.buttons()[1].dispatchEvent(down)
  assert.ok(down.defaultPrevented)
  await act(async () => h.buttons()[0].click()); await act(async () => h.buttons()[5].click())
  assert.deepEqual(ran, ['划线', '翻译'])
})

test('each bar action reaches its capture, and every toast’s 撤销 reverses it for real', async t => {
  const h = await mountBar(t)
  await act(async () => h.root.render(<><h.ui.ToastHost /><h.bar.SelectionBar read={() => selected} highlight={async () => {}} /></>))
  const click = async (label: string) => { await act(async () => h.buttons().find(button => button.textContent === label)!.click()); await h.settle() }

  await click('存入 FastCard')
  assert.equal(h.added.length, 1)
  assert.equal(h.added[0].text, '选中的文字')
  assert.deepEqual(h.added[0].source?.ref, selected.ref)
  assert.equal(h.added[0].source?.pageUrl, selected.pageUrl)
  assert.match(h.toast()!.textContent!, /已存入 FastCard.*撤销.*打开/)
  await h.toastAction('撤销')
  assert.deepEqual(h.removed, [h.added[0].id])

  await click('引用到文档')
  const content = () => h.f.useDocTabs.getState().tabs.find(tab => tab.id === t.name)!.content
  assert.match(content(), /> 选中的文字/)
  assert.match(content(), /\[网页标题\]\(ready:\/\/web\?url=https%3A%2F%2Fexample\.com%2Farticle\)/)
  assert.match(h.toast()!.textContent!, /已引用到《夹具》/)
  await h.toastAction('撤销')
  h.f.bytes('正文')

  await click('保存到画板')
  assert.equal(h.transfers.length, 1)
  assert.deepEqual(h.transfers[0].itemIds, [h.added[1].id])
  assert.equal(h.transfers[0].target, undefined, 'the last board, as FastCard’s own 保存到画板')
  assert.match(h.toast()!.textContent!, /已存到画板《灵感》/)
  await h.toastAction('撤销')
  assert.deepEqual(h.undone, [h.transfers[0].operationId])
  assert.deepEqual(h.removed.at(-1), h.added[1].id, 'the card the capture made leaves FastCard too')

  await click('问 AI')
  assert.equal(document.querySelector('.rn-toast[data-tone="bad"]'), null, '问 AI completes without an error')
  const agent = h.useAgent.getState()
  assert.ok(agent.attachments.some(item => item.source === 'browser-tab' && item.url === selected.pageUrl))
  assert.match(agent.inputValue, /> 选中的文字/)
})

test('a failed capture is reported in the toast and the bar stays usable', async t => {
  const h = await mountBar(t)
  let done = 0
  await act(async () => h.root.render(<><h.ui.ToastHost /><h.bar.SelectionBar read={() => null} highlight={async () => { throw new Error('网页已切换，请重新选择') }} onDone={() => { done++ }} /></>))
  await act(async () => h.buttons()[0].click()); await h.settle()
  assert.equal(h.toast()?.getAttribute('data-tone'), 'bad')
  assert.match(h.toast()!.textContent!, /网页已切换/)
  await act(async () => h.buttons()[1].click()); await h.settle()
  assert.match(document.querySelector('.rn-toast-stack')!.textContent!, /选区已经变了/)
  assert.equal(done, 0)
  assert.ok(h.buttons().every(button => !button.disabled))
})
