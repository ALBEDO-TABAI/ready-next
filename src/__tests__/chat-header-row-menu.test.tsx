import assert from 'node:assert/strict'
import test from 'node:test'
import { Fragment, createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import type { SessionRecallHit } from '../shared/session-recall'

function installDomGlobals(): { dom: JSDOM; restore: () => void } {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })

  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement,
    Node: (globalThis as { Node?: typeof Node }).Node,
    Event: (globalThis as { Event?: typeof Event }).Event,
    MouseEvent: (globalThis as { MouseEvent?: typeof MouseEvent }).MouseEvent,
    Element: (globalThis as { Element?: typeof Element }).Element,
    MutationObserver: (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver,
    ResizeObserver: globalThis.ResizeObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    getComputedStyle: globalThis.getComputedStyle,
    navigator: (globalThis as { navigator?: Navigator }).navigator,
  }

  function setGlobal<K extends keyof typeof previous>(key: K, value: unknown) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }

  setGlobal('window', dom.window)
  setGlobal('document', dom.window.document)
  setGlobal('HTMLElement', dom.window.HTMLElement)
  setGlobal('Node', dom.window.Node)
  setGlobal('Event', dom.window.Event)
  setGlobal('MouseEvent', dom.window.MouseEvent)
  setGlobal('Element', dom.window.Element)
  setGlobal('MutationObserver', dom.window.MutationObserver)
  setGlobal('ResizeObserver', class {
    constructor(private callback: () => void) {}
    observe(element: Element) { resizeCallbacks.set(element, this.callback) }
    disconnect() { for (const [element, callback] of resizeCallbacks) if (callback === this.callback) resizeCallbacks.delete(element) }
  })
  setGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 0
  })
  setGlobal('cancelAnimationFrame', () => undefined)
  setGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window))
  setGlobal('navigator', dom.window.navigator)
  const htmlElementPrototype = dom.window.HTMLElement.prototype as unknown as Record<string, unknown>
  htmlElementPrototype.attachEvent ??= () => undefined
  htmlElementPrototype.detachEvent ??= () => undefined

  return {
    dom,
    restore: () => {
      for (const key of Object.keys(previous) as Array<keyof typeof previous>) {
        const previousValue = previous[key]
        if (previousValue === undefined) {
          delete (globalThis as unknown as Record<string, unknown>)[key]
        } else {
          Object.defineProperty(globalThis, key, {
            value: previousValue,
            configurable: true,
            writable: true,
          })
        }
      }
      try { dom.window.close() } catch { /* silent-catch: jsdom close best-effort */ }
    },
  }
}

const resizeCallbacks = new Map<Element, () => void>()
const domHandle = installDomGlobals()
process.on('exit', () => {
  try { domHandle.restore() } catch { /* silent-catch: best-effort restore */ }
})

const ChatHeaderModule = await import('../renderer/components/agent/ChatHeader')
const ChatHeader = ChatHeaderModule.default
// The operation menu (openMenu) and the rename / delete dialogs render in the app's one float host.
const { FloatHost } = await import('../renderer/components/ui')
// V17: the header's buttons render into the shell's corner element and its title row into the panel's header cell.
const { ShellAssistantToolsContext } = await import('../renderer/modules/workbench/shell/assistant-tools-slot')

const localChannel = {
  key: 'local:app',
  sourceKind: 'local' as const,
  sourceId: 'app',
  label: '本地会话',
  caption: '本地会话',
}

const recallHit: SessionRecallHit = {
  conversationId: 'conv-1',
  lineageRootId: 'conv-1',
  resumeTitle: '继续测试会话',
  title: '测试会话',
  sourceKind: 'local',
  sourceId: 'app',
  threadKey: 'conv-1',
  matchedBy: ['recent'],
  score: 1,
  hitExcerpt: '摘要',
  latestTaskTitle: null,
  latestTaskSummary: null,
  attachmentNames: [],
  updatedAt: '2026-06-17T07:00:00.000Z',
  sessionStatus: 'done',
}

type ChatHeaderProps = Parameters<typeof ChatHeader>[0]

