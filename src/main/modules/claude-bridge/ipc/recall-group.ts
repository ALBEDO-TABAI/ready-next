// Stage V V2.1g — RecallGroup channel group.
//
// Bundles the 8 channels that expose the session-recall surface (search +
// list + capsule lookup + attached-context maintenance + reference skill
// hint + resume-candidate probe) to the renderer:
//
//   agent:searchSessionRecall              (full-text + filter search)
//   agent:listRecentSessions               (recent-first window)
//   agent:getSessionRecallCapsule          (one capsule by conversationId)
//   agent:listAttachedSessionRecallContexts(currently attached capsules)
//   agent:getReferenceSkillHint            (latest live reference skill hint)
//   agent:attachSessionRecallContext       (attach a session as context)
//   agent:detachSessionRecallContext       (detach a session from context)
//   agent:resumeSessionCandidate           (probe a resume target)
//
// Handler bodies are lifted VERBATIM from `ipc-handler.ts` (V2.1g is a pure
// move — semantics must be byte-for-byte identical so the V5 IPC contract
// gate stays green and downstream renderer flows do not notice the refactor).
//
// All eight channels live in one group because they share:
//   • the same domain concept (session-recall reads + attach/detach mutations
//     and the reference skill hint that hangs off the same scope)
//   • the same dispose lifecycle (renderer boots them together when opening
//     the session-recall picker / context strip)
//   • a closely-coupled dep surface (every handler is a one-line forward to
//     a `runtime.*` method)
//
// Per-group deps are NOT a `Pick<EngineDeps>` — same rationale as the other
// V2.1 groups: the dep surface is bound runtime methods (resolved fresh per
// `setupAgentIPC` invocation), not composition-root singletons. `engine-deps.ts`
// is reserved for true singletons; mixed/bound surfaces stay on the per-group
// interface where they belong.
import type { IpcMain } from 'electron'
import type {
  ConversationScope,
  ConversationSourceKind,
} from '../../agent-control/contracts/types'
import type { SessionRecallCapsule, SessionRecallHit } from '../../../../shared/session-recall'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'

/**
 * Local mirror of the host's `IPCResponse` shape. Inlined to avoid a back
 * import from `ipc-handler.ts` (the file we are extracting AWAY from); the
 * shape is stable across the codebase — see `IPCResponse<T>` in the host.
 */
interface IPCResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  mock?: boolean
  errorKind?: string
  persistence?: unknown
}

/**
 * Filter payload for `agent:searchSessionRecall`. Mirrors the inline anonymous
 * type from the pre-extraction handler. The renderer hands these straight
 * through to `runtime.searchSessionRecall`; the runtime then narrows
 * `sourceKind` against `ConversationSourceKind`.
 */
export interface SearchSessionRecallPayload {
  query?: string
  channelKey?: string
  sourceKind?: ConversationSourceKind
  userId?: string
  agent?: string
  hasAttachments?: boolean
  currentScopeId?: string
  limit?: number
}

/**
 * Filter payload for `agent:listRecentSessions`. Same shape as
 * `SearchSessionRecallPayload` minus the free-text `query` field.
 */
export interface ListRecentSessionsPayload {
  channelKey?: string
  sourceKind?: ConversationSourceKind
  userId?: string
  agent?: string
  hasAttachments?: boolean
  currentScopeId?: string
  limit?: number
}

/**
 * Result shape from `runtime.attachSessionRecallContext`. Mirrored locally for
 * the same reason as `IPCResponse`: avoid a back import from runtime types
 * into the lifted handler body.
 */
export interface AttachSessionRecallContextResult {
  scope: ConversationScope
  capsule: SessionRecallCapsule
}

/**
 * Result shape from `runtime.detachSessionRecallContext`. Mirrored locally —
 * same rationale as `AttachSessionRecallContextResult`.
 */
export interface DetachSessionRecallContextResult {
  scope: ConversationScope
}

/**
 * Reference-skill hint shape returned by `runtime.getReferenceSkillHint`.
 * Mirrored locally to keep the group decoupled from the runtime module.
 */
export interface ReferenceSkillHint {
  id: string
  name: string
  at: number
  expiresAt: number
}

/**
 * Payload for `agent:resumeSessionCandidate`. Both fields are optional —
 * the runtime treats the missing-conversationId case as a title-based probe.
 */
export interface ResumeSessionCandidatePayload {
  conversationId?: string
  resumeTitle?: string
}

/**
 * Per-group deps. Mixed surface — see file header for why this is not
 * `Pick<EngineDeps, …>`.
 *
 * Each field is a bound runtime method (bound by the host so the group never
 * imports `AgentControlRuntime` and stays decoupled from the runtime
 * concrete class).
 */
