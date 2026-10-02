// Stage V V2.1m — ChatPersistenceGroup channel group.
//
// Bundles the 5 renderer-side chat metadata/read + file-picker/file-read
// channels. Message creation and conversation lifecycle writes are owned by
// the Codex ingress/finalizer/lifecycle path and are intentionally absent.
//
//   chat:getConversations            (list conversations for an agent)
//   chat:getMessages                 (list messages in a conversation)
//   chat:updateConversationTitle     (rename a conversation)
//   chat:pickFiles                   (multi-select file picker)
//   chat:readFileForAI               (load + classify a file for inline use)
//
// Handler bodies are lifted VERBATIM from `ipc-handler.ts` (V2.1m is a pure
// move — semantics must be byte-for-byte identical so the V5 IPC contract
// gate stays green and the renderer chat panel + file picker do not notice
// the refactor).
//
// All five channels live in one group because they share:
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
// The remaining metadata/read and file handlers share one renderer lifecycle.
import type { IpcMain } from 'electron'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'
import type { PastedImageFile } from '../../../../shared/chat-pasted-image'

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
   * Bound `chatRepository.updateConversationTitle` — sync, renames a
   * conversation row.
   */
  updateConversationTitle(payload: UpdateConversationTitlePayload): void
  /**
   * Bound multi-select file picker — async, returns the chosen files (already
   * classified by ext) or an empty array on cancel. Host wires this to
   * `dialog.showOpenDialog(mainWindow, …)` + the post-processing loop that
   * builds `PickedFile` entries.
   */
  pickFiles(): Promise<PickedFile[]>
  savePastedImage(bytes: Uint8Array): Promise<PastedImageFile>
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
  'chat:updateConversationTitle',
  'chat:pickFiles',
  'chat:savePastedImage',
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

    ipcMain.handle('chat:savePastedImage', async (_, bytes: Uint8Array): Promise<IPCResponse> => {
      try {
        return { success: true, data: await deps.savePastedImage(bytes) }
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