function mountChatHeader(
  overrides: Partial<ChatHeaderProps> = {},
): { root: Root; container: HTMLElement; unmount: () => void } {
  const host = document.getElementById('root')
  if (!host) throw new Error('missing root')
  host.innerHTML = ''
  const container = document.createElement('div')
  host.appendChild(container)
  const reactHost = document.createElement('div')
  const rowSlot = document.createElement('div')
  const toolsSlot = document.createElement('div')
  container.append(reactHost, rowSlot, toolsSlot)
  const root = createRoot(reactHost)
  flushSync(() => {
    root.render(createElement(Fragment, null, createElement(FloatHost), createElement(ShellAssistantToolsContext.Provider, { value: toolsSlot }, createElement(ChatHeader, {
      panelOpen: true,
      rowSlot,
      currentChannel: localChannel,
      channelOptions: [localChannel],
      // Empty query → the expanded list renders this channel's live sessions.
      sessionsByChannelKey: { [localChannel.key]: [recallHit] },
      onChannelSelect: () => undefined,
      onNewSession: () => undefined,
      onLoadConversation: () => undefined,
      onDeleteConversation: () => undefined,
      onRenameConversation: () => undefined,
      sessionRecallQuery: '',
      sessionRecallResults: [recallHit],
      sessionRecallSearching: false,
      sessionRecallError: null,
      attachedSessionRecallCount: 0,
      attachedSessionRecallConversationIds: [],
      onSessionRecallQueryChange: () => undefined,
      onSessionRecallSearch: () => undefined,
      onAttachSessionRecall: () => undefined,
      sessionTitle: '当前会话',
      formatTime: () => '刚刚',
      ...overrides,
    }))))
  })
  return {
    root,
    container,
    unmount: () => {
      try { root.unmount() } catch { /* silent-catch: unmount best-effort */ }
      try { host.removeChild(container) } catch { /* silent-catch: detach best-effort */ }
    },
  }
}

