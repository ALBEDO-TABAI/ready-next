/**
 * Regression — pushed ask_user_questions card must mirror into top-level
 * `messages` whenever it routes to the ACTIVE-KEY slice, even when
 * `state.activeSessionId` is null.
 *
 * Bug: after `loadScope` (which writes into `sessions[activeSessionKey]` but
 * never assigns `activeSessionId`), `activeSessionId` stays null and
 * `activeSessionKey` falls back to `sessionId`/`PRIMARY_SESSION_KEY`. The
 * card-push listener mirrored to top-level `messages` only when
 * `decision.targetSessionId === prev.activeSessionId` — comparing against the
 * raw null field — so the routed card landed in the active slice but never
 * surfaced in the rendered top-level stream. It only appeared once an
 * unrelated active-slice write (e.g. expanding a tool-trace section via
 * `setTaskSectionExpanded`) re-ran the slice→top-level mirror.
 *
 * Fix: the listener compares against `activeSessionKey(prev)` — the same key
 * top-level `messages` actually mirrors. This test drives the real listener
 * (`initAgentInteractionListeners`) with a minimal `agentInteraction` mock and
 * asserts the card reaches top-level `messages` in the null-activeSessionId
 * case, while still NOT bleeding into the active view for background-session
 * cards.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  initAgentInteractionListeners,
  useAgent,
  type AskUserQuestionsCardState,
  type SessionSlice,
} from '../renderer/stores/useAgent'

type PushHandler = (event: {
  cardId: string
  sessionId: string | null
  conversationId: string | null
  questions: AskUserQuestionsCardState['questions']
  askedAt: number
}) => void

function makeSlice(patch: Partial<SessionSlice> = {}): SessionSlice {
  return {
    messages: [],
    pendingSendCount: 0,
    pendingSendFlushAt: null,
    isStreaming: false,
    foregroundBusy: false,
    composerLocked: false,
    streamingMessageId: null,
    streamingRequestId: null,
    scopeRunStates: {},
    taskDisclosureState: {},
    state: 'live',
    conversationId: null,
    inputValue: '',
    ...patch,
  }
}

function seedStore(opts: {
  sessions: Record<string, SessionSlice>
  activeSessionId: string | null
  sessionId: string
}) {
  useAgent.setState({
    agents: [{ name: 'butler', displayName: '管家', avatar: '', status: 'idle', selected: true }],
    messages: [],
    currentAgent: 'butler',
    inputValue: '',
    pendingContinuationIntent: null,
    pendingContinuationDraftAnchor: null,
    isStreaming: false,
    foregroundBusy: false,
    composerLocked: false,
    streamingMessageId: null,
    streamingRequestId: null,
    sessionId: opts.sessionId,
    conversationId: null,
    conversations: [],
    currentScopeId: null,
    currentScope: null,
    scopes: [],
    scopeRunStates: {},
    toolTrace: [],
    toolTraceStatus: 'idle',
    attachments: [],
    filePool: [],
    activeAttachmentPreview: null,
    sendCoalescingEnabled: true,
    sendCoalescingWindowMs: 1200,
    pendingSendCount: 0,
    pendingSendFlushAt: null,
    sessions: opts.sessions,
    activeSessionId: opts.activeSessionId,
    sessionOrder: Object.keys(opts.sessions),
    taskDisclosureState: {},
  })
}

const SAMPLE_QUESTIONS: AskUserQuestionsCardState['questions'] = [
  { id: 'q1', question: '继续安装？', kind: 'single_choice', options: ['是', '否'], placeholder: null, required: true },
]

/**
 * Installs a minimal `window.electronAPI` so the listener can subscribe, then
 * calls `initAgentInteractionListeners` and returns the captured push handler
 * plus a teardown that unsubscribes and clears the global.
 */
function driveListener(): { push: PushHandler; teardown: () => void } {
  const hadWindow = 'window' in globalThis
  const previousWindow = (globalThis as { window?: unknown }).window
  let captured: PushHandler | null = null
  ;(globalThis as { window?: unknown }).window = {
    electronAPI: {
      agentInteraction: {
        listPendingAskUserQuestions: () => Promise.resolve({ success: true, data: [] }),
        onAskUserQuestionsCard: (handler: PushHandler) => {
          captured = handler
          return () => { captured = null }
        },
      },
    },
  }
  const unsubscribe = initAgentInteractionListeners()
  if (!captured) throw new Error('listener did not subscribe to onAskUserQuestionsCard')
  return {
    push: captured,
    teardown: () => {
      try { unsubscribe() } catch { /* silent-catch: teardown best-effort */ }
      if (hadWindow) (globalThis as { window?: unknown }).window = previousWindow
      else delete (globalThis as { window?: unknown }).window
    },
  }
}

// ---------------------------------------------------------------------------

test('pushed card mirrors to top-level messages when activeSessionId is null (post-loadScope state)', () => {
  // Post-loadScope: activeSessionId null, active-key slice == sessions[sessionId],
  // whose conversationId is the loaded scope. The push carries that scope id.
  seedStore({
    sessions: { 'session-bootstrap': makeSlice({ state: 'live', conversationId: 'conv-X' }) },
    activeSessionId: null,
    sessionId: 'session-bootstrap',
  })
  const { push, teardown } = driveListener()
  try {
    push({ cardId: 'card-null-active', sessionId: 'conv-X', conversationId: 'conv-X', questions: SAMPLE_QUESTIONS, askedAt: Date.now() })

    const state = useAgent.getState()
    const top = state.messages.find((m) => m.id === 'card-null-active')
    assert.ok(top, 'card must appear in top-level messages (the rendered stream)')
    assert.equal(top!.type, 'ask_user_questions')
    assert.equal(top!.askUserQuestions?.status, 'pending')

    const slice = state.sessions['session-bootstrap']
    assert.ok(
      slice.messages.some((m) => m.id === 'card-null-active'),
      'card must also live in the active-key slice',
    )
  } finally {
    teardown()
  }
})

test('pushed card mirrors to top-level messages when activeSessionId is set and equals the target (no regression)', () => {
  seedStore({
    sessions: { 'session-A': makeSlice({ state: 'live', conversationId: 'conv-A' }) },
    activeSessionId: 'session-A',
    sessionId: 'session-A',
  })
  const { push, teardown } = driveListener()
  try {
    push({ cardId: 'card-active', sessionId: 'session-A', conversationId: 'conv-A', questions: SAMPLE_QUESTIONS, askedAt: Date.now() })

    const state = useAgent.getState()
    assert.ok(state.messages.some((m) => m.id === 'card-active'), 'active-session card surfaces in top-level messages')
  } finally {
    teardown()
  }
})

test('pushed card for a background session does NOT bleed into the active top-level stream (no regression)', () => {
  seedStore({
    sessions: {
      'session-A': makeSlice({ state: 'live', conversationId: 'conv-A' }),
      'session-B': makeSlice({ state: 'live', conversationId: 'conv-B' }),
    },
    activeSessionId: 'session-A',
    sessionId: 'session-A',
  })
  const { push, teardown } = driveListener()
  try {
    push({ cardId: 'card-bg', sessionId: 'session-B', conversationId: 'conv-B', questions: SAMPLE_QUESTIONS, askedAt: Date.now() })

    const state = useAgent.getState()
    assert.equal(
      state.messages.some((m) => m.id === 'card-bg'),
      false,
      'background-session card must NOT appear in the active top-level stream',
    )
    assert.ok(
      state.sessions['session-B'].messages.some((m) => m.id === 'card-bg'),
      'background card stays parked in its own slice until the user switches',
    )
  } finally {
    teardown()
  }
})
