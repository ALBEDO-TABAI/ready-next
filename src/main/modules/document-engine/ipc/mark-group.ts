// Stage V V2.3a — document-engine MarkGroup channel cluster.
//
// Bundles the 4 channels that drive document mark CRUD (bookmarks + notes
// anchored to a document path), as consumed by the side-panels UI:
//
//   document:listMarks    (list marks for a given document path)
//   document:createMark   (insert a mark draft → returns the persisted row)
//   document:updateMark   (patch an existing mark by id → returns next row
//                          or `document_mark_not_found`)
//   document:deleteMark   (delete a mark by id → returns `deleted: boolean`)
//
// Handler bodies are lifted from `ipc-handler.ts` verbatim (V2.3a is a
// move + thin-wrapper: response shaping and mock-mode dispatch stay on
// this side; the SQLite-backed repository factory runs through
// `EngineDeps.getDocumentMarksRepository` so the group does not import the
// database module or `DocumentMarksRepository`'s construction site
// directly).
//
// The 4 channels live in one group despite ranging across reads
// (`listMarks`) and mutations (`createMark` / `updateMark` / `deleteMark`)
// because they share:
//   • the same domain concept (document mark lifecycle)
//   • the same dispose lifecycle (renderer wires them together)
//   • the same dep surface (mock flag + marks repository factory)
// Splitting reads from writes would create two groups whose deps overlap
// entirely, which goes against the per-group-deps-as-contract intent.
import type { IpcMain } from 'electron'
import type {
  DocumentMarkDraft,
  DocumentMarkPatch,
} from '../../../../shared/document-side-panels'
import type { EngineDeps } from './engine-deps'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'

/**
 * Per-group deps — subset of `EngineDeps`. Tests pass a fake that
 * implements exactly these two members; nothing more is required to
 * exercise the 4 handler bodies.
 */
export type MarkGroupDeps = Pick<
  EngineDeps,
  | 'useMock'
  | 'getDocumentMarksRepository'
>

const CHANNELS = [
  'document:listMarks',
  'document:createMark',
  'document:updateMark',
  'document:deleteMark',
] as const

export const markGroup: IpcChannelGroup<MarkGroupDeps> = {
  namespace: 'document:mark',

  register(ipcMain: IpcMain, deps: MarkGroupDeps): IpcDisposeHandle {
    // setupDocumentIPC may be re-entered on dev reload; strip any prior
    // handler so `ipcMain.handle` does not throw on the second
    // registration. Mirrors the pre-extraction defensive pattern used by
    // the rss-engine groups (V2.2a).
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore — handler may not exist */ }
    }

    ipcMain.handle('document:listMarks', async (_, payload: { documentPath?: string }) => {
      try {
        if (deps.useMock) return { success: true, data: [] }
        const documentPath = typeof payload?.documentPath === 'string' ? payload.documentPath : ''
        return { success: true, data: deps.getDocumentMarksRepository().list(documentPath) }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('document:createMark', async (_, payload: DocumentMarkDraft) => {
      try {
        if (deps.useMock) return { success: false, error: 'mock_document_marks_unavailable' }
        const repository = deps.getDocumentMarksRepository()
        const created = repository.create(payload)
        const portability = await repository.ensureMarkPortable(created.id)
        const data = repository.get(created.id)
        return portability.ok ? { success: true, data, portability } : { success: false, localSaved: true, data, portability, errorCode: portability.code, error: '已保留本地记录，尚不可跨机器恢复：' + portability.message }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('document:updateMark', async (_, payload: { id?: string; patch?: DocumentMarkPatch }) => {
      try {
        if (deps.useMock) return { success: false, error: 'mock_document_marks_unavailable' }
        const id = typeof payload?.id === 'string' ? payload.id : ''
        if (!id) return { success: false, error: 'document_mark_id_required' }
        const data = deps.getDocumentMarksRepository().update(id, payload.patch || {})
        return data
          ? { success: true, data }
          : { success: false, error: 'document_mark_not_found' }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('document:deleteMark', async (_, payload: { id?: string }) => {
      try {
        if (deps.useMock) return { success: false, error: 'mock_document_marks_unavailable' }
        const id = typeof payload?.id === 'string' ? payload.id : ''
        if (!id) return { success: false, error: 'document_mark_id_required' }
        return { success: true, deleted: deps.getDocumentMarksRepository().delete(id) }
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
export const _markGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
