import { makeScopeHeadActionProjection } from './product-turn-action-projection-fixture'
import { makeEmptySessionSlice } from '../renderer/stores/agent-store-helpers'
import { codexHeadActionAdmissionRef } from '../renderer/modules/agent/productTurnReceipt'
/**
 * Stage V — V6 / V1.0 ChatPanel fixture baseline.
 *
 * Snapshot-locks the SEMANTIC structural tree current ChatPanel.tsx produces
 * for four representative store states. Subsequent V1.1 - V1.9 extractions
 * (helpers → markdown → layout → attachments-preview → ModelSelector → TaskCard
 * → task-merge → task-snapshot → channel/recall → drag/drop → task interaction)
 * must keep these snapshots diff = 0 — the fixture is the behavior lock.
 *
 * Plan: docs/superpowers/plans/2026-05-21-V-stage-v-comprehensive-implementation.md
 *   §2 (V1 cut), §7 (V6 fixture infra), R2 (snapshot scope).
 *
 * Snapshot scope (R2):
 *  - tag names, key data-* testids, direct text content, recursive children
 *  - SKIPS className, style, ARIA ids, react auto-generated keys
 *
 * Mount strategy:
 *  - jsdom + createRoot + flushSync (same as
 *    `browser-blank-page-contract.test.ts`)
 *  - MemoryRouter wraps ChatPanel because internal ModelSelector calls
 *    useNavigate()
 *  - electronAPI is stubbed with safe `{ success: false }` / empty array
 *    returns for every channel ChatPanel touches; push subscriptions are
 *    no-op (return cleanup fn)
 *  - Each case seeds `useAgent.setState` *before* mount so initial render
 *    sees the intended store snapshot. Async effects (loadScopes,
 *    refresh*) fire but resolve to no-ops because electronAPI returns
 *    nullish; the snapshot is captured immediately after `flushSync`
 *    and reflects the synchronous render output only.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { projectCodexHeadActionProjection } from '../main/modules/agent-control/codex-runtime/codex-action-surface'
import { projectCodexLifecycleOperationV2 } from '../main/modules/agent-control/codex-runtime/codex-lifecycle-action-surface'

// --- jsdom + global stubs must be installed BEFORE importing renderer code ---

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
    MutationObserver: (globalThis as { MutationObserver?: unknown }).MutationObserver,
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
  setGlobal('matchMedia', dom.window.matchMedia = (_query: string) => ({
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
  // LiquidBackdropProjection（vertical-tabs 液态玻璃）挂载时观察 DOM 变更；
  // jsdom 自带实现，暴露成全局即可（ResizeObserver 组件侧已有 typeof 防护）。
  setGlobal('MutationObserver', dom.window.MutationObserver)
  setGlobal('navigator', dom.window.navigator)
  setGlobal('localStorage', dom.window.localStorage)

  // jsdom doesn't implement scrollIntoView; ChatMessages calls it on every
  // mount inside a useEffect to auto-pin to the end of the conversation.
  // Stub it to a no-op so the effect runs without throwing.
  ;(dom.window.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => undefined

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

// Install once at module load so the dynamic imports of renderer modules
// (zustand stores, ChatPanel, etc.) see a real window/document/localStorage.
const domHandle = installDomGlobals()

// `process.exit` is the safe hook for ad-hoc cleanup that node:test runners
// can't directly chain — restoration is best-effort because the test
// process is short-lived.
process.on('exit', () => {
  try { domHandle.restore() } catch { /* silent-catch: best-effort restore */ }
})

// --- stub electronAPI BEFORE importing useAgent (so module init reads it) ---

interface ElectronAPIStubResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

function noopUnsubscribe(): () => void {
  return () => undefined
}

function failingResult<T = unknown>(): ElectronAPIStubResult<T> {
  return { success: false, data: undefined }
}

function emptyArrayResult(): ElectronAPIStubResult<unknown[]> {
  return { success: true, data: [] }
}

const scopeRunEventHandlers = new Set<(event: unknown) => void>()

/**
 * Defensive electronAPI surface — ChatPanel + useAgent + runtimeDriver touch
 * 30+ channels across multiple namespaces. Listing every one by hand is
 * fragile (and the surface drifts faster than this fixture would). Instead
 * we wrap each namespace in a Proxy that synthesises a safe default for
 * any method name the renderer tries to call:
 *
 *  - methods starting with `on*` (push subscriptions) → return a no-op
 *    unsubscribe function (matches `(callback) => () => void` shape)
 *  - everything else → return an async function resolving to `{ success: false }`
 *
 * Explicit overrides (where the renderer expects a specific shape, e.g.
 * `listPendingAskUserQuestions` must return `{ success: true, data: [] }`)
 * are layered on top via the `overrides` map.
 */
function makeChannelProxy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return new Proxy(overrides, {
    get(target, prop, _receiver) {
      if (typeof prop !== 'string') return Reflect.get(target, prop)
      if (prop in target) return target[prop as keyof typeof target]
      if (prop.startsWith('on')) {
        // Push subscription: signature `(callback, ...args) => unsubscribe`
        const handler = (_callback: unknown) => noopUnsubscribe()
        target[prop as keyof typeof target] = handler as unknown as never
        return handler
      }
      const handler = async (..._args: unknown[]) => failingResult()
      target[prop as keyof typeof target] = handler as unknown as never
      return handler
    },
  }) as Record<string, unknown>
}

