import electron, { type IpcMain, type WebContents } from 'electron'
import type { VaultState } from '../../../shared/vault'
import type { VaultService } from './vault-service'

export function registerVaultIPC(
  ipcMain: Pick<IpcMain, 'handle'>,
  service: VaultService,
  windows: () => { isDestroyed(): boolean; webContents: Pick<WebContents, 'send'> }[] = () => electron.BrowserWindow.getAllWindows(),
): void {
  const changed = (state: VaultState): VaultState => {
    for (const window of windows()) {
      if (!window.isDestroyed()) window.webContents.send('vault:changed', state)
    }
    return state
  }
  ipcMain.handle('vault:get', () => service.get())
  ipcMain.handle('vault:set', (_event, path: unknown) => changed(service.set(path)))
  ipcMain.handle('vault:createDefault', () => changed(service.createDefault()))
}
