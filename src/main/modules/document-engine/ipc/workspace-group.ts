// Stage V V2.3d — document-engine WorkspaceGroup channel cluster.
//
// Bundles the 3 channels that drive workspace index file portability
// (export/import) and the home-directory hint the export flow uses for
// its default save path:
//
//   document:exportWorkspace  (write a `.ready-workspace.json` index file
//                              after a save-dialog round-trip)
//   document:importWorkspace  (parse a previously-exported workspace index
//                              after an open-file dialog round-trip)
//   document:getHome          (return the OS home directory; consumed by
//                              renderer-side workspace UIs that want the
//                              same default path the export flow uses)
//
// Handler bodies are lifted VERBATIM from `ipc-handler.ts` (V2.3d follows
// the V2.3a/V2.3b/V2.3c move + thin-wrapper shape). The handlers do NOT
// import electron at runtime: dialog and BrowserWindow access is wrapped
// behind small facades on `WorkspaceGroupDeps` so the group is testable
// with a stub host and a future move out of document-engine stays
// mechanical. `os.homedir()` is likewise lifted to a dep so tests can pin
// a deterministic home path.
//
// The 3 channels live in one group despite mixing a read companion
// (`getHome`) with the two dialog-driven flows (`exportWorkspace`/
// `importWorkspace`) because they share:
//   • the same domain concept (workspace-index file portability)
//   • the same dispose lifecycle (the workspace-manager UI wires them as
//     one feature toggle)
//   • the same dep surface (dialog facades + home directory + window
//     resolution — no marks repo, no write-index hook, no shell)
// Splitting `getHome` off would create a single-handler group whose deps
// fully overlap; pinning the dialog flows on their own would silently leak
// the read companion back into the host. The grouping is mixed-surface
// by design, mirroring V2.3c's FileMutationGroup (mutations + stat).
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import type { IpcMain } from 'electron'
import type { EngineDeps } from './engine-deps'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'

/**
 * Per-group deps — subset of `EngineDeps`. Tests pass a fake that
 * implements exactly these members; nothing more is required to exercise
 * the 3 handler bodies.
 */
export type WorkspaceGroupDeps = Pick<
  EngineDeps,
  | 'resolveDialogWindow'
  | 'getBrowserWindowFromWebContents'
  | 'showSaveWorkspaceDialog'
  | 'showOpenWorkspaceFileDialog'
  | 'getHomeDirectory'
>

const CHANNELS = [
  'document:exportWorkspace',
  'document:importWorkspace',
  'document:getHome',
] as const

export const workspaceGroup: IpcChannelGroup<WorkspaceGroupDeps> = {
  namespace: 'document:workspace',

  register(ipcMain: IpcMain, deps: WorkspaceGroupDeps): IpcDisposeHandle {
    // setupDocumentIPC may be re-entered on dev reload; strip any prior
    // handler so `ipcMain.handle` does not throw on the second
    // registration. Mirrors the pre-extraction defensive pattern used by
    // V2.3a MarkGroup, V2.3b FileIoGroup, V2.3c FileMutationGroup, and the
    // rss-engine groups (V2.2a).
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore — handler may not exist */ }
    }

    // Export workspace index file. Caller supplies a name + folder list; we
    // pop a save dialog so the user picks a location and we write a
    // `.ready-workspace.json` file. The schema is intentionally minimal so it
    // stays portable (just absolute folder paths).
    ipcMain.handle('document:exportWorkspace', async (event, payload: { name: string; folders: string[] }) => {
      try {
        const win = deps.resolveDialogWindow(deps.getBrowserWindowFromWebContents(event.sender))
        if (!win) return { success: false, error: 'No window' }
        const safeName = (payload?.name || '工作区').replace(/[\\/:*?"<>|]/g, '_').trim() || '工作区'
        const folders = Array.isArray(payload?.folders) ? payload.folders.filter((f) => typeof f === 'string' && f.length > 0) : []
        if (folders.length === 0) {
          return { success: false, error: '当前没有可保存的文件夹' }
        }
        const defaultPath = join(deps.getHomeDirectory(), `${safeName}.ready-workspace.json`)
        const result = await deps.showSaveWorkspaceDialog(win, {
          title: '保存工作区',
          defaultPath,
          filters: [{ name: 'Ready 工作区', extensions: ['ready-workspace.json', 'json'] }],
        })
        if (result.canceled || !result.filePath) {
          return { success: false, error: 'cancelled' }
        }
        const now = new Date().toISOString()
        const indexBody = {
          schema: 'ready-workspace@1',
          name: safeName,
          folders,
          createdAt: now,
          updatedAt: now,
        }
        await writeFile(result.filePath, JSON.stringify(indexBody, null, 2), 'utf-8')
        return { success: true, path: result.filePath, name: safeName }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    // Import workspace index file. Opens a file picker and returns the parsed
    // schema. Caller (renderer store) is responsible for validating each
    // folder against `validateWorkspaceRoot` before adopting them.
    ipcMain.handle('document:importWorkspace', async (event) => {
      try {
        const win = deps.resolveDialogWindow(deps.getBrowserWindowFromWebContents(event.sender))
        if (!win) return { success: false, error: 'No window' }
        const result = await deps.showOpenWorkspaceFileDialog(win, {
          title: '导入工作区',
          properties: ['openFile'],
          filters: [{ name: 'Ready 工作区', extensions: ['json'] }],
        })
        if (result.canceled || result.filePaths.length === 0) {
          return { success: false, error: 'cancelled' }
        }
        const filePath = result.filePaths[0]
        const raw = await readFile(filePath, 'utf-8')
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          return { success: false, error: '文件不是合法的 JSON' }
        }
        if (!parsed || typeof parsed !== 'object') {
          return { success: false, error: '工作区文件结构不合法' }
        }
        const obj = parsed as Record<string, unknown>
        const schema = typeof obj.schema === 'string' ? obj.schema : null
        if (schema !== 'ready-workspace@1') {
          return { success: false, error: '未识别的工作区版本' }
        }
        const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name : '导入的工作区'
        const folders = Array.isArray(obj.folders)
          ? (obj.folders.filter((f): f is string => typeof f === 'string' && f.length > 0))
          : []
        if (folders.length === 0) {
          return { success: false, error: '工作区不包含任何文件夹' }
        }
        return { success: true, path: filePath, name, folders }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    // Get home directory
    ipcMain.handle('document:getHome', async () => {
      return { success: true, path: deps.getHomeDirectory() }
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
export const _workspaceGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
