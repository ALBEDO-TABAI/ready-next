import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { act } from 'react'
import { JSDOM } from 'jsdom'
import type { BrowserTab } from '../renderer/stores/useBrowserTabs'
import type { BrowserUserAttention } from '../shared/browser-user-attention'
import type { BrowserDownloadReceipt } from '../shared/browser-download-receipt'
import type { BrowserTaskRecord } from '../renderer/modules/browser/browser-task-work'
import { importWithoutAssets as importWithoutStyles } from './utils/import-without-styles'

// W7 T7/T8 interface: the band above a page that needs the person, the assistant's work tabs as their own group in the
// browser sidebar, and the task card with downloaded files as reference capsules. Real components; callbacks recorded.

const { default: BrowserTabList } = await importWithoutStyles(() => import('../renderer/components/browser/BrowserTabList'))
const { BrowserTaskBand } = await importWithoutStyles(() => import('../renderer/components/browser/BrowserTaskBand'))
const { BrowserTaskCardView } = await importWithoutStyles(() => import('../renderer/components/agent/chat-panel/task/BrowserTaskCard'))
const { default: BrowserShellLayout } = await importWithoutStyles(() => import('../renderer/components/browser/BrowserShellLayout'))
const { buildBrowserTaskTabGroups } = await importWithoutStyles(() => import('../renderer/modules/browser/useBrowserTaskShell'))

const tab = (id: string, title: string, extra: Partial<BrowserTab> = {}): BrowserTab => ({
  id, title, url: `https://${id}.example.com/`, loading: false, canGoBack: false, canGoForward: false, ...extra,
})

function attention(reason: BrowserUserAttention['reason'], tabId: string | null = 'b'): BrowserUserAttention {
  return {
    id: 'att-1', reason, tabId, physicalTargetToken: tabId ? 'token' : null, status: 'needs_user',
    browserTaskId: 'bt-1', parentTaskId: 'task-1', ownerRunId: 'run-1',
    action: { kind: 'send_user_input', label: { login: '我处理好了，继续', captcha: '我处理好了，继续', takeover: '让助手接着做', review_rejected: '重新尝试' }[reason], text: 'fixed' },
  }
}

function task(extra: Partial<BrowserTaskRecord> = {}): BrowserTaskRecord {
  return {
    browserTaskId: 'bt-1', seenAt: 1, parentTaskId: 'task-1', ownerRunId: 'run-1', scopeId: 'scope-a', title: '调研印厂报价',
    tabIds: ['b', 'c'], heldTabIds: [], attention: null, receipts: [], ...extra,
  }
}

const receipt = (name: string, size: number): BrowserDownloadReceipt => ({
  receiptId: `r-${name}`, browserTaskId: 'bt-1', ownerRunId: 'run-1', path: `/vault/下载/${name}`, size, sha256: 'a'.repeat(64),
  sourceUrl: `http://127.0.0.1/${name}`, readyRef: { kind: 'file', id: `obj-${name}` }, readyUri: `ready://doc/file/obj-${name}`,
})

async function mount(t: TestContext) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('root')!)
  t.after(async () => {
    await act(async () => root.unmount())
    dom.window.close()
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  })
  const render = async (node: React.ReactNode) => { await act(async () => root.render(node)) }
  const click = async (element: Element, init: MouseEventInit = {}) => {
    await act(async () => { element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, ...init })) })
  }
  return { dom, body: dom.window.document.body, render, click }
}

test('the band says what is needed and offers the one button Main named', async t => {
  const { body, render, click } = await mount(t)
  const continued: string[] = []
  await render(<BrowserTaskBand task={task({ attention: attention('login') })} onContinue={() => continued.push('go')} />)
  const band = body.querySelector<HTMLElement>('[data-browser-task-band="bt-1"]')!
  assert.equal(band.getAttribute('aria-label'), '需要你来完成登录')
  assert.match(band.textContent ?? '', /登录好后点继续/)
  const button = band.querySelector('button')!
  assert.equal(button.textContent, '我处理好了，继续')
  await click(button)
  assert.deepEqual(continued, ['go'])

  await render(<BrowserTaskBand task={task({ attention: attention('takeover') })} action={{ attentionId: 'att-1', phase: 'sending' }} onContinue={() => continued.push('again')} />)
  const sending = body.querySelector<HTMLButtonElement>('[data-browser-task-band] button')!
  assert.equal(sending.textContent, '正在交给助手…')
  assert.equal(sending.disabled, true)
  await click(sending)
  assert.deepEqual(continued, ['go'], 'nothing is sent twice')

  await render(<BrowserTaskBand task={task({ attention: attention('review_rejected', null) })} action={{ attentionId: 'att-1', phase: 'refused', message: '当前模型配置无法使用，请在设置里检查供应商与模型后重试。' }} onContinue={() => {}} />)
  assert.equal(body.querySelector('[role="alert"]')?.textContent, '当前模型配置无法使用，请在设置里检查供应商与模型后重试。')
  assert.equal(body.querySelector('[data-browser-task-band] button')?.textContent, '重新尝试')
})

