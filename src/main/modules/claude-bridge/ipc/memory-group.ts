// Stage V V2.1n — MemoryGroup channel group.
//
// Bundles the 8 channels that expose the agent memory system surface
// (CRUD + stats + lifecycle + scope-to-memory promotion) used by the
// Memory settings UI and the reflection / promotion pipeline:
//
//   agent:memory:query                    (filtered list)
//   agent:memory:create                   (insert one row)
//   agent:memory:update                   (patch one row)
//   agent:memory:delete                   (remove one row)
//   agent:memory:stats                    (aggregate counts)
//   agent:memory:lifecycle:status         (read background-maintenance state)
//   agent:memory:lifecycle:runMaintenance (force one maintenance pass)
//   agent:memory:createFromConversation   (promote a conversation snippet
//                                          into a memory + knowledge row)
//
// Handler bodies are lifted VERBATIM from `ipc-handler.ts` (V2.1n is a pure
// move — semantics must be byte-for-byte identical so the V5 IPC contract
// gate stays green and the Memory UI does not notice the refactor).
//
// All eight channels live in one group because they share:
//   • the same domain concept (agent memory lifecycle: query → create →
//     update → delete → stats, plus the lifecycle/maintenance and the
//     promotion endpoint that writes into the same metadata table)
//   • the same dispose lifecycle (renderer boots them together when opening
//     the Memory settings page; the reflection pipeline also depends on
//     `createFromConversation` being live whenever the runtime is up)
//   • a closely-coupled dep surface (every handler is a one-line forward to
//     a `memoryRepository.*` / `memoryLifecycle.*` / `promptAssembly.*` method
//     resolved off the runtime — the host pre-resolves these as bound deps).
//
// The `agent:trigger:*` channels are NOT part of this group: they live on
// the same `memoryRepository` instance but the renderer surface treats
// memories and triggers as two separate Settings tabs and the V5 plan
// reserves a future V2.1 sub-step for trigger consolidation. Keeping the
// boundary at "memory metadata + lifecycle + promotion" matches the
// channel naming (`agent:memory:*`) and avoids dragging trigger CRUD into
// the same dispose unit when triggers may be retired or restructured
// independently (see plan §3 V2.1n).
//
// Per-group deps are NOT a `Pick<EngineDeps>` — same rationale as the
// other V2.1 groups: the dep surface is bound runtime / repository
// methods (resolved fresh per `setupAgentIPC` invocation), not
// composition-root singletons. `engine-deps.ts` is reserved for true
// singletons; mixed/bound surfaces stay on the per-group interface where
// they belong.
import type { IpcMain } from 'electron'
import type { MemoryEntry, MemoryQueryFilters, MemoryStats } from '../../repositories/memory-repository'
import type { MaintenanceResult } from '../../agent-control/memory/memory-lifecycle'
import type { ConversationScope } from '../../agent-control/contracts/types'
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
}

/**
 * `agent:memory:update` payload. Matches the inline anonymous type from the
 * pre-extraction handler verbatim. The `updates` field is intentionally a
 * `Record<string, unknown>` — the handler hands the patch straight through
 * to `memoryRepository.updateMemory`, which decides which keys it
 * recognises; widening to `Partial<MemoryEntry>` here would leak the
 * `MemoryEntry` shape into the IPC boundary and reject legitimate forward-
 * compatible fields the repo learns to support later.
 */
export interface UpdateMemoryPayload {
  id: string
  updates: Record<string, unknown>
}

/**
 * `agent:memory:lifecycle:status` response shape. Pinned here because the
 * host hand-builds this object literal (it is not a method on the
 * lifecycle manager); the group needs the type so the handler's return
 * value is checked.
 */
export interface MemoryLifecycleStatus {
  running: boolean
  lastMaintenanceAt: string | null
}

/**
 * `agent:memory:createFromConversation` payload. Matches the inline
 * anonymous type from the pre-extraction handler verbatim. The handler
 * looks up the scope by id (so the renderer never has to send a fully
 * hydrated `ConversationScope`) and forwards the rest to
 * `promptAssembly.createMemoryFromConversation`.
 */
export interface CreateMemoryFromConversationPayload {
  scopeId: string
  category: 'summary' | 'learning'
  title: string
  content: string
  tags?: string[]
  priority?: number
}

/**
 * Per-group deps. Mixed surface — see file header for why this is not
 * `Pick<EngineDeps, …>`.
 *
 * The repo / lifecycle / promotion accessors are intentionally
 * "resolve-on-demand" (each returns `null` when the runtime side is not
 * ready yet) — the pre-extraction handler called
 * `runtime?.getMemoryRepository()` and short-circuited with a structured
 * error response when the result was nullish. Keeping the dep shape as
 * `() => X | null` preserves that null-path verbatim instead of throwing
 * inside the dep at the wrong layer.
 */