const electronAPIStub = {
  agent: makeChannelProxy({
    // Explicit overrides where the renderer expects a *successful* shape
    // (empty list vs. failure changes branch behavior).
    listScopeRuns: async () => emptyArrayResult(),
    listTaskProjections: async () => emptyArrayResult(),
    listAttachedSessionRecallContexts: async () => emptyArrayResult(),
    listActiveChildRuns: async () => emptyArrayResult(),
    searchSessionRecall: async () => emptyArrayResult(),
    getConversationScopeMessages: async () => emptyArrayResult(),
    listConversationScopes: async () => emptyArrayResult(),
    onScopeRunEvent: (callback: (event: unknown) => void) => {
      scopeRunEventHandlers.add(callback)
      return () => { scopeRunEventHandlers.delete(callback) }
    },
  }),
  agentInteraction: makeChannelProxy({
    listPendingAskUserQuestions: async () => emptyArrayResult(),
  }),
  tools: makeChannelProxy({
    logToolEvent: () => undefined,
  }),
  settings: makeChannelProxy(),
  chat: makeChannelProxy({
    pickFiles: async () => emptyArrayResult(),
  }),
  document: makeChannelProxy(),
  pet: makeChannelProxy(),
  memory: makeChannelProxy(),
  browser: makeChannelProxy(),
  ui: makeChannelProxy({
    showNativeContextMenu: async () => ({ success: false, selectedId: null }),
  }),
}

;(globalThis.window as unknown as { electronAPI: typeof electronAPIStub }).electronAPI = electronAPIStub

// --- dynamic imports AFTER globals are installed ---

const { MemoryRouter } = await import('react-router-dom')
const { useAgent } = await import('../renderer/stores/useAgent')
const { useWorkspace } = await import('../renderer/stores/useWorkspace')
const AgentRuntimeListenerRoot = (await import('../renderer/modules/agent/AgentRuntimeListenerRoot')).default
const ChatPanelModule = await import('../renderer/components/agent/ChatPanel')
const ChatPanel = ChatPanelModule.default

// --- semantic serializer (R2 scope) -----------------------------------------

interface SemanticNode {
  tag: string
  testid?: string
  role?: string
  /** First semantic marker (used in formatSemantic for the readable view). */
  marker?: string
  /** All semantic markers on this element (used in collectMarkers for the lock). */
  markers: string[]
  text?: string
  children: SemanticNode[]
}

// Set of data-* attributes that carry semantic / behavior contract value
// (not auto-generated keys). Locking these keeps the fixture meaningful
// across renames of class strings / IDs.
const SEMANTIC_DATA_ATTRS = [
  'data-chat-panel-root',
  'data-liquid-shell',
  'data-reference-skill-hint',
  'data-session-recall-attachments',
  'data-testid',
]

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function pickMarker(element: Element): string | undefined {
  for (const attr of SEMANTIC_DATA_ATTRS) {
    const value = element.getAttribute(attr)
    if (value != null) return `${attr}=${value}`
  }
  return undefined
}

function pickAllMarkers(element: Element): string[] {
  const acc: string[] = []
  for (const attr of SEMANTIC_DATA_ATTRS) {
    const value = element.getAttribute(attr)
    if (value != null) acc.push(`${attr}=${value}`)
  }
  return acc
}

function directText(element: Element): string | undefined {
  const fragments: string[] = []
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === 3 /* TEXT_NODE */) {
      const trimmed = collapseWhitespace(child.textContent || '')
      if (trimmed) fragments.push(trimmed)
    }
  }
  if (fragments.length === 0) return undefined
  return fragments.join(' ')
}

function serializeSemantic(root: Element): SemanticNode {
  const tag = root.tagName.toLowerCase()
  const markers = pickAllMarkers(root)
  const node: SemanticNode = {
    tag,
    markers,
    children: [],
  }
  const marker = pickMarker(root)
  if (marker) node.marker = marker
  const role = root.getAttribute('role')
  if (role) node.role = role
  const text = directText(root)
  if (text) node.text = text
  for (const child of Array.from(root.children)) {
    node.children.push(serializeSemantic(child))
  }
  return node
}

/**
 * Walk a semantic tree and collect markers in document order.
 *
 * The marker list is the "behavior contract" surface: every data-* attribute
 * we listed in `SEMANTIC_DATA_ATTRS`. V1.x extractions can rearrange class
 * strings and even DOM nesting, but the set + order of markers must stay
 * the same — that's what guarantees behavior isn't dropped.
 */
function collectMarkers(node: SemanticNode): string[] {
  const acc: string[] = []
  const visit = (current: SemanticNode) => {
    for (const m of current.markers) acc.push(m)
    for (const child of current.children) visit(child)
  }
  visit(node)
  return acc
}

/**
 * Pretty-print a semantic tree as a stable, line-oriented string so that
 * diffs are readable when a snapshot drifts. We deliberately do NOT use
 * JSON.stringify because the natural reader on a failed assertion would
 * see a one-line wall of text.
 */
function formatSemantic(node: SemanticNode, depth = 0): string {
  const indent = '  '.repeat(depth)
  const header = [node.tag]
  if (node.marker) header.push(`[${node.marker}]`)
  if (node.role) header.push(`{role=${node.role}}`)
  if (node.text) header.push(`"${node.text}"`)
  const lines = [`${indent}${header.join(' ')}`]
  for (const child of node.children) {
    lines.push(formatSemantic(child, depth + 1))
  }
  return lines.join('\n')
}

// --- store reset helper -----------------------------------------------------

function resetStores() {
  // Reset the workspace store back to default chat-panel-visible state so
  // ChatPanel mounts in the expanded form expected by the fixtures.
  useWorkspace.setState({
    chatPanelVisible: true,
    chatPanelWidth: 380,
  })
  // Stage X2.3 — the ChatPanel boot effect now appends to `sessionOrder`
  // via `createNewSession()` when scopes are empty (this is what makes
  // the cold/header path produce a visible tab — plan §7 required
  // behavior). That write runs as a microtask AFTER the test under which
  // it was triggered serializes, so its `sessions`/`sessionOrder` leak
  // into the NEXT test's seed. Explicit zero here is the safest fix.
  useAgent.setState({
    sessions: {},
    activeSessionId: null,
    sessionOrder: [],
  })
}