test('the band sits in the page column before the page, taking its own room rather than covering it', async t => {
  const { body, render } = await mount(t)
  const contentRef = { current: null as HTMLDivElement | null }
  await render(
    <BrowserShellLayout
      isElectron
      contentRef={contentRef}
      activeTab={tab('b', 'Beta')}
      toastVisible={false}
      onDragOver={() => {}}
      onDrop={() => {}}
      onRetry={() => {}}
      band={<BrowserTaskBand task={task({ attention: attention('login') })} onContinue={() => {}} />}
    />,
  )
  const band = body.querySelector<HTMLElement>('[data-browser-task-band]')!
  const page = contentRef.current!
  assert.ok(band.compareDocumentPosition(page) & 4, 'the page follows the band')
  assert.equal(band.parentElement, page.parentElement!.parentElement, 'band and page share the column')
  assert.equal(band.style.position, '', 'the band is in the flow, not laid over the page')
})

test('the sidebar lists the assistant’s tabs as their own groups with name and state; the person’s tabs stay as they are', async t => {
  const { body, render, click } = await mount(t)
  const log: string[] = []
  const tabs = [tab('a', 'Alpha'), tab('b', '印厂 A 报价页'), tab('d', 'Delta'), tab('c', '登录 · 印厂 C')]
  const tasks = {
    'bt-1': task({ tabIds: ['b', 'c'], attention: attention('login', 'c') }),
    'bt-2': task({ browserTaskId: 'bt-2', seenAt: 2, title: null, tabIds: ['gone'], ownerRunId: 'run-2' }),
  }
  const groups = buildBrowserTaskTabGroups(tasks, tabs, [])
  assert.equal(groups.length, 1, 'a task none of whose tabs are open is not listed')
  await render(
    <BrowserTabList
      tabs={tabs} tabGroups={[]} activeTabId="c" splitTabId={null}
      onTabClick={(id, event) => { log.push(`click:${id}:${event.shiftKey}`) }}
      onTabClose={id => { log.push(`close:${id}`) }}
      onNewTab={() => {}} onReorderToRank={(moved, rank, group) => { log.push(`reorder:${moved}:${rank}:${group}`) }}
      onCreateGroup={() => {}} onAddToGroup={() => {}} onRenameGroup={() => {}} onRecolorGroup={() => {}}
      onSetGroupCollapsed={() => {}} onDisbandGroup={() => {}} onDeleteGroup={() => {}} onNewTabInGroup={() => {}}
      taskGroups={groups}
      onCloseTaskTabs={id => { log.push(`close-all:${id}`) }}
    />,
  )
  const own = [...body.querySelectorAll('[aria-label="打开的标签页"] .browser-tab-list__label')].map(node => node.textContent)
  assert.deepEqual(own, ['Alpha', 'Delta'])
  const group = body.querySelector<HTMLElement>('[data-browser-task-group="bt-1"]')!
  assert.equal(group.getAttribute('aria-label'), '调研印厂报价，等你处理')
  assert.equal(group.querySelector('.browser-task-group__state')?.textContent, '等你处理')
  const rows = [...group.querySelectorAll<HTMLElement>('[data-browser-task-tab]')]
  assert.deepEqual(rows.map(row => row.querySelector('.browser-tab-list__label')?.textContent), ['印厂 A 报价页', '登录 · 印厂 C'])
  assert.equal(rows[1].hasAttribute('data-current'), true, 'the visible task tab is the current row')
  assert.equal(rows[1].querySelector('.browser-task-group__waiting')?.textContent, '等你处理')
  assert.deepEqual(rows.map(row => row.textContent), ['印厂 A 报价页', '登录 · 印厂 C等你处理'], 'a task tab is one line: its title, and the wait at its end')
  await click(rows[0])
  await click(group.querySelector('.browser-task-group__close')!)
  assert.deepEqual(log, ['click:b:false', 'close-all:bt-1'])

  // Dragging the person's tab after Delta still lands on the right flat rank: the hidden task tab b keeps its place.
  const dragged = body.querySelector<HTMLElement>('[aria-label="打开的标签页"] [role="listitem"]')!
  const target = [...body.querySelectorAll<HTMLElement>('[aria-label="打开的标签页"] [role="listitem"]')][1]
  const { dom } = { dom: { window: (globalThis as unknown as { window: Window }).window } }
  const transfer = { setData: () => {}, effectAllowed: '', dropEffect: '' }
  await act(async () => {
    const start = new dom.window.Event('dragstart', { bubbles: true }) as Event & { dataTransfer: unknown }
    start.dataTransfer = transfer
    dragged.dispatchEvent(start)
  })
  target.getBoundingClientRect = () => ({ top: 0, height: 40, left: 0, width: 200, bottom: 40, right: 200, x: 0, y: 0, toJSON: () => ({}) })
  await act(async () => {
    const over = new dom.window.MouseEvent('dragover', { bubbles: true, cancelable: true, clientY: 38 }) as MouseEvent & { dataTransfer: unknown }
    Object.defineProperty(over, 'dataTransfer', { value: transfer })
    target.dispatchEvent(over)
  })
  await act(async () => {
    const drop = new dom.window.MouseEvent('drop', { bubbles: true, cancelable: true }) as MouseEvent & { dataTransfer: unknown }
    Object.defineProperty(drop, 'dataTransfer', { value: transfer })
    target.dispatchEvent(drop)
  })
  assert.equal(log.at(-1), 'reorder:a:2:null', 'a lands after Delta, counting the hidden task tab before it')
})