export interface MemoryGroupDeps {
  /**
   * Resolves the memory repository on demand. Returns `null` while the
   * runtime is not yet initialised (the handler turns this into a
   * structured "Memory repository not available" error response — same
   * wording as the pre-extraction handler).
   */
  getMemoryRepository(): {
    queryMemories(filters: MemoryQueryFilters): Promise<MemoryEntry[]>
    createMemory(entry: Partial<MemoryEntry>): Promise<MemoryEntry>
    updateMemory(id: string, updates: Partial<MemoryEntry>): Promise<void>
    deleteMemory(id: string): Promise<void>
    getMemoryStats(): Promise<MemoryStats>
  } | null
  /**
   * Resolves the memory lifecycle manager on demand. Returns `null` while
   * the runtime is not yet initialised (handler emits the same structured
   * "Memory lifecycle manager not available" error as the pre-extraction
   * code).
   */
  getMemoryLifecycleManager(): {
    isRunning(): boolean
    getLastMaintenanceAt(): Date | null
    runMaintenance(): Promise<MaintenanceResult>
  } | null
  /**
   * Resolves the prompt-assembly service on demand. Returns `null` while
   * the runtime is not yet initialised (handler emits the same structured
   * "Prompt assembly not available" error as the pre-extraction code).
   * Only `createMemoryFromConversation` is consumed here — the rest of
   * the prompt-assembly surface is irrelevant to memory IPC.
   */
  getPromptAssembly(): {
    createMemoryFromConversation(params: {
      scope: ConversationScope
      category: 'summary' | 'learning'
      title: string
      content: string
      tags?: string[]
      priority?: number
    }): Promise<string | null>
  } | null
  /**
   * Resolves all conversation scopes (used by
   * `agent:memory:createFromConversation` to look up the scope by id
   * before forwarding it to prompt-assembly). Returns `null` while the
   * runtime is not yet initialised — same null-path as the other
   * accessors.
   */
  listConversationScopes(): ConversationScope[] | null
}

const CHANNELS = [
  'agent:memory:query',
  'agent:memory:create',
  'agent:memory:update',
  'agent:memory:delete',
  'agent:memory:stats',
  'agent:memory:lifecycle:status',
  'agent:memory:lifecycle:runMaintenance',
  'agent:memory:createFromConversation',
] as const

export const memoryGroup: IpcChannelGroup<MemoryGroupDeps> = {
  namespace: 'agent:memory',

  register(ipcMain: IpcMain, deps: MemoryGroupDeps): IpcDisposeHandle {
    // setupAgentIPC runs on every dev reload; strip any prior handler so
    // `ipcMain.handle` does not throw on the second registration. Mirrors the
    // pre-extraction defensive `removeHandler` calls in `ipc-handler.ts`.
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore — handler may not exist */ }
    }

    ipcMain.handle('agent:memory:query', async (_, filters: MemoryQueryFilters): Promise<IPCResponse> => {
      try {
        const memoryRepo = deps.getMemoryRepository()
        if (!memoryRepo) {
          return { success: false, error: 'Memory repository not available' }
        }
        const memories = await memoryRepo.queryMemories(filters)
        return { success: true, data: memories }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:memory:create', async (_, entry: Partial<MemoryEntry>): Promise<IPCResponse> => {
      try {
        const memoryRepo = deps.getMemoryRepository()
        if (!memoryRepo) {
          return { success: false, error: 'Memory repository not available' }
        }
        const created = await memoryRepo.createMemory(entry)
        return { success: true, data: created }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:memory:update', async (_, payload: UpdateMemoryPayload): Promise<IPCResponse> => {
      try {
        const memoryRepo = deps.getMemoryRepository()
        if (!memoryRepo) {
          return { success: false, error: 'Memory repository not available' }
        }
        // The repo's `updateMemory` is typed `Partial<MemoryEntry>` but the
        // pre-extraction handler accepted a free-form `Record<string, unknown>`
        // patch — keep the cast at the call site so future repo-side widening
        // does not require touching the IPC boundary.
        await memoryRepo.updateMemory(payload.id, payload.updates as Partial<MemoryEntry>)
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:memory:delete', async (_, id: string): Promise<IPCResponse> => {
      try {
        const memoryRepo = deps.getMemoryRepository()
        if (!memoryRepo) {
          return { success: false, error: 'Memory repository not available' }
        }
        await memoryRepo.deleteMemory(id)
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:memory:stats', async (): Promise<IPCResponse> => {
      try {
        const memoryRepo = deps.getMemoryRepository()
        if (!memoryRepo) {
          return { success: false, error: 'Memory repository not available' }
        }
        const stats = await memoryRepo.getMemoryStats()
        return { success: true, data: stats }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:memory:lifecycle:status', async (): Promise<IPCResponse> => {
      try {
        const lifecycle = deps.getMemoryLifecycleManager()
        if (!lifecycle) {
          return { success: false, error: 'Memory lifecycle manager not available' }
        }
        const status: MemoryLifecycleStatus = {
          running: lifecycle.isRunning(),
          lastMaintenanceAt: lifecycle.getLastMaintenanceAt()?.toISOString() || null,
        }
        return { success: true, data: status }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:memory:lifecycle:runMaintenance', async (): Promise<IPCResponse> => {
      try {
        const lifecycle = deps.getMemoryLifecycleManager()
        if (!lifecycle) {
          return { success: false, error: 'Memory lifecycle manager not available' }
        }
        const result = await lifecycle.runMaintenance()
        return { success: true, data: result }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:memory:createFromConversation', async (_, payload: CreateMemoryFromConversationPayload): Promise<IPCResponse> => {
      try {
        const promptAssembly = deps.getPromptAssembly()
        if (!promptAssembly) {
          return { success: false, error: 'Prompt assembly not available' }
        }

        // Look up the scope from the renderer-supplied id. The
        // pre-extraction handler resolved the full `ConversationScope`
        // server-side rather than trusting an inflated payload — same
        // shape preserved here.
        const scopes = deps.listConversationScopes()
        const scope = scopes?.find((s) => s.id === payload.scopeId)
        if (!scope) {
          return { success: false, error: 'Scope not found' }
        }

        const memoryId = await promptAssembly.createMemoryFromConversation({
          scope,
          category: payload.category,
          title: payload.title,
          content: payload.content,
          tags: payload.tags,
          priority: payload.priority,
        })

        if (!memoryId) {
          return { success: false, error: 'Failed to create memory' }
        }

        return { success: true, data: { memoryId } }
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
export const _memoryGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
