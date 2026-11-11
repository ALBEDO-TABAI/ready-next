import type { IpcMain } from 'electron'
import type { EngineDeps } from './engine-deps'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'

export type WorkspaceGroupDeps = Pick<
  EngineDeps,
  'getHomeDirectory'
>

const CHANNELS = [
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
