// Stage V V2.1e — ConversationGroup channel group.
//
// Bundles the read/write/cache channels that expose conversation-scope state + attachment
// surface to the renderer:
//
//   agent:listConversationScopes        (list scopes)
//   agent:listScopeRuns                 (list active/completed scope-runs)
//   agent:readCodexLifecycleSnapshot    (durable Codex operation projection)
//   agent:getConversationScopeMessages  (full chat_messages stream for a scope)
//   agent:listScopeAttachments          (filesystem-verified attachment rows)
//   agent:getScopeAttachment            (one attachment by scope + attachmentId)
//   agent:clearRemoteAttachmentCache    (wipe channel-attachments cache dir)
//   agent:getRemoteAttachmentCacheStats (size/file counts for the cache dir)
//
// Handler bodies are lifted VERBATIM from `ipc-handler.ts` (V2.1e is a pure
// move — semantics must be byte-for-byte identical so the V5 IPC contract
// gate stays green and downstream renderer flows do not notice the refactor).
//
// All eight channels live in one group because they share:
//   • the same domain concept (conversation-scope reads + the attachment
//     resource layer that hangs off a scope)
//   • the same dispose lifecycle (renderer boots them together when opening
//     the workbench shell + session list)
//   • a closely-coupled dep surface (every handler is a one-line forward to
//     a `runtime.*` method, optionally wrapped with a `log` line for the two
//     channels that already had logging in the pre-extraction file)
//
// Per-group deps are NOT a `Pick<EngineDeps>` — same rationale as the
// `AgentLifecycleGroup` / `AgentRuntimeGroup`: the dep surface is bound
// runtime methods (resolved fresh per `setupAgentIPC` invocation) plus the
// host log appender, not composition-root singletons. `engine-deps.ts` is
// reserved for true singletons; mixed/bound surfaces stay on the per-group
// interface where they belong.
import type { IpcMain } from 'electron'
import {
  parseLifecycleRequest,
  type LifecycleRequest,
  type ProductTurnReceipt,
} from '../../../../shared/ipc-contracts/agent-runtime'
import type { LifecycleOperationProjectionV2 } from '../../../../shared/ipc-contracts/agent-lifecycle-snapshot'
import {
  parseActionAuthorizationMode,
  type ActionAuthorizationMode,
} from '../../../../shared/action-authorization-mode'
import type {
  ConversationAttachment,
  ConversationScope,
  ConversationScopeMessage,
  ScopeRunEventPayload,
  ScopeRunSummary,
} from '../../agent-control/contracts/types'
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
 * Payload shape for `agent:listScopeRuns`. Mirrors the inline anonymous type
 * from the pre-extraction handler; statuses arrive as plain strings from the
 * renderer and the handler narrows them via a filter so the runtime call
 * receives the strongly-typed `ScopeRunEventPayload['phase']` array.
 */
export interface ListScopeRunsPayload {
  channelKey?: string
  statuses?: string[]
  limit?: number
}

/**
 * Cache-stats shape returned from `runtime.getRemoteAttachmentCacheStats`.
 * Mirrored locally — see `runtime.ts` for the source of truth; lifting the
 * shape avoids dragging the entire runtime into this group's import graph.
 */
export interface RemoteAttachmentCacheStats {
  totalFiles: number
  totalBytes: number
  targetPath: string
  channels: Array<{ channelId: string; files: number; bytes: number }>
}

/**
 * Result shape from `runtime.clearRemoteAttachmentCache`. Same rationale as
 * `RemoteAttachmentCacheStats`.
 */
export interface ClearRemoteAttachmentCacheResult {
  removedFiles: number
  removedBytes: number
  targetPath: string
}

/**
 * Per-group deps. Mixed surface — see file header for why this is not
 * `Pick<EngineDeps, …>`.
 *
 * Each field is a bound runtime method (bound by the host so the group never
 * imports `AgentControlRuntime` and stays decoupled from the runtime
 * concrete class), plus the host `log` appender for the two channels that
 * had pre-extraction logging.
 */
