import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IpcMain } from 'electron'
import { thirdPartyNoticesSchema, type ThirdPartyNoticesResult } from '../../../shared/ipc-contracts/third-party-notices'

export function setupThirdPartyNoticesIPC(
  ipcMain: Pick<IpcMain, 'handle'>,
  app: { isPackaged: boolean; getAppPath(): string },
  resourcesPath: string,
): void {
  ipcMain.handle('app:getThirdPartyNotices', async (): Promise<ThirdPartyNoticesResult> => {
    const root = app.isPackaged ? resourcesPath : app.getAppPath()
    let contents: string
    try {
      contents = await readFile(join(root, 'licenses/generated/third-party-notices.json'), 'utf8')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { ok: false, reason: 'not_generated' }
      }
      throw error
    }
    return { ok: true, notices: thirdPartyNoticesSchema.parse(JSON.parse(contents)) }
  })
}
