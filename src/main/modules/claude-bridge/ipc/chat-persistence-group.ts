// Stage V V2.1m — ChatPersistenceGroup channel group.
//
// Bundles the 8 channels that expose the renderer-side chat history /
// conversation persistence + the file-picker / file-read surfaces that share
// the same lifecycle and dep neighbourhood (chat repository + main-process
// file I/O):
//
//   chat:getConversations            (list conversations for an agent)
//   chat:getMessages                 (list messages in a conversation)
//   chat:deleteConversation          (drop a conversation + its rows)
//   chat:saveMessage                 (persist a chat_messages row)
//   chat:createConversation          (insert a new conversation row)
//   chat:updateConversationTitle     (rename a conversation)
//   chat:pickFiles                   (multi-select file picker)
//   chat:readFileForAI               (load + classify a file for inline use)
//
// Handler bodies are lifted VERBATIM from `ipc-handler.ts` (V2.1m is a pure
// move — semantics must be byte-for-byte identical so the V5 IPC contract
// gate stays green and the renderer chat panel + file picker do not notice
// the refactor).
//
// All eight channels live in one group because they share:
//   • the same domain concept (conversation persistence + the file picker /
//     reader the chat panel uses to attach files to those conversations)
//   • the same dispose lifecycle (renderer boots them together when opening
//     the chat panel and unmounts them together on shutdown)
//   • a closely-coupled dep surface (chat repository for the persistence
//     channels + main-window-bound dialog + node fs primitives for the file
//     channels). Mixed surface — see file header rationale in
//     `recall-group.ts` for why this is intentionally NOT a
//     `Pick<EngineDeps>`.
//
// The chat persistence + file picker handlers were neighbours in
// `setupAgentIPC` (the file picker is the renderer surface that feeds files
// into the chat panel that then writes them through `chat:saveMessage`), so
// they retire together as one group rather than splitting persistence vs
// picker artificially.
import type { IpcMain } from 'electron'
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
 * Payload for `chat:saveMessage`. Matches the inline anonymous type from the
 * pre-extraction handler. The renderer hands these straight through; the
 * handler scrubs assistant content via `sanitizeAssistantText` before
 * persisting (see file-picker / save-message body for the leak hot-fix
 * rationale).
 */
export interface SaveMessagePayload {
  id: string
  conversationId: string
  role: string
  content: string
  timestamp: string
  meta?: Record<string, unknown>
}

/**
 * Payload for `chat:createConversation`. Matches the inline anonymous type
 * from the pre-extraction handler.
 */
export interface CreateConversationPayload {
  id: string
  agent: string
  title: string
}

/**
 * Payload for `chat:updateConversationTitle`. Matches the inline anonymous
 * type from the pre-extraction handler.
 */
export interface UpdateConversationTitlePayload {
  id: string
  title: string
}

/**
 * One entry in the `chat:pickFiles` response data array. Mirrors the inline
 * object literal the pre-extraction handler returned (name + path + type +
 * size + ext).
 */
export interface PickedFile {
  name: string
  path: string
  type: string
  size: number
  ext: string
}

/**
 * Sanitization options passed by the handler to `sanitizeAssistantText` so the
 * group does not import the scrub helper directly. The host wires a bound
 * variant of `sanitizeAssistantText` (the production fn) so the call site
 * stays decoupled from `tools-runtime/tool-call-text-guard`.
 */
export interface SanitizeAssistantTextOptions {
  sessionId: string
  // Matches the `source` literal union exported by `tool-call-text-guard.ts`.
  // We pin `'chat_save_message'` because that's the only call site this
  // group emits; widening to the full union (`'session_push' | ...`) would
  // misrepresent the contract.
  source: 'chat_save_message'
}

/**
 * Per-group deps. Mixed surface — same rationale as `RecallGroupDeps` in
 * `recall-group.ts`: each field is a bound method on a real singleton
 * (chat repository, dialog handle, sanitizer, mammoth/xlsx lazy loaders),
 * not a composition-root object. `engine-deps.ts` stays reserved for true
 * singletons; mixed/bound surfaces live on the per-group interface.
 */