export interface ConversationGroupDeps {
  /**
   * Bound `runtime.listConversationScopes` — sync, returns the scope rows
   * optionally filtered by agent.
   */
  listConversationScopes(): ConversationScope[]
  /**
   * Bound `runtime.listScopeRuns` — sync, returns the scope-run summary
   * window. Status narrowing happens INSIDE the handler before this is
   * called (so the dep signature uses the runtime's typed phase array).
   */
  listScopeRuns(payload?: {
    channelKey?: string
    statuses?: Array<ScopeRunEventPayload['phase']>
    limit?: number
  }): ScopeRunSummary[]
  readCodexLifecycleSnapshot(request: LifecycleRequest): LifecycleOperationProjectionV2
  readCodexHeadActionProjection(
    request: LifecycleRequest,
  ): import('../../../../shared/ipc-contracts/agent-runtime').CodexHeadActionProjection
  readCodexActionSurface(
    request: LifecycleRequest,
  ): import('../../../../shared/ipc-contracts/agent-runtime').CodexActionSurfaceEnvelope
  readProductTurnPresentation(
    readyRunId: string,
    requestedWorkbenchMode: 'browser' | 'document' | 'rss' | 'calendar',
  ): Promise<ProductTurnReceipt>
  readProductTurnPresentations(
    readyRunIds: readonly string[],
    requestedWorkbenchMode: 'browser' | 'document' | 'rss' | 'calendar',
  ): Promise<ProductTurnReceipt[]>
  /**
   * Bound `runtime.getConversationScopeMessages` — sync, returns the full
   * chat_messages stream for the scope.
   */
  getConversationScopeMessages(scopeId: string): ConversationScopeMessage[]
  setActionAuthorizationMode(
    scopeId: string,
    mode: ActionAuthorizationMode,
    expectedMessageVisibilityEpoch: number,
  ): ConversationScope
  /**
   * Bound `runtime.listScopeAttachments` — sync, returns attachment rows
   * that still exist on disk (the runtime filters via `existsSync`).
   */
  listScopeAttachments(scopeId: string): ConversationAttachment[]
  /**
   * Bound `runtime.getScopeAttachment` — sync, returns the attachment row
   * by (scopeId, attachmentId) or null if missing.
   */
  getScopeAttachment(scopeId: string, attachmentId: string): ConversationAttachment | null
  /**
   * Bound `runtime.clearRemoteAttachmentCache` — sync, wipes the channel
   * attachment cache subtree (whole base if `channelId` omitted).
   */
  clearRemoteAttachmentCache(channelId?: string): ClearRemoteAttachmentCacheResult
  /**
   * Bound `runtime.getRemoteAttachmentCacheStats` — sync, returns
   * file/byte counts under the cache dir (optionally scoped per channel).
   */
  getRemoteAttachmentCacheStats(channelId?: string): RemoteAttachmentCacheStats
  /**
   * Host log appender (rotating file logger). The scope-list read logs start
   * and failure lines;
   * the dep keeps the byte-for-byte log line behavior without forcing the
   * group to import the rotating-logger module directly.
   */
  log(message: string): void
}

const CHANNELS = [
  'agent:listConversationScopes',
  'agent:listScopeRuns',
  'agent:readCodexLifecycleSnapshot',
  'agent:readCodexHeadActionProjection',
  'agent:readCodexActionSurface',
  'agent:readProductTurnPresentation',
  'agent:readProductTurnPresentations',
  'agent:getConversationScopeMessages',
  'agent:setActionAuthorizationMode',
  'agent:listScopeAttachments',
  'agent:getScopeAttachment',
  'agent:clearRemoteAttachmentCache',
  'agent:getRemoteAttachmentCacheStats',
] as const