function click(element: Element) {
  flushSync(() => {
    element.dispatchEvent(new domHandle.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

function findButtonByText(label: string): HTMLButtonElement | null {
  return Array.from(document.querySelectorAll('button'))
    .find((button) => button.textContent?.trim() === label) ?? null
}

test('both history entry points and row actions stay inside the chat pane after pane resize', () => {
  const { container, unmount } = mountChatHeader()
  container.dataset.chatPanelRoot = 'true'
  let paneLeft = 704
  const rect = (left: number, top: number, width: number, height: number) => (
    new domHandle.dom.window.DOMRect(left, top, width, height)
  )
  container.getBoundingClientRect = () => rect(paneLeft, 40, 1024 - paneLeft, 700)
  const scope = container.querySelector<HTMLButtonElement>('button[title="会话来源"]')!
  const title = container.querySelector<HTMLButtonElement>('[data-chat-session-title] button')!
  scope.getBoundingClientRect = () => rect(890, 48, 24, 24)
  title.getBoundingClientRect = () => rect(paneLeft + 14, 48, 100, 24)
  const assertContained = (menu: HTMLElement) => {
    const left = Number.parseFloat(menu.style.left)
    const width = Number.parseFloat(menu.style.width)
    assert.ok(left >= paneLeft + 8, `left ${left} must stay inside pane ${paneLeft}`)
    assert.ok(left + width <= 1016, 'menu must stay inside the pane right edge')
    assert.ok(width > 0)
  }
  try {
    for (const trigger of [scope, title]) {
      click(trigger)
      const history = document.querySelector('input')!.closest<HTMLElement>('[data-chat-header-menu]')!
      assert.ok(history)
      assertContained(history)
      paneLeft = 784
      flushSync(() => resizeCallbacks.get(container)?.())
      assertContained(history)
      const rowTrigger = document.querySelector<HTMLButtonElement>('[aria-label="更多操作"]')!
      rowTrigger.getBoundingClientRect = () => rect(830, 180, 20, 20)
      click(rowTrigger)
      assertContained(findButtonByText('重命名')!.closest<HTMLElement>('[data-chat-header-menu]')!)
      click(trigger)
      assert.equal(document.querySelector('[data-chat-header-menu]'), null)
      paneLeft = 704
    }
  } finally { unmount() }
})

test('chat header row menu stays open when the history panel scrolls and can open rename', () => {
  const { unmount } = mountChatHeader()
  try {
    const historyButton = document.querySelector('button[title="会话来源"]')
    assert.ok(historyButton, 'history/source button is rendered')
    click(historyButton)

    const rowMenuButton = document.querySelector('button[aria-label="更多操作"]')
    assert.ok(rowMenuButton, 'row more menu button is rendered')
    click(rowMenuButton)

    assert.ok(findButtonByText('重命名'), 'rename action is visible after opening row menu')
    assert.ok(findButtonByText('删除'), 'delete action is visible after opening row menu')

    const scrollContainer = document.querySelector('.panel-hover-scrollbar')
    assert.ok(scrollContainer, 'history panel scroll container is rendered')
    flushSync(() => {
      scrollContainer.dispatchEvent(new domHandle.dom.window.Event('scroll', { bubbles: true, cancelable: true }))
    })

    const renameButton = findButtonByText('重命名')
    assert.ok(renameButton, 'rename action stays visible after panel scroll/reposition')
    click(renameButton)

    assert.match(document.body.textContent ?? '', /为这个会话取一个新名称/)
  } finally {
    unmount()
  }
})

test('row rename and delete go through the shared dialog and reach the callbacks', async () => {
  const renamed: Array<[string, string]> = []
  const deleted: string[] = []
  const { unmount } = mountChatHeader({
    onRenameConversation: (id, title) => { renamed.push([id, title]) },
    onDeleteConversation: (id) => { deleted.push(id) },
  })
  const openRowMenu = () => {
    click(document.querySelector('button[title="会话来源"]')!)
    click(document.querySelector('button[aria-label="更多操作"]')!)
  }
  try {
    openRowMenu()
    click(findButtonByText('重命名')!)
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input[aria-label="会话名称"]')
    assert.ok(input, 'the rename dialog carries a name field')
    assert.equal(input.value, '测试会话')
    flushSync(() => {
      const setValue = Object.getOwnPropertyDescriptor(domHandle.dom.window.HTMLInputElement.prototype, 'value')!.set!
      setValue.call(input, '  新名字  ')
      input.dispatchEvent(new domHandle.dom.window.Event('input', { bubbles: true }))
      // react-dom loads before this file installs the DOM, so it reads text edits through its keyup fallback.
      input.dispatchEvent(new domHandle.dom.window.KeyboardEvent('keyup', { key: 'a', bubbles: true }))
    })
    click(findButtonByText('保存')!)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(renamed, [['conv-1', '新名字']])
    assert.equal(document.querySelector('[role="dialog"]'), null)

    openRowMenu()
    click(findButtonByText('删除')!)
    assert.match(document.querySelector('[role="dialog"]')?.textContent ?? '', /确定删除会话 "测试会话" 吗？此操作不可撤销。/)
    click(findButtonByText('删除')!)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(deleted, ['conv-1'])
  } finally {
    unmount()
  }
})

test('chat header menus and dialogs are the shared float primitives (W1 DL4)', async () => {
  const { unmount } = mountChatHeader({
    currentConversationAvailable: true,
    lifecyclePendingAction: null,
    lifecycleUncertainty: null,
    lifecycleActions: {
      stop: { availability: 'not_applicable', blockers: ['no_active_operation'], requestRef: null },
      reset: { availability: 'ready', blockers: [], requestRef: null },
      close: { availability: 'ready', blockers: [], requestRef: null },
      manual_compact: { availability: 'ready', blockers: [], requestRef: null },
    },
  })
  try {
    // The operation menu is openMenu in the one float host; a second click on its trigger closes it.
    const operations = document.querySelector<HTMLButtonElement>('button[title="当前对话操作"]')!
    click(operations)
    const operationMenu = document.querySelector('[data-float-id="chat-header-operations"]')
    assert.ok(operationMenu?.classList.contains('rn-float'))
    assert.ok(operationMenu?.querySelector('[role="menu"].rn-menu'))
    click(operations)
    assert.equal(document.querySelector('[data-float-id="chat-header-operations"]'), null)

    // The history menu sits on the float material; its row menu is the shared MenuList.
    click(document.querySelector('button[title="会话来源"]')!)
    assert.ok(document.querySelector('[data-chat-header-menu="history"]')?.classList.contains('rn-float'))
    click(document.querySelector('button[aria-label="更多操作"]')!)
    const rowMenu = document.querySelector('[data-chat-header-menu="row"]')
    assert.ok(rowMenu?.classList.contains('rn-float'))
    assert.deepEqual([...rowMenu!.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent), ['重命名', '删除'])
    assert.equal(rowMenu!.querySelector('[role="menuitem"]:last-child')?.getAttribute('data-danger'), 'true')

    // Delete asks through the shared confirm dialog.
    click(findButtonByText('删除')!)
    const dialog = document.querySelector('[role="dialog"]')
    assert.ok(dialog?.classList.contains('rn-dialog'))
    assert.equal(dialog?.getAttribute('aria-modal'), 'true')
    click(findButtonByText('取消')!)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(document.querySelector('[role="dialog"]'), null)
  } finally {
    unmount()
  }
})

test('history row shows a changed responsible agent beside time without adding a header indicator', () => {
  const reassigned = { ...recallHit, agentId: 'butler', activeAgentId: 'analyst' }
  const { unmount } = mountChatHeader({
    sessionsByChannelKey: { [localChannel.key]: [reassigned] },
    formatAgentName: (agentId) => agentId === 'analyst' ? '智识' : agentId,
  })
  try {
    const historyButton = document.querySelector('button[title="会话来源"]')
    assert.ok(historyButton)
    click(historyButton)
    assert.equal(document.querySelector('[data-chat-session-responsible-agent="true"]')?.textContent, '智识')
    assert.equal(document.querySelector('[data-chat-agent-responsibility="true"]'), null)
  } finally {
    unmount()
  }
})

test('compaction uncertainty keeps reset available while disabling another compaction', () => {
  let resetCalls = 0
  let compactCalls = 0
  const { unmount } = mountChatHeader({
    currentConversationAvailable: true,
    lifecyclePendingAction: null,
    lifecycleUncertainty: 'compaction',
    lifecycleActions: {
      stop: { availability: 'not_applicable', blockers: ['no_active_operation'], requestRef: null },
      reset: { availability: 'ready', blockers: [], requestRef: null },
      close: { availability: 'ready', blockers: [], requestRef: null },
      manual_compact: {
        availability: 'blocked',
        blockers: ['manual_compaction_unknown'],
        requestRef: null,
      },
    },
    onResetCurrentConversation: () => { resetCalls += 1 },
    onCompactCurrentSession: () => { compactCalls += 1 },
  })
  try {
    const operationButton = document.querySelector(
      'button[title="压缩状态待确认，可重置当前对话"]',
    )
    assert.ok(operationButton)
    assert.equal((operationButton as HTMLButtonElement).disabled, false)
    click(operationButton)

    // The shared menu marks an unavailable item aria-disabled and ignores it.
    const resetButton = findButtonByText('重置当前对话')
    const compactButton = findButtonByText('压缩上下文')
    assert.ok(resetButton)
    assert.ok(compactButton)
    assert.equal(compactButton.getAttribute('aria-disabled'), 'true')
    click(compactButton)
    assert.equal(compactCalls, 0)
    click(resetButton)
    assert.equal(resetCalls, 1)
    assert.equal(compactCalls, 0)
  } finally {
    unmount()
  }
})

test('one channel expands into every distinct session — each remote /new is selectable', () => {
  const wechatChannel = {
    key: 'channel:wechat-bot',
    sourceKind: 'channel' as const,
    sourceId: 'wechat-bot',
    label: '微信会话',
    caption: '微信频道',
  }
  // Two scopes share one channel (same sourceId) but are distinct sessions —
  // exactly what two `/new` commands in one IM thread produce.
  const makeSession = (id: string, title: string): SessionRecallHit => ({
    conversationId: id,
    lineageRootId: id,
    resumeTitle: title,
    title,
    sourceKind: 'channel',
    sourceId: 'wechat-bot',
    threadKey: id,
    matchedBy: ['recent'],
    score: 0,
    attachmentNames: [],
    updatedAt: '2026-06-23T00:00:00.000Z',
    sessionStatus: null,
  })
  const sessionNew = makeSession('conv-new', '最新会话')
  const sessionOld = makeSession('conv-old', '较早会话')

  const selected: string[] = []
  const { unmount } = mountChatHeader({
    currentChannel: wechatChannel,
    channelOptions: [wechatChannel],
    sessionsByChannelKey: { [wechatChannel.key]: [sessionNew, sessionOld] },
    sessionRecallResults: [],
    onLoadConversation: (id) => selected.push(id),
  })
  try {
    const historyButton = document.querySelector('button[title="会话来源"]')
    assert.ok(historyButton, 'history/source button is rendered')
    click(historyButton)

    const text = document.body.textContent ?? ''
    assert.match(text, /最新会话/, 'the freshly created session is listed')
    assert.match(text, /较早会话/, 'the earlier session is still listed as a distinct row')

    const newRow = Array.from(document.querySelectorAll('button')).find(
      (button) => (button.textContent ?? '').includes('最新会话'),
    )
    assert.ok(newRow, 'each session is an individually selectable row')
    click(newRow)
    assert.deepEqual(selected, ['conv-new'], 'selecting a session loads that exact conversation')
  } finally {
    unmount()
  }
})