function seedEmptyAgent() {
  useAgent.setState({
    agents: [
      { name: 'butler', displayName: '管家', avatar: '', status: 'idle' },
    ],
    messages: [],
    currentAgent: 'butler',
    currentScopeId: null,
    currentScope: null,
    scopes: [],
    scopeRunStates: {},
    inputValue: '',
    isStreaming: false,
    foregroundBusy: false,
    composerLocked: false,
    streamingMessageId: null,
    streamingRequestId: null,
    conversations: [],
    conversationId: null,
    toolTrace: [],
    toolTraceStatus: 'idle',
    attachments: [],
    filePool: [],
    activeAttachmentPreview: null,
    pendingSendCount: 0,
    pendingSendFlushAt: null,
    taskDisclosureState: {},
    // Stage X2.3 — the ChatPanel boot effect now calls createNewSession()
    // when scopes are empty, which would otherwise leak a tab into the
    // next test's `sessionOrder` via a microtask after this test's
    // serialization. Explicitly zero `sessions`/`sessionOrder` so each
    // fixture starts from a clean tab strip.
    sessions: {},
    activeSessionId: null,
    sessionOrder: [],
  })
}

// --- mount helper -----------------------------------------------------------

interface MountResult {
  container: HTMLElement
  unmount: () => void
}

function mountChatPanel(panelState: 'collapsed' | 'expanded' = 'expanded'): MountResult {
  const document = globalThis.document
  const host = document.getElementById('root')
  if (!host) throw new Error('jsdom root element missing')
  // Reset any previously rendered tree
  host.innerHTML = ''
  const container = document.createElement('div')
  host.appendChild(container)
  const root = createRoot(container)
  flushSync(() => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/workbench'] },
        createElement(AgentRuntimeListenerRoot),
        createElement(ChatPanel, {
          shellWidth: 380,
          panelState,
          onTogglePanel: () => undefined,
        }),
      ),
    )
  })
  return {
    container,
    unmount: () => {
      try { root.unmount() } catch { /* silent-catch: unmount best-effort */ }
      try { host.removeChild(container) } catch { /* silent-catch: detach best-effort */ }
    },
  }
}

function fireScopeRunEvent(event: Record<string, unknown>): void {
  for (const handler of [...scopeRunEventHandlers]) handler(event)
}

// ---------------------------------------------------------------------------
// V1.0 Case 1 — empty agent session (expanded shell)
// ---------------------------------------------------------------------------
// Fresh agent session with no messages, no scopes, no attachments, no
// input. This is the "fresh app cold start" baseline — the panel mounts
// in expanded mode, the AnimatePresence branch picks ChatPanelMotionLayer
// with header + body slots, but no reference-skill / recall capsule
// cards are visible. V1.1 helpers + V1.3 layout extractions MUST keep
// this marker set unchanged.

test('V1.0 fixture / case 1 — empty session: only root + liquid-shell markers visible', () => {
  resetStores()
  seedEmptyAgent()

  const { container, unmount } = mountChatPanel('expanded')
  try {
    const root = container.querySelector('[data-chat-panel-root="true"]')
    assert.ok(root, 'ChatPanel root element should be present')
    assert.equal((root as Element).getAttribute('data-liquid-shell'), 'chat-panel')

    const tree = serializeSemantic(root as Element)
    assert.equal(tree.tag, 'div', 'root is a div')
    assert.equal(tree.marker, 'data-chat-panel-root=true', 'root marker present')

    // The load-bearing snapshot: ordered list of semantic markers.
    const markers = collectMarkers(tree)
    assert.deepEqual(
      markers,
      ['data-chat-panel-root=true', 'data-liquid-shell=chat-panel'],
      'empty-session shell exposes exactly the root + liquid-shell markers',
    )

    // Single shell + no attachment-preview modal in the cold-start view.
    const allRoots = container.querySelectorAll('[data-chat-panel-root="true"]')
    assert.equal(allRoots.length, 1, 'empty-session case has exactly one shell root')
    const formatted = formatSemantic(tree)
    assert.match(formatted, /^div \[data-chat-panel-root=true\]/, 'tree begins at chat-panel-root')
    assert.doesNotMatch(formatted, /data-reference-skill-hint/, 'no reference-skill hint card in empty session')
    assert.doesNotMatch(formatted, /data-session-recall-attachments/, 'no session-recall capsule in empty session')
    assert.doesNotMatch(formatted, /在 Finder 中显示/, 'attachment preview modal absent without activeAttachmentPreview')
  } finally {
    unmount()
  }
})

// ---------------------------------------------------------------------------
// V1.0 Case 2 — streaming-text mid-flight
// ---------------------------------------------------------------------------
// Seed an assistant message that's mid-stream + a scopeRunState in the
// `responding` phase. This locks the structural truth that the streaming
// text path keeps the ChatMessages region inside the same body cell —
// no new top-level wrappers appear (V1.7 task-merge hook MUST preserve).

