// Stage V V2.1a — AskUser channel group.
//
// Bundles the 6 channels that drive both flavors of the agent-side "ask the
// user a question" interaction:
//
//   skills:askUser:submit              (single-question, skill primitive)
//   skills:askUser:pending             (list pending single-question prompts)
//   agent:askUserQuestions:submit      (multi-question reflection card)
//   agent:askUserQuestions:cancel      (cancel a reflection card)
//   agent:askUserQuestions:listPending (hydrate live reflection cards)
//   agent:frozenCall:respond           (EP1-I3-2 confirm/deny a frozen call —
//                                       programmatic press of the confirmation
//                                       card variant; converges on submit core)
//
// Handler bodies are lifted VERBATIM from `ipc-handler.ts` (V2.1a is a pure
// move — semantics must be byte-for-byte identical so the V5 IPC contract
// gate stays green and downstream renderer flows don't notice the refactor).
//
// The two `skills:askUser:*` channels and three `agent:askUserQuestions:*`
// channels live in one group despite the prefix split because they share:
//   • the same domain concept (askUser flow from the model loop)
//   • the same dispose lifecycle (renderer treats them as one boot phase)
//   • the same dep surface (db + two stores + metric logger)
// Splitting them would create two groups whose deps overlap entirely, which
// goes against the per-group-deps-as-contract intent.
import type { IpcMain } from 'electron'
import {
  cancelAskUserQuestionsCardCore,
  submitAskUserQuestionsAnswersCore,
} from '../../tools/builtins/ask-user-questions'
import type { AskUserAnswer } from '../../tools/builtins/ask-user-questions-store'
import { getFrozenCallStore } from '../../agent-control/safety/frozen-call-bridge'
import {
  FROZEN_CALL_CONFIRM_OPTION,
  FROZEN_CALL_DENY_OPTION,
  FROZEN_CALL_QUESTION_ID,
} from '../../agent-control/safety/frozen-call-confirmation'
import type { EngineDeps } from './engine-deps'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'

/**
 * Per-group deps — subset of `EngineDeps`. Tests pass a fake that implements
 * exactly these four members; nothing more is required to exercise the 5
 * handler bodies.
 */
export type AskUserGroupDeps = Pick<
  EngineDeps,
  'getDatabase'
  | 'getEphemeralExecutionStore'
  | 'getAskUserQuestionsStore'
  | 'logAgentMetric'
  | 'refreshActiveRunProgress'
>

const CHANNELS = [
  'skills:askUser:submit',
  'skills:askUser:pending',
  'agent:askUserQuestions:submit',
  'agent:askUserQuestions:cancel',
  'agent:askUserQuestions:listPending',
  'agent:frozenCall:respond',
] as const