export interface RecallGroupDeps {
  /**
   * Bound `runtime.searchSessionRecall` — sync, returns filtered session-
   * recall hits.
   */
  searchSessionRecall(payload?: SearchSessionRecallPayload): SessionRecallHit[]
  /**
   * Bound `runtime.listRecentSessions` — sync, returns recent-first session
   * window matching the filter payload.
   */
  listRecentSessions(payload?: ListRecentSessionsPayload): SessionRecallHit[]
  /**
   * Bound `runtime.getSessionRecallCapsule` — sync, returns the capsule for
   * a conversationId or `null` if missing.
   */
  getSessionRecallCapsule(conversationId: string): SessionRecallCapsule | null
  /**
   * Bound `runtime.listAttachedSessionRecallContexts` — sync, returns the
   * capsules currently attached to the given scope.
   */
  listAttachedSessionRecallContexts(scopeId: string): SessionRecallCapsule[]
  /**
   * Bound `runtime.getReferenceSkillHint` — sync, returns the latest live
   * reference skill hint for the scope or `null` when none is active.
   */
  getReferenceSkillHint(scopeId: string): ReferenceSkillHint | null
  /**
   * Bound `runtime.attachSessionRecallContext` — sync, attaches the named
   * conversation as session-recall context on the current scope.
   */
  attachSessionRecallContext(
    currentScopeId: string,
    conversationId: string,
  ): AttachSessionRecallContextResult
  /**
   * Bound `runtime.detachSessionRecallContext` — sync, detaches the named
   * conversation from session-recall context on the current scope.
   */
  detachSessionRecallContext(
    currentScopeId: string,
    conversationId: string,
  ): DetachSessionRecallContextResult
  /**
   * Bound `runtime.resumeSessionCandidate` — sync, probes whether a resume
   * candidate exists for the supplied conversationId / title combo.
   */
  resumeSessionCandidate(payload: ResumeSessionCandidatePayload): SessionRecallHit | null
}

const CHANNELS = [
  'agent:searchSessionRecall',
  'agent:listRecentSessions',
  'agent:getSessionRecallCapsule',
  'agent:listAttachedSessionRecallContexts',
  'agent:getReferenceSkillHint',
  'agent:attachSessionRecallContext',
  'agent:detachSessionRecallContext',
  'agent:resumeSessionCandidate',
] as const

export const recallGroup: IpcChannelGroup<RecallGroupDeps> = {
  namespace: 'agent:recall',

  register(ipcMain: IpcMain, deps: RecallGroupDeps): IpcDisposeHandle {
    // setupAgentIPC runs on every dev reload; strip any prior handler so
    // `ipcMain.handle` does not throw on the second registration. Mirrors the
    // pre-extraction defensive `removeHandler` calls in `ipc-handler.ts`.
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore — handler may not exist */ }
    }

    ipcMain.handle('agent:searchSessionRecall', (_, payload?: SearchSessionRecallPayload): IPCResponse => {
      try {
        return { success: true, data: deps.searchSessionRecall(payload) }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:listRecentSessions', (_, payload?: ListRecentSessionsPayload): IPCResponse => {
      try {
        return { success: true, data: deps.listRecentSessions(payload) }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:getSessionRecallCapsule', (_, payload: { conversationId: string }): IPCResponse => {
      try {
        const capsule = deps.getSessionRecallCapsule(payload.conversationId)
        if (!capsule) return { success: false, error: `Session recall capsule not found: ${payload.conversationId}` }
        return { success: true, data: capsule }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:listAttachedSessionRecallContexts', (_, payload: { scopeId: string }): IPCResponse => {
      try {
        return { success: true, data: deps.listAttachedSessionRecallContexts(payload.scopeId) }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:getReferenceSkillHint', (_, payload: { scopeId: string }): IPCResponse => {
      try {
        const scopeId = String(payload?.scopeId || '').trim()
        if (!scopeId) return { success: true, data: null }
        return { success: true, data: deps.getReferenceSkillHint(scopeId) }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:attachSessionRecallContext', (_, payload: { currentScopeId: string; conversationId: string }): IPCResponse => {
      try {
        return { success: true, data: deps.attachSessionRecallContext(payload.currentScopeId, payload.conversationId) }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:detachSessionRecallContext', (_, payload: { currentScopeId: string; conversationId: string }): IPCResponse => {
      try {
        return { success: true, data: deps.detachSessionRecallContext(payload.currentScopeId, payload.conversationId) }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:resumeSessionCandidate', (_, payload: ResumeSessionCandidatePayload): IPCResponse => {
      try {
        return { success: true, data: deps.resumeSessionCandidate(payload) }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
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
export const _recallGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