test('the task card: the need with 打开页面 and the button; downloaded files as capsules with their size', async t => {
  const { body, render, click } = await mount(t)
  const log: string[] = []
  await render(
    <BrowserTaskCardView
      task={task({ attention: attention('captcha'), receipts: [receipt('report-2026-q3.csv', 1234), receipt('summary.pdf', 3_400_000)] })}
      onContinue={() => log.push('continue')}
      onOpenPage={() => log.push('open-page')}
    />,
  )
  const card = body.querySelector<HTMLElement>('[data-browser-task-card="bt-1"]')!
  assert.equal(card.querySelector('[role="region"]')?.getAttribute('aria-label'), '需要你来完成验证')
  const buttons = [...card.querySelectorAll('button')]
  assert.deepEqual(buttons.map(button => button.textContent), ['打开页面', '我处理好了，继续'])
  await click(buttons[0])
  await click(buttons[1])
  assert.deepEqual(log, ['open-page', 'continue'])
  const capsules = [...card.querySelectorAll<HTMLAnchorElement>('[data-browser-download-receipt] a[data-ready-ref-capsule]')]
  assert.deepEqual(capsules.map(capsule => [capsule.textContent, capsule.getAttribute('href'), capsule.dataset.refKind]), [
    ['report-2026-q3', 'ready://doc/file/obj-report-2026-q3.csv', 'file'],
    ['summary', 'ready://doc/file/obj-summary.pdf', 'file'],
  ])
  assert.deepEqual([...card.querySelectorAll('.rn-task-card__size')].map(node => node.textContent), ['CSV · 1.2 KB', 'PDF · 3.2 MB'])

  // Files alone: no need section, no buttons.
  await render(<BrowserTaskCardView task={task({ receipts: [receipt('a.csv', 10)] })} onContinue={() => {}} />)
  assert.equal(body.querySelector('[data-browser-task-card] [role="region"]'), null)
  assert.equal(body.querySelectorAll('[data-browser-task-card] button').length, 0)
  // Nothing to show: no card.
  await render(<BrowserTaskCardView task={task()} onContinue={() => {}} />)
  assert.equal(body.querySelector('[data-browser-task-card]'), null)
})

test('the conversation shows a one-click help message as its sentence; the task ids stay in the message for the assistant', async () => {
  const { readBrowserUserAttention, browserAttentionUserInput } = await import('../main/modules/browser-engine/browser-user-attention')
  const { browserHelpDisplayText } = await importWithoutStyles(() => import('../renderer/modules/browser/browser-task-copy'))
  const found = readBrowserUserAttention({ taskId: 'browser-task-1', parentTaskId: 'codex-task-1', createdByRunId: 'run-1',
    kind: 'browser_workflow', status: 'failed', progress: { total: 1, completed: 0, failed: 1, currentLabel: null } },
  { userAttention: { id: 'attention-1', reason: 'login', tabId: 'tab-1', physicalTargetToken: 'physical-1' } })!
  const { userMessage } = browserAttentionUserInput(found, { scopeId: 'scope-1', expectedMessageVisibilityEpoch: 0, actionAdmissionRef: {
    headProjectionDigest: 'a'.repeat(64), actionProjectionVersion: { scopeEpoch: 0, headGeneration: 1, actionProjectionSequence: 1 },
    actionHeadIdentity: { aliasId: 'scope-1', aliasGeneration: 1, threadBindingId: 'thread-1', headRevision: 1 } } })
  assert.ok(userMessage && userMessage.content.includes('browser-task-1'), 'Main keeps the reference for the assistant')
  const shown = browserHelpDisplayText(userMessage.content, userMessage.meta)
  assert.equal(shown, userMessage.content.split('\n')[0])
  assert.ok(shown && !shown.includes('browser-task-1') && !shown.includes('codex-task-1'))
  assert.equal(browserHelpDisplayText('原任务：别的\n第二行', {}), null, 'an ordinary message is shown as written')
})