export const askUserGroup: IpcChannelGroup<AskUserGroupDeps> = {
  namespace: 'agent:askUser+skills:askUser',

  register(ipcMain: IpcMain, deps: AskUserGroupDeps): IpcDisposeHandle {
    // setupAgentIPC runs on every dev reload; strip any prior handler so
    // `ipcMain.handle` doesn't throw on the second registration. Mirrors the
    // pre-extraction defensive `removeHandler` calls in `ipc-handler.ts`.
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore — handler may not exist */ }
    }

    ipcMain.handle('skills:askUser:submit', (_event, rawPayload: unknown) => {
      const payload = (rawPayload || {}) as { executionId?: string; answer?: string }
      const executionId = typeof payload.executionId === 'string' ? payload.executionId : ''
      const answer = typeof payload.answer === 'string' ? payload.answer : ''
      if (!executionId) {
        return { success: false, error: 'executionId is required' }
	      }
	      const store = deps.getEphemeralExecutionStore()
	      const record = store.get(executionId)
	      const resolved = store.resolve(executionId, answer)
	      if (!resolved) {
	        return { success: false, error: 'No pending ask_user question with this id (already answered or timed out)' }
	      }
	      if (record?.agent && record.requestId) {
	        deps.refreshActiveRunProgress(record.agent, record.scopeId || record.sessionId || undefined, record.requestId)
	      }
	      return { success: true }
	    })

    ipcMain.handle('skills:askUser:pending', () => {
      return deps.getEphemeralExecutionStore().list()
    })

    // ===================== agent_interaction IPC =====================
    // ask_user_questions — multi-question reflection card. Submit handler:
    //   1. validate payload shape
    //   2. update DB row to status='submitted' + content=summary (so chat
    //      history search picks up the resolved Q/A even after restart)
    //   3. store.resolve(cardId, answerSet) so the handler Promise unblocks
    //      and the executor returns a ToolExecutionOutput to the model
    //
    // Order is critical: DB FIRST then store.resolve. Otherwise the model's
    // turn engine could race ahead (handler resumes synchronously inside
    // resolve) and observe DB still showing pending.
    ipcMain.handle('agent:askUserQuestions:submit', (_event, rawPayload: unknown) => {
      const payload = (rawPayload || {}) as { cardId?: string; answers?: unknown }
      const cardId = typeof payload.cardId === 'string' ? payload.cardId : ''
      if (!cardId) return { success: false, error: 'cardId is required' }
      if (!Array.isArray(payload.answers)) return { success: false, error: 'answers must be an array' }
      const answers: AskUserAnswer[] = []
      for (const raw of payload.answers as unknown[]) {
        if (!raw || typeof raw !== 'object') continue
        const a = raw as { id?: unknown; answer?: unknown }
        const id = typeof a.id === 'string' ? a.id : null
        if (!id) continue
        if (typeof a.answer === 'string') {
          answers.push({ id, answer: a.answer })
        } else if (Array.isArray(a.answer)) {
          const list: string[] = []
          for (const v of a.answer) {
            if (typeof v === 'string') list.push(v)
          }
          answers.push({ id, answer: list })
        }
      }
      // PR 1 — submit logic lives in `submitAskUserQuestionsAnswersCore` so it
      // can be unit-tested without electron / sqlite. This handler is the IPC
      // thin wrapper: payload unwrap + dep injection + result forward.
	      const record = deps.getAskUserQuestionsStore().get(cardId)
	      const result = submitAskUserQuestionsAnswersCore(cardId, answers, {
	        store: deps.getAskUserQuestionsStore(),
	        db: deps.getDatabase(),
	        logMetric: (name, payload) => deps.logAgentMetric(name, payload),
	      })
	      if (result.success && record?.agent && record.requestId) {
	        deps.refreshActiveRunProgress(record.agent, record.scopeId || record.sessionId || undefined, record.requestId)
	      }
	      return result
	    })

    ipcMain.handle('agent:askUserQuestions:cancel', (_event, rawPayload: unknown) => {
      const payload = (rawPayload || {}) as { cardId?: string; reason?: string }
      const cardId = typeof payload.cardId === 'string' ? payload.cardId : ''
      if (!cardId) return { success: false, error: 'cardId is required' }
      const reason = typeof payload.reason === 'string' && payload.reason.length > 0
        ? payload.reason
        : 'user_cancelled'
      // PR 1 — cancel logic lives in `cancelAskUserQuestionsCardCore` for the
      // same testability reasons as submit. See the test file for B.4a coverage.
      return cancelAskUserQuestionsCardCore(cardId, reason, {
        store: deps.getAskUserQuestionsStore(),
        db: deps.getDatabase(),
        logMetric: (name, payload) => deps.logAgentMetric(name, payload),
      })
    })

    // EP1-I3-2 — dedicated confirm/deny entry for the frozen-call
    // confirmation card (§7 minimal closed loop). Converges on the SAME
    // mechanism as a manual card answer: it programmatically submits the
    // pending ask_user_questions variant card via the submit core, so there
    // is exactly one decision state machine. The frozen-call store is read
    // through its bridge (module singleton) — same pattern the dispatcher
    // uses — to keep EngineDeps untouched.
    ipcMain.handle('agent:frozenCall:respond', (_event, rawPayload: unknown) => {
      const payload = (rawPayload || {}) as { frozenCallId?: string; decision?: string }
      const frozenCallId = typeof payload.frozenCallId === 'string' ? payload.frozenCallId : ''
      const decision = payload.decision === 'confirm' || payload.decision === 'deny'
        ? payload.decision
        : null
      if (!frozenCallId) return { success: false, error: 'frozenCallId is required' }
      if (!decision) return { success: false, error: "decision must be 'confirm' or 'deny'" }
      const frozenStore = getFrozenCallStore()
      if (!frozenStore) return { success: false, error: 'frozen-call store is not ready' }
      const record = frozenStore.get(frozenCallId)
      if (!record || record.status !== 'pending') {
        return { success: false, error: 'No pending frozen call with this id (already decided or expired)' }
      }
      const sessionKey = record.sessionId || record.scopeId
      const card = deps.getAskUserQuestionsStore().findPendingForSession(sessionKey)
      if (!card || card.questions[0]?.id !== FROZEN_CALL_QUESTION_ID) {
        return { success: false, error: 'No pending confirmation card for this frozen call' }
      }
	      const result = submitAskUserQuestionsAnswersCore(
	        card.cardId,
	        [{
	          id: FROZEN_CALL_QUESTION_ID,
          answer: decision === 'confirm' ? FROZEN_CALL_CONFIRM_OPTION : FROZEN_CALL_DENY_OPTION,
        }],
        {
          store: deps.getAskUserQuestionsStore(),
          db: deps.getDatabase(),
	          logMetric: (name, payload) => deps.logAgentMetric(name, payload),
	        },
	      )
	      if (result.success && card.agent && card.requestId) {
	        deps.refreshActiveRunProgress(card.agent, card.scopeId || card.sessionId || undefined, card.requestId)
	      }
	      return result
	    })

    ipcMain.handle('agent:askUserQuestions:listPending', () => {
      // Source of truth = DB rows still tagged status='pending'. Combine with
      // in-memory store to detect rows whose handler isn't waiting on them
      // anymore (those count as orphaned and are sent down as 'cancelled' so
      // the renderer doesn't display them as live cards).
      try {
        const dbPending = deps.getDatabase().listPendingAskUserQuestionsCards()
        const store = deps.getAskUserQuestionsStore()
        const liveIds = new Set(store.list().map((entry) => entry.cardId))
        const cards = dbPending
          .filter((entry) => liveIds.has(entry.messageId))
          .map((entry) => {
            const aug = entry.meta.askUserQuestions as Record<string, unknown>
            return {
              cardId: entry.messageId,
              conversationId: entry.conversationId,
              askedAt: typeof aug.askedAt === 'number' ? aug.askedAt : Date.parse(entry.timestamp),
              questions: Array.isArray(aug.questions) ? aug.questions : [],
            }
          })
        return { success: true, data: cards }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { success: false, error: message }
      }
    })

    return {
      dispose(): void {
        for (const channel of CHANNELS) {
          try { ipcMain.removeHandler(channel) } catch { /* ignore — already removed */ }
        }
      },
    }
  },
}

/** Exposed for the registration-behavior test (channels list assertion). */
export const _askUserGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
