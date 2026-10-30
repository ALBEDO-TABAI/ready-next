import type { IpcMain } from 'electron'
import type { VaultService } from './vault-service'

export function registerVaultIPC(ipcMain: Pick<IpcMain, 'handle'>, service: VaultService): void {
  ipcMain.handle('vault:get', () => service.get())
  ipcMain.handle('vault:set', (_event, path: unknown) => service.set(path))
  ipcMain.handle('vault:createDefault', () => service.createDefault())
}