test('V1.0 fixture / case 2 — streaming-text: assistant mid-stream keeps single shell', () => {
  resetStores()
  const streamingMessageId = 'msg-streaming-1'
  useAgent.setState({
    agents: [
      { name: 'butler', displayName: '管家', avatar: '', status: 'idle' },
    ],
    messages: [
      {
        id: 'msg-user-1',
        agent: 'butler',
        content: '帮我总结一下今天的新闻',
        type: 'user',
        timestamp: new Date('2026-05-21T12:00:00Z'),
      },
      {
        id: streamingMessageId,
        agent: 'butler',
        content: '今天的头条是',
        type: 'agent',
        timestamp: new Date('2026-05-21T12:00:01Z'),
      },
    ],
    currentAgent: 'butler',
    currentScopeId: 'scope-stream',
    currentScope: {
      id: 'scope-stream',
      agent: 'butler',
      title: '新闻速览',
      sourceKind: 'local',
      sourceId: 'app',
      threadKey: 'local:app',
      meta: {},
      createdAt: '2026-05-21T11:59:00Z',
      updatedAt: '2026-05-21T12:00:01Z',
    },
    scopes: [
      {
        id: 'scope-stream',
        agent: 'butler',
        title: '新闻速览',
        sourceKind: 'local',
        sourceId: 'app',
        threadKey: 'local:app',
        meta: {},
        createdAt: '2026-05-21T11:59:00Z',
        updatedAt: '2026-05-21T12:00:01Z',
      },
    ],
    scopeRunStates: {
      'scope-stream': {
        scopeId: 'scope-stream',
        agent: 'butler',
        requestId: 'req-1',
        phase: 'responding',
        terminalReason: null,
        toolTrace: [],
        startedAt: '2026-05-21T12:00:00Z',
        updatedAt: '2026-05-21T12:00:01Z',
        responseMessageId: streamingMessageId,
        responseBuffer: '今天的头条是',
        responseSegmentToolTraceStart: 0,
      },
    },
    isStreaming: true,
    foregroundBusy: true,
    composerLocked: true,
    streamingMessageId,
    streamingRequestId: 'req-1',
    inputValue: '',
    conversations: [],
    conversationId: null,
    toolTrace: [],
    toolTraceStatus: 'streaming',
    attachments: [],
    filePool: [],
    activeAttachmentPreview: null,
    pendingSendCount: 0,
    pendingSendFlushAt: null,
    taskDisclosureState: {},
  })

  const { container, unmount } = mountChatPanel('expanded')
  try {
    const root = container.querySelector('[data-chat-panel-root="true"]')
    assert.ok(root, 'ChatPanel root present during streaming')
    const tree = serializeSemantic(root as Element)
    const formatted = formatSemantic(tree)
    assert.match(formatted, /^div \[data-chat-panel-root=true\]/)
    // Streaming text should appear somewhere in the rendered DOM.
    const fullText = (root as Element).textContent || ''
    assert.match(fullText, /今天的头条是/, 'streaming partial text is rendered')
    assert.match(fullText, /帮我总结一下今天的新闻/, 'preceding user message is rendered')
    // Behavior lock: exactly one chat-panel-root (no double-shell regression).
    const allRoots = container.querySelectorAll('[data-chat-panel-root="true"]')
    assert.equal(allRoots.length, 1, 'streaming case has exactly one shell root')
    // Marker lock: streaming with no reference hint / recall capsule
    // should still expose just root + liquid-shell.
    const markers = collectMarkers(tree)
    assert.deepEqual(
      markers,
      ['data-chat-panel-root=true', 'data-liquid-shell=chat-panel'],
      'streaming shell baseline markers',
    )
  } finally {
    unmount()
  }
})

