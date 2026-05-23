/**
 * Stage V V3.4a — SessionTabs UI behavior test.
 *
 * Mounts the SessionTabs component against the real `useAgent` store under
 * jsdom + createRoot + flushSync (same mount strategy as the V6 fixture
 * `chat-panel-baseline.test.ts`) and asserts four end-to-end scenarios:
 *
 *   1. Empty state — `sessionOrder.length === 0` renders nothing (the V6
 *      fixture-compatible cold-start path). No chips, no "+ 新建" button.
 *   2. Two sessions — two chips render plus the "+ 新建" button (enabled);
 *      clicking the inactive chip flips `activeSessionId`.
 *   3. Three sessions — three chips render and the "+ 新建" button is
 *      disabled (renderer-side hard limit from plan §4 V3.4).
 *   4. Close session — `closeSession(activeId)` drops the chip and the
 *      active id reroutes to the first remaining tab.
 *
 * Behavior tests over store actions only (no IPC, no preload). The test
 * uses `useAgent.getState()` to drive `createNewSession` / `closeSession`
 * for setup, and routes user-interaction assertions through real DOM
 * clicks dispatched onto the rendered chips.
 *
 * Plan: docs/superpowers/plans/2026-05-21-V-stage-v-comprehensive-implementation.md
 *   §4 V3.4
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'

// --- jsdom + globals must be installed BEFORE importing renderer code ---

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

// SessionTabs does not call electronAPI, but importing useAgent transitively
// touches `window.electronAPI?.settings` in `loadSendPreferences`; we never
// invoke that path from this test, so leaving the property undefined is
// safe — the store's setter never fires.

// --- dynamic imports AFTER globals are installed ---

const { useAgent } = await import('../renderer/stores/useAgent')
const SessionTabsModule = await import('../renderer/components/agent/chat-panel/session-tabs/SessionTabs')
const SessionTabs = SessionTabsModule.default

// --- mount helper -----------------------------------------------------------

interface MountResult {
  container: HTMLElement
  root: Root
  unmount: () => void
}

function mountSessionTabs(): MountResult {
  const document = globalThis.document
  const host = document.getElementById('root')
  if (!host) throw new Error('jsdom root element missing')
  host.innerHTML = ''
  const container = document.createElement('div')
  host.appendChild(container)
  const root = createRoot(container)
  flushSync(() => {
    root.render(createElement(SessionTabs))
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

function resetStoreToBootstrap() {
  // Mirror the cold-start initial shape: empty sessions Record, no active
  // session, empty sessionOrder. setState merges so unrelated fields
  // (agents/messages/etc) are kept at their default values from the
  // store factory.
  useAgent.setState({
    sessions: {},
    activeSessionId: null,
    sessionOrder: [],
    inputValue: '',
    pendingSendCount: 0,
    pendingSendFlushAt: null,
  })
}

// --- Case 1 — empty state renders nothing ---------------------------------

test('V3.4a case 1 — empty sessionOrder: nothing rendered (V6 fixture compatible)', () => {
  resetStoreToBootstrap()

  const { container, unmount } = mountSessionTabs()
  try {
    // The component must return `null` when sessionOrder is empty — no
    // strip wrapper, no new-button, nothing observable in the DOM.
    const strip = container.querySelector('[data-testid="session-tabs-strip"]')
    assert.equal(strip, null, 'no strip wrapper when sessionOrder is empty')
    const chips = container.querySelectorAll('[data-testid="session-tab-chip"]')
    assert.equal(chips.length, 0, 'no chips in empty state')
    const newBtn = container.querySelector('[data-testid="session-tab-new"]')
    assert.equal(newBtn, null, 'no "+ 新建" button in empty state — strip is null')
    // Container is empty (the React root rendered `null`).
    assert.equal(container.children.length, 0, 'container has no children in empty state')
  } finally {
    unmount()
  }
})

// --- Case 2 — 2 sessions: chips + new button + click switches active -----

test('V3.4a case 2 — two sessions: 2 chips + "+ 新建" enabled; click chip switches active', () => {
  resetStoreToBootstrap()
  // Seed via the production actions so we exercise the full
  // createNewSession path (which also seeds the slice + mirrors the
  // inputValue onto the top-level field). The first call sets
  // activeSessionId; the second leaves the second tab as active.
  const idA = useAgent.getState().createNewSession()
  const idB = useAgent.getState().createNewSession()
  assert.ok(idA, 'createNewSession #1 returns an id')
  assert.ok(idB, 'createNewSession #2 returns an id')
  assert.notEqual(idA, idB, 'session ids are distinct')

  const { container, unmount } = mountSessionTabs()
  try {
    const strip = container.querySelector('[data-testid="session-tabs-strip"]')
    assert.ok(strip, 'strip wrapper rendered with 2 sessions')

    const chips = container.querySelectorAll('[data-testid="session-tab-chip"]')
    assert.equal(chips.length, 2, 'two chips rendered')

    const newBtn = container.querySelector('[data-testid="session-tab-new"]') as HTMLButtonElement | null
    assert.ok(newBtn, '"+ 新建" button rendered')
    assert.equal(newBtn!.disabled, false, '"+ 新建" enabled when under 3-session limit')
    assert.equal(
      newBtn!.getAttribute('data-session-tab-new-disabled'),
      'false',
      'data-session-tab-new-disabled reflects enabled state',
    )

    // Active session is the second one created (createNewSession sets
    // active to the newly created id on every call).
    assert.equal(useAgent.getState().activeSessionId, idB, 'second creation is active')
    const activeChips = container.querySelectorAll('[data-session-tab-active="true"]')
    assert.equal(activeChips.length, 1, 'exactly one chip is marked active')
    assert.equal(
      (activeChips[0] as HTMLElement).getAttribute('data-session-tab-id'),
      idB,
      'active chip matches the newly-created session id',
    )

    // Click the first (inactive) chip — it should become active.
    const inactiveChip = Array.from(chips).find(
      (chip) => chip.getAttribute('data-session-tab-id') === idA,
    ) as HTMLButtonElement | undefined
    assert.ok(inactiveChip, 'inactive chip for session A is present in DOM')
    flushSync(() => {
      inactiveChip!.dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true }))
    })
    assert.equal(
      useAgent.getState().activeSessionId,
      idA,
      'clicking inactive chip switches activeSessionId',
    )
  } finally {
    unmount()
  }
})

// --- Case 3 — 3 sessions: "+ 新建" disabled at hard limit ---------------

test('V3.4a case 3 — three sessions: "+ 新建" disabled at the renderer hard limit', () => {
  resetStoreToBootstrap()
  const id1 = useAgent.getState().createNewSession()
  const id2 = useAgent.getState().createNewSession()
  const id3 = useAgent.getState().createNewSession()
  assert.ok(id1 && id2 && id3, 'three sessions created successfully')

  // The 4th attempt must be rejected by the renderer hard limit.
  const id4 = useAgent.getState().createNewSession()
  assert.equal(id4, null, 'createNewSession returns null past the 3-session limit')
  assert.equal(
    useAgent.getState().sessionOrder.length,
    3,
    'sessionOrder stays at 3 entries after rejected create',
  )

  const { container, unmount } = mountSessionTabs()
  try {
    const chips = container.querySelectorAll('[data-testid="session-tab-chip"]')
    assert.equal(chips.length, 3, 'three chips rendered')

    const newBtn = container.querySelector('[data-testid="session-tab-new"]') as HTMLButtonElement | null
    assert.ok(newBtn, '"+ 新建" button rendered')
    assert.equal(newBtn!.disabled, true, '"+ 新建" disabled at hard limit')
    assert.equal(
      newBtn!.getAttribute('data-session-tab-new-disabled'),
      'true',
      'data-session-tab-new-disabled reflects disabled state',
    )

    // Clicking the disabled button is a no-op (browser blocks it but we
    // also defensively short-circuit inside the handler).
    flushSync(() => {
      newBtn!.dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true }))
    })
    assert.equal(
      useAgent.getState().sessionOrder.length,
      3,
      'clicking disabled new-button does not create a fourth session',
    )
  } finally {
    unmount()
  }
})

// --- Case X2.1 #7 — UI-reachable callsites use the visible API ----------
//
// Plan §7 implementation rule "Choose one explicit contract for session
// creation" — under chosen contract (b), UI paths call `createNewSession()`
// (which appends to `sessionOrder`); non-UI bootstrap paths may still call
// `newSession()` (which swaps in place without growing `sessionOrder`).
//
// This is a hard cross-file contract that can't be fully exercised by a
// pure useAgent behavior test (the bug is which API ChatPanel calls). The
// source grep here pins that ChatPanel.tsx does not call `newSession()`
// from any of its UI handlers. The legacy callsite in useAgent.ts itself
// (`deleteConversation` recovery) is allowed because it is not directly
// triggered by a session-strip control — it is a post-delete fallback that
// runs against an already-empty active session.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

test('X2.1 case 7 — ChatPanel UI handlers call createNewSession (visible API), not newSession', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/renderer/components/agent/ChatPanel.tsx'), 'utf8')
  // The legacy `newSession()` action remains exported from useAgent but is
  // no longer invoked by any user-clickable ChatPanel handler.
  // Source-grep allowance: this is a cross-file hard contract under plan
  // §7 — UI session creation must funnel through the visible API.
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed plan §7 contract
  const newSessionCallRegex = /\bnewSession\s*\(\s*\)/g
  const matches = source.match(newSessionCallRegex) || []
  assert.equal(
    matches.length,
    0,
    `ChatPanel.tsx must not call newSession() from UI handlers; found ${matches.length} call(s). Use createNewSession() (visible API) instead.`,
  )
  // Positive assertion: there's at least one createNewSession reference
  // wired up (header / channel-empty / new-conversation buttons).
  assert.match(source, /createNewSession\s*\(\s*\)/, 'ChatPanel.tsx must wire UI session creation through createNewSession()')
})

// --- Case X2.1 #1 — cold/header path produces a visible tab --------------
//
// Plan §7 required test 1: starting with `sessionOrder: []`, invoking the
// header new-session path (ChatPanel.tsx:591 — `useAgent.getState().newSession()`)
// must create one visible tab and make it active. Under Stage X2.3 contract
// (b) the renderer-side `newSession()` action itself is the cold/header
// entry point: it MUST append to `sessionOrder` when invoked against an
// empty list, not just swap.
//
// This test pins that contract — it asserts on `sessionOrder` length after
// the call, so the fix can either (a) make `newSession()` always visible,
// or (b) repoint ChatPanel:591 to `createNewSession()` and we update this
// test alongside the production callsite. Either way the user-visible
// outcome is the same.

test('X2.1 case 5 — cold start: header new-session produces 1 visible tab', () => {
  resetStoreToBootstrap()
  const stateBefore = useAgent.getState()
  assert.equal(stateBefore.sessionOrder.length, 0, 'cold start: sessionOrder is empty')

  // Drive the header path. Under Stage X2.3 contract (b) this is now
  // wired to `createNewSession()` — which IS the visible-tab API. The
  // legacy `newSession()` is retained for non-UI bootstrap paths
  // (e.g. `deleteConversation` recovery) and is NOT what the header
  // button calls.
  useAgent.getState().createNewSession()

  const state = useAgent.getState()
  assert.equal(state.sessionOrder.length, 1, 'header new-session appends one tab to sessionOrder')
  const newId = state.sessionOrder[0]
  assert.ok(newId, 'sessionOrder[0] is the new id')
  assert.equal(state.activeSessionId, newId, 'newly created session is active')

  // The strip is now visible.
  const { container, unmount } = mountSessionTabs()
  try {
    const chips = container.querySelectorAll('[data-testid="session-tab-chip"]')
    assert.equal(chips.length, 1, 'one chip rendered in the strip after header create')
    const newBtn = container.querySelector('[data-testid="session-tab-new"]') as HTMLButtonElement | null
    assert.ok(newBtn, '"+ 新建" button rendered')
    assert.equal(newBtn!.disabled, false, '"+ 新建" still enabled (1/3 sessions used)')
  } finally {
    unmount()
  }
})

// --- Case X2.1 #2 — repeated visible new-session never hides active -------
//
// Plan §7 required test 2: repeated visible new-session actions append (or
// replace per the chosen contract) but never leave the active session
// hidden from `sessionOrder`.

test('X2.1 case 6 — repeated visible new-session leaves active session visible each time', () => {
  resetStoreToBootstrap()
  for (let i = 0; i < 3; i++) {
    const created = useAgent.getState().createNewSession()
    assert.ok(created, `iteration ${i}: createNewSession returns an id`)
    const state = useAgent.getState()
    assert.equal(state.activeSessionId, created, `iteration ${i}: active session matches the newly created id`)
    assert.equal(
      state.sessionOrder.includes(created!),
      true,
      `iteration ${i}: active session id appears in sessionOrder (not hidden)`,
    )
  }
  assert.equal(useAgent.getState().sessionOrder.length, 3, 'all 3 are visible')
})

// --- Case 4 — close session reroutes active to remaining tab ------------

test('V3.4a case 4 — closeSession on active id: chip count drops, active reroutes', () => {
  resetStoreToBootstrap()
  const id1 = useAgent.getState().createNewSession()
  const id2 = useAgent.getState().createNewSession()
  const id3 = useAgent.getState().createNewSession()
  assert.ok(id1 && id2 && id3, 'three sessions seeded')
  assert.equal(useAgent.getState().activeSessionId, id3, 'third session is active after creation')

  // Close the currently-active session (id3). The active id should fall
  // through to the first remaining entry in sessionOrder (id1).
  useAgent.getState().closeSession(id3!)
  assert.equal(useAgent.getState().sessionOrder.length, 2, 'sessionOrder drops to 2 after close')
  assert.equal(
    useAgent.getState().activeSessionId,
    id1,
    'active reroutes to first remaining entry when active session was closed',
  )
  assert.equal(
    useAgent.getState().sessions[id3!],
    undefined,
    'closed session slice removed from sessions Record',
  )

  const { container, unmount } = mountSessionTabs()
  try {
    const chips = container.querySelectorAll('[data-testid="session-tab-chip"]')
    assert.equal(chips.length, 2, 'two chips remain after close')

    const ids = Array.from(chips).map((chip) => chip.getAttribute('data-session-tab-id'))
    assert.deepEqual(ids, [id1, id2], 'remaining chips preserve sessionOrder order')

    const activeChips = container.querySelectorAll('[data-session-tab-active="true"]')
    assert.equal(activeChips.length, 1, 'exactly one chip marked active after close')
    assert.equal(
      (activeChips[0] as HTMLElement).getAttribute('data-session-tab-id'),
      id1,
      'active chip is the rerouted first remaining session',
    )

    // After closing one session "+ 新建" becomes enabled again.
    const newBtn = container.querySelector('[data-testid="session-tab-new"]') as HTMLButtonElement | null
    assert.ok(newBtn, '"+ 新建" button still rendered after close')
    assert.equal(newBtn!.disabled, false, '"+ 新建" re-enabled once below the 3-session limit')

    // Closing every remaining session collapses the strip back to the
    // empty/null state — sessionOrder becomes empty and activeSessionId
    // becomes null.
    useAgent.getState().closeSession(id1!)
    useAgent.getState().closeSession(id2!)
    assert.equal(useAgent.getState().sessionOrder.length, 0, 'sessionOrder empty after closing all')
    assert.equal(useAgent.getState().activeSessionId, null, 'activeSessionId nulled when no tabs remain')
  } finally {
    unmount()
  }
})
