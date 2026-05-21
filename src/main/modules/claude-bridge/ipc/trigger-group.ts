// Stage V V2.1o — TriggerGroup channel group (claude-bridge split FINAL).
//
// Bundles the 4 channels that expose the agent memory-trigger surface
// (CRUD + combined "create trigger + associate memories" promotion) used by
// the Triggers settings tab and the trigger authoring flow:
//
//   agent:trigger:list                  (filtered list)
//   agent:trigger:create                (insert one row)
//   agent:trigger:update                (patch one row)
//   agent:trigger:createWithMemories    (create trigger + attach memoryIds
//                                        in one round trip via prompt-assembly)
//
// Handler bodies are lifted VERBATIM from `ipc-handler.ts` (V2.1o is a pure
// move — semantics must be byte-for-byte identical so the V5 IPC contract
// gate stays green and the Triggers UI does not notice the refactor).
//
// All four channels live in one group because they share:
//   • the same domain concept (memory triggers: list → create → update,
//     plus the promotion endpoint that hand-builds a trigger and immediately
//     attaches memory refs in one transaction-like call)
//   • the same dispose lifecycle (renderer boots them together when opening
//     the Triggers settings page; the authoring flow depends on
//     `createWithMemories` being live whenever the runtime is up)
//   • a closely-coupled dep surface — `list/create/update` forward directly
//     to `memoryRepository.*Trigger*` methods, while `createWithMemories`
//     forwards to `promptAssembly.createTrigger` which orchestrates the
//     `memoryRepository.createTrigger` + `addTriggerRef` calls server-side.
//
// The `agent:memory:*` channels (V2.1n / `memory-group.ts`) live on the same
// `memoryRepository` instance but expose memory CRUD + lifecycle; the V5
// plan splits them at the `memory` vs `trigger` namespace boundary so
// triggers can be retired or restructured independently. See
// `memory-group.ts` header for the symmetric rationale.
//
// Per-group deps are NOT a `Pick<EngineDeps>` — same rationale as the other
// V2.1 groups: the dep surface is bound runtime / repository / prompt-
// assembly methods (resolved fresh per `setupAgentIPC` invocation), not
// composition-root singletons. `engine-deps.ts` is reserved for true
// singletons; mixed/bound surfaces stay on the per-group interface where
// they belong.
import type { IpcMain } from 'electron'
import type { TriggerDefinition, TriggerFilters } from '../../repositories/memory-repository'
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
 * `agent:trigger:update` payload. Matches the inline anonymous type from the
 * pre-extraction handler verbatim. The `updates` field is intentionally a
 * `Record<string, unknown>` — the handler hands the patch straight through
 * to `memoryRepository.updateTrigger`, which decides which keys it
 * recognises; widening to `Partial<TriggerDefinition>` here would leak the
 * `TriggerDefinition` shape into the IPC boundary and reject legitimate
 * forward-compatible fields the repo learns to support later.
 */
export interface UpdateTriggerPayload {
  id: string
  updates: Record<string, unknown>
}

/**
 * `agent:trigger:createWithMemories` payload. Matches the inline anonymous
 * type from the pre-extraction handler verbatim. The handler forwards every
 * field straight through to `promptAssembly.createTrigger` which does the
 * `memoryRepository.createTrigger` + per-memory `addTriggerRef` orchestration
 * server-side, so the renderer never has to know the two-step shape.
 */
export interface CreateTriggerWithMemoriesPayload {
  label: string
  pattern: string
  patternFlags?: string
  memoryIds: string[]
  module?: string
  blocking?: boolean
  priority?: number
}

/**
 * Per-group deps. Mixed surface — see file header for why this is not
 * `Pick<EngineDeps, …>`.
 *
 * The repo / prompt-assembly accessors are intentionally "resolve-on-demand"
 * (each returns `null` when the runtime side is not ready yet) — the
 * pre-extraction handler called `runtime?.getMemoryRepository()` /
 * `runtime?.getPromptAssembly()` and short-circuited with a structured
 * error response when the result was nullish. Keeping the dep shape as
 * `() => X | null` preserves that null-path verbatim instead of throwing
 * inside the dep at the wrong layer.
 */