test('late stop terminal clears the matching error, while a stale terminal leaves it visible and locked', async () => {
  resetStores()
  const scopeId = 'scope-stop-reconcile'
  const sessionId = 'session-stop-reconcile'
  const requestId = 'req-stop-current'
  const scopeRunState = {
    scopeId,
    agent: 'butler',
    requestId,
    phase: 'responding' as const,
    terminalReason: null,
    toolTrace: [],
    startedAt: '2026-08-11T09:00:00.000Z',
    updatedAt: '2026-08-11T09:00:01.000Z',
  }
  const sessionSlice = {
    messages: [],
    pendingSendCount: 0,
    pendingSendFlushAt: null,
    isStreaming: true,
    foregroundBusy: true,
    composerLocked: true,
    streamingMessageId: 'response-stop-current',
    streamingRequestId: requestId,
    scopeRunStates: { [scopeId]: scopeRunState },
    taskDisclosureState: {},
    lifecyclePendingAction: null,
    lifecycleError: null,
    state: 'live' as const,
    conversationId: scopeId,
    aliasGeneration: 1,
    messageVisibilityEpoch: 0,
    inputValue: '',
  }
  const stopScope = {
    id: scopeId,
    aliasGeneration: 1,
    messageVisibilityEpoch: 0,
    agent: 'butler',
    activeAgentId: 'butler',
    handoffGeneration: 0,
    title: '停止收口测试',
    sourceKind: 'local' as const,
    sourceId: 'app',
    threadKey: scopeId,
    meta: {},
    createdAt: '2026-08-11T09:00:00.000Z',
    updatedAt: '2026-08-11T09:00:01.000Z',
    lastMessageAt: null,
  }
  useAgent.setState({
    agents: [{ name: 'butler', displayName: '管家', avatar: '', status: 'idle' }],
    currentAgent: 'butler',
    currentScopeId: scopeId,
    currentScope: stopScope,
    scopes: [stopScope],
    messages: [],
    scopeRunStates: { [scopeId]: scopeRunState },
    isStreaming: true,
    foregroundBusy: true,
    composerLocked: true,
    streamingMessageId: 'response-stop-current',
    streamingRequestId: requestId,
    inputValue: '',
    conversations: [],
    conversationId: scopeId,
    toolTrace: [],
    toolTraceStatus: 'running',
    attachments: [],
    filePool: [],
    activeAttachmentPreview: null,
    pendingSendCount: 0,
    pendingSendFlushAt: null,
    taskDisclosureState: {},
    sessions: { [sessionId]: sessionSlice },
    activeSessionId: sessionId,
    sessionId,
    sessionOrder: [sessionId],
  })

  const agentApi = electronAPIStub.agent as Record<string, unknown>
  const previousKill = agentApi.kill
  const previousListConversationScopes = agentApi.listConversationScopes
  const previousReadCodexActionSurface = agentApi.readCodexActionSurface
  agentApi.listConversationScopes = async () => ({ success: true, data: [stopScope] })
  agentApi.readCodexActionSurface = async () => {
    const targetReadyRunId = useAgent.getState().sessions[sessionId]?.streamingRequestId || null
    const head = projectCodexHeadActionProjection({
      scopeId, scopeEpoch: 0, aliasId: scopeId, aliasGeneration: 1,
      threadBindingId: 'stop-binding', headRevision: 1, actionProjectionSequence: 1,
      materializationKind: 'fresh_start', materializationState: 'confirmed', codexThreadId: 'native-stop',
      continuationBlocked: false, activeProductFence: Boolean(targetReadyRunId),
      manualCompactionState: 'none', hasLegacyPreparedRun: false,
      headRuntimeManifestDigest: 'runtime', headProtocolSchemaDigest: 'protocol',
      currentRuntimeManifestDigest: 'runtime', currentProtocolSchemaDigest: 'protocol',
    })
    return { success: true, data: {
      scopeId, scopeEpoch: 0, head,
      lifecycle: projectCodexLifecycleOperationV2({
        base: {
          identity: { aliasId: scopeId, aliasGeneration: 1 },
          activeReadyRunId: targetReadyRunId, latestReadyRunId: targetReadyRunId,
          snapshot: targetReadyRunId ? 'product_turn_interruptible' : 'idle_native_thread',
          interruptRequested: false, interruptAcknowledged: false,
          requestedAction: null, evidenceDigest: 'lifecycle-stop-ready',
        },
        head, scopeEpoch: 0, threadBindingId: 'stop-binding', headRevision: 1,
        materializationIntentRef: null,
      }),
    } }
  }
  agentApi.kill = async () => ({
    ok: false,
    action: 'stop',
    code: 'interrupt_state_unknown',
    preserveUi: true,
    aliasId: scopeId,
    aliasGeneration: 1,
    evidenceDigest: 'stop-unknown',
  })

  await useAgent.getState().refreshCodexActionSurface(scopeId)
  const { container, unmount } = mountChatPanel('expanded')
  try {
    const stopButton = container.querySelector<HTMLButtonElement>('[data-ready-agent-stop="true"]')
    assert.ok(stopButton)
    stopButton.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.match(
      container.querySelector('[data-ready-agent-stop-error="true"]')?.textContent || '',
      /停止状态待确认/,
    )

    flushSync(() => {
      fireScopeRunEvent({
        aliasGeneration: 1,
        messageVisibilityEpoch: 0,
        type: 'finished',
        scopeId,
        sessionId,
        agent: 'butler',
        runId: 'req-stop-old',
        phase: 'cancelled',
        terminalReason: 'cancelled_user',
        timestamp: '2026-08-11T09:00:02.000Z',
      })
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.ok(container.querySelector('[data-ready-agent-stop-error="true"]'))
    assert.equal(useAgent.getState().sessions[sessionId]?.composerLocked, true)
    assert.equal(useAgent.getState().sessions[sessionId]?.streamingRequestId, requestId)

    flushSync(() => {
      fireScopeRunEvent({
        aliasGeneration: 1,
        messageVisibilityEpoch: 0,
        type: 'finished',
        scopeId,
        sessionId,
        agent: 'butler',
        runId: requestId,
        phase: 'cancelled',
        terminalReason: 'cancelled_user',
        timestamp: '2026-08-11T09:00:03.000Z',
      })
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(container.querySelector('[data-ready-agent-stop-error="true"]'), null)
    const reconciled = useAgent.getState().sessions[sessionId]
    assert.equal(reconciled?.composerLocked, false)
    assert.equal(reconciled?.streamingRequestId, null)
    assert.equal(reconciled?.lifecycleError, null)

    let resolveLateStop!: (value: unknown) => void
    agentApi.kill = () => new Promise((resolve) => { resolveLateStop = resolve })
    flushSync(() => {
      useAgent.setState((state) => ({
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...state.sessions[sessionId],
            state: 'live',
            isStreaming: true,
            foregroundBusy: true,
            composerLocked: true,
            streamingMessageId: 'response-cross-scope',
            streamingRequestId: 'req-cross-scope',
            scopeRunStates: {
              [scopeId]: {
                ...scopeRunState,
                requestId: 'req-cross-scope',
                terminalReason: null,
              },
            },
          },
        },
        scopeRunStates: {
          [scopeId]: {
            ...scopeRunState,
            requestId: 'req-cross-scope',
            terminalReason: null,
          },
        },
        isStreaming: true,
        foregroundBusy: true,
        composerLocked: true,
        streamingMessageId: 'response-cross-scope',
        streamingRequestId: 'req-cross-scope',
      }))
    })
    container.querySelector<HTMLButtonElement>('[data-ready-agent-stop="true"]')?.click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const otherScopeId = 'scope-stop-other'
    const otherSessionId = 'session-stop-other'
    flushSync(() => {
      useAgent.setState((state) => ({
        sessions: {
          ...state.sessions,
          [otherSessionId]: {
            ...sessionSlice,
            conversationId: otherScopeId,
            aliasGeneration: 1,
            messageVisibilityEpoch: 0,
            isStreaming: false,
            foregroundBusy: false,
            composerLocked: false,
            streamingMessageId: null,
            streamingRequestId: null,
            scopeRunStates: {},
          },
        },
        activeSessionId: otherSessionId,
        sessionId: otherSessionId,
        sessionOrder: [sessionId, otherSessionId],
        currentScopeId: otherScopeId,
        currentScope: {
          id: otherScopeId,
          aliasGeneration: 1,
          messageVisibilityEpoch: 0,
          agent: 'butler',
          activeAgentId: 'butler',
          handoffGeneration: 0,
          title: '其他任务',
          sourceKind: 'local',
          sourceId: 'app',
          threadKey: otherScopeId,
          meta: {},
          createdAt: '2026-08-11T09:00:04.000Z',
          updatedAt: '2026-08-11T09:00:04.000Z',
        },
        scopes: [
          stopScope,
          {
            id: otherScopeId,
            aliasGeneration: 1,
            messageVisibilityEpoch: 0,
            agent: 'butler',
            activeAgentId: 'butler',
            handoffGeneration: 0,
            title: '其他任务',
            sourceKind: 'local',
            sourceId: 'app',
            threadKey: otherScopeId,
            meta: {},
            createdAt: '2026-08-11T09:00:04.000Z',
            updatedAt: '2026-08-11T09:00:04.000Z',
            lastMessageAt: null,
          },
        ],
        scopeRunStates: {},
        isStreaming: false,
        foregroundBusy: false,
        composerLocked: false,
        streamingMessageId: null,
        streamingRequestId: null,
      }))
    })
    resolveLateStop({
      ok: false,
      action: 'stop',
      code: 'interrupt_state_unknown',
      preserveUi: true,
      aliasId: scopeId,
      aliasGeneration: 1,
      evidenceDigest: 'late-cross-scope-stop',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(container.querySelector('[data-ready-agent-stop-error="true"]'), null)
    assert.equal(useAgent.getState().currentScopeId, otherScopeId)
    assert.equal(useAgent.getState().sessions[otherSessionId]?.lifecycleError, null)
  } finally {
    agentApi.kill = previousKill
    agentApi.listConversationScopes = previousListConversationScopes
    agentApi.readCodexActionSurface = previousReadCodexActionSurface
    unmount()
  }
})

// ---------------------------------------------------------------------------
// V1.0 Case 3 — tool-running task in flight
// ---------------------------------------------------------------------------
// scopeRunState in `tool_running` phase with one active step and one
// in-flight tool call. This locks how the shell behaves when the task
// projection lane has an active step but no terminal projection yet.
// V1.6 (TaskCard extraction) and V1.8 (TaskToolSnapshot) must keep the
// shell tree shape unchanged.

test('V1.0 fixture / case 3 — tool-running task in flight: shell renders without crash', () => {
  resetStores()
  const scopeId = 'scope-task'
  useAgent.setState({
    agents: [
      { name: 'butler', displayName: '管家', avatar: '', status: 'idle' },
    ],
    messages: [
      {
        id: 'msg-user-task',
        agent: 'butler',
        content: '搜索 Ready 项目最近的提交',
        type: 'user',
        timestamp: new Date('2026-05-21T13:00:00Z'),
      },
    ],
    currentAgent: 'butler',
    currentScopeId: scopeId,
    currentScope: {
      id: scopeId,
      agent: 'butler',
      title: '提交检索任务',
      sourceKind: 'local',
      sourceId: 'app',
      threadKey: 'local:app',
      meta: {},
      createdAt: '2026-05-21T12:59:00Z',
      updatedAt: '2026-05-21T13:00:05Z',
    },
    scopes: [
      {
        id: scopeId,
        agent: 'butler',
        title: '提交检索任务',
        sourceKind: 'local',
        sourceId: 'app',
        threadKey: 'local:app',
        meta: {},
        createdAt: '2026-05-21T12:59:00Z',
        updatedAt: '2026-05-21T13:00:05Z',
      },
    ],
    scopeRunStates: {
      [scopeId]: {
        scopeId,
        agent: 'butler',
        requestId: 'req-task-1',
        taskId: 'task-1',
        phase: 'tool_running',
        terminalReason: null,
        toolTrace: [
          {
            id: 'trace-1',
            kind: 'call',
            text: 'git_log --since 7d',
            timestamp: new Date('2026-05-21T13:00:02Z'),
          },
        ],
        startedAt: '2026-05-21T13:00:00Z',
        updatedAt: '2026-05-21T13:00:05Z',
        responseMessageId: null,
        taskTitle: '检索最近提交',
        taskSummary: '在 ready-cowork 仓库执行 git log',
        steps: [
          {
            id: 'step-1',
            title: '解析仓库根目录',
            status: 'done',
            updatedAt: '2026-05-21T13:00:01Z',
          },
          {
            id: 'step-2',
            title: '调用 git log',
            status: 'running',
            updatedAt: '2026-05-21T13:00:02Z',
          },
        ],
        currentStepId: 'step-2',
        waitingFor: 'tool',
        resumableActions: [],
        recentArtifacts: [],
        taskContinuation: null,
        progress: null,
      },
    },
    isStreaming: false,
    foregroundBusy: true,
    composerLocked: true,
    streamingMessageId: null,
    streamingRequestId: null,
    inputValue: '',
    conversations: [],
    conversationId: null,
    toolTrace: [],
    toolTraceStatus: 'running',
    attachments: [],
    filePool: [],
    activeAttachmentPreview: null,
    pendingSendCount: 0,
    pendingSendFlushAt: null,
    taskDisclosureState: {},
  })

  const { container, unmount } = mountChatPanel('expanded')
  try {
    const root = container.querySelector('[data-chat-panel-root="true"]')
    assert.ok(root, 'ChatPanel root present with active tool_running task')
    const tree = serializeSemantic(root as Element)
    const formatted = formatSemantic(tree)
    assert.match(formatted, /^div \[data-chat-panel-root=true\]/)
    // Behavior lock: with tool_running scopeRun the shell still renders
    // exactly one chat-panel-root and the user message text appears.
    const fullText = (root as Element).textContent || ''
    assert.match(fullText, /搜索 Ready 项目最近的提交/, 'user task message is rendered')
    const allRoots = container.querySelectorAll('[data-chat-panel-root="true"]')
    assert.equal(allRoots.length, 1, 'tool_running case has exactly one shell root')
    // Marker lock: same baseline (no reference-skill / recall capsule),
    // task card is rendered inside ChatMessages without contributing a
    // new top-level marker — that's the structural truth we lock.
    const markers = collectMarkers(tree)
    assert.deepEqual(
      markers,
      ['data-chat-panel-root=true', 'data-liquid-shell=chat-panel'],
      'tool_running shell baseline markers',
    )
  } finally {
    unmount()
  }
})

// ---------------------------------------------------------------------------
// V1.0 Case 4 — completed task-card (terminal projection)
// ---------------------------------------------------------------------------
// A task that's finished — scopeRunState.phase = 'done', all steps in
// `done` status, terminalReason populated. The task card should render
// in its completed shape (no spinner, no in-flight tool trace). This
// locks the structural shell around the terminal projection so V1.6 /
// V1.8 / V1.9c extractions can't accidentally drop the completed-card
// rendering path.

test('V1.0 fixture / case 4 — completed task-card: terminal projection renders without crash', () => {
  resetStores()
  const scopeId = 'scope-task-done'
  useAgent.setState({
    agents: [
      { name: 'butler', displayName: '管家', avatar: '', status: 'idle' },
    ],
    messages: [
      {
        id: 'msg-user-done',
        agent: 'butler',
        content: '帮我整理今天的会议纪要',
        type: 'user',
        timestamp: new Date('2026-05-21T14:00:00Z'),
      },
      {
        id: 'msg-agent-done',
        agent: 'butler',
        content: '会议纪要已整理完成，已保存到本地。',
        type: 'agent',
        timestamp: new Date('2026-05-21T14:00:20Z'),
      },
    ],
    currentAgent: 'butler',
    currentScopeId: scopeId,
    currentScope: {
      id: scopeId,
      agent: 'butler',
      title: '会议纪要整理',
      sourceKind: 'local',
      sourceId: 'app',
      threadKey: 'local:app',
      meta: {},
      createdAt: '2026-05-21T13:59:00Z',
      updatedAt: '2026-05-21T14:00:20Z',
    },
    scopes: [
      {
        id: scopeId,
        agent: 'butler',
        title: '会议纪要整理',
        sourceKind: 'local',
        sourceId: 'app',
        threadKey: 'local:app',
        meta: {},
        createdAt: '2026-05-21T13:59:00Z',
        updatedAt: '2026-05-21T14:00:20Z',
        lastMessageAt: '2026-05-21T14:00:20Z',
      },
    ],
    scopeRunStates: {
      [scopeId]: {
        scopeId,
        agent: 'butler',
        requestId: 'req-done-1',
        taskId: 'task-done-1',
        phase: 'done',
        terminalReason: 'completed',
        toolTrace: [
          {
            id: 'trace-call-1',
            kind: 'call',
            text: 'note_summarize',
            timestamp: new Date('2026-05-21T14:00:05Z'),
          },
          {
            id: 'trace-result-1',
            kind: 'result',
            text: 'ok',
            timestamp: new Date('2026-05-21T14:00:18Z'),
          },
        ],
        startedAt: '2026-05-21T14:00:00Z',
        updatedAt: '2026-05-21T14:00:20Z',
        responseMessageId: 'msg-agent-done',
        responseSegmentToolTraceStart: 0,
        taskTitle: '整理会议纪要',
        taskSummary: '汇总录音转写并生成结构化纪要',
        steps: [
          {
            id: 'step-collect',
            title: '收集会议素材',
            status: 'done',
            updatedAt: '2026-05-21T14:00:03Z',
          },
          {
            id: 'step-summarize',
            title: '生成纪要',
            status: 'done',
            updatedAt: '2026-05-21T14:00:18Z',
          },
        ],
        currentStepId: null,
        waitingFor: 'none',
        resumableActions: [],
        recentArtifacts: [],
        taskContinuation: null,
        progress: null,
      },
    },
    isStreaming: false,
    foregroundBusy: false,
    composerLocked: false,
    streamingMessageId: null,
    streamingRequestId: null,
    inputValue: '',
    conversations: [],
    conversationId: null,
    toolTrace: [],
    toolTraceStatus: 'idle',
    attachments: [],
    filePool: [],
    activeAttachmentPreview: null,
    pendingSendCount: 0,
    pendingSendFlushAt: null,
    taskDisclosureState: {},
  })

  const { container, unmount } = mountChatPanel('expanded')
  try {
    const root = container.querySelector('[data-chat-panel-root="true"]')
    assert.ok(root, 'ChatPanel root present with completed task projection')
    const tree = serializeSemantic(root as Element)
    const formatted = formatSemantic(tree)
    assert.match(formatted, /^div \[data-chat-panel-root=true\]/)

    // The completed task summary and assistant final reply both surface.
    const fullText = (root as Element).textContent || ''
    assert.match(fullText, /会议纪要已整理完成/, 'final assistant reply is rendered')
    assert.match(fullText, /帮我整理今天的会议纪要/, 'user prompt is rendered')

    // Single shell root + baseline marker set (no recall / hint cards).
    const allRoots = container.querySelectorAll('[data-chat-panel-root="true"]')
    assert.equal(allRoots.length, 1, 'completed-task case has exactly one shell root')
    const markers = collectMarkers(tree)
    assert.deepEqual(
      markers,
      ['data-chat-panel-root=true', 'data-liquid-shell=chat-panel'],
      'completed-task shell baseline markers',
    )
  } finally {
    unmount()
  }
})


test('composer submits the Main head reference with its consequence; the set-aside notice is not shown', async () => {
  resetStores()
  seedEmptyAgent()
  const scopeId = 'scope-consequence-ui'
  const sessionId = 'session-consequence-ui'
  const scope = { id: scopeId, aliasGeneration: 1, messageVisibilityEpoch: 0, agent: 'butler',
    activeAgentId: 'butler', handoffGeneration: 0, title: '省略提示', sourceKind: 'local' as const,
    sourceId: 'app', threadKey: scopeId, meta: {}, createdAt: '2026-09-03T00:00:00Z',
    updatedAt: '2026-09-03T00:00:00Z', lastMessageAt: null }
  const tail = [
    { messageId: 'a', digest: 'a'.repeat(64), policy: 'resource_restatement_required' as const },
    { messageId: 'b', digest: 'b'.repeat(64), policy: 'task_restatement_required' as const },
  ]
  const head = makeScopeHeadActionProjection(scopeId, { uncommittedStructuredTail: tail })
  const slice = { ...makeEmptySessionSlice(scopeId), aliasGeneration: 1,
    inputValue: '本次新任务', scopeHeadActionProjection: head }
  const agentApi = electronAPIStub.agent as Record<string, unknown>
  const originalList = agentApi.listConversationScopes
  agentApi.listConversationScopes = async () => ({ success: false })
  const originalSend = useAgent.getState().sendMessage
  const originalRefresh = useAgent.getState().refreshCodexActionSurface
  let submitted: unknown
  let refreshes = 0
  useAgent.setState({ ...slice, currentScopeId: scopeId, currentScope: scope, scopes: [scope],
    sessions: { [sessionId]: slice }, activeSessionId: sessionId, sessionId, sessionOrder: [sessionId],
    sendMessage: async (_text, options) => {
      submitted = options?.actionAdmissionRef
      return { success: false, disposition: 'rejected_before_persistence',
        errorKind: 'conversation_reset_required' }
    },
    refreshCodexActionSurface: async () => { refreshes += 1 },
  })
  const { container, unmount } = mountChatPanel()
  try {
    assert.equal(container.querySelector('[data-ready-send-consequence="true"]'), null)
    assert.doesNotMatch(container.textContent || '', /不会作为当前任务带入/)
    container.querySelector<HTMLButtonElement>('[data-ready-agent-send="true"]')!.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(submitted, codexHeadActionAdmissionRef(head))
    assert.equal(useAgent.getState().inputValue, '本次新任务')
    flushSync(() => useAgent.setState((state) => ({ sessions: {
      ...state.sessions, [sessionId]: { ...state.sessions[sessionId], scopeHeadActionProjection: null },
    } })))
    const recovery = container.querySelector('[data-ready-action-state="head_unavailable"]')
    assert.ok(recovery)
    assert.equal(container.querySelector('[data-ready-agent-stop="true"]'), null)
    assert.equal(container.querySelector<HTMLButtonElement>('[data-ready-agent-send="true"]')?.disabled, true)
    recovery.querySelector<HTMLButtonElement>('button')!.click()
    assert.equal(refreshes, 1)
    assert.equal(useAgent.getState().inputValue, '本次新任务')
  } finally {
    unmount()
    agentApi.listConversationScopes = originalList
    useAgent.setState({ sendMessage: originalSend, refreshCodexActionSurface: originalRefresh })
  }
})


test('the latest user message can be copied, or edited in place and sent as an ordinary new message', async () => {
  resetStores()
  seedEmptyAgent()
  const scopeId = 'scope-resend-ui'
  const sessionId = 'session-resend-ui'
  const scope = { id: scopeId, aliasGeneration: 1, messageVisibilityEpoch: 0, agent: 'butler',
    activeAgentId: 'butler', handoffGeneration: 0, title: '重新发送', sourceKind: 'local' as const,
    sourceId: 'app', threadKey: scopeId, meta: {}, createdAt: '2026-09-03T00:00:00Z',
    updatedAt: '2026-09-03T00:00:00Z', lastMessageAt: null }
  const head = makeScopeHeadActionProjection(scopeId, { uncommittedStructuredTail: [
    { messageId: 'u1', digest: 'a'.repeat(64), policy: 'resource_restatement_required' as const },
  ] })
  const messages = [
    { id: 'u1', type: 'user' as const, content: '明天广州天气怎么样', timestamp: 1 },
    { id: 'a1', type: 'agent' as const, content: '本轮未能完成。', timestamp: 2, meta: { runId: 'run-1' } },
  ]
  const slice = { ...makeEmptySessionSlice(scopeId), aliasGeneration: 1, messages, scopeHeadActionProjection: head }
  const agentApi = electronAPIStub.agent as Record<string, unknown>
  const originalList = agentApi.listConversationScopes
  agentApi.listConversationScopes = async () => ({ success: false })
  const originalSend = useAgent.getState().sendMessage
  const sent: Array<{ text: string; ref: unknown }> = []
  useAgent.setState({ ...slice, currentScopeId: scopeId, currentScope: scope, scopes: [scope],
    sessions: { [sessionId]: slice }, activeSessionId: sessionId, sessionId, sessionOrder: [sessionId],
    sendMessage: async (text, options) => {
      sent.push({ text, ref: options?.actionAdmissionRef })
      return { success: true } as never
    },
  })
  const { container, unmount } = mountChatPanel()
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
  try {
    // The baseline mount shows the conversation in more than one list; follow one of them.
    const list = container.querySelector('.ready-chat-user-message')!.closest('.panel-hover-scrollbar')!
    const actions = () => list.querySelector('[data-chat-user-message-actions="true"]')
    const editor = () => list.querySelector<HTMLTextAreaElement>('[data-chat-user-message-editor="true"] textarea')
    const editorButton = (label: string) => [...list.querySelectorAll<HTMLButtonElement>(
      '[data-chat-user-message-editor="true"] button',
    )].find((button) => button.textContent === label)!
    assert.ok(actions()?.querySelector('[aria-label="复制"]'))
    flushSync(() => actions()!.querySelector<HTMLButtonElement>('[aria-label="编辑"]')!.click())
    assert.equal(editor()?.value, '明天广州天气怎么样')
    assert.equal(actions(), null, 'the bubble gives way to the editor')

    // Cancel leaves everything as it was.
    flushSync(() => editorButton('取消').click())
    assert.equal(editor(), null)
    assert.deepEqual(sent, [])

    // A draft in the composer is never overwritten or sent in its place; the editor stays open.
    flushSync(() => actions()!.querySelector<HTMLButtonElement>('[aria-label="编辑"]')!.click())
    editor()!.value = '后天广州天气怎么样'
    flushSync(() => useAgent.setState((state) => ({ inputValue: '写了一半',
      sessions: { ...state.sessions, [sessionId]: { ...state.sessions[sessionId], inputValue: '写了一半' } } })))
    flushSync(() => editorButton('发送').click())
    await tick()
    assert.deepEqual(sent, [])
    assert.equal(useAgent.getState().inputValue, '写了一半')
    assert.equal(editor()?.value, '后天广州天气怎么样')

    flushSync(() => useAgent.setState((state) => ({ inputValue: '',
      sessions: { ...state.sessions, [sessionId]: { ...state.sessions[sessionId], inputValue: '' } } })))
    flushSync(() => editorButton('发送').click())
    await tick()
    assert.deepEqual(sent, [{ text: '后天广州天气怎么样', ref: codexHeadActionAdmissionRef(head) }])
    assert.equal(editor(), null)
  } finally {
    unmount()
    agentApi.listConversationScopes = originalList
    useAgent.setState({ sendMessage: originalSend })
  }
})
