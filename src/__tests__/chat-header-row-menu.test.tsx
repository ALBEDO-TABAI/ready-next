import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
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

const domHandle = installDomGlobals()
process.on('exit', () => {
  try { domHandle.restore() } catch { /* silent-catch: best-effort restore */ }
})

const ChatHeaderModule = await import('../renderer/components/agent/ChatHeader')
const ChatHeader = ChatHeaderModule.default

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
  const root = createRoot(container)
  flushSync(() => {
    root.render(createElement(ChatHeader, {
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
    }))
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