export interface TriggerGroupDeps {
  /**
   * Resolves the memory repository on demand. Returns `null` while the
   * runtime is not yet initialised (the handler turns this into a
   * structured "Memory repository not available" error response — same
   * wording as the pre-extraction handler).
   *
   * Only the trigger surface (`listTriggers` / `createTrigger` /
   * `updateTrigger`) is consumed here; the memory CRUD surface lives in
   * `memory-group.ts` (V2.1n).
   */
  getMemoryRepository(): {
    listTriggers(filters?: TriggerFilters): Promise<TriggerDefinition[]>
    createTrigger(trigger: Partial<TriggerDefinition>): Promise<TriggerDefinition>
    updateTrigger(id: string, updates: Partial<TriggerDefinition>): Promise<void>
  } | null
  /**
   * Resolves the prompt-assembly service on demand. Returns `null` while
   * the runtime is not yet initialised (handler emits the same structured
   * "Prompt assembly not available" error as the pre-extraction code).
   * Only `createTrigger` is consumed here — the rest of the prompt-assembly
   * surface is irrelevant to trigger IPC (memory promotion lives in
   * `memory-group.ts`).
   */
  getPromptAssembly(): {
    createTrigger(params: {
      label: string
      pattern: string
      patternFlags?: string
      memoryIds: string[]
      module?: string
      blocking?: boolean
      priority?: number
    }): Promise<string | null>
  } | null
}

const CHANNELS = [
  'agent:trigger:list',
  'agent:trigger:create',
  'agent:trigger:update',
  'agent:trigger:createWithMemories',
] as const

export const triggerGroup: IpcChannelGroup<TriggerGroupDeps> = {
  namespace: 'agent:trigger',

  register(ipcMain: IpcMain, deps: TriggerGroupDeps): IpcDisposeHandle {
    // setupAgentIPC runs on every dev reload; strip any prior handler so
    // `ipcMain.handle` does not throw on the second registration. Mirrors the
    // pre-extraction defensive `removeHandler` calls in `ipc-handler.ts`.
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore — handler may not exist */ }
    }

    ipcMain.handle('agent:trigger:list', async (_, filters: TriggerFilters | undefined): Promise<IPCResponse> => {
      try {
        const memoryRepo = deps.getMemoryRepository()
        if (!memoryRepo) {
          return { success: false, error: 'Memory repository not available' }
        }
        const triggers = await memoryRepo.listTriggers(filters)
        return { success: true, data: triggers }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:trigger:create', async (_, trigger: Partial<TriggerDefinition>): Promise<IPCResponse> => {
      try {
        const memoryRepo = deps.getMemoryRepository()
        if (!memoryRepo) {
          return { success: false, error: 'Memory repository not available' }
        }
        const created = await memoryRepo.createTrigger(trigger)
        return { success: true, data: created }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:trigger:update', async (_, payload: UpdateTriggerPayload): Promise<IPCResponse> => {
      try {
        const memoryRepo = deps.getMemoryRepository()
        if (!memoryRepo) {
          return { success: false, error: 'Memory repository not available' }
        }
        // The repo's `updateTrigger` is typed `Partial<TriggerDefinition>` but
        // the pre-extraction handler accepted a free-form
        // `Record<string, unknown>` patch — keep the cast at the call site so
        // future repo-side widening does not require touching the IPC
        // boundary.
        await memoryRepo.updateTrigger(payload.id, payload.updates as Partial<TriggerDefinition>)
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:trigger:createWithMemories', async (_, payload: CreateTriggerWithMemoriesPayload): Promise<IPCResponse> => {
      try {
        const promptAssembly = deps.getPromptAssembly()
        if (!promptAssembly) {
          return { success: false, error: 'Prompt assembly not available' }
        }

        const triggerId = await promptAssembly.createTrigger({
          label: payload.label,
          pattern: payload.pattern,
          patternFlags: payload.patternFlags,
          memoryIds: payload.memoryIds,
          module: payload.module,
          blocking: payload.blocking,
          priority: payload.priority,
        })

        if (!triggerId) {
          return { success: false, error: 'Failed to create trigger' }
        }

        return { success: true, data: { triggerId } }
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
export const _triggerGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