export const conversationGroup: IpcChannelGroup<ConversationGroupDeps> = {
  namespace: 'agent:conversation',

  register(ipcMain: IpcMain, deps: ConversationGroupDeps): IpcDisposeHandle {
    // setupAgentIPC runs on every dev reload; strip any prior handler so
    // `ipcMain.handle` does not throw on the second registration. Mirrors the
    // pre-extraction defensive `removeHandler` calls in `ipc-handler.ts`.
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore — handler may not exist */ }
    }

    ipcMain.handle('agent:listConversationScopes', (): IPCResponse => {
      try {
        const scopes = deps.listConversationScopes()
        deps.log(`[ipc] agent:listConversationScopes count=${scopes.length}`)
        return { success: true, data: scopes }
      } catch (error) {
        deps.log(`[ipc] agent:listConversationScopes failed error=${error instanceof Error ? error.message : String(error)}`)
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:listScopeRuns', (_, payload?: ListScopeRunsPayload): IPCResponse => {
      try {
        const statuses = Array.isArray(payload?.statuses)
          ? payload?.statuses.filter((item): item is 'queued' | 'planning' | 'tool_running' | 'checkpoint' | 'takeover' | 'resuming' | 'responding' | 'done' | 'error' | 'cancelled' =>
            item === 'queued' ||
            item === 'planning' ||
            item === 'tool_running' ||
            item === 'checkpoint' ||
            item === 'takeover' ||
            item === 'resuming' ||
            item === 'responding' ||
            item === 'done' ||
            item === 'error' ||
            item === 'cancelled')
          : undefined
        return { success: true, data: deps.listScopeRuns({ ...payload, statuses }) }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:readCodexLifecycleSnapshot', (_, payload: unknown): IPCResponse => {
      try {
        return {
          success: true,
          data: deps.readCodexLifecycleSnapshot(parseLifecycleRequest(payload)),
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:readCodexHeadActionProjection', (_, payload: unknown): IPCResponse => {
      try {
        return {
          success: true,
          data: deps.readCodexHeadActionProjection(parseLifecycleRequest(payload)),
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:readCodexActionSurface', (_, payload: unknown): IPCResponse => {
      try {
        return {
          success: true,
          data: deps.readCodexActionSurface(parseLifecycleRequest(payload)),
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:readProductTurnPresentation', async (_, payload: unknown): Promise<IPCResponse> => {
      try {
        const record = typeof payload === 'object' && payload
          ? payload as { readyRunId?: unknown; requestedWorkbenchMode?: unknown }
          : null
        const readyRunId = record
          ? String(record.readyRunId || '').trim()
          : ''
        const requestedWorkbenchMode = String(record?.requestedWorkbenchMode || '')
        if (!readyRunId) throw new Error('product_turn_run_id_invalid')
        if (!['browser', 'document', 'rss', 'calendar'].includes(requestedWorkbenchMode)) {
          throw new Error('product_turn_workbench_mode_invalid')
        }
        return {
          success: true,
          data: await deps.readProductTurnPresentation(
            readyRunId,
            requestedWorkbenchMode as 'browser' | 'document' | 'rss' | 'calendar',
          ),
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:readProductTurnPresentations', async (_, payload: unknown): Promise<IPCResponse> => {
      try {
        const readyRunIds = typeof payload === 'object' && payload
          && Array.isArray((payload as { readyRunIds?: unknown }).readyRunIds)
          ? (payload as { readyRunIds: unknown[] }).readyRunIds
            .map((value) => String(value || '').trim())
            .filter(Boolean)
          : []
        const requestedWorkbenchMode = typeof payload === 'object' && payload
          ? String((payload as { requestedWorkbenchMode?: unknown }).requestedWorkbenchMode || '')
          : ''
        if (!['browser', 'document', 'rss', 'calendar'].includes(requestedWorkbenchMode)) {
          throw new Error('product_turn_workbench_mode_invalid')
        }
        return {
          success: true,
          data: await deps.readProductTurnPresentations(
            readyRunIds,
            requestedWorkbenchMode as 'browser' | 'document' | 'rss' | 'calendar',
          ),
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:getConversationScopeMessages', (_, payload: { scopeId: string }): IPCResponse => {
      try {
        return { success: true, data: deps.getConversationScopeMessages(payload.scopeId) }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:setActionAuthorizationMode', (_, payload?: {
      scopeId?: unknown
      mode?: unknown
      expectedMessageVisibilityEpoch?: unknown
    }): IPCResponse => {
      try {
        const scopeId = typeof payload?.scopeId === 'string' ? payload.scopeId.trim() : ''
        if (!scopeId) return { success: false, error: 'action_authorization_scope_invalid' }
        const mode = parseActionAuthorizationMode(payload?.mode)
        if (mode !== payload?.mode) {
          return { success: false, error: 'action_authorization_mode_invalid' }
        }
        const expectedMessageVisibilityEpoch = payload?.expectedMessageVisibilityEpoch
        if (!Number.isSafeInteger(expectedMessageVisibilityEpoch)
          || Number(expectedMessageVisibilityEpoch) < 0) {
          return { success: false, error: 'action_authorization_scope_identity_invalid' }
        }
        const updated = deps.setActionAuthorizationMode(
          scopeId,
          mode,
          Number(expectedMessageVisibilityEpoch),
        )
        return {
          success: true,
          data: {
            scopeId: updated.id,
            mode,
            messageVisibilityEpoch: Number(expectedMessageVisibilityEpoch),
          },
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:listScopeAttachments', (_, payload?: { scopeId?: string }): IPCResponse => {
      try {
        const scopeId = String(payload?.scopeId || '').trim()
        if (!scopeId) return { success: true, data: [] }
        return { success: true, data: deps.listScopeAttachments(scopeId) }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:getScopeAttachment', (_, payload: { scopeId: string; attachmentId: string }): IPCResponse => {
      try {
        const attachment = deps.getScopeAttachment(payload.scopeId, payload.attachmentId)
        if (!attachment) {
          return { success: false, error: `Attachment not found: ${payload.attachmentId}` }
        }
        return { success: true, data: attachment }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:clearRemoteAttachmentCache', (_, payload?: { channelId?: string }): IPCResponse => {
      try {
        return { success: true, data: deps.clearRemoteAttachmentCache(payload?.channelId) }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:getRemoteAttachmentCacheStats', (_, payload?: { channelId?: string }): IPCResponse => {
      try {
        return { success: true, data: deps.getRemoteAttachmentCacheStats(payload?.channelId) }
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
export const _conversationGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