export interface ChatPersistenceGroupDeps {
  /**
   * Bound `chatRepository.getConversations` — sync, returns conversation rows
   * for the given agent ordered by recency. Return type is `unknown[]`
   * because the row shape (`ConversationRecord`) lives in `database.ts` and
   * is forwarded unchanged to the renderer — the group is intentionally
   * agnostic to column names.
   */
  getConversations(agent: string): unknown[]
  /**
   * Bound `chatRepository.getMessages` — sync, returns chat messages in
   * insertion order for the given conversationId. Return type is `unknown[]`
   * for the same rationale as `getConversations`.
   */
  getMessages(conversationId: string): unknown[]
  /**
   * Bound `runtime.deleteConversation` — sync, removes the conversation row
   * and cascading message / attachment rows. NOTE: must be `runtime.` (not
   * `chatRepository.`) — runtime piggybacks on the delete to drop in-memory
   * scope state and emit detached-task cancellations. The pre-extraction
   * handler called `runtime!.deleteConversation` explicitly for this reason.
   */
  deleteConversation(conversationId: string): void
  /**
   * Bound `chatRepository.saveMessage` — sync, inserts a chat_messages row.
   * The handler scrubs assistant content first; this dep takes the
   * already-scrubbed payload.
   */
  saveMessage(payload: SaveMessagePayload): void
  /**
   * Bound `chatRepository.createConversation` — sync, inserts a conversations
   * row.
   */
  createConversation(payload: CreateConversationPayload): void
  /**
   * Bound `chatRepository.updateConversationTitle` — sync, renames a
   * conversation row.
   */
  updateConversationTitle(payload: UpdateConversationTitlePayload): void
  /**
   * Bound `sanitizeAssistantText` — sync, scrubs `<tool_call>` markers that
   * may have leaked into assistant content before persistence. Defense in
   * depth: the primary leak fix lives in `TurnTranscript.emitOutput`; this
   * layer catches anything that bypassed it.
   */
  sanitizeAssistantText(text: string, options: SanitizeAssistantTextOptions): string
  /**
   * Bound `runtime.persistReferenceHintAfterAssistantMessage` — sync, persists
   * the latest reference skill hint to `meta_json` so a Ready restart re-arms
   * typed skill actions. Optional (the runtime may not be ready yet — host
   * mirrors this with the `?.` chain in the pre-extraction handler).
   */
  persistReferenceHintAfterAssistantMessage(scopeId: string, role: string): void
  /**
   * Bound multi-select file picker — async, returns the chosen files (already
   * classified by ext) or an empty array on cancel. Host wires this to
   * `dialog.showOpenDialog(mainWindow, …)` + the post-processing loop that
   * builds `PickedFile` entries.
   */
  pickFiles(): Promise<PickedFile[]>
  /**
   * Bound file reader / classifier — async, returns the shape the renderer
   * expects per file type (image base64, video base64 or downgrade text,
   * audio descriptor, DOCX extracted text, XLSX sheet summary, plain text,
   * or a generic file descriptor). Host wires this to the verbatim
   * read-file-for-AI body from `ipc-handler.ts`.
   */
  readFileForAI(filePath: string): Promise<unknown>
}

const CHANNELS = [
  'chat:getConversations',
  'chat:getMessages',
  'chat:deleteConversation',
  'chat:saveMessage',
  'chat:createConversation',
  'chat:updateConversationTitle',
  'chat:pickFiles',
  'chat:readFileForAI',
] as const

export const chatPersistenceGroup: IpcChannelGroup<ChatPersistenceGroupDeps> = {
  namespace: 'chat:persistence',

  register(ipcMain: IpcMain, deps: ChatPersistenceGroupDeps): IpcDisposeHandle {
    // setupAgentIPC runs on every dev reload; strip any prior handler so
    // `ipcMain.handle` does not throw on the second registration. Mirrors the
    // pre-extraction defensive `removeHandler` calls in `ipc-handler.ts`.
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore — handler may not exist */ }
    }

    ipcMain.handle('chat:getConversations', (_, agent: string): IPCResponse => {
      try {
        const conversations = deps.getConversations(agent)
        return { success: true, data: conversations }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('chat:getMessages', (_, conversationId: string): IPCResponse => {
      try {
        const messages = deps.getMessages(conversationId)
        return { success: true, data: messages }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('chat:deleteConversation', (_, conversationId: string): IPCResponse => {
      try {
        deps.deleteConversation(conversationId)
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('chat:saveMessage', (_, data: SaveMessagePayload): IPCResponse => {
      try {
        // Screenshot-bug hotfix — defense-in-depth: even if streaming leaked
        // `<tool_call>` markers into the renderer's assembled message, scrub
        // them here before persisting to chat_messages. Only assistant rows
        // get cleaned (user / system content is unrelated to leaks). The
        // primary fix lives in `TurnTranscript.emitOutput`; this layer
        // catches anything that bypassed it (e.g. legacy code paths).
        const sanitizedContent = data.role === 'assistant'
          ? deps.sanitizeAssistantText(data.content, {
              sessionId: data.conversationId,
              source: 'chat_save_message',
            })
          : data.content
        deps.saveMessage({ ...data, content: sanitizedContent })
        // Phase 1.1 — assistant messages saved through this IPC previously
        // bypassed `runtime.persistReferenceHintToScope`, so local sessions
        // (the default flow for the chat panel) never wrote `lastReferenceSkill`
        // to meta_json. Result: a Ready restart re-armed `referenceSkillHintArmed=false`
        // and the model lost typed skill actions mid-flow. The hook is a no-op
        // for non-assistant roles and idempotent (skips DB write when persisted
        // snapshot equals in-memory hint).
        deps.persistReferenceHintAfterAssistantMessage(data.conversationId, data.role)
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('chat:createConversation', (_, data: CreateConversationPayload): IPCResponse => {
      try {
        deps.createConversation(data)
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('chat:updateConversationTitle', (_, data: UpdateConversationTitlePayload): IPCResponse => {
      try {
        deps.updateConversationTitle(data)
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('chat:pickFiles', async (): Promise<IPCResponse> => {
      try {
        const files = await deps.pickFiles()
        return { success: true, data: files }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('chat:readFileForAI', async (_, filePath: string): Promise<IPCResponse> => {
      try {
        const data = await deps.readFileForAI(filePath)
        return { success: true, data }
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
export const _chatPersistenceGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
