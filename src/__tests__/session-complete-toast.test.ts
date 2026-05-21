import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'

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
    CustomEvent: (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent,
    KeyboardEvent: (globalThis as { KeyboardEvent?: typeof KeyboardEvent }).KeyboardEvent,
    MouseEvent: (globalThis as { MouseEvent?: typeof MouseEvent }).MouseEvent,
    Element: (globalThis as { Element?: typeof Element }).Element,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    matchMedia: (globalThis as { matchMedia?: (q: string) => MediaQueryList }).matchMedia,
    getComputedStyle: globalThis.getComputedStyle,
    navigator: (globalThis as { navigator?: Navigator }).navigator,
    localStorage: (globalThis as { localStorage?: Storage }).localStorage,
  }

  function setGlobal<K extends keyof typeof previous>(key: K, value: unknown) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }

  setGlobal('window', dom.window)
  setGlobal('document', dom.window.document)
  setGlobal('HTMLElement', dom.window.HTMLElement)
  setGlobal('Node', dom.window.Node)
  setGlobal('Event', dom.window.Event)
  setGlobal('CustomEvent', dom.window.CustomEvent)
  setGlobal('KeyboardEvent', dom.window.KeyboardEvent)
  setGlobal('MouseEvent', dom.window.MouseEvent)
  setGlobal('Element', dom.window.Element)
  setGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 0
  })
  setGlobal('cancelAnimationFrame', () => undefined)
  setGlobal('matchMedia', (_query: string) => ({
    matches: false,
    media: '',
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  }))
  setGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window))
  setGlobal('navigator', dom.window.navigator)
  setGlobal('localStorage', dom.window.localStorage)

  return {
    dom,
    restore: () => {
      for (const key of Object.keys(previous) as Array<keyof typeof previous>) {
        const previousValue = previous[key]
        if (previousValue === undefined) {
          delete (globalThis as unknown as Record<string, unknown>)[key as string]
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

const { useAgent } = await import('../renderer/stores/useAgent')
const SessionCompleteToastModule = await import('../renderer/components/agent/chat-panel/session-tabs/SessionCompleteToast')
const SessionCompleteToast = SessionCompleteToastModule.default

interface MountResult {
  container: HTMLElement
  root: Root
  unmount: () => void
}

function mountSessionCompleteToast(): MountResult {
  const document = globalThis.document
  const host = document.getElementById('root')
  if (!host) throw new Error('jsdom root element missing')
  host.innerHTML = ''
  const container = document.createElement('div')
  host.appendChild(container)
  const root = createRoot(container)
  flushSync(() => {
    root.render(createElement(SessionCompleteToast))
  })
  return {
    container,
    root,
    unmount: () => {
      try { root.unmount() } catch { /* silent-catch: unmount best-effort */ }
      try { host.removeChild(container) } catch { /* silent-catch: detach best-effort */ }
    },
  }
}

function makeSlice(state: 'live' | 'done' | 'error' | 'cancelled' | 'closed' = 'live') {
  return {
    pendingSendCount: 0,
    pendingSendFlushAt: null,
    state,
    conversationId: null,
    inputValue: '',
  }
}

function resetSessions(activeSessionId: string, sessionOrder: string[]) {
  useAgent.setState({
    sessions: Object.fromEntries(sessionOrder.map((id) => [id, makeSlice('live')])),
    activeSessionId,
    sessionOrder,
    inputValue: '',
    pendingSendCount: 0,
    pendingSendFlushAt: null,
  })
}

function setSessionState(sessionId: string, state: 'live' | 'done' | 'error' | 'cancelled' | 'closed') {
  useAgent.setState((current) => ({
    sessions: {
      ...current.sessions,
      [sessionId]: {
        ...(current.sessions[sessionId] ?? makeSlice('live')),
        state,
      },
    },
  }))
}

async function flushEffects() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

test('V3.4b case 1 — active session completes: no toast', async () => {
  resetSessions('session-A', ['session-A', 'session-B'])
  const { container, unmount } = mountSessionCompleteToast()
  try {
    await flushEffects()
    flushSync(() => {
      setSessionState('session-A', 'done')
    })
    await flushEffects()
    assert.equal(
      container.querySelector('[data-testid="session-complete-toast"]'),
      null,
      'active session completion should not produce a toast',
    )
  } finally {
    unmount()
  }
})

test('V3.4b case 2 — background session completes: toast appears with label and kind', async () => {
  resetSessions('session-A', ['session-A', 'session-B'])
  const { container, unmount } = mountSessionCompleteToast()
  try {
    await flushEffects()
    flushSync(() => {
      setSessionState('session-B', 'done')
    })
    await flushEffects()
    const toast = container.querySelector('[data-testid="session-complete-toast"]')
    assert.ok(toast, 'background completion should produce a toast')
    assert.equal(toast!.getAttribute('data-session-toast-id'), 'session-B')
    assert.equal(toast!.getAttribute('data-session-toast-kind'), 'done')
    assert.match(toast!.textContent || '', /会话 2/)
    assert.match(toast!.textContent || '', /已完成/)
  } finally {
    unmount()
  }
})

test('V3.4b case 3 — click toast switches active session and dismisses toast', async () => {
  resetSessions('session-A', ['session-A', 'session-B'])
  const { container, unmount } = mountSessionCompleteToast()
  try {
    await flushEffects()
    flushSync(() => {
      setSessionState('session-B', 'error')
    })
    await flushEffects()
    const toast = container.querySelector('[data-testid="session-complete-toast"]') as HTMLButtonElement | null
    assert.ok(toast, 'toast rendered before click')
    flushSync(() => {
      toast!.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true }))
    })
    await flushEffects()
    assert.equal(useAgent.getState().activeSessionId, 'session-B')
    assert.equal(
      container.querySelector('[data-testid="session-complete-toast"]'),
      null,
      'toast dismissed after click',
    )
  } finally {
    unmount()
  }
})

test('V3.4b case 4 — multiple background completions keep latest 3 toasts', async () => {
  resetSessions('session-A', ['session-A', 'session-B', 'session-C', 'session-D', 'session-E'])
  const { container, unmount } = mountSessionCompleteToast()
  try {
    await flushEffects()
    flushSync(() => {
      useAgent.setState((current) => ({
        sessions: {
          ...current.sessions,
          'session-B': { ...current.sessions['session-B'], state: 'done' },
          'session-C': { ...current.sessions['session-C'], state: 'error' },
          'session-D': { ...current.sessions['session-D'], state: 'cancelled' },
          'session-E': { ...current.sessions['session-E'], state: 'done' },
        },
      }))
    })
    await flushEffects()
    const toasts = Array.from(container.querySelectorAll('[data-testid="session-complete-toast"]'))
    assert.equal(toasts.length, 3, 'visible toast queue is capped at 3')
    assert.deepEqual(
      toasts.map((toast) => toast.getAttribute('data-session-toast-id')),
      ['session-C', 'session-D', 'session-E'],
      'oldest toast is dropped first when the queue overflows',
    )
  } finally {
    unmount()
  }
})
